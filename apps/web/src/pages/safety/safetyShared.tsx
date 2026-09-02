/**
 * Shared vocabulary for the SAFETY workspace — spec Vol I §2.11 / module M21.
 *
 * Every type below mirrors a response shape produced by
 * apps/api/src/modules/safety (index.ts + reportability.ts + rates.ts +
 * scoring.ts). Nothing here invents a field and nothing here recomputes a
 * figure the API already computed — least of all a rate.
 *
 * THREE HONESTY RULES, ENFORCED BY THE COMPONENTS AT THE BOTTOM OF THIS FILE
 *
 *  1. A RATE WITH NO DENOMINATOR IS NOT A RATE. `computeSafetyRates` returns
 *     `{ value: null, reasons: [...] }` when exposure hours are unavailable.
 *     `<RateValue>` prints "Not available" and the reasons VERBATIM. It never
 *     prints 0.00 — a TRIR of 0.00 goes into a prequalification questionnaire
 *     and is relied on, and one computed against an invented denominator is a
 *     misrepresentation rather than an approximation.
 *
 *  2. A DETERMINATION THAT NEEDS A HUMAN IS NOT A DETERMINATION. Where
 *     `needsHumanReview` is true the reportability engine could not decide a
 *     rule on the facts held. `<ReportabilityPanel>` renders that as an open
 *     question with the rule's own basis lines, never as "not reportable".
 *
 *  3. A DEADLINE IS A CLOCK, NOT A DATE. A reportable incident carries a
 *     statutory notification deadline. `<NotificationCountdown>` counts it
 *     down live and changes register the moment it passes, because the
 *     consequence of passing it is an offence and not a late field.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AcknowledgementMethod,
  ActionEffectivenessVerdict,
  BodyPart,
  CorrectiveActionKind,
  CorrectiveActionSource,
  CorrectiveActionStatus,
  HierarchyOfControl,
  IncidentInvestigationStatus,
  IncidentMechanism,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  InjuredPersonType,
  InjuryNature,
  InjuryTreatmentLevel,
  InspectionResult,
  OshaCaseType,
  ReportableRegime,
  RiddorCategory,
  RootCauseMethod,
  SafetyCategory,
  SafetyInspectionStatus,
  SafetyInspectionType,
  SafetyObservationKind,
  SafetyObservationStatus,
  SafetyProgrammeRecordKind,
  SafetyProgrammeRecordStatus,
  SafetySeverity,
  ToolboxTalkStatus,
} from "@constructos/shared";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, Tooltip, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";

/* ========================================================================== */
/* Wire shapes                                                                 */
/* ========================================================================== */

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** scoring.ts — `RiskScore`. Present only when BOTH axes were scored. */
export interface RiskScore {
  likelihood: number;
  severity: number;
  score: number;
  band: "low" | "medium" | "high" | "critical";
  label: string;
  guidance: string;
}

export interface SafetyObservation {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  kind: SafetyObservationKind;
  category: SafetyCategory;
  severity: SafetySeverity;
  title: string;
  description: string | null;
  observedAt: string;
  locationText: string | null;
  vendorId: string | null;
  trade: string | null;
  workerId: string | null;
  riskLikelihood: number | null;
  riskSeverity: number | null;
  riskScore: number | null;
  immediateActionTaken: string | null;
  workStopped: boolean;
  workResumedAt: string | null;
  status: SafetyObservationStatus;
  assigneeId: string | null;
  dueDate: string | null;
  photoFileIds: string[];
  relatedIncidentId: string | null;
  openActionCount: number;
  closedBy: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateObservation */
  risk: RiskScore | null;
  riskReasons: string[];
  isOverdue: boolean;
  daysOverdue: number | null;
  workStoppedAndNotResumed: boolean;
}

export interface ObservationDetail extends SafetyObservation {
  actions: CorrectiveAction[];
}

/** reportability.ts — `RuleDeadline`. */
export interface RuleDeadline {
  dueAt: string;
  clockStartsAt: string;
  clockStartsFrom: string;
  withinHours: number;
  withinLabel: string;
  immediateNotificationRequired: boolean;
  notificationMethod: string;
}

/** reportability.ts — `RuleDetermination`. One statutory test, and its verdict. */
export interface RuleDetermination {
  ruleId: string;
  regime: ReportableRegime;
  jurisdiction: string;
  authority: string;
  title: string;
  citation: string;
  outcome: "met" | "not_met" | "indeterminate";
  basis: string[];
  needsHumanReview: boolean;
  openQuestion: string | null;
  deadline: RuleDeadline | null;
  isRecordingDutyOnly: boolean;
  riddorCategory: RiddorCategory | null;
  oshaCaseType: OshaCaseType | null;
  consequenceIfMissed: string;
}

/** reportability.ts — `ReportabilityDetermination`. */
export interface ReportabilityDetermination {
  isReportable: boolean;
  needsHumanReview: boolean;
  regimes: ReportableRegime[];
  assessedRegimes: ReportableRegime[];
  riddorCategory: RiddorCategory;
  oshaCaseType: OshaCaseType;
  reportDueAt: string | null;
  governingRuleId: string | null;
  rules: RuleDetermination[];
  metRuleIds: string[];
  indeterminateRuleIds: string[];
  openQuestions: string[];
  reasons: string[];
  disclaimer: string;
}

export interface IncidentNotification {
  required: boolean;
  regimes: ReportableRegime[];
  riddorCategory: RiddorCategory | null;
  oshaCaseType: OshaCaseType | null;
  dueAt: string | null;
  notifiedAt: string | null;
  notifiedBy: string | null;
  reference: string | null;
  notifications: Array<{
    regime?: string;
    notifiedAt?: string;
    reference?: string | null;
    method?: string;
  }>;
  missed: boolean;
  hoursRemaining: number | null;
  obligationId: string | null;
  needsHumanReview: boolean | null;
  openQuestions: string[];
  /**
   * One entry per regime. An incident answerable to two authorities owes two
   * duties on two clocks, and a single "notified" flag is how the second one
   * disappears off the register.
   */
  duties: RegimeDutyState[];
  outstandingRegimes: string[];
  missedRegimes: string[];
  allDischarged: boolean;
  reasons: string[];
}

export interface RegimeDutyState {
  regime: string;
  ruleId: string | null;
  title: string;
  citation: string | null;
  authority: string | null;
  dueAt: string | null;
  immediateNotificationRequired: boolean;
  notificationMethod: string | null;
  consequenceIfMissed: string | null;
  state: "not_required" | "outstanding" | "notified" | "notified_late" | "missed";
  notifiedAt: string | null;
  reference: string | null;
  method: string | null;
  hoursLate: number | null;
  hoursRemaining: number | null;
}

