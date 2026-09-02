/**
 * TIMECARDS workspace — the shared vocabulary.
 *
 * Labour is the only major cost on a construction project that is claimed,
 * approved and paid before anybody independently checks it. So this workspace
 * is not a timesheet screen with a total at the bottom; it is three
 * reconciliations with a timesheet attached, and this file carries the
 * primitives that keep each of them honest.
 *
 *  1. CLAIMED vs PRESENT. Where no site-access record exists the API returns
 *     `varianceHours: null` with a reason. `<NotComparable>` renders that as
 *     NOT COMPARABLE — never as zero hours present. Treating a data gap as
 *     absence manufactures a fraud finding out of a broken turnstile, and a
 *     control that cries fraud at a gate log is switched off within a month.
 *
 *  2. HOURS vs COST CODE. Allocations must reconcile with the card bucket by
 *     bucket. `<AllocationBalance>` does the same arithmetic client-side so
 *     the foreman sees the difference before the server names it, and
 *     `<RefusalNotice>` prints the server's refusal verbatim when it lands.
 *
 *  3. OUR HOURS vs THEIR SIGNATURE. Signed, signed under protest and refused
 *     to sign are three visibly different states, because a dispute later
 *     turns on exactly which one it was.
 *
 * And the segregation control: an attempted self-approval is WRITTEN — an
 * approval row with `isSelfApproval` set, a signal, a ledger entry — and only
 * then refused. `<SelfApprovalAttempts>` shows those rows, because a control
 * that silently blocks a breach leaves no evidence it was attempted.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Badge,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tooltip,
  Tr,
} from "../../ui";
import { cx } from "../../ui/cx";
import type { Tone } from "../../ui/tokens";
import { IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";

/* ========================================================================== */
/* Wire types                                                                  */
/* ========================================================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** `hours.ts` → HourSplit. */
export interface HourSplit {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
}

/** `hours.ts` → AppliedOvertimeRule. The rule as applied, in words. */
export interface AppliedOvertimeRule {
  kind: "daily" | "weekly" | "none";
  basis: "day" | "week" | "none";
  thresholdHours: number | null;
  doubleTimeThresholdHours: number | null;
  cumulativeFrom: number;
  cumulativeTo: number;
  source: string;
  explanation: string;
}

/** `shared.ts` → overtimeRuleOf. The rule as CONFIGURED. */
export interface OvertimeRule {
  kind: "daily" | "weekly" | "none";
  thresholdHours: number | null;
  doubleTimeThresholdHours: number | null;
  source: string;
}

/** What `detail.hourClassification` carries on every card. */
export interface HourClassificationRecord {
  method: "explicit_split" | "classified_from_worked_hours" | "classified_from_clock_times";
  workedHours: number;
  rule: AppliedOvertimeRule | null;
  note: string | null;
  priorWeekLadderHours?: number;
  weekStart?: string;
  weekEnd?: string;
}

export interface TimecardDetailBlob {
  hourClassification?: HourClassificationRecord;
  cost?: { value: number | null; reasons: string[]; currency: string };
  variance?: {
    value: number | null;
    accessHours: number | null;
    accessHoursSource: string | null;
    withinTolerance: boolean | null;
    toleranceHours: number;
    reasons: string[];
  };
  submitComment?: string | null;
  lockNote?: string | null;
  revisedBy?: { id?: string; reference?: string };
  [key: string]: unknown;
}