export interface IncidentInvestigation {
  status: IncidentInvestigationStatus;
  leadId: string | null;
  dueDate: string | null;
  isOverdue: boolean;
  daysOverdue: number | null;
  startedAt: string | null;
  completedAt: string | null;
  rootCauseMethod: RootCauseMethod;
  rootCause: string | null;
  contributingFactors: Array<{ factor?: string; category?: string; note?: string }>;
  findings: string | null;
  reportFileId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface Witness {
  name?: string;
  organisation?: string | null;
  contact?: string | null;
  statementFileId?: string | null;
}

export interface SafetyIncident {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  incidentType: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  occurredAt: string;
  discoveredAt: string | null;
  reportedAt: string | null;
  reportingDelayHours: number | null;
  hoursIntoShift: number | null;
  shift: string | null;
  locationText: string | null;
  weatherConditions: string | null;
  lightingConditions: string | null;
  activityAtTime: string | null;
  workerId: string | null;
  injuredPersonName: string | null;
  injuredPersonType: InjuredPersonType | null;
  vendorId: string | null;
  injuredPersonTrade: string | null;
  injuredPersonAge: number | null;
  yearsExperience: number | null;
  daysSinceInduction: number | null;
  treatmentLevel: InjuryTreatmentLevel | null;
  bodyPart: BodyPart | null;
  additionalBodyParts: string[];
  injuryNature: InjuryNature | null;
  mechanism: IncidentMechanism | null;
  treatmentProvider: string | null;
  hospitalName: string | null;
  isLostTime: boolean;
  lostTimeDays: number | null;
  restrictedDutyDays: number | null;
  returnToWorkDate: string | null;
  isFatality: boolean;
  propertyDamageDescription: string | null;
  environmentalReleaseDescription: string | null;
  thirdPartyInvolved: boolean;
  thirdPartyDetail: string | null;
  immediateCause: string | null;
  immediateActionTaken: string | null;
  workStopped: boolean;
  workResumedAt: string | null;
  emergencyServicesAttended: boolean;
  witnesses: Witness[];
  witnessCount: number;
  isReportable: boolean;
  reportableRegimes: ReportableRegime[];
  riddorCategory: RiddorCategory | null;
  oshaCaseType: OshaCaseType | null;
  reportDueAt: string | null;
  regulatorNotifiedAt: string | null;
  regulatorReference: string | null;
  regulatorVisitExpected: boolean;
  enforcementNoticeReceived: boolean;
  isInsurableClaim: boolean;
  estimatedCost: number | null;
  actualCost: number | null;
  currency: string;
  status: IncidentStatus;
  openActionCount: number;
  isConfidential: boolean;
  reopenedCount: number;
  createdBy: string;
  reportedBy: string | null;
  approvedBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
  /** decorateIncident */
  reportingDelay: { hours: number | null; reasons: string[] } | null;
  /**
   * The injured person's name, resolved by the API from the WORKER register.
   *
   * `workerId` points at workforce.workers, not at the company user directory,
   * so resolving it through the user map printed a raw `wrk_` id in the column
   * an inspector reads first. The API resolves it once per response.
   */
  injuredPersonDisplayName: string | null;
  reportability: ReportabilityDetermination | null;
  notification: IncidentNotification;
  investigation: IncidentInvestigation;
}

export interface BriefingRef {
  id: string;
  reference: string;
  title: string;
  talkDate: string;
  attendeeCount: number;
  status: ToolboxTalkStatus;
}

export interface IncidentDetail extends SafetyIncident {
  actions: CorrectiveAction[];
  briefings: BriefingRef[];
}

export interface ReportabilityResponse {
  incidentId: string;
  reference: string;
  stored: {
    isReportable: boolean;
    regimes: ReportableRegime[];
    riddorCategory: RiddorCategory | null;
    oshaCaseType: OshaCaseType | null;
    reportDueAt: string | null;
    obligationId: string | null;
  };
  current: ReportabilityDetermination;
  regimeBasis: string[];
  facts: Record<string, unknown>;
}

export interface CorrectiveAction {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  sourceType: CorrectiveActionSource;
  sourceId: string;
  sourceReference: string | null;
  title: string;
  description: string | null;
  actionKind: CorrectiveActionKind;
  hierarchyOfControl: HierarchyOfControl | null;
  category: SafetyCategory | null;
  priority: "low" | "medium" | "high" | "critical";
  status: CorrectiveActionStatus;
  ownerId: string | null;
  ownerVendorId: string | null;
  ownerName: string | null;
  dueDate: string;
  originalDueDate: string | null;
  revisedCount: number;
  completedAt: string | null;
  completedBy: string | null;
  completionNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationMethod: string | null;
  effectivenessCheckDate: string | null;
  effectivenessVerdict: ActionEffectivenessVerdict;
  effectivenessCheckedBy: string | null;
  effectivenessNote: string | null;
  costToImplement: number | null;
  currency: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateAction */
  isOverdue: boolean;
  daysOverdue: number | null;
  effectivenessOutstanding: boolean;
  isWeakControl: boolean;
  canClose: boolean;
}

export interface HierarchyProfile {
  counts: Record<string, number>;
  unrecorded: number;
  total: number;
  weakControlShare: number | null;
  reasons: string[];
}

export interface ActionListResponse extends Paged<CorrectiveAction> {
  hierarchyProfile: HierarchyProfile;
}

export interface TemplateItemSpec {
  id: string;
  section?: string | null;
  position?: number | null;
  text: string;
  itemType: string;
  required?: boolean;
  options?: string[] | null;
  guidance?: string | null;
  weight?: number | null;
  isCritical?: boolean;
  photoRequired?: boolean;
}

export interface InspectionTemplate {
  id: string;
  projectId: string | null;
  reference: string;
  name: string;
  description: string | null;
  inspectionType: SafetyInspectionType;
  version: number;
  status: "draft" | "active" | "retired";
  items: TemplateItemSpec[];
  itemCount: number;
  scoringMethod: string;
  passThreshold: number | null;
  frequency: string;
  regulatoryBasis: string | null;
  isStatutory: boolean;
  appliesToTrades: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateTemplate */
  criticalItemCount?: number;
  isUsable?: boolean;
}

export interface InspectionResponseRow {
  itemId?: string;
  response?: string | null;
  numericValue?: number | null;
  isPass?: boolean | null;
  note?: string | null;
  photoFileIds?: string[];
  actionId?: string | null;
}

export interface SafetyInspection {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  templateId: string | null;
  templateVersion: number | null;
  title: string;
  inspectionType: SafetyInspectionType;
  status: SafetyInspectionStatus;
  scheduledFor: string | null;
  performedAt: string | null;
  locationText: string | null;
  vendorId: string | null;
  inspectorId: string | null;
  inspectorName: string | null;
  accompaniedBy: Array<{ userId?: string | null; name?: string; organisation?: string | null }>;
  responses: InspectionResponseRow[];
  score: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  result: InspectionResult | null;
  defectCount: number;
  criticalDefectCount: number;
  openActionCount: number;
  isStatutory: boolean;
  nextDueDate: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateInspection */
  reInspectionOverdue: boolean;
  daysOverdue: number | null;
}

export interface InspectionDetail extends SafetyInspection {
  template: InspectionTemplate | null;
  actions: CorrectiveAction[];
}

export interface ToolboxTalk {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  topic: string | null;
  category: SafetyCategory;
  talkDate: string;
  startTime: string | null;
  durationMinutes: number | null;
  locationText: string | null;
  presenterId: string | null;
  presenterName: string | null;
  vendorId: string | null;
  contentSummary: string | null;
  language: string | null;
  interpreterUsed: boolean;
  attendeeCount: number;
  expectedAttendeeCount: number | null;
  relatedIncidentId: string | null;
  relatedObservationId: string | null;
  status: ToolboxTalkStatus;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateTalk */
  attendanceShortfall: number | null;
}

export interface TalkAttendee {
  id: string;
  talkId: string;
  workerId: string | null;
  userId: string | null;
  name: string;
  vendorId: string | null;
  trade: string | null;
  acknowledgementMethod: AcknowledgementMethod;
  signedAt: string | null;
  comprehensionChecked: boolean;
  comprehensionNote: string | null;
}

export interface TalkDetail extends ToolboxTalk {
  attendees: TalkAttendee[];
  comprehensionCheckedCount: number;
  registeredWorkerCount: number;
}

export interface ProgrammeRecord {
  id: string;
  projectId: string | null;
  number: number;
  reference: string;
  recordKind: SafetyProgrammeRecordKind;
  title: string;
  description: string | null;
  version: string | null;
  status: SafetyProgrammeRecordStatus;
  documentFileId: string | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  reviewDueDate: string | null;
  reviewIntervalMonths: number | null;
  ownerId: string | null;
  vendorId: string | null;
  workerId: string | null;
  appliesToTrades: string[];
  regulatoryReference: string | null;
  categories: string[];
  acknowledgementCount: number;
  requiredAcknowledgementCount: number | null;
  supersedesId: string | null;
  supersededById: string | null;
  obligationId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** decorateRecord */
  isExpired: boolean;
  daysToExpiry: number | null;
  reviewOverdue: boolean;
  acknowledgementShortfall: number | null;
  isCriticalKind: boolean;
  /**
   * Who has confirmed they read it, and — the field that matters after an
   * incident — whether they confirmed it themselves or somebody recorded it
   * on their behalf.
   */
  acknowledgements?: Acknowledgement[];
}

export interface Acknowledgement {
  workerId: string | null;
  userId: string | null;
  acknowledgedAt: string;
  method: string;
  recordedBy?: string | null;
  selfRecorded?: boolean;
  recordedOnBehalf?: { by: string; role: string | null } | null;
  attestation?: string | null;
}

/* --- rates.ts ------------------------------------------------------------- */

export interface ExposureHours {
  hours: number | null;
  source: "timecards" | "site_access" | null;
  inputs: {
    timecardHours: number | null;
    timecardCount: number;
    siteAccessHours: number | null;
    siteAccessCount: number;
    from: string;
    to: string;
  };
  reasons: string[];
}

export interface RateCounts {
  recordableCases: number;
  lostTimeCases: number;
  dartCases: number;
  fatalities: number;
  daysLost: number;
  allInjuries: number;
  nearMisses: number;
  underAssessment: number;
}

export interface SafetyRate {
  key: string;
  name: string;
  /** null when the denominator is unavailable — never fabricated */
  value: number | null;
  unit: string;
  basis: string;
  formula: string;
  numerator: number;
  denominatorHours: number | null;
  inputs: Record<string, unknown>;
  reasons: string[];
  note: string | null;
}

export interface SafetyStatistics {
  projectId: string;
  from: string;
  to: string;
  exposure: ExposureHours;
  counts: RateCounts;
  rates: SafetyRate[];
  incomputable: string[];
  ratios: { nearMissToInjury: number | null; reasons: string[] };
  caveats: string[];
  reportable: StatutoryStanding;
  leadingIndicators: {
    observationsPositive: number;
    observationsNegative: number;
    positiveShare: number | null;
    reasons: string[];
  };
  honesty: string | null;
}

export interface Tally {
  byStatus: Record<string, number>;
  total: number;
}

export interface StatutoryRef {
  id: string;
  reference: string;
  regimes?: string[];
}

/**
 * The standing of the statutory duties across a whole register, counted per
 * DUTY. The workspace header is driven from this rather than from the rows on
 * screen: a filter that hides the offending incident must not take a live
 * statutory warning off the workspace.
 */
export interface StatutoryStanding {
  reportableCount: number;
  notifiedCount: number;
  awaitingNotification: number;
  missedNotification: number;
  outstandingDuties: number;
  missedDuties: number;
  needsHumanReview: number;
  missedRefs: StatutoryRef[];
  awaitingRefs: StatutoryRef[];
  reviewRefs: StatutoryRef[];
  note: string;
}

export interface SafetySummary {
  projectId: string;
  asOf: string;
  /** unfiltered and unwindowed — what the header banners are driven from */
  statutory: StatutoryStanding;
  observations: Tally;
  incidents: Tally;
  correctiveActions: Tally & { overdue: number; awaitingEffectivenessCheck: number };
  inspections: Tally;
  toolboxTalks: Tally;
  programmeRecords: Tally;
  obligations: { total: number; byStatus: Record<string, number>; note: string };
  signals: {
    total: number;
    open: number;
    byDetector: Record<string, number>;
    detectors: readonly string[];
  };
}

export interface RuleCatalogueEntry {
  ruleId: string;
  regime: ReportableRegime;
  jurisdiction: string;
  title: string;
  citation: string;
  isRecordingDutyOnly: boolean;
}

export interface RuleCatalogue {
  rules: RuleCatalogueEntry[];
  riddorSchedule2Classes: Array<{ key: string; label: string }>;
  hospitalAdmissions: readonly string[];
  note: string;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

export interface VendorRef {
  id: string;
  name: string;
}

/* ========================================================================== */
/* Errors                                                                      */
/* ========================================================================== */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

interface ErrorBody {
  message?: string;
  details?: unknown;
}

export function errorDetails(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details as ErrorBody | undefined;
  const details = body?.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return null;
}

/** `details.reasons`, verbatim. Empty when the refusal carried none. */
export function errorReasons(err: unknown): string[] {
  const raw = errorDetails(err)?.["reasons"];
  return Array.isArray(raw) ? raw.map((r) => String(r)) : [];
}

export interface Refusal {
  title: string;
  message: string;
  reasons: string[];
}

/** 400/403/409 are the controls working. Anything else is a fault. */
export const isRefusal = (err: unknown): boolean =>
  err instanceof ApiClientError && (err.status === 400 || err.status === 403 || err.status === 409);

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

export const NOT_AVAILABLE = "Not available";
export const EM_DASH = "—";

export function labelize(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function decimal(n: number | null | undefined, precision = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
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
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Money in ONE currency. There is no overload that takes a mixed list. */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ========================================================================== */
/* Domain labels + tones                                                       */
/* ========================================================================== */

export const OBSERVATION_STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  action_assigned: "info",
  actioned: "accent",
  verified: "success",
  closed: "neutral",
  void: "neutral",
};

export const INCIDENT_STATUS_TONE: Record<string, Tone> = {
  reported: "warning",
  under_investigation: "info",
  actions_open: "accent",
  pending_closure: "info",
  closed: "neutral",
  reopened: "danger",
  void: "neutral",
};

export const INCIDENT_SEVERITY_TONE: Record<string, Tone> = {
  negligible: "neutral",
  minor: "info",
  serious: "warning",
  major: "danger",
  catastrophic: "danger",
};

export const SAFETY_SEVERITY_TONE: Record<string, Tone> = {
  informational: "neutral",
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const ACTION_STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  in_progress: "info",
  completed: "accent",
  verified: "success",
  closed: "neutral",
  cancelled: "neutral",
};

export const EFFECTIVENESS_TONE: Record<string, Tone> = {
  pending: "warning",
  effective: "success",
  partially_effective: "warning",
  not_effective: "danger",
};

export const INSPECTION_STATUS_TONE: Record<string, Tone> = {
  scheduled: "neutral",
  in_progress: "info",
  complete: "accent",
  overdue: "danger",
  reviewed: "success",
  closed: "neutral",
  void: "neutral",
};

export const INSPECTION_RESULT_TONE: Record<string, Tone> = {
  pass: "success",
  pass_with_observations: "warning",
  fail: "danger",
  not_applicable: "neutral",
};

export const TALK_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  delivered: "info",
  verified: "success",
  cancelled: "neutral",
};

export const RECORD_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  in_review: "info",
  approved: "accent",
  active: "success",
  expired: "danger",
  superseded: "neutral",
  withdrawn: "neutral",
};

export const RISK_BAND_TONE: Record<string, Tone> = {
  low: "success",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const INVESTIGATION_STATUS_TONE: Record<string, Tone> = {
  not_started: "danger",
  in_progress: "warning",
  under_review: "info",
  complete: "success",
  reopened: "danger",
};

/**
 * The hierarchy of control, ordered by DURABILITY. The order is the point:
 * eliminating a hazard and retraining an operative are both "actions", and a
 * register that does not say which was chosen cannot tell you whether the
 * programme is engineering hazards out or issuing another briefing.
 */
export const HIERARCHY_ORDER: HierarchyOfControl[] = [
  "elimination",
  "substitution",
  "engineering",
  "isolation",
  "administrative",
  "ppe",
];

export const HIERARCHY_LABEL: Record<HierarchyOfControl, string> = {
  elimination: "Elimination",
  substitution: "Substitution",
  engineering: "Engineering control",
  isolation: "Isolation / separation",
  administrative: "Administrative",
  ppe: "PPE",
};

export const HIERARCHY_HINT: Record<HierarchyOfControl, string> = {
  elimination:
    "The hazard is removed from the job. Nothing has to be done correctly afterwards for the control to hold.",
  substitution:
    "The hazard is replaced by a less dangerous one. The residual risk is lower for everyone, permanently.",
  engineering:
    "The hazard remains but is contained by a physical measure — a guard, an edge protection system, extraction.",
  isolation:
    "People and the hazard are separated in space or in time. It holds as long as the separation is maintained.",
  administrative:
    "A procedure, a briefing, a permit, a retraining. It depends on a person behaving correctly every time.",
  ppe: "The last line. It protects one person, only when worn, only if it fits, and only from what it was chosen for.",
};

/** Everything below `isolation` depends on a person getting it right each time. */
export const HIERARCHY_TONE: Record<HierarchyOfControl, Tone> = {
  elimination: "success",
  substitution: "success",
  engineering: "accent",
  isolation: "info",
  administrative: "warning",
  ppe: "danger",
};

export const REGIME_LABEL: Record<string, string> = {
  riddor: "RIDDOR 2013 (GB)",
  osha: "29 CFR 1904 (US)",
  eu_framework: "EU framework directive",
  ilo: "ILO",
  environment_agency: "Environment agency",
  local_authority: "Local authority",
  client_specific: "Client-specific",
  insurer: "Insurer",
  none: "None",
};

export const RULE_OUTCOME_TONE: Record<string, Tone> = {
  met: "danger",
  not_met: "neutral",
  indeterminate: "warning",
};

export const RULE_OUTCOME_LABEL: Record<string, string> = {
  met: "Test met — reportable",
  not_met: "Test not met",
  indeterminate: "Cannot be decided on the facts held",
};

export const SOURCE_LABEL: Record<string, string> = {
  incident: "Incident",
  observation: "Observation",
  inspection: "Inspection",
  toolbox_talk: "Toolbox talk",
  audit: "Audit",
  ncr: "Quality NCR",
  risk_assessment: "Risk assessment",
  meeting_action: "Meeting action",
  regulator_notice: "Regulator notice",
  insurer_recommendation: "Insurer recommendation",
};

export const SAFETY_DETECTOR_LABEL: Record<string, string> = {
  safety_notification_deadline_missed: "Statutory notification deadline missed",
  safety_corrective_action_overdue: "Corrective action overdue",
  safety_statutory_inspection_overdue: "Statutory re-inspection overdue",
  safety_programme_record_expired: "Programme record expired",
  safety_investigation_overdue: "Investigation overdue",
};

/* ========================================================================== */
/* Data loading                                                                */
/* ========================================================================== */

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * One loader for the whole workspace. A failed load is NEVER rendered as an
 * empty register — "nothing happened here" and "we could not ask" are very
 * different statements about a project's safety record.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef.current(controller.signal).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded"));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

export function useCompanyUsers(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<Paged<CompanyUser>>("/api/v1/company/users?page=1&pageSize=200")
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((u) => [u.id, u.name || u.email])));
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

export function useVendors(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<Paged<VendorRef>>("/api/v1/vendors?page=1&pageSize=200")
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((v) => [v.id, v.name])));
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