export interface TimecardRecord {
  id: string;
  companyId: string;
  projectId: string;
  number: number;
  reference: string;
  batchId: string | null;
  workerId: string;
  crewId: string | null;
  vendorId: string | null;
  workDate: string;
  shift: string;
  trade: string | null;
  classification: string | null;
  startTime: string | null;
  endTime: string | null;
  breakMinutes: number;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  premiumKind: string;
  totalHours: number;
  idleHours: number;
  idleReason: string | null;
  hourlyRate: number | null;
  overtimeRate: number | null;
  doubleTimeRate: number | null;
  premiumRate: number | null;
  burdenRate: number | null;
  totalCost: number | null;
  currency: string;
  isBillable: number;
  source: string;
  siteAccessRecordId: string | null;
  accessHoursOnSite: number | null;
  varianceHours: number | null;
  varianceExplanation: string | null;
  status: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  lockedAt: string | null;
  exportedAt: string | null;
  revisesTimecardId: string | null;
  notes: string | null;
  detail: TimecardDetailBlob | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimecardListRow extends TimecardRecord {
  workerReference: string;
  workerName: string;
  allocationCount: number;
  allocatedHours: number;
  isAllocated: boolean;
}

export interface TimecardListResponse extends ListResponse<TimecardListRow> {
  sweep: unknown;
}

export interface Allocation {
  id: string;
  timecardId: string;
  position: number;
  costCodeId: string | null;
  costCode: string | null;
  costType: string;
  budgetLineItemId: string | null;
  wbsPath: string | null;
  locationId: string | null;
  changeEventId: string | null;
  tmTicketId: string | null;
  equipmentId: string | null;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
  hourlyRate: number | null;
  cost: number | null;
  currency: string;
  quantity: number | null;
  unit: string | null;
  isBillable: number;
  notes: string | null;
  detail: Record<string, unknown> | null;
}

export interface BucketDifference {
  bucket: "regularHours" | "overtimeHours" | "doubleTimeHours" | "premiumHours" | "totalHours";
  claimed: number;
  allocated: number;
  difference: number;
}

export interface AllocationCheck {
  ok: boolean;
  claimed: HourSplit;
  allocated: HourSplit;
  differences: BucketDifference[];
  message: string | null;
}

export interface Approval {
  id: string;
  timecardId: string | null;
  batchId: string | null;
  level: number;
  approverId: string;
  approverRole: string | null;
  decision: string;
  decidedAt: string;
  comment: string | null;
  subjectWorkerId: string | null;
  /** 1 when the approver was the submitter or the raiser. STORED ON PURPOSE. */
  isSelfApproval: number;
  delegatedFromId: string | null;
  detail: {
    outcome?: string;
    control?: string;
    breachedRelationship?: string;
    attemptedDecision?: string;
    timecardReference?: string;
    [key: string]: unknown;
  } | null;
  createdAt: string;
}

export interface SiteAccessRecord {
  id: string;
  workerId: string;
  accessDate: string;
  firstIn: string | null;
  lastOut: string | null;
  hoursOnSite: number | null;
  source: string;
}

/** `hours.ts` → AccessVarianceResult. */
export interface AccessVariance {
  value: number | null;
  accessHours: number | null;
  accessHoursSource: "recorded" | "derived_from_gate_times" | null;
  direction: "over" | "under" | "match" | null;
  withinTolerance: boolean | null;
  toleranceHours: number;
  requiresExplanation: boolean;
  explained: boolean;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface TimecardDetail extends TimecardRecord {
  workerReference: string | null;
  workerName: string | null;
  crewReference: string | null;
  crewName: string | null;
  overtimeRule: OvertimeRule;
  allocations: Allocation[];
  allocationCheck: AllocationCheck;
  approvals: Approval[];
  siteAccess: SiteAccessRecord | null;
  variance: AccessVariance;
  isEditable: boolean;
  weekReclassified?: unknown[];
}

export interface CrewConfig {
  overtimeRule: "daily" | "weekly" | "none";
  doubleTimeThresholdHours: number | null;
  weeklyOvertimeThresholdHours: number | null;
  weeklyDoubleTimeThresholdHours: number | null;
  weekStartsOn: number;
  approvalLevels: number;
  varianceToleranceHours: number;
}

export interface CrewRecord {
  id: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  trade: string | null;
  foremanWorkerId: string | null;
  supervisorUserId: string | null;
  vendorId: string | null;
  defaultShift: string;
  standardHoursPerDay: number | null;
  overtimeThresholdHours: number | null;
  defaultCostCodeId: string | null;
  status: string;
  headcountTarget: number | null;
  currentHeadcount: number;
  activeFrom: string | null;
  activeTo: string | null;
  config: CrewConfig;
  overtimeRule: OvertimeRule;
  /** How the rule reads in words, or why it cannot classify anything yet. */
  overtimeRuleExplanation: string;
  canClassifyHours: boolean;
}

export interface CrewMember {
  id: string;
  crewId: string;
  workerId: string;
  roleInCrew: string;
  fromDate: string;
  toDate: string | null;
  isActive: number;
  classification: string | null;
  hourlyRate: number | null;
  currency: string;
  workerReference?: string;
  workerName?: string;
  workerStatus?: string;
}

export interface CrewDetail extends CrewRecord {
  asOf: string;
  members: CrewMember[];
  memberHistory: CrewMember[];
  headcountOnDate: number;
  timecardCount: number;
}

export interface BatchRollup {
  timecardCount: number;
  workerCount: number;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
  totalCost: number | null;
  currency: string;
  varianceHours: number | null;
  exceptionCount: number;
  uncostedCards: string[];
  unallocatedCards: string[];
  unexplainedVarianceCards: string[];
  cardsWithoutAccessRecord: string[];
  reasons: string[];
}

export interface BatchRecord {
  id: string;
  number: number;
  reference: string;
  crewId: string | null;
  vendorId: string | null;
  periodStart: string;
  periodEnd: string;
  weekEnding: string | null;
  status: string;
  timecardCount: number;
  workerCount: number;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
  totalCost: number;
  currency: string;
  varianceHours: number | null;
  exceptionCount: number;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  lockedAt: string | null;
  exportedAt: string | null;
  payrollBatchRef: string | null;
}

export interface BatchDetail extends BatchRecord {
  crewReference: string | null;
  crewName: string | null;
  rollup: BatchRollup;
  timecards: Array<TimecardRecord & { workerReference: string; workerName: string }>;
  approvals: Approval[];
}

/** `hours.ts` → WorkerVariancePattern. */
export interface WorkerVariancePattern {
  workerId: string;
  workerReference: string;
  workerName: string;
  vendorId: string | null;
  days: number;
  daysCompared: number;
  /** days with NO access record — a data gap, never counted as an overclaim */
  daysWithoutAccessRecord: number;
  claimedHours: number;
  accessHours: number;
  unexplainedOverHours: number;
  unexplainedOverDays: number;
  explainedOverDays: number;
  underHours: number;
  isOverclaimPattern: boolean;
  isAccessGap: boolean;
  reason: string;
}

export interface VarianceRow {
  timecardId: string;
  reference: string;
  workerId: string;
  workerReference: string;
  workerName: string;
  vendorId: string | null;
  workDate: string;
  shift: string;
  claimedHours: number;
  accessHours: number | null;
  varianceHours: number | null;
  explained: boolean;
  explanation: string | null;
  reasons: string[];
}

export interface ReconciliationReport {
  periodStart: string;
  periodEnd: string;
  timecards: number;
  compared: number;
  withoutAccessRecord: number;
  overclaimPatterns: number;
  accessGaps: number;
  totals: {
    claimedHours: number;
    accessHours: number;
    unexplainedOverHours: number;
    underHours: number;
  };
  workers: WorkerVariancePattern[];
  rows: VarianceRow[];
  persisted: boolean;
  toleranceHours: number;
  thresholds: {
    overclaimMinDays: number;
    overclaimMinHours: number;
    accessGapMinDays: number;
  };
}

/** `tm.ts` → Figure. */
export interface Figure {
  value: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface PricedTmLine {
  position: number;
  lineKind: string;
  description: string;
  quantity?: number | null;
  unit?: string | null;
  hours?: number | null;
  rate?: number | null;
  amount: number | null;
  currency: string;
  isDisputed?: boolean;
  agreedAmount?: number | null;
  basis: "stated" | "hours_x_rate" | "quantity_x_rate" | "unpriced";
  reasons: string[];
}

export interface TmTotals {
  currency: string;
  lineCount: number;
  totalLabourHours: number;
  totalEquipmentHours: number;
  labourTotal: Figure;
  equipmentTotal: Figure;
  materialTotal: Figure;
  subcontractTotal: Figure;
  otherTotal: Figure;
  netTotal: Figure;
  markupPercent: number | null;
  markupTotal: Figure;
  total: Figure;
  agreedTotal: Figure;
  disputedLineCount: number;
  unpricedLineCount: number;
  lines: PricedTmLine[];
  notes: string[];
}

/** `tm.ts` → SignatureEvidence. THREE visibly different states. */
export type SignatureState = "unsigned" | "signed" | "signed_under_protest" | "refused_to_sign";

export interface SignatureEvidence {
  state: SignatureState;
  isSigned: boolean;
  hasClientResponse: boolean;
  note: string | null;
  summary: string;
}

export interface TicketLine {
  id: string;
  ticketId: string;
  position: number;
  lineKind: string;
  description: string;
  workerId: string | null;
  equipmentId: string | null;
  timecardId: string | null;
  timecardAllocationId: string | null;
  costCodeId: string | null;
  budgetLineItemId: string | null;
  quantity: number | null;
  unit: string | null;
  hours: number | null;
  rate: number | null;
  amount: number;
  currency: string;
  isDisputed: number;
  disputeNote: string | null;
  agreedAmount: number | null;
}

export interface TicketRecord {
  id: string;
  number: number;
  reference: string;
  ticketDate: string;
  title: string;
  description: string | null;
  scopeOfWork: string | null;
  instructedByName: string | null;
  instructionRef: string | null;
  instructionDate: string | null;
  wasVerbalInstruction: number;
  changeEventId: string | null;
  commitmentId: string | null;
  vendorId: string | null;
  crewId: string | null;
  locationText: string | null;
  rateBasis: string;
  markupPercent: number | null;
  labourTotal: number;
  equipmentTotal: number;
  materialTotal: number;
  subcontractTotal: number;
  markupTotal: number;
  total: number;
  currency: string;
  totalLabourHours: number;
  lineCount: number;
  status: string;
  signedByName: string | null;
  signedByRole: string | null;
  signedByOrganisation: string | null;
  signedAt: string | null;
  signatureMethod: string;
  signatureLatitude: number | null;
  signatureLongitude: number | null;
  signatureDeviceId: string | null;
  signedUnderProtest: number;
  protestNote: string | null;
  refusedToSign: number;
  refusalNote: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  disputedReason: string | null;
  incorporatedChangeOrderId: string | null;
  incorporatedAt: string | null;
  createdBy: string;
  signature: SignatureEvidence;
  isSigned: boolean;
}

/**
 * The register row. `total` is the priced-SO-FAR subtotal, which is why
 * `totalsAreComplete` travels with it: a ticket with unpriced labour hours
 * has no total, and rendering the column as though it did contradicts the
 * drawer, which says so.
 */
export interface TicketListRow extends TicketRecord {
  unpricedLineCount: number;
  totalsAreComplete: boolean;
  totalNote: string | null;
}

export interface TicketDetail extends TicketRecord {
  lines: TicketLine[];
  totals: TmTotals;
  totalsAreComplete: boolean;
  verbalInstruction: {
    instructedByName: string | null;
    instructionDate: string | null;
    note: string;
  } | null;
}

export interface CostReportLine {
  budgetLineItemId: string | null;
  costCodeId: string | null;
  costCode: string | null;
  costType: string;
  description: string | null;
  revisedBudget: number | null;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
  labourCost: number | null;
  currency: string | null;
  timecards: number;
  workers: number;
  onBudget: boolean;
  reasons: string[];
}

export interface LabourCostReport {
  from: string;
  to: string;
  groupBy: string;
  lines: CostReportLine[];
  totals: {
    totalHours: number;
    onBudgetHours: number;
    offBudgetHours: number;
    uncodedHours: number;
    labourCost: number | null;
    currency: string | null;
  };
  uncodedTimecards: Array<{
    id: string;
    reference: string;
    workerId: string;
    workDate: string;
    totalHours: number;
    status: string;
  }>;
  reasons: string[];
  note: string;
}

export interface CostCodeOption {
  id: string;
  code: string;
  title: string;
  division: string | null;
  costType: string | null;
  source: "standard" | "project";
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

/* ========================================================================== */
/* Vocabulary                                                                  */
/* ========================================================================== */

export const EM_DASH = "—";
export const NOT_AVAILABLE = "Not available";
export const NOT_COMPARABLE = "Not comparable";

export const HOUR_BUCKETS = [
  "regularHours",
  "overtimeHours",
  "doubleTimeHours",
  "premiumHours",
] as const;
export type HourBucket = (typeof HOUR_BUCKETS)[number];

export const BUCKET_LABEL: Record<HourBucket | "totalHours", string> = {
  regularHours: "Plain time",
  overtimeHours: "Overtime",
  doubleTimeHours: "Double time",
  premiumHours: "Premium",
  totalHours: "Total",
};

export const TIMECARD_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  revised: "warning",
  locked: "highlight",
  exported: "highlight",
  void: "neutral",
};

export const BATCH_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  partially_approved: "warning",
  approved: "success",
  rejected: "danger",
  locked: "highlight",
  exported: "highlight",
};

export const SIGNATURE_TONE: Record<SignatureState, Tone> = {
  signed: "success",
  signed_under_protest: "warning",
  refused_to_sign: "danger",
  unsigned: "neutral",
};

export const SIGNATURE_LABEL: Record<SignatureState, string> = {
  signed: "Signed",
  signed_under_protest: "Signed under protest",
  refused_to_sign: "Refused to sign",
  unsigned: "Unsigned",
};

export const CLASSIFICATION_METHOD_LABEL: Record<HourClassificationRecord["method"], string> = {
  explicit_split: "Split supplied by hand",
  classified_from_worked_hours: "Classified from worked hours",
  classified_from_clock_times: "Classified from clock times",
};

export const PREMIUM_KIND_LABEL: Record<string, string> = {
  none: "None",
  night_shift: "Night shift",
  weekend: "Weekend",
  public_holiday: "Public holiday",
  hazard: "Hazard",
  confined_space: "Confined space",
  working_at_height: "Working at height",
  travel: "Travel",
  standby: "Standby",
  call_out: "Call out",
  shift_allowance: "Shift allowance",
  other: "Other",
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

export const LINE_KIND_LABEL: Record<string, string> = {
  labour: "Labour",
  equipment: "Equipment",
  material: "Material",
  subcontract: "Subcontract",
  markup: "Markup",
  other: "Other",
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

export function money(
  value: number | null | undefined,
  currency: string | null,
  options: { fractionDigits?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  const code = currency ?? "USD";
  try {
    return currencyFormat(code, options.fractionDigits ?? 2).format(value);
  } catch {
    return `${code} ${value.toFixed(options.fractionDigits ?? 2)}`;
  }
}

export function hoursText(value: number | null | undefined, precision = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${round2(value).toFixed(precision)} h`;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function signedHours(value: number): string {
  return `${value > 0 ? "+" : ""}${round2(value).toFixed(2)} h`;
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

export function shiftDays(iso: string, delta: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/* ========================================================================== */
/* Errors and refusals                                                         */
/* ========================================================================== */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

interface ErrorBody {
  details?: unknown;
}

function detailsOf(err: unknown): Record<string, unknown> | null {
  const body = (err as { details?: unknown } | null)?.details as ErrorBody | undefined;
  const inner = body && typeof body === "object" ? body.details : undefined;
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
}

export interface Refusal {
  status: number;
  deliberate: boolean;
  message: string;
  control: string | null;
  /** Set when the refusal RECORDED the attempt — self-approval does. */
  recorded: boolean;
  approvalId: string | null;
  /** The named bucket differences an allocation refusal carries. */
  differences: BucketDifference[];
  claimed: HourSplit | null;
  allocated: HourSplit | null;
  reasons: string[];
}

const STRUCTURED_KEYS = new Set([
  "control",
  "reasons",
  "recorded",
  "approvalId",
  "differences",
  "claimed",
  "allocated",
]);

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
      if (STRUCTURED_KEYS.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      reasons.push(`${labelize(key)}: ${String(value)}`);
    }
  }
  const differences = Array.isArray(details?.["differences"])
    ? (details["differences"] as BucketDifference[])
    : [];
  return {
    status,
    deliberate: status === 400 || status === 403 || status === 409,
    message: errorMessage(err, "The platform refused this action."),
    control: typeof details?.["control"] === "string" ? (details["control"] as string) : null,
    recorded: details?.["recorded"] === true,
    approvalId:
      typeof details?.["approvalId"] === "string" ? (details["approvalId"] as string) : null,
    differences,
    claimed: (details?.["claimed"] as HourSplit | undefined) ?? null,
    allocated: (details?.["allocated"] as HourSplit | undefined) ?? null,
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
  return { busy, refusal, clear: () => setRefusal(null), run };
}

export function useCompanyUsers(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=200")
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((user) => [user.id, user.name || user.email])));
      })
      .catch(() => {
        /* names are a courtesy; ids still render */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return byId;
}

export function actorName(users: Map<string, string>, id: string | null | undefined): string {
  if (!id) return EM_DASH;
  return users.get(id) ?? id;
}

/* ========================================================================== */
/* Allocation arithmetic — the same check the server runs                      */
/* ========================================================================== */

export interface AllocationDraft {
  key: string;
  costCodeId: string | null;
  costCode: string | null;
  costType: string;
  budgetLineItemId: string | null;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  notes: string | null;
}

export function emptyDraft(index: number): AllocationDraft {
  return {
    key: `draft-${index}-${Math.random().toString(36).slice(2, 8)}`,
    costCodeId: null,
    costCode: null,
    costType: "labour",
    budgetLineItemId: null,
    regularHours: 0,
    overtimeHours: 0,
    doubleTimeHours: 0,
    premiumHours: 0,
    notes: null,
  };
}

export function draftsFrom(allocations: readonly Allocation[]): AllocationDraft[] {
  return allocations.map((allocation, index) => ({
    key: allocation.id || `existing-${index}`,
    costCodeId: allocation.costCodeId,
    costCode: allocation.costCode,
    costType: allocation.costType,
    budgetLineItemId: allocation.budgetLineItemId,
    regularHours: allocation.regularHours,
    overtimeHours: allocation.overtimeHours,
    doubleTimeHours: allocation.doubleTimeHours,
    premiumHours: allocation.premiumHours,
    notes: allocation.notes,
  }));
}

const EPSILON = 0.005;

/**
 * The client-side mirror of `reconcileAllocations`. It exists so the person
 * coding a card sees the difference NAMED before they press save, not after
 * the server refuses. Checked per bucket rather than on the total alone,
 * because the buckets carry different rates: eight plain hours coded as eight
 * overtime hours reconciles perfectly on the total and overstates the cost
 * report by half a day's pay.
 */
export function checkDrafts(claimed: HourSplit, drafts: readonly AllocationDraft[]): AllocationCheck {
  const allocatedBuckets = {
    regularHours: 0,
    overtimeHours: 0,
    doubleTimeHours: 0,
    premiumHours: 0,
  };
  for (const draft of drafts) {
    for (const bucket of HOUR_BUCKETS) allocatedBuckets[bucket] += draft[bucket] || 0;
  }
  const allocated: HourSplit = {
    regularHours: round2(allocatedBuckets.regularHours),
    overtimeHours: round2(allocatedBuckets.overtimeHours),
    doubleTimeHours: round2(allocatedBuckets.doubleTimeHours),
    premiumHours: round2(allocatedBuckets.premiumHours),
    totalHours: round2(
      allocatedBuckets.regularHours +
        allocatedBuckets.overtimeHours +
        allocatedBuckets.doubleTimeHours +
        allocatedBuckets.premiumHours,
    ),
  };

  const differences: BucketDifference[] = [];
  for (const bucket of [...HOUR_BUCKETS, "totalHours"] as const) {
    const claimedValue = round2(claimed[bucket]);
    const allocatedValue = round2(allocated[bucket]);
    if (Math.abs(claimedValue - allocatedValue) > EPSILON) {
      differences.push({
        bucket,
        claimed: claimedValue,
        allocated: allocatedValue,
        difference: round2(allocatedValue - claimedValue),
      });
    }
  }
  if (differences.length === 0) {
    return { ok: true, claimed, allocated, differences, message: null };
  }
  const total = differences.find((entry) => entry.bucket === "totalHours");
  const headline = total
    ? `${allocated.totalHours} hour(s) allocated against ${round2(claimed.totalHours)} hour(s) claimed — ${
        total.difference > 0 ? "over" : "short"
      } by ${round2(Math.abs(total.difference))} hour(s)`
    : "the hours balance in total but not by pay treatment";
  const detail = differences
    .filter((entry) => entry.bucket !== "totalHours")
    .map(
      (entry) =>
        `${BUCKET_LABEL[entry.bucket]}: ${entry.allocated} allocated vs ${entry.claimed} claimed (${
          entry.difference > 0 ? "+" : ""
        }${entry.difference})`,
    )
    .join("; ");
  return {
    ok: false,
    claimed,
    allocated,
    differences,
    message: `Allocations do not reconcile with the timecard — ${headline}.${detail ? ` ${detail}.` : ""}`,
  };
}

export function splitOf(card: {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  premiumHours: number;
  totalHours: number;
}): HourSplit {
  return {
    regularHours: card.regularHours,
    overtimeHours: card.overtimeHours,
    doubleTimeHours: card.doubleTimeHours,
    premiumHours: card.premiumHours,
    totalHours: card.totalHours,
  };
}

/* ========================================================================== */
/* Honesty components                                                          */
/* ========================================================================== */

export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
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
 * THE component this module exists for.
 *
 * Where no site-access record exists, hours present are UNKNOWN. Rendering
 * that as zero would turn every honest card in a week with a broken turnstile
 * into a maximal overclaim — a fraud finding manufactured out of a
 * data-quality problem.
 */
export function NotComparable({
  reason,
  label = NOT_COMPARABLE,
  tone = "neutral",
}: {
  reason: string;
  label?: string;
  tone?: Tone;
}) {
  return (
    <Tooltip content={<span className="block max-w-sm">{reason}</span>}>
      <span className="inline-flex items-center gap-1">
        <Badge tone={tone} size="xs" variant="outline">
          {label}
        </Badge>
      </span>
    </Tooltip>
  );
}

/** A figure the platform could not compute, with the reasons behind it. */
export function FigureCell({
  value,
  reasons,
  render,
  label = NOT_AVAILABLE,
  className,
  reasonsBelow = false,
}: {
  value: number | null | undefined;
  reasons: readonly string[];
  render: (value: number) => ReactNode;
  label?: string;
  className?: string;
  reasonsBelow?: boolean;
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
          <span className="block max-w-sm space-y-1">
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

/**
 * The server's refusal, quoted. Where the refusal RECORDED the attempt — a
 * self-approval does — that fact is the headline, because the whole point of
 * the control is that the breach leaves evidence.
 */
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
      icon={refusal.recorded ? IconWarning : undefined}
      title={
        title ??
        (refusal.control === "no_self_approval"
          ? "Segregation of duties — the attempt has been recorded"
          : refusal.deliberate
            ? "The platform refused this — deliberately"
            : "That did not complete")
      }
      onDismiss={onDismiss}
    >
      <p>{refusal.message}</p>
      {refusal.recorded ? (
        <p className="mt-2 rounded-md border border-warning-border bg-warning-subtle px-2.5 py-1.5 text-meta text-warning-fg">
          This attempt is now on the record{refusal.approvalId ? ` as approval ${refusal.approvalId}` : ""}
          , with <span className="font-mono">isSelfApproval</span> set, a signal raised for the
          assurance layer and a ledger entry appended. A control that silently blocks a breach
          leaves no evidence the breach was attempted — this one does not.
        </p>
      ) : null}
      {refusal.differences.length > 0 ? (
        <Table dense className="mt-2" tableClassName="min-w-[380px] text-meta">
            <THead>
              <Tr>
                <Th>Bucket</Th>
                <Th align="right">Claimed</Th>
                <Th align="right">Allocated</Th>
                <Th align="right">Difference</Th>
              </Tr>
            </THead>
            <TBody>
              {refusal.differences.map((entry) => (
                <Tr key={entry.bucket}>
                  <Td>{BUCKET_LABEL[entry.bucket]}</Td>
                  <Td align="right" numeric>{entry.claimed}</Td>
                  <Td align="right" numeric>{entry.allocated}</Td>
                  <Td align="right" numeric className="font-semibold text-danger-fg">
                    {entry.difference > 0 ? "+" : ""}
                    {entry.difference}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
      ) : null}
      {refusal.control ? (
        <p className="mt-2 text-2xs text-content-muted">
          Control: <span className="font-mono">{refusal.control}</span>
        </p>
      ) : null}
      <ReasonList reasons={refusal.reasons} className="mt-2" />
    </Alert>
  );
}

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
 * WHICH RULE produced this split. A card whose hours were supplied already
 * split was NOT classified at all, and says so — it is an assertion by
 * whoever typed it, not a derivation the platform stands behind.
 */
export function RuleExplanation({
  classification,
  configured,
  className,
}: {
  classification: HourClassificationRecord | undefined;
  configured: OvertimeRule | undefined;
  className?: string;
}) {
  if (!classification) {
    return (
      <Alert tone="warning" size="sm" title="No classification record on this card" className={className}>
        This card carries no record of how its hours were split. Without it, nobody can say which
        rule produced the overtime — and the split is the difference between plain time and time
        and a half on every hour above the threshold.
      </Alert>
    );
  }
  const rule = classification.rule;
  const explicit = classification.method === "explicit_split";
  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        explicit ? "border-warning-border bg-warning-subtle" : "border-border bg-surface-sunken",
        className,
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge tone={explicit ? "warning" : "info"} size="xs" dot>
          {CLASSIFICATION_METHOD_LABEL[classification.method]}
        </Badge>
        {rule ? (
          <Badge tone="neutral" size="xs" variant="outline">
            {rule.kind === "weekly"
              ? "Weekly ladder"
              : rule.kind === "daily"
                ? "Daily ladder"
                : "No overtime"}
          </Badge>
        ) : null}
        {rule?.thresholdHours !== null && rule?.thresholdHours !== undefined ? (
          <Badge tone="neutral" size="xs" variant="outline">
            over {rule.thresholdHours} h per {rule.basis}
          </Badge>
        ) : null}
        {rule?.doubleTimeThresholdHours ? (
          <Badge tone="neutral" size="xs" variant="outline">
            double over {rule.doubleTimeThresholdHours} h
          </Badge>
        ) : null}
      </div>
      <p className={cx("text-meta", explicit ? "text-warning-fg" : "text-content-muted")}>
        {rule?.explanation ?? classification.note ?? "No explanation was recorded."}
      </p>
      {rule && explicit === false ? (
        <p className="mt-1 text-2xs text-content-subtle">
          Source: {rule.source}
          {rule.kind === "weekly"
            ? ` · this day occupied hours ${rule.cumulativeFrom}–${rule.cumulativeTo} of the pay week${
                classification.weekStart ? ` (${classification.weekStart} to ${classification.weekEnd})` : ""
              }`
            : ""}
        </p>
      ) : null}
      {explicit && classification.note ? null : null}
      {!rule && configured && configured.thresholdHours === null && configured.kind !== "none" ? (
        <p className="mt-1 text-2xs text-warning-fg">
          The crew records no overtime threshold. There is no platform-wide default and there never
          will be — 8 hours a day is Californian, 40 a week is federal, 48 a week is the Working
          Time Directive, and a crew whose agreement says none of those must not be silently costed
          under one of them.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The claimed-against-present cell. Three outcomes, never two: over, under, or
 * NOT COMPARABLE with the reason.
 */
export function VarianceCell({
  varianceHours,
  reasons,
  explained,
  toleranceHours,
}: {
  varianceHours: number | null;
  reasons: readonly string[];
  explained: boolean;
  toleranceHours?: number;
}) {
  if (varianceHours === null) {
    return (
      <NotComparable
        reason={
          reasons[0] ??
          "No site-access record exists for this worker on this date, so the hours actually present are unknown. A missing turnstile record is a gap in the evidence stream, not zero hours on site."
        }
      />
    );
  }
  const tolerance = toleranceHours ?? 0.5;
  const withinTolerance = Math.abs(varianceHours) <= tolerance + 0.005;
  if (withinTolerance) {
    return (
      <span className="tabular-nums text-content-muted">{signedHours(varianceHours)}</span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cx(
          "font-semibold tabular-nums",
          varianceHours > 0 ? "text-danger-fg" : "text-info-fg",
        )}
      >
        {signedHours(varianceHours)}
      </span>
      {varianceHours > 0 && !explained ? (
        <Tooltip content="Claimed hours exceed the hours the turnstile recorded by more than the crew's tolerance, and nobody has explained why. That is the exception this reconciliation exists to surface.">
          <span>
            <Badge tone="danger" size="xs">
              unexplained
            </Badge>
          </span>
        </Tooltip>
      ) : explained ? (
        <Badge tone="success" size="xs" variant="outline">
          explained
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * The allocation balance, stated out loud rather than trusted silently.
 * Bucket by bucket, with the difference named and its direction.
 */
export function AllocationBalance({
  check,
  emptyMessage,
  className,
}: {
  check: AllocationCheck;
  emptyMessage?: string | null;
  className?: string;
}) {
  if (emptyMessage) {
    return (
      <Alert tone="danger" size="sm" title="No cost coding on this card" className={className}>
        {emptyMessage}
      </Alert>
    );
  }
  if (check.ok) {
    return (
      <Alert tone="success" size="sm" title="Allocations reconcile with the card" className={className}>
        {round2(check.allocated.totalHours)} hour(s) coded against {round2(check.claimed.totalHours)}{" "}
        claimed, and every pay bucket agrees. These hours will land on the cost report in the
        treatment they were claimed in.
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      size="sm"
      icon={IconWarning}
      title="Allocations do not reconcile with the card"
      className={className}
    >
      <p>{check.message}</p>
      <Table dense className="mt-2" tableClassName="min-w-[380px] text-meta">
          <THead>
            <Tr>
              <Th>Bucket</Th>
              <Th align="right">Claimed</Th>
              <Th align="right">Allocated</Th>
              <Th align="right">Difference</Th>
            </Tr>
          </THead>
          <TBody>
            {check.differences.map((entry) => (
              <Tr key={entry.bucket}>
                <Td className="text-content">{BUCKET_LABEL[entry.bucket]}</Td>
                <Td align="right" numeric>{entry.claimed}</Td>
                <Td align="right" numeric>{entry.allocated}</Td>
                <Td align="right" numeric className="font-semibold text-danger-fg">
                  {entry.difference > 0 ? "+" : ""}
                  {entry.difference}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      <p className="mt-2 text-2xs">
        Checked per bucket rather than on the total alone, because the buckets carry different
        rates: eight plain hours coded as eight overtime hours reconciles perfectly on the total and
        overstates the cost report by half a day&rsquo;s pay.
      </p>
    </Alert>
  );
}

/**
 * The attempts that were refused AND RECORDED.
 *
 * `timecard_approvals.isSelfApproval` is a stored column on purpose. The
 * attempt is written first — an approval row, a signal, a ledger entry — and
 * only then refused, so this panel has something to show.
 */
export function SelfApprovalAttempts({
  approvals,
  users,
}: {
  approvals: readonly Approval[];
  users: Map<string, string>;
}) {
  const attempts = approvals.filter((approval) => approval.isSelfApproval === 1);
  if (attempts.length === 0) return null;
  return (
    <Alert
      tone="danger"
      icon={IconWarning}
      title={`${attempts.length} self-approval attempt${attempts.length === 1 ? "" : "s"} recorded on this card`}
    >
      <p>
        Approving one&rsquo;s own claimed hours is the classic labour fraud on a construction
        project: it needs no forged document and no accomplice, only an approval chain nobody
        segregated. Each attempt below was refused — and written down, which is the part that
        matters a year later.
      </p>
      <ul className="mt-2 space-y-1.5">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="rounded-md bg-surface-raised px-2.5 py-1.5 text-meta">
            <span className="font-medium text-content">{actorName(users, attempt.approverId)}</span>{" "}
            attempted to {labelize(attempt.detail?.attemptedDecision ?? attempt.decision).toLowerCase()} at
            level {attempt.level} on {dateTime(attempt.decidedAt)} —{" "}
            {attempt.detail?.breachedRelationship === "submitted_by"
              ? "they submitted this card"
              : attempt.detail?.breachedRelationship === "created_by"
                ? "they raised this card"
                : "they are a party to this card"}
            . Recorded as approval <span className="font-mono text-2xs">{attempt.id}</span> with{" "}
            <span className="font-mono text-2xs">isSelfApproval</span> set.
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/* ========================================================================== */
/* Resource hooks                                                              */
/* ========================================================================== */

export interface CardFilters {
  from: string;
  to: string;
  status: string;
  crewId: string;
  exceptions: boolean;
  unallocated: boolean;
}

export function useTimecards(
  projectId: string | undefined,
  filters: CardFilters,
  enabled: boolean,
): Loadable<TimecardListResponse> {
  const path = useMemo(() => {
    if (!enabled || !projectId) return null;
    const params = new URLSearchParams({
      page: "1",
      pageSize: "200",
      from: filters.from,
      to: filters.to,
    });
    if (filters.status) params.set("status", filters.status);
    if (filters.crewId) params.set("crewId", filters.crewId);
    if (filters.exceptions) params.set("exceptions", "true");
    if (filters.unallocated) params.set("unallocated", "true");
    return `/api/v1/projects/${projectId}/timecards?${params.toString()}`;
  }, [
    enabled,
    projectId,
    filters.from,
    filters.to,
    filters.status,
    filters.crewId,
    filters.exceptions,
    filters.unallocated,
  ]);
  return useResource<TimecardListResponse>(path);
}

export function useTimecardDetail(
  projectId: string | undefined,
  timecardId: string | null,
): Loadable<TimecardDetail> {
  return useResource<TimecardDetail>(
    projectId && timecardId ? `/api/v1/projects/${projectId}/timecards/${timecardId}` : null,
  );
}

export function useCrews(projectId: string | undefined): Loadable<ListResponse<CrewRecord>> {
  return useResource<ListResponse<CrewRecord>>(
    projectId ? `/api/v1/projects/${projectId}/crews?page=1&pageSize=200` : null,
  );
}

export function useCrewDetail(
  projectId: string | undefined,
  crewId: string | null,
  onDate: string,
): Loadable<CrewDetail> {
  return useResource<CrewDetail>(
    projectId && crewId
      ? `/api/v1/projects/${projectId}/crews/${crewId}?onDate=${onDate}`
      : null,
  );
}

export function useBatches(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<ListResponse<BatchRecord>> {
  return useResource<ListResponse<BatchRecord>>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/timecard-batches?page=1&pageSize=200`
      : null,
  );
}

export function useBatchDetail(
  projectId: string | undefined,
  batchId: string | null,
): Loadable<BatchDetail> {
  return useResource<BatchDetail>(
    projectId && batchId ? `/api/v1/projects/${projectId}/timecard-batches/${batchId}` : null,
  );
}

export function useReconciliation(
  projectId: string | undefined,
  from: string,
  to: string,
  enabled: boolean,
): Loadable<ReconciliationReport> {
  return useResource<ReconciliationReport>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/timecards/reconciliation?from=${from}&to=${to}`
      : null,
  );
}

export function useTickets(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<ListResponse<TicketListRow>> {
  return useResource<ListResponse<TicketListRow>>(
    enabled && projectId ? `/api/v1/projects/${projectId}/tm-tickets?page=1&pageSize=200` : null,
  );
}

export function useTicketDetail(
  projectId: string | undefined,
  ticketId: string | null,
): Loadable<TicketDetail> {
  return useResource<TicketDetail>(
    projectId && ticketId ? `/api/v1/projects/${projectId}/tm-tickets/${ticketId}` : null,
  );
}

export function useCostReport(
  projectId: string | undefined,
  from: string,
  to: string,
  enabled: boolean,
): Loadable<LabourCostReport> {
  return useResource<LabourCostReport>(
    enabled && projectId
      ? `/api/v1/projects/${projectId}/labour-cost-report?from=${from}&to=${to}`
      : null,
  );
}

export function useCostCodes(
  projectId: string | undefined,
  enabled: boolean,
): Loadable<{ items: CostCodeOption[]; total: number }> {
  return useResource<{ items: CostCodeOption[]; total: number }>(
    enabled && projectId ? `/api/v1/projects/${projectId}/cost-codes` : null,
  );
}