/** Actor id → name, falling back to the id so a row is never blank. */
export function nameOf(map: Map<string, string>, id: string | null | undefined): string {
  if (!id) return EM_DASH;
  return map.get(id) ?? id;
}

/**
 * A ticking clock, for anything whose meaning changes as time passes.
 *
 * One interval is shared by every subscriber on the same cadence, because a
 * register of eighty reportable incidents would otherwise open eighty timers
 * to draw eighty countdowns of the same second.
 */
const tickers = new Map<number, { listeners: Set<(now: number) => void>; handle: number }>();

function subscribeToTick(intervalMs: number, listener: (now: number) => void): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const listeners = new Set<(now: number) => void>();
    const handle = window.setInterval(() => {
      const now = Date.now();
      for (const fn of listeners) fn(now);
    }, intervalMs);
    ticker = { listeners, handle };
    tickers.set(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    const current = tickers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      window.clearInterval(current.handle);
      tickers.delete(intervalMs);
    }
  };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeToTick(intervalMs, setNow), [intervalMs]);
  return now;
}

/** Mutation runner that keeps the server's own refusal wording intact. */
export function useMutation(onDone: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, refusalTitle: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setRefusal(null);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      if (isRefusal(err)) {
        setRefusal({
          title: refusalTitle,
          message: errorMessage(err, "The platform refused this action."),
          reasons: errorReasons(err),
        });
      } else {
        setError(errorMessage(err, "That action could not be completed"));
      }
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    refusal,
    error,
    run,
    clear: () => {
      setRefusal(null);
      setError(null);
    },
  };
}

/* ========================================================================== */
/* Honesty components                                                          */
/* ========================================================================== */

/**
 * The server's reasons, quoted. They name the exact platform records that are
 * absent ("No timecard hours are recorded for 2025-08-31 → 2026-08-31"), and
 * paraphrasing them costs the reader the only thing that makes the gap
 * actionable.
 */
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

/** A failed load, named and retryable. Never rendered as "no incidents". */
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
 * A refusal the platform is SUPPOSED to make — an incident closed with a live
 * statutory duty on it, an investigation signed off by its own lead, an
 * action verified by the person who completed it. It is the control working,
 * so it is presented as a rule, in the server's own words.
 */
export function RefusalNotice({ refusal, onDismiss }: { refusal: Refusal; onDismiss?: () => void }) {
  return (
    <Alert tone="warning" title={refusal.title} onDismiss={onDismiss}>
      <p>{refusal.message}</p>
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
 * A published safety rate, rendered honestly.
 *
 * The whole reason this component exists is the case where `value` is null.
 * TRIR, DART, LTIFR and the severity rate all divide by HOURS ACTUALLY
 * WORKED. When the platform holds no timecards and no turnstile record for
 * the window, there is no denominator, and a figure printed anyway would be a
 * fabrication that ends up in a prequalification questionnaire. So the tile
 * prints "Not available", the numerator it DOES hold, and the API's reasons
 * word for word.
 */
export function RateTile({ rate }: { rate: SafetyRate }) {
  const unavailable = rate.value === null;
  return (
    <Card variant={unavailable ? "sunken" : "raised"} className="h-full">
      <CardBody className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <span className="text-label uppercase text-content-subtle">{rate.name}</span>
          {unavailable ? (
            <Badge tone="warning" size="xs" variant="outline">
              No denominator
            </Badge>
          ) : null}
        </div>

        {unavailable ? (
          <p className="text-lg font-semibold text-content-muted">{NOT_AVAILABLE}</p>
        ) : (
          <p className="text-display-xs font-semibold tabular-nums text-content">
            {decimal(rate.value)}
          </p>
        )}

        <p className="text-2xs text-content-subtle">{rate.basis}</p>

        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-content-muted">
          <div className="flex gap-1">
            <dt className="text-content-subtle">Numerator</dt>
            <dd className="tabular-nums text-content">{count(rate.numerator)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-content-subtle">Hours worked</dt>
            <dd className="tabular-nums text-content">
              {rate.denominatorHours === null ? NOT_AVAILABLE : count(rate.denominatorHours)}
            </dd>
          </div>
        </dl>

        <p className="text-2xs text-content-subtle">
          <span className="font-medium text-content-muted">Formula</span> · {rate.formula}
        </p>

        {unavailable ? (
          <div className="mt-auto rounded-md border border-warning-border bg-warning-subtle/50 p-2">
            <p className="text-2xs font-semibold uppercase tracking-wide text-warning-fg">
              Why there is no figure
            </p>
            <ReasonList reasons={rate.reasons} className="mt-1" />
          </div>
        ) : rate.note ? (
          <p className="mt-auto text-2xs text-content-subtle">{rate.note}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * The observation risk score, or the reason there is not one. A 5×5 matrix
 * with one axis unscored produces no number at all here — a blank cell is
 * honest, a "0" would not be.
 */
export function RiskBadge({
  risk,
  reasons,
  size = "sm",
}: {
  risk: RiskScore | null;
  reasons: readonly string[];
  size?: "xs" | "sm";
}) {
  if (!risk) {
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
            "Neither risk axis was scored, so no 5×5 score exists for this observation."
          )
        }
      >
        <span>
          <Badge tone="neutral" size={size} variant="outline">
            Not scored
          </Badge>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={<span className="block max-w-xs">{risk.guidance}</span>}>
      <span>
        <Badge tone={RISK_BAND_TONE[risk.band] ?? "neutral"} size={size} dot>
          {risk.score} · {labelize(risk.band)}
        </Badge>
      </span>
    </Tooltip>
  );
}

/** The hierarchy-of-control choice, always shown with what it costs to rely on. */
export function HierarchyBadge({
  value,
  size = "xs",
}: {
  value: HierarchyOfControl | null;
  size?: "xs" | "sm";
}) {
  if (!value) {
    return (
      <Tooltip content="No control level was recorded, so this action cannot be weighed against any other in the register.">
        <span>
          <Badge tone="neutral" size={size} variant="outline">
            Not recorded
          </Badge>
        </span>
      </Tooltip>
    );
  }
  const rank = HIERARCHY_ORDER.indexOf(value) + 1;
  return (
    <Tooltip content={<span className="block max-w-xs">{HIERARCHY_HINT[value]}</span>}>
      <span>
        <Badge tone={HIERARCHY_TONE[value]} size={size} variant="outline">
          {rank}. {HIERARCHY_LABEL[value]}
        </Badge>
      </span>
    </Tooltip>
  );
}

/* ========================================================================== */
/* The notification clock                                                      */
/* ========================================================================== */

export interface CountdownState {
  /** ms remaining; negative once the deadline has passed */
  remainingMs: number;
  passed: boolean;
  /** "2 days 04:11:38" / "04:11:38" */
  text: string;
  tone: Tone;
  /** under 24h and still running */
  urgent: boolean;
}

export function countdownFrom(dueAt: string, now: number): CountdownState {
  const due = Date.parse(dueAt);
  const remainingMs = Number.isNaN(due) ? 0 : due - now;
  const passed = remainingMs <= 0;
  const abs = Math.abs(remainingMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
  const text = days > 0 ? `${days}d ${clock}` : clock;
  const urgent = !passed && remainingMs < 24 * 3_600_000;
  return {
    remainingMs,
    passed,
    text,
    tone: passed ? "danger" : urgent ? "warning" : "info",
    urgent,
  };
}

/**
 * The live statutory clock.
 *
 * Before the deadline it is a countdown. The moment it passes it stops being
 * a countdown and becomes a statement that a statutory duty was missed — a
 * different colour, a different verb, and a running count of how long the
 * breach has stood. This is deliberate: a notification deadline that quietly
 * turns into "overdue by 3 days" in a grey cell is how a RIDDOR report gets
 * filed a fortnight late.
 */
export function NotificationCountdown({
  dueAt,
  notifiedAt,
  size = "md",
}: {
  dueAt: string | null;
  notifiedAt: string | null;
  size?: "sm" | "md";
}) {
  const now = useNow(1000);
  const state = useMemo(() => (dueAt ? countdownFrom(dueAt, now) : null), [dueAt, now]);

  if (notifiedAt) {
    const late = dueAt !== null && Date.parse(notifiedAt) > Date.parse(dueAt);
    return (
      <Badge tone={late ? "danger" : "success"} size={size === "sm" ? "xs" : "sm"} dot>
        {late ? "Notified late" : "Notified"} · {dateTime(notifiedAt)}
      </Badge>
    );
  }

  if (!state || !dueAt) {
    return (
      <Badge tone="neutral" size={size === "sm" ? "xs" : "sm"} variant="outline">
        No deadline computed
      </Badge>
    );
  }

  if (size === "sm") {
    return (
      <Badge tone={state.tone} size="xs" dot>
        {state.passed ? `Missed by ${state.text}` : `${state.text} left`}
      </Badge>
    );
  }

  return (
    <div
      className={cx(
        "rounded-lg border px-3 py-2",
        state.passed
          ? "border-danger-border bg-danger-subtle"
          : state.urgent
            ? "border-warning-border bg-warning-subtle"
            : "border-info-border bg-info-subtle",
      )}
    >
      <p
        className={cx(
          "text-label uppercase",
          state.passed ? "text-danger-fg" : state.urgent ? "text-warning-fg" : "text-info-fg",
        )}
      >
        {state.passed ? "Statutory deadline passed" : "Time left to notify"}
      </p>
      <p
        className={cx(
          "mt-0.5 font-semibold tabular-nums",
          state.passed ? "text-2xl text-danger-fg" : "text-xl text-content",
        )}
      >
        {state.passed ? `− ${state.text}` : state.text}
      </p>
      <p className="mt-0.5 text-2xs text-content-muted">
        {state.passed ? "Deadline was " : "Due "}
        {dateTime(dueAt)}
      </p>
    </div>
  );
}

/* ========================================================================== */
/* Reportability                                                               */
/* ========================================================================== */

/**
 * One statutory test and what it concluded, with its citation.
 *
 * `indeterminate` is rendered as a QUESTION, not as a negative result. The
 * engine could not decide the rule on the facts held; presenting that as "not
 * reportable" would be the single most dangerous thing this screen could do.
 */
export function RuleCard({ rule }: { rule: RuleDetermination }) {
  const tone = RULE_OUTCOME_TONE[rule.outcome] ?? "neutral";
  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        rule.outcome === "met"
          ? "border-danger-border bg-danger-subtle/40"
          : rule.outcome === "indeterminate"
            ? "border-warning-border bg-warning-subtle/40"
            : "border-border bg-surface-raised",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body font-semibold text-content">{rule.title}</p>
          <p className="mt-0.5 font-mono text-2xs text-content-muted">{rule.citation}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={tone} size="xs" dot>
            {RULE_OUTCOME_LABEL[rule.outcome] ?? rule.outcome}
          </Badge>
          {rule.isRecordingDutyOnly ? (
            <Tooltip content="A recording duty — the case goes on the log. It is not a notification to the authority and it starts no notification clock.">
              <span>
                <Badge tone="neutral" size="xs" variant="outline">
                  Recording duty only
                </Badge>
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>

      <p className="mt-1.5 text-2xs text-content-subtle">
        {REGIME_LABEL[rule.regime] ?? rule.regime} · {rule.jurisdiction} · enforced by{" "}
        {rule.authority}
      </p>

      {rule.basis.length > 0 ? (
        <div className="mt-2">
          <p className="text-label uppercase text-content-subtle">What the rule read</p>
          <ReasonList reasons={rule.basis} className="mt-1" />
        </div>
      ) : null}

      {rule.needsHumanReview && rule.openQuestion ? (
        <div className="mt-2 rounded-md border border-warning-border bg-warning-subtle/60 p-2">
          <p className="text-label uppercase text-warning-fg">A human must answer this</p>
          <p className="mt-1 text-meta text-content">{rule.openQuestion}</p>
        </div>
      ) : null}

      {rule.deadline ? (
        <div className="mt-2 rounded-md border border-border bg-surface p-2">
          <p className="text-label uppercase text-content-subtle">Notification deadline</p>
          <p className="mt-1 text-meta text-content">
            {rule.deadline.withinLabel} from {rule.deadline.clockStartsFrom}
          </p>
          <p className="mt-0.5 text-2xs text-content-muted">
            Clock started {dateTime(rule.deadline.clockStartsAt)} · due{" "}
            {dateTime(rule.deadline.dueAt)} · {rule.deadline.notificationMethod}
          </p>
          {rule.deadline.immediateNotificationRequired ? (
            <p className="mt-1 text-2xs font-medium text-danger-fg">
              An immediate notification by the quickest practicable means is due FIRST — the written
              report does not discharge it.
            </p>
          ) : null}
        </div>
      ) : null}

      {rule.outcome === "met" ? (
        <p className="mt-2 text-2xs text-danger-fg">{rule.consequenceIfMissed}</p>
      ) : null}
    </div>
  );
}

/**
 * The determination in full: the regimes assessed, the classification, the
 * clock, the rules with their citations, and — first, and loudest — anything
 * a human still has to decide.
 */
export function ReportabilityPanel({
  determination,
  notification,
  regimeBasis,
  compact = false,
}: {
  determination: ReportabilityDetermination | null;
  notification?: IncidentNotification;
  regimeBasis?: readonly string[];
  compact?: boolean;
}) {
  if (!determination) {
    return (
      <Alert tone="neutral" title="No determination has been recorded">
        <p>
          This incident has not been assessed against any statutory regime. Until it is, its
          reportability is unknown — which is not the same as not reportable.
        </p>
      </Alert>
    );
  }

  const met = determination.rules.filter((r) => r.outcome === "met");
  const indeterminate = determination.rules.filter((r) => r.outcome === "indeterminate");
  const notMet = determination.rules.filter((r) => r.outcome === "not_met");
  const governing = determination.governingRuleId
    ? determination.rules.find((r) => r.ruleId === determination.governingRuleId)
    : undefined;

  return (
    <div className="space-y-3">
      {/* The headline: never "not reportable" while a rule is undecided. */}
      {determination.needsHumanReview ? (
        <Alert
          tone="warning"
          title="This determination is not settled — a competent person must decide"
        >
          <p>
            {indeterminate.length} statutory test
            {indeterminate.length === 1 ? "" : "s"} could not be decided on the facts the platform
            holds. Until they are answered the classification below is provisional, and treating it
            as final is how a reportable event goes unreported.
          </p>
          <ReasonList reasons={determination.openQuestions} className="mt-2" />
        </Alert>
      ) : determination.isReportable ? (
        <Alert tone="danger" title="Reportable — a statutory notification is owed">
          <p>
            {met.length} test{met.length === 1 ? "" : "s"} met under{" "}
            {determination.regimes.map((r) => REGIME_LABEL[r] ?? r).join(" and ")}.
          </p>
        </Alert>
      ) : (
        <Alert tone="success" title="No statutory notification is owed on the facts held">
          <p>
            Every test in{" "}
            {determination.assessedRegimes.map((r) => REGIME_LABEL[r] ?? r).join(" and ") ||
              "the assessed regimes"}{" "}
            was decided, and none was met. If the facts change — days off accrue, a diagnosis
            arrives — reassess: the answer is a function of the facts, not of the file.
          </p>
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <FactTile label="Regimes assessed">
          <div className="flex flex-wrap gap-1">
            {determination.assessedRegimes.length === 0 ? (
              <span className="text-meta text-content-muted">None</span>
            ) : (
              determination.assessedRegimes.map((r) => (
                <Badge
                  key={r}
                  size="xs"
                  tone={determination.regimes.includes(r) ? "danger" : "neutral"}
                  variant={determination.regimes.includes(r) ? "subtle" : "outline"}
                >
                  {REGIME_LABEL[r] ?? r}
                </Badge>
              ))
            )}
          </div>
        </FactTile>
        <FactTile label="RIDDOR category">
          <Badge
            size="xs"
            tone={
              determination.riddorCategory === "under_assessment"
                ? "warning"
                : determination.riddorCategory === "not_reportable"
                  ? "neutral"
                  : "danger"
            }
          >
            {labelize(determination.riddorCategory)}
          </Badge>
        </FactTile>
        <FactTile label="OSHA case type">
          <Badge
            size="xs"
            tone={
              determination.oshaCaseType === "under_assessment"
                ? "warning"
                : determination.oshaCaseType === "not_recordable"
                  ? "neutral"
                  : "danger"
            }
          >
            {labelize(determination.oshaCaseType)}
          </Badge>
        </FactTile>
        <FactTile label="Governing rule">
          {governing ? (
            <span className="text-meta text-content">
              {governing.title}
              <span className="block font-mono text-2xs text-content-muted">
                {governing.citation}
              </span>
            </span>
          ) : (
            <span className="text-meta text-content-muted">None</span>
          )}
        </FactTile>
      </div>

      {determination.reportDueAt ? (
        <NotificationCountdown
          dueAt={determination.reportDueAt}
          notifiedAt={notification?.notifiedAt ?? null}
        />
      ) : determination.reasons.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-sunken p-3">
          <p className="text-label uppercase text-content-subtle">
            Why there is no notification deadline
          </p>
          <ReasonList reasons={determination.reasons} className="mt-1" />
        </div>
      ) : null}

      {regimeBasis && regimeBasis.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-raised p-3">
          <p className="text-label uppercase text-content-subtle">How the regimes were chosen</p>
          <ReasonList reasons={regimeBasis} className="mt-1" />
        </div>
      ) : null}

      {indeterminate.length > 0 ? (
        <div>
          <SectionHeading
            title={`Undecided — ${indeterminate.length} test${indeterminate.length === 1 ? "" : "s"}`}
            hint="These are questions, not results. Each names the fact the platform does not hold."
          />
          <div className="space-y-2">
            {indeterminate.map((rule) => (
              <RuleCard key={rule.ruleId} rule={rule} />
            ))}
          </div>
        </div>
      ) : null}

      {met.length > 0 ? (
        <div>
          <SectionHeading
            title={`Tests met — ${met.length}`}
            hint="Each of these creates a duty. The earliest deadline across them is the one on the clock above."
          />
          <div className="space-y-2">
            {met.map((rule) => (
              <RuleCard key={rule.ruleId} rule={rule} />
            ))}
          </div>
        </div>
      ) : null}

      {!compact && notMet.length > 0 ? (
        <details className="rounded-lg border border-border bg-surface-raised">
          <summary className="cursor-pointer px-3 py-2 text-meta font-medium text-content">
            {notMet.length} test{notMet.length === 1 ? "" : "s"} decided and not met
          </summary>
          <div className="space-y-2 border-t border-border p-3">
            {notMet.map((rule) => (
              <RuleCard key={rule.ruleId} rule={rule} />
            ))}
          </div>
        </details>
      ) : null}

      <p className="text-2xs italic text-content-subtle">{determination.disclaimer}</p>
    </div>
  );
}

export function FactTile({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <p className="text-label uppercase text-content-subtle">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/* ========================================================================== */
/* Paging                                                                      */
/* ========================================================================== */

/**
 * The page size every safety register asks for.
 *
 * It used to be 200 — the server maximum — with no paging control anywhere, so
 * a project holding more than two hundred observations silently lost the rest
 * of them off the register AND off the header counts derived from it. A
 * register that quietly truncates is worse than one that refuses to load: the
 * reader has no way to know the row they are looking for is simply not there.
 */
export const REGISTER_PAGE_SIZE = 100;

/** A filter object's `page` value as a number, defaulting to the first page. */
export function pageNumber(value: string | undefined): number {
  const n = Number(value ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** `page` and `pageSize` for a register query, from the filter object. */
export function pageParams(page: string | undefined): URLSearchParams {
  return new URLSearchParams({
    page: String(pageNumber(page)),
    pageSize: String(REGISTER_PAGE_SIZE),
  });
}

/**
 * The pager under a register. It states the range being shown out of the
 * total, so "45 of 45" and "1–100 of 812" are visibly different situations.
 */
export function RegisterPager({
  page,
  loaded,
  total,
  noun,
  onPage,
  loading,
}: {
  page: string;
  loaded: number;
  total: number | null;
  noun: string;
  onPage: (page: string) => void;
  loading?: boolean;
}) {
  const current = pageNumber(page);
  if (total === null) return null;
  const first = total === 0 ? 0 : (current - 1) * REGISTER_PAGE_SIZE + 1;
  const last = (current - 1) * REGISTER_PAGE_SIZE + loaded;
  const hasMore = last < total;
  if (total <= REGISTER_PAGE_SIZE && current === 1) {
    return (
      <p className="text-2xs text-content-subtle">
        {count(total)} {noun}
        {total === 1 ? "" : "s"} — the whole register is on this page.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2">
      <p className="text-meta text-content-muted">
        Showing <span className="font-medium text-content">{count(first)}</span>–
        <span className="font-medium text-content">{count(last)}</span> of{" "}
        <span className="font-medium text-content">{count(total)}</span> {noun}
        {total === 1 ? "" : "s"}.{" "}
        {hasMore || current > 1 ? (
          <span className="text-content-subtle">
            This register is longer than one page — anything computed from what is on screen is
            computed from a slice of it.
          </span>
        ) : null}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          disabled={current <= 1 || loading === true}
          onClick={() => onPage(String(current - 1))}
        >
          Previous
        </Button>
        <span className="text-2xs text-content-subtle">page {count(current)}</span>
        <Button
          size="xs"
          variant="secondary"
          disabled={!hasMore || loading === true}
          onClick={() => onPage(String(current + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Platform upgrade wave — devices, statutory forms, index, scorecards         */
/* ========================================================================== */

export interface SensorEvent {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  source: string;
  kind: string;
  severity: string;
  deviceId: string | null;
  deviceModel: string | null;
  workerId: string | null;
  reportedPersonName: string | null;
  vendorId: string | null;
  occurredAt: string;
  receivedAt: string;
  locationText: string | null;
  measurementValue: number | null;
  measurementUnit: string | null;
  thresholdValue: number | null;
  status: string;
  acknowledgeDueAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  responseSeconds: number | null;
  responseNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  outcome: string | null;
  incidentId: string | null;
  observationId: string | null;
  signalId: string | null;
  externalId: string | null;
  createdAt: string;
  /** decorateSensorEvent */
  isLifeSafety: boolean;
  responseDeadlineMinutes: number;
  acknowledgementOverdue: boolean;
  minutesLate: number | null;
  responseMinutes: number | null;
  note: string | null;
}

export interface SensorEventDetail extends SensorEvent {
  workerName: string | null;
}

export interface FormField<T> {
  value: T | null;
  reason: string | null;
}

export interface RegulatoryReportRow {
  id: string;
  reference: string;
  form: string;
  status: string;
  periodYear: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  incidentId: string | null;
  sha256: string;
  fileId: string | null;
  rowCount: number;
  caveats: string[];
  certifiedBy: string | null;
  certifiedAt: string | null;
  certifierTitle: string | null;
  submittedAt: string | null;
  submissionReference: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  generatedBy: string;
  createdAt: string;
}

export interface RegulatoryPreview {
  form: string;
  stored: boolean;
  note: string;
  payload: Record<string, unknown>;
  rowCount: number;
  caveats: string[];
  periodYear: number | null;
  incidentId: string | null;
}

export interface RiskComponent {
  key: string;
  name: string;
  value: number | null;
  weight: number;
  contribution: number | null;
  basis: string;
  inputs: Record<string, number | null>;
  reasons: string[];
}

export interface RiskIndex {
  projectId: string;
  from: string;
  to: string;
  asOf: string;
  score: number | null;
  band: string;
  components: RiskComponent[];
  coverage: number;
  reasons: string[];
  drivers: Array<{ key: string; name: string; contribution: number; advice: string }>;
  explanation: string;
  trend: Array<{ asOfDate: string; score: number | null; band: string; coverage: number | null }>;
  note: string;
  snapshotId?: string | null;
  signalId?: string | null;
}

export interface UnderReportingFinding {
  key: string;
  title: string;
  confidence: number;
  severity: string;
  expected: string;
  observed: string;
  explanation: string;
  refutedBy: string;
  inputs: Record<string, number | string | null>;
}

export interface UnderReportingResult {
  projectId: string;
  from: string;
  to: string;
  findings: UnderReportingFinding[];
  reasons: string[];
  note: string;
}

export interface ScorecardMetric {
  key: string;
  name: string;
  value: number | null;
  unit: string;
  direction: "higher_is_better" | "lower_is_better";
  basis: string;
  inputs: Record<string, number | string | null>;
  reasons: string[];
  points: number | null;
  weight: number;
}

export interface VendorScorecard {
  vendorId: string;
  vendorName: string | null;
  projectId: string | null;
  from: string;
  to: string;
  metrics: ScorecardMetric[];
  score: number | null;
  grade: string;
  coverage: number;
  recordCount: number;
  reasons: string[];
  flags: string[];
  computedAt: string;
}

export interface ScorecardResponse {
  from: string;
  to: string;
  scorecards: VendorScorecard[];
  reasons: string[];
  note: string;
}

export const RISK_BAND_LABEL: Record<string, string> = {
  low: "Low",
  elevated: "Elevated",
  high: "High",
  severe: "Severe",
  unrated: "Unrated",
};

export const RISK_BAND_TONE_MAP: Record<string, Tone> = {
  low: "success",
  elevated: "info",
  high: "warning",
  severe: "danger",
  unrated: "neutral",
};

export const ALARM_STATUS_TONE: Record<string, Tone> = {
  open: "danger",
  acknowledged: "warning",
  auto_resolved: "info",
  resolved: "success",
  escalated: "danger",
  false_alarm: "neutral",
  void: "neutral",
};

export const REGULATORY_FORM_LABEL: Record<string, string> = {
  osha_300: "OSHA 300 log",
  osha_300a: "OSHA 300A annual summary",
  osha_301: "OSHA 301 incident report",
  riddor_f2508: "RIDDOR F2508",
  riddor_f2508a: "RIDDOR F2508A (disease)",
};

export const REGULATORY_STATUS_TONE: Record<string, Tone> = {
  generated: "info",
  submitted: "success",
  superseded: "neutral",
  void: "neutral",
};
