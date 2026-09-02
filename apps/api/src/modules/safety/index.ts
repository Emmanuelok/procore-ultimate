import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  companies,
  files,
  locations,
  nonConformanceReports,
  obligations,
  prequalificationSubmissions,
  projects,
  safetyCorrectiveActions,
  safetyIncidents,
  safetyInspectionTemplates,
  safetyInspections,
  safetyObservations,
  safetyProgrammeRecords,
  safetyRegulatoryReports,
  safetyRiskSnapshots,
  safetySensorEvents,
  signals,
  siteAccessRecords,
  timecards,
  toolboxTalkAttendees,
  toolboxTalks,
  vendors,
  workers,
} from "@constructos/db";
import {
  ACKNOWLEDGEMENT_METHODS,
  ACTION_EFFECTIVENESS_VERDICTS,
  BODY_PARTS,
  CHECKLIST_ITEM_TYPES,
  CORRECTIVE_ACTION_KINDS,
  CORRECTIVE_ACTION_SOURCES,
  HIERARCHY_OF_CONTROLS,
  INCIDENT_MECHANISMS,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  INJURED_PERSON_TYPES,
  INJURY_NATURES,
  INJURY_TREATMENT_LEVELS,
  INSPECTION_FREQUENCIES,
  INSPECTION_SCORING_METHODS,
  REPORTABLE_REGIMES,
  type InspectionScoringMethod,
  ROOT_CAUSE_METHODS,
  SAFETY_CATEGORIES,
  SAFETY_INSPECTION_TYPES,
  SAFETY_OBSERVATION_KINDS,
  SAFETY_RECORD_KINDS_ALL,
  SAFETY_REGULATORY_FORMS,
  SAFETY_SENSOR_EVENT_KINDS,
  SAFETY_SENSOR_SOURCES,
  SAFETY_SEVERITIES,
  SHIFTS,
  type CorrectiveActionSource,
  type ReportableRegime,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  addMonthsISO,
  computeReportingDelay,
  computeRiskScore,
  nextStatutoryDueDate,
  optionalRiskScore,
  scoreInspection,
  type InspectionAnswer,
  type TemplateItem,
} from "./scoring.js";
import {
  assessReportability,
  blankFacts,
  HOSPITAL_ADMISSIONS,
  isNotificationMissed,
  resolveRegimes,
  RIDDOR_SCHEDULE_2_CLASSES,
  ruleCatalogue,
  type IncidentFacts,
  type ReportabilityDetermination,
} from "./reportability.js";
import { computeSafetyRates, resolveExposureHours, type ExposureHours, type RateCounts } from "./rates.js";
import {
  derivedRegulatorNotifiedAt,
  missedNotificationKey,
  notificationState,
  type NotificationEntry,
  type NotificationState,
} from "./notifications.js";
import {
  buildOsha300,
  buildOsha300A,
  buildOsha301,
  buildRiddorF2508,
  canonicalJson,
  emptyFormContext,
  type FormContext,
  type FormIncident,
} from "./regulatory.js";
import {
  buildVendorScorecard,
  type VendorScorecard,
  type VendorScorecardInput,
} from "./scorecard.js";
import {
  assessUnderReporting,
  computeRiskIndex,
  type RiskIndexInput,
  type RiskIndexResult,
} from "./riskindex.js";
import {
  assistOutputSchema,
  buildAssistPrompt,
  reconcileAssist,
  type AssistContext,
  type AssistRecordRef,
} from "./assist.js";
import { aiEnabled, runAgent } from "../ai/service.js";
import { forEachCompany } from "../../lib/scheduler.js";

/* ------------------------------------------------------------------ */
/* Vocabularies local to this module                                   */
/* ------------------------------------------------------------------ */

/** Every detector this module owns. The summary counts exactly these. */
const SAFETY_DETECTORS = [
  "safety_notification_deadline_missed",
  "safety_corrective_action_overdue",
  "safety_statutory_inspection_overdue",
  "safety_programme_record_expired",
  "safety_investigation_overdue",
  "safety_device_alarm_unanswered",
  "safety_risk_index_elevated",
  "safety_under_reporting_suspected",
] as const;

/** Obligations created here carry this prefix so they can be counted back. */
const OBLIGATION_PREFIX = "safety";

/** Programme record kinds whose expiry stops work rather than merely dating a file. */
const CRITICAL_RECORD_KINDS = new Set(["permit_to_work", "competency_card", "temporary_works_design"]);

/**
 * Device alarm classes that are life-safety: somebody may be unconscious, and
 * the only useful response time is measured in minutes. Everything else gets
 * the shift-length clock.
 */
const LIFE_SAFETY_ALARMS = new Set([
  "man_down",
  "no_motion",
  "fall_detected",
  "sos",
  "gas_alarm",
  "check_in_missed",
]);

/** Response deadline for one alarm class, in minutes from receipt. */
const ALARM_RESPONSE_MINUTES: Record<string, number> = {
  man_down: 5,
  sos: 5,
  no_motion: 10,
  fall_detected: 5,
  gas_alarm: 5,
  check_in_missed: 15,
  impact: 60,
  heat_stress: 30,
  proximity_alert: 120,
  exclusion_zone_breach: 60,
  noise_exposure: 480,
  device_offline: 480,
  panic_test: 480,
};

/** Corrective action sources this module can validate the existence of. */
const IN_MODULE_SOURCES: ReadonlySet<string> = new Set([
  "incident",
  "observation",
  "inspection",
  "toolbox_talk",
]);

const OPEN_ACTION_STATUSES = ["open", "in_progress"] as const;
const LIVE_ACTION_STATUSES = ["open", "in_progress", "completed", "verified"] as const;

const pad = (n: number): string => String(n).padStart(4, "0");

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const observationCreateSchema = z.object({
  kind: z.enum(SAFETY_OBSERVATION_KINDS).optional(),
  category: z.enum(SAFETY_CATEGORIES).optional(),
  severity: z.enum(SAFETY_SEVERITIES).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable().optional(),
  observedAt: isoTimestamp,
  locationId: z.string().max(64).nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  workerId: z.string().max(64).nullable().optional(),
  crewId: z.string().max(64).nullable().optional(),
  riskLikelihood: z.number().int().min(1).max(5).nullable().optional(),
  riskSeverity: z.number().int().min(1).max(5).nullable().optional(),
  immediateActionTaken: z.string().max(4000).nullable().optional(),
  workStopped: z.boolean().optional(),
  assigneeId: z.string().max(64).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  photoFileIds: z.array(z.string().max(64)).max(50).optional(),
  relatedIncidentId: z.string().max(64).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const observationPatchSchema = observationCreateSchema.partial();

const observationListQuery = pageQuerySchema.extend({
  kind: z.enum(SAFETY_OBSERVATION_KINDS).optional(),
  category: z.enum(SAFETY_CATEGORIES).optional(),
  severity: z.enum(SAFETY_SEVERITIES).optional(),
  status: z.string().max(40).optional(),
  vendorId: z.string().max(64).optional(),
  assigneeId: z.string().max(64).optional(),
  workStopped: z.enum(["true", "false"]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
});

const observationAssignSchema = z.object({
  assigneeId: z.string().min(1).max(64),
  dueDate: isoDateSchema,
  note: z.string().max(2000).optional(),
});

const observationCloseSchema = z.object({
  note: z.string().min(1).max(4000),
  evidenceFileIds: z.array(z.string().max(64)).max(50).optional(),
  /** required to close an observation whose work stoppage was never lifted */
  workNotResumedReason: z.string().max(2000).optional(),
});

const resumeWorkSchema = z.object({
  resumedAt: isoTimestamp.optional(),
  controlsInPlace: z.string().min(1).max(4000),
});

/* --- incidents --- */

const witnessSchema = z.object({
  name: z.string().min(1).max(300),
  organisation: z.string().max(300).nullable().optional(),
  contact: z.string().max(300).nullable().optional(),
  statementFileId: z.string().max(64).nullable().optional(),
});

/**
 * The assessment answers the reportability rules need and the narrative
 * cannot supply. Every one of these exists because a statutory test turns on
 * it — see reportability.ts for which rule reads which field.
 */
const reportabilityInputsSchema = z.object({
  becameAwareAt: isoTimestamp.nullable().optional(),
  hospitalAdmission: z.enum(HOSPITAL_ADMISSIONS).optional(),
  hospitalAdmittedAt: isoTimestamp.nullable().optional(),
  fatalityOccurredAt: isoTimestamp.nullable().optional(),
  medicalTreatmentBeyondFirstAid: z.boolean().nullable().optional(),
  lossOfConsciousness: z.boolean().nullable().optional(),
  permanentSightLoss: z.boolean().nullable().optional(),
  lossOfAnEye: z.boolean().nullable().optional(),
  seriousBurn: z.boolean().nullable().optional(),
  enclosedSpace: z.boolean().nullable().optional(),
  dangerousOccurrenceClass: z.string().max(120).nullable().optional(),
  occupationalDiseaseDiagnosed: z.boolean().nullable().optional(),
  diagnosisReceivedAt: isoTimestamp.nullable().optional(),
  gasIncident: z.boolean().nullable().optional(),
  underOurDayToDayControl: z.boolean().nullable().optional(),
  incapacityStillAccruing: z.boolean().optional(),
  workRelated: z.boolean().nullable().optional(),
});

const incidentCreateSchema = z.object({
  incidentType: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(20000),
  occurredAt: isoTimestamp,
  discoveredAt: isoTimestamp.nullable().optional(),
  reportedAt: isoTimestamp.nullable().optional(),
  hoursIntoShift: z.number().min(0).max(48).nullable().optional(),
  shift: z.enum(SHIFTS).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  weatherConditions: z.string().max(300).nullable().optional(),
  lightingConditions: z.string().max(300).nullable().optional(),
  activityAtTime: z.string().max(2000).nullable().optional(),
  workerId: z.string().max(64).nullable().optional(),
  injuredPersonName: z.string().max(300).nullable().optional(),
  injuredPersonType: z.enum(INJURED_PERSON_TYPES).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  injuredPersonTrade: z.string().max(200).nullable().optional(),
  injuredPersonAge: z.number().int().min(0).max(120).nullable().optional(),
  yearsExperience: z.number().min(0).max(80).nullable().optional(),
  daysSinceInduction: z.number().int().min(0).max(20000).nullable().optional(),
  treatmentLevel: z.enum(INJURY_TREATMENT_LEVELS).nullable().optional(),
  bodyPart: z.enum(BODY_PARTS).nullable().optional(),
  additionalBodyParts: z.array(z.enum(BODY_PARTS)).max(20).optional(),
  injuryNature: z.enum(INJURY_NATURES).nullable().optional(),
  mechanism: z.enum(INCIDENT_MECHANISMS).nullable().optional(),
  treatmentProvider: z.string().max(300).nullable().optional(),
  hospitalName: z.string().max(300).nullable().optional(),
  isLostTime: z.boolean().optional(),
  lostTimeDays: z.number().min(0).max(20000).nullable().optional(),
  restrictedDutyDays: z.number().min(0).max(20000).nullable().optional(),
  returnToWorkDate: isoDateSchema.nullable().optional(),
  isFatality: z.boolean().optional(),
  equipmentId: z.string().max(64).nullable().optional(),
  propertyDamageDescription: z.string().max(4000).nullable().optional(),
  environmentalReleaseDescription: z.string().max(4000).nullable().optional(),
  releaseQuantity: z.number().nullable().optional(),
  releaseUnit: z.string().max(40).nullable().optional(),
  thirdPartyInvolved: z.boolean().optional(),
  thirdPartyDetail: z.string().max(4000).nullable().optional(),
  immediateCause: z.string().max(4000).nullable().optional(),
  immediateActionTaken: z.string().max(4000).nullable().optional(),
  workStopped: z.boolean().optional(),
  emergencyServicesAttended: z.boolean().optional(),
  witnesses: z.array(witnessSchema).max(100).optional(),
  investigationDueDate: isoDateSchema.nullable().optional(),
  estimatedCost: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  isConfidential: z.boolean().optional(),
  photoFileIds: z.array(z.string().max(64)).max(100).optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(100).optional(),
  /** explicit regime override — a UK site with a US parent reports under both */
  regimes: z.array(z.enum(REPORTABLE_REGIMES)).max(9).optional(),
  reportabilityInputs: reportabilityInputsSchema.optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const incidentPatchSchema = incidentCreateSchema.partial().omit({ occurredAt: true });

const incidentListQuery = pageQuerySchema.extend({
  incidentType: z.enum(INCIDENT_TYPES).optional(),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  status: z.string().max(40).optional(),
  reportable: z.enum(["true", "false"]).optional(),
  vendorId: z.string().max(64).optional(),
  workerId: z.string().max(64).optional(),
  investigationStatus: z.string().max(40).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const contributingFactorSchema = z.object({
  factor: z.string().min(1).max(500),
  category: z.string().max(120).optional(),
  note: z.string().max(4000).optional(),
});

const investigationSchema = z.object({
  investigationLeadId: z.string().max(64).nullable().optional(),
  investigationDueDate: isoDateSchema.nullable().optional(),
  rootCauseMethod: z.enum(ROOT_CAUSE_METHODS).optional(),
  rootCause: z.string().max(8000).nullable().optional(),
  contributingFactors: z.array(contributingFactorSchema).max(60).optional(),
  investigationFindings: z.string().max(20000).nullable().optional(),
  investigationReportFileId: z.string().max(64).nullable().optional(),
});

const notifyRegulatorSchema = z.object({
  regime: z.enum(REPORTABLE_REGIMES),
  notifiedAt: isoTimestamp.optional(),
  reference: z.string().max(200).nullable().optional(),
  method: z.string().max(120).optional(),
  fileId: z.string().max(64).nullable().optional(),
});

const incidentCloseSchema = z.object({
  note: z.string().min(1).max(8000),
  lessonId: z.string().max(64).nullable().optional(),
});

/* --- corrective actions --- */

const actionCreateSchema = z.object({
  sourceType: z.enum(CORRECTIVE_ACTION_SOURCES),
  sourceId: z.string().min(1).max(64),
  sourceReference: z.string().max(120).nullable().optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable().optional(),
  actionKind: z.enum(CORRECTIVE_ACTION_KINDS).optional(),
  hierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS),
  category: z.enum(SAFETY_CATEGORIES).nullable().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  ownerId: z.string().max(64).nullable().optional(),
  ownerVendorId: z.string().max(64).nullable().optional(),
  ownerName: z.string().max(300).nullable().optional(),
  dueDate: isoDateSchema,
  costToImplement: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const actionPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(8000).nullable().optional(),
  actionKind: z.enum(CORRECTIVE_ACTION_KINDS).optional(),
  hierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS).optional(),
  category: z.enum(SAFETY_CATEGORIES).nullable().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  ownerId: z.string().max(64).nullable().optional(),
  ownerVendorId: z.string().max(64).nullable().optional(),
  ownerName: z.string().max(300).nullable().optional(),
  dueDate: isoDateSchema.optional(),
  revisionReason: z.string().max(2000).optional(),
  costToImplement: z.number().min(0).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const actionListQuery = pageQuerySchema.extend({
  sourceType: z.enum(CORRECTIVE_ACTION_SOURCES).optional(),
  sourceId: z.string().max(64).optional(),
  status: z.string().max(40).optional(),
  ownerId: z.string().max(64).optional(),
  hierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  effectiveness: z.enum(ACTION_EFFECTIVENESS_VERDICTS).optional(),
});

const actionCompleteSchema = z.object({
  completionNote: z.string().min(1).max(8000),
  evidenceFileIds: z.array(z.string().max(64)).max(50).optional(),
  completedAt: isoTimestamp.optional(),
});

const actionVerifySchema = z.object({
  verificationMethod: z.string().min(1).max(300),
  note: z.string().max(4000).optional(),
});

const effectivenessSchema = z.object({
  verdict: z.enum(["effective", "partially_effective", "not_effective"]),
  checkDate: isoDateSchema.optional(),
  note: z.string().min(1).max(8000),
});

/* --- inspection templates and inspections --- */

const templateItemSchema = z.object({
  id: z.string().max(64).optional(),
  section: z.string().max(200).nullable().optional(),
  position: z.number().int().min(0).max(10000).optional(),
  text: z.string().min(1).max(2000),
  itemType: z.enum(CHECKLIST_ITEM_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().max(200)).max(50).nullable().optional(),
  guidance: z.string().max(4000).nullable().optional(),
  weight: z.number().min(0).max(1000).nullable().optional(),
  isCritical: z.boolean().optional(),
  photoRequired: z.boolean().optional(),
});

const templateCreateSchema = z.object({
  reference: z.string().min(1).max(60),
  name: z.string().min(1).max(300),
  description: z.string().max(4000).nullable().optional(),
  inspectionType: z.enum(SAFETY_INSPECTION_TYPES).optional(),
  projectId: z.string().max(64).nullable().optional(),
  items: z.array(templateItemSchema).min(1).max(500),
  scoringMethod: z.enum(INSPECTION_SCORING_METHODS).optional(),
  passThreshold: z.number().min(0).max(100).nullable().optional(),
  frequency: z.enum(INSPECTION_FREQUENCIES).optional(),
  regulatoryBasis: z.string().max(500).nullable().optional(),
  isStatutory: z.boolean().optional(),
  appliesToTrades: z.array(z.string().max(120)).max(60).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const templatePatchSchema = templateCreateSchema.partial().omit({ reference: true });

const inspectionCreateSchema = z.object({
  templateId: z.string().max(64).nullable().optional(),
  title: z.string().min(1).max(300),
  inspectionType: z.enum(SAFETY_INSPECTION_TYPES).optional(),
  scheduledFor: isoDateSchema.nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  equipmentId: z.string().max(64).nullable().optional(),
  inspectorId: z.string().max(64).nullable().optional(),
  inspectorName: z.string().max(300).nullable().optional(),
  accompaniedBy: z
    .array(
      z.object({
        userId: z.string().max(64).nullable().optional(),
        name: z.string().min(1).max(300),
        organisation: z.string().max(300).nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
  isStatutory: z.boolean().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const answerSchema = z.object({
  itemId: z.string().min(1).max(64),
  response: z.string().max(4000).nullable().optional(),
  numericValue: z.number().nullable().optional(),
  isPass: z.boolean().nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  photoFileIds: z.array(z.string().max(64)).max(20).optional(),
});

const inspectionCompleteSchema = z.object({
  performedAt: isoTimestamp.optional(),
  responses: z.array(answerSchema).max(500),
  signatureFileId: z.string().max(64).nullable().optional(),
  reportFileId: z.string().max(64).nullable().optional(),
  photoFileIds: z.array(z.string().max(64)).max(100).optional(),
  /** raise a corrective action per defect, owned by whoever is named here */
  raiseActions: z.boolean().optional(),
  defectActionOwnerId: z.string().max(64).nullable().optional(),
  defectActionDueDate: isoDateSchema.optional(),
  defectHierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS).optional(),
  nextDueDate: isoDateSchema.nullable().optional(),
});

const inspectionReviewSchema = z.object({
  note: z.string().max(4000).optional(),
  close: z.boolean().optional(),
});

/* --- toolbox talks --- */

const talkCreateSchema = z.object({
  title: z.string().min(1).max(300),
  topic: z.string().max(300).nullable().optional(),
  category: z.enum(SAFETY_CATEGORIES).optional(),
  talkDate: isoDateSchema,
  startTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  durationMinutes: z.number().int().min(1).max(600).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  presenterId: z.string().max(64).nullable().optional(),
  presenterName: z.string().max(300).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  crewId: z.string().max(64).nullable().optional(),
  contentSummary: z.string().max(20000).nullable().optional(),
  contentFileId: z.string().max(64).nullable().optional(),
  language: z.string().max(60).nullable().optional(),
  interpreterUsed: z.boolean().optional(),
  expectedAttendeeCount: z.number().int().min(0).max(2000).nullable().optional(),
  relatedIncidentId: z.string().max(64).nullable().optional(),
  relatedObservationId: z.string().max(64).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const talkPatchSchema = talkCreateSchema.partial();

const attendeeSchema = z.object({
  workerId: z.string().max(64).nullable().optional(),
  userId: z.string().max(64).nullable().optional(),
  name: z.string().max(300).optional(),
  vendorId: z.string().max(64).nullable().optional(),
  trade: z.string().max(200).nullable().optional(),
  acknowledgementMethod: z.enum(ACKNOWLEDGEMENT_METHODS).optional(),
  signedAt: isoTimestamp.nullable().optional(),
  signatureFileId: z.string().max(64).nullable().optional(),
  comprehensionChecked: z.boolean().optional(),
  comprehensionNote: z.string().max(2000).nullable().optional(),
});

const attendeesSchema = z.object({
  attendees: z.array(attendeeSchema).min(1).max(200),
});

/* --- programme records --- */

const acknowledgementSchema = z.object({
  workerId: z.string().max(64).nullable().optional(),
  userId: z.string().max(64).nullable().optional(),
  method: z.enum(ACKNOWLEDGEMENT_METHODS).optional(),
  acknowledgedAt: isoTimestamp.optional(),
  /** required when recording on behalf of a worker — what was actually seen */
  attestation: z.string().max(2000).optional(),
});

/**
 * Acknowledgement methods that carry their own evidence: the person left a
 * mark, or a device recorded them. `verbal_confirmed` and
 * `on_device_signature` recorded BY SOMEBODY ELSE do not — they are one
 * person's word that another person read something, which is exactly what an
 * inspector discounts.
 */
const ATTESTABLE_METHODS: ReadonlySet<string> = new Set([
  "wet_signature",
  "biometric",
  "qr_scan",
  "badge_scan",
  "supervisor_attested",
]);

const recordCreateSchema = z.object({
  projectId: z.string().max(64).nullable().optional(),
  recordKind: z.enum(SAFETY_RECORD_KINDS_ALL),
  title: z.string().min(1).max(300),
  description: z.string().max(8000).nullable().optional(),
  version: z.string().max(40).nullable().optional(),
  reference: z.string().max(60).optional(),
  documentFileId: z.string().max(64).nullable().optional(),
  documentSha256: z.string().max(80).nullable().optional(),
  effectiveFrom: isoDateSchema.nullable().optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  reviewDueDate: isoDateSchema.nullable().optional(),
  reviewIntervalMonths: z.number().int().min(1).max(240).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  workerId: z.string().max(64).nullable().optional(),
  appliesToTrades: z.array(z.string().max(120)).max(60).optional(),
  appliesToLocationIds: z.array(z.string().max(64)).max(200).optional(),
  regulatoryReference: z.string().max(500).nullable().optional(),
  categories: z.array(z.enum(SAFETY_CATEGORIES)).max(20).optional(),
  requiredAcknowledgementCount: z.number().int().min(0).max(10000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const recordPatchSchema = recordCreateSchema.partial().omit({ recordKind: true, projectId: true });

const recordListQuery = pageQuerySchema.extend({
  recordKind: z.enum(SAFETY_RECORD_KINDS_ALL).optional(),
  status: z.string().max(40).optional(),
  workerId: z.string().max(64).optional(),
  vendorId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});

const supersedeSchema = recordCreateSchema.partial().extend({
  title: z.string().min(1).max(300),
  version: z.string().max(40).nullable().optional(),
  reason: z.string().max(4000).optional(),
});

const statisticsQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Row → facts                                                          */
/* ------------------------------------------------------------------ */

type IncidentRow = typeof safetyIncidents.$inferSelect;
type ObservationRow = typeof safetyObservations.$inferSelect;
type ActionRow = typeof safetyCorrectiveActions.$inferSelect;
type InspectionRow = typeof safetyInspections.$inferSelect;
type TalkRow = typeof toolboxTalks.$inferSelect;
type RecordRow = typeof safetyProgrammeRecords.$inferSelect;
type TemplateRow = typeof safetyInspectionTemplates.$inferSelect;

const asBool = (n: number | null | undefined): boolean => n === 1;
const fromBool = (b: boolean | undefined, fallback = 0): number => (b === undefined ? fallback : b ? 1 : 0);

function detailObject(row: { detail: Record<string, unknown> }, key: string): Record<string, unknown> {
  const v = row.detail[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readBool(o: Record<string, unknown>, key: string): boolean | null {
  const v = o[key];
  return typeof v === "boolean" ? v : null;
}

function readString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * Project a stored incident onto the fact shape the rules read.
 *
 * Columns supply what an insurer's form already captures; `detail
 * .reportabilityInputs` supplies the handful of answers a statutory test
 * turns on that no narrative carries — was the admission for treatment or
 * observation, was the treatment beyond first aid, which Schedule 2 class.
 * Anything unanswered arrives as `null`, and the rules are written to say so
 * rather than to assume.
 */
function factsFromIncident(row: IncidentRow): IncidentFacts {
  const a = detailObject(row, "reportabilityInputs");
  const admission = readString(a, "hospitalAdmission");
  return {
    ...blankFacts(),
    incidentType: row.incidentType as IncidentFacts["incidentType"],
    occurredAt: row.occurredAt,
    becameAwareAt: readString(a, "becameAwareAt") ?? row.discoveredAt ?? row.reportedAt,
    injuredPersonType: (row.injuredPersonType as IncidentFacts["injuredPersonType"]) ?? null,
    treatmentLevel: (row.treatmentLevel as IncidentFacts["treatmentLevel"]) ?? null,
    injuryNature: (row.injuryNature as IncidentFacts["injuryNature"]) ?? null,
    mechanism: (row.mechanism as IncidentFacts["mechanism"]) ?? null,
    bodyPart: row.bodyPart,
    additionalBodyParts: row.additionalBodyParts ?? [],
    isFatality: asBool(row.isFatality),
    fatalityOccurredAt: readString(a, "fatalityOccurredAt"),
    isLostTime: asBool(row.isLostTime),
    lostTimeDays: row.lostTimeDays,
    restrictedDutyDays: row.restrictedDutyDays,
    hospitalAdmission:
      admission && (HOSPITAL_ADMISSIONS as readonly string[]).includes(admission)
        ? (admission as IncidentFacts["hospitalAdmission"])
        : "unknown",
    hospitalAdmittedAt: readString(a, "hospitalAdmittedAt"),
    medicalTreatmentBeyondFirstAid: readBool(a, "medicalTreatmentBeyondFirstAid"),
    lossOfConsciousness: readBool(a, "lossOfConsciousness"),
    permanentSightLoss: readBool(a, "permanentSightLoss"),
    lossOfAnEye: readBool(a, "lossOfAnEye"),
    seriousBurn: readBool(a, "seriousBurn"),
    enclosedSpace: readBool(a, "enclosedSpace"),
    dangerousOccurrenceClass: readString(a, "dangerousOccurrenceClass"),
    occupationalDiseaseDiagnosed: readBool(a, "occupationalDiseaseDiagnosed"),
    diagnosisReceivedAt: readString(a, "diagnosisReceivedAt"),
    gasIncident: readBool(a, "gasIncident"),
    underOurDayToDayControl: readBool(a, "underOurDayToDayControl"),
    incapacityStillAccruing: readBool(a, "incapacityStillAccruing") === true,
    workRelated: readBool(a, "workRelated"),
  };
}

/** The determination stored on the incident at the last assessment. */
function storedDetermination(row: IncidentRow): ReportabilityDetermination | null {
  const d = row.detail["reportability"];
  return d && typeof d === "object" && !Array.isArray(d) ? (d as ReportabilityDetermination) : null;
}

/**
 * The standing of every statutory notification duty on one incident.
 *
 * ONE function, used by the register, the drawer, the sweep and the close
 * gate, so those four cannot disagree about whether a duty is live. It reads
 * the stored determination where there is one and falls back to the stored
 * regime list and deadline where there is not.
 */
function incidentNotificationState(row: IncidentRow, asOfISO: string): NotificationState {
  return notificationState({
    determination: storedDetermination(row),
    storedRegimes: (row.reportableRegimes ?? []) as string[],
    reportDueAt: row.reportDueAt,
    notifications: ((row.notifications ?? []) as unknown[]).filter(
      (n): n is NotificationEntry => !!n && typeof n === "object",
    ),
    isReportable: asBool(row.isReportable),
    asOfISO,
  });
}

/**
 * Whether 29 CFR Part 1904 was actually applied to this incident.
 *
 * `oshaCaseType` is set to `under_assessment` both when a rule could not be
 * decided AND when OSHA was never in the assessed regime list at all
 * (reportability.ts). Those two states mean opposite things to a rate: the
 * first is an open question, the second is a question nobody asked. Only the
 * stored determination can tell them apart, so an incident with no stored
 * determination counts as unassessed.
 */
function assessedUnderOsha(row: IncidentRow): boolean {
  const det = storedDetermination(row);
  if (det) return det.assessedRegimes.includes("osha");
  const regimes = storedRegimes(row);
  return regimes != null && regimes.includes("osha");
}

/** Regimes recorded on the incident, for reassessment without re-supplying them. */
function storedRegimes(row: IncidentRow): string[] | null {
  const a = detailObject(row, "reportabilityInputs");
  const v = a["regimes"];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
}

/** Template items as the scorer wants them, with ids guaranteed. */
function normaliseItems(items: unknown): TemplateItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((raw, i) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    return {
      id: typeof it["id"] === "string" && it["id"] !== "" ? (it["id"] as string) : `item-${i + 1}`,
      section: typeof it["section"] === "string" ? (it["section"] as string) : null,
      position: typeof it["position"] === "number" ? (it["position"] as number) : i,
      text: typeof it["text"] === "string" ? (it["text"] as string) : "",
      itemType: (typeof it["itemType"] === "string" ? it["itemType"] : "pass_fail") as TemplateItem["itemType"],
      required: it["required"] === true,
      options: Array.isArray(it["options"]) ? (it["options"] as string[]) : null,
      guidance: typeof it["guidance"] === "string" ? (it["guidance"] as string) : null,
      weight: typeof it["weight"] === "number" ? (it["weight"] as number) : null,
      isCritical: it["isCritical"] === true,
      photoRequired: it["photoRequired"] === true,
    };
  });
}

const daysBetweenDates = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const PRIORITY_TO_SIGNAL_SEVERITY: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * SAFETY (M21, spec Vol I §2.11) — tool key `safety`.
 *
 * The module builds nothing the platform already has. A statutory
 * notification deadline is an **Obligation** — the same machinery an
 * insurance notification period and a contractual time bar use (ADR 0012) —
 * so a missed RIDDOR report appears in the same register, and on the same
 * dashboard, as a missed clause-notice. A missed deadline, an overdue
 * corrective action, an overdue statutory re-inspection, an expired permit
 * and an uninvestigated incident are **Signals** raised by an idempotent lazy
 * sweep on list and detail reads: never a cron, because the read is the
 * moment the answer has to be true, and `evidenceRefs.key` is what stops the
 * same finding being raised twice.
 *
 * The one thing it does build is `reportability.ts` — a code-resident,
 * unit-tested rules file for RIDDOR 2013 and 29 CFR Part 1904, each rule
 * carrying its citation, its clock start and its deadline, and each capable
 * of returning "I cannot tell you" rather than a guess. That file is the
 * module. Everything else is a register around it.
 */
export const safetyModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("safety", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("safety", "standard")];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("safety", "admin")];
  const companyRead = [app.authenticate, app.requireCompany];
  const companyWrite = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetchers                                                          */
  /* ---------------------------------------------------------------- */

  async function fetchObservation(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.id, id),
          eq(safetyObservations.companyId, companyId),
          eq(safetyObservations.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Observation not found");
    return rows[0];
  }

  async function fetchIncident(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.id, id),
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Incident not found");
    return rows[0];
  }

  async function fetchAction(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.id, id),
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Corrective action not found");
    return rows[0];
  }

  async function fetchInspection(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.id, id),
          eq(safetyInspections.companyId, companyId),
          eq(safetyInspections.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Inspection not found");
    return rows[0];
  }

  async function fetchTalk(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(toolboxTalks)
      .where(
        and(
          eq(toolboxTalks.id, id),
          eq(toolboxTalks.companyId, companyId),
          eq(toolboxTalks.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Toolbox talk not found");
    return rows[0];
  }

  async function fetchTemplate(id: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(safetyInspectionTemplates)
      .where(
        and(eq(safetyInspectionTemplates.id, id), eq(safetyInspectionTemplates.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Inspection template not found");
    return rows[0];
  }

  async function fetchRecord(id: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(safetyProgrammeRecords)
      .where(
        and(eq(safetyProgrammeRecords.id, id), eq(safetyProgrammeRecords.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Programme record not found");
    return rows[0];
  }

  async function projectCountry(projectId: string, companyId: string): Promise<string | null> {
    const rows = await app.db
      .select({ country: projects.country })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    return rows[0]?.country ?? null;
  }

  /** A worker must exist in the workforce register on THIS project. */
  async function assertWorker(workerId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select({ id: workers.id, fullName: workers.fullName, vendorId: workers.vendorId, trade: workers.trade })
      .from(workers)
      .where(
        and(eq(workers.id, workerId), eq(workers.companyId, companyId), eq(workers.projectId, projectId)),
      )
      .limit(1);
    if (!rows[0]) {
      throw badRequest(
        `Worker ${workerId} is not in this project's worker register. Attendance and injury records ` +
          `reference workforce.workers — the same register that carries induction, identity ` +
          `verification and site access — so that "has this person been briefed" can be answered ` +
          `about a person rather than about a form. Register the worker first.`,
      );
    }
    return rows[0];
  }

  async function assertVendor(vendorId: string, companyId: string) {
    const rows = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest(`Vendor ${vendorId} not found in this company`);
  }

  /* ---------------------------------------------------------------- */
  /* Signals                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Signal keys already raised for a detector, bounded by project.
   *
   * The project bound is not an optimisation, it is a correctness property at
   * scale: signals are never deleted, so a company-wide read of one detector
   * grows monotonically for the life of the tenant and every sweep pays for
   * every signal ever raised. Keys are unique per record, so restricting to
   * the project being swept cannot miss a duplicate — a record belongs to one
   * project.
   */
  async function alreadySignalled(
    companyId: string,
    detector: string,
    projectId: string | null,
  ): Promise<Set<string>> {
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.detector, detector),
          ...(projectId ? [eq(signals.projectId, projectId)] : []),
        ),
      );
    const keys = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { key?: unknown } | null;
      if (typeof refs?.key === "string") keys.add(refs.key);
    }
    return keys;
  }

  /* ---------------------------------------------------------------- */
  /* Reportability → obligation (ADR 0012)                             */
  /* ---------------------------------------------------------------- */

  /**
   * Assess an incident and persist the result: the classification columns a
   * regulator asks for, the deadline, and — the part that matters — an
   * OBLIGATION carrying that deadline.
   *
   * The obligation is the whole point. A statutory notification period and a
   * contractual time bar are the same object: a dated thing that must be done
   * and whose omission is usually fatal. Putting the RIDDOR clock in the same
   * register as the clause-notice clock means one overdue list, one warning
   * mechanism, and one place an auditor looks. A safety deadline living in a
   * safety screen is a deadline nobody outside the safety team ever sees.
   */
  async function applyReportability(
    row: IncidentRow,
    actorId: string,
    explicitRegimes: readonly string[] | null,
  ): Promise<{ row: IncidentRow; determination: ReportabilityDetermination }> {
    const country = await projectCountry(row.projectId, row.companyId);
    const regimeChoice = resolveRegimes(explicitRegimes ?? storedRegimes(row), country);
    const facts = factsFromIncident(row);
    const determination = assessReportability(facts, regimeChoice.regimes);
    determination.reasons.push(...regimeChoice.reasons);
    const detail = { ...row.detail } as Record<string, unknown>;
    const inputs = { ...detailObject(row, "reportabilityInputs") };
    if (regimeChoice.regimes.length > 0) inputs["regimes"] = regimeChoice.regimes;
    detail["reportabilityInputs"] = inputs;
    detail["reportability"] = determination;
    detail["reportabilityBasis"] = regimeChoice.basis;
    detail["reportabilityAssessedAt"] = new Date().toISOString();

    let obligationId = row.obligationId;
    const due = determination.reportDueAt;
    if (due) {
      const governing = determination.rules.find((r) => r.ruleId === determination.governingRuleId);
      const withinHours = governing?.deadline?.withinHours ?? 240;
      const warnDays = Math.min(3, Math.max(0.125, withinHours / 24 / 4));
      const trigger =
        `Notify the regulator of incident ${row.reference}: ${row.title} ` +
        `(${governing?.title ?? "statutory notification"})`;
      const sourceClause =
        `${OBLIGATION_PREFIX} ${determination.governingRuleId ?? "statutory notification"} — ` +
        `${governing?.citation ?? "statutory reporting duty"}`;
      if (obligationId) {
        await app.db
          .update(obligations)
          .set({ deadline: due, trigger, sourceClause, warnDaysBefore: warnDays })
          .where(and(eq(obligations.id, obligationId), eq(obligations.status, "open")));
      } else {
        obligationId = newId("obl");
        await app.db.insert(obligations).values({
          id: obligationId,
          companyId: row.companyId,
          projectId: row.projectId,
          sourceClause,
          trigger,
          deadline: due,
          warnDaysBefore: warnDays,
          evidenceRequirement:
            "The submitted statutory notification and the authority's reference for it",
          status: "open",
          createdBy: actorId,
        });
        await appendLedger(app.db, {
          companyId: row.companyId,
          projectId: row.projectId,
          actorId,
          action: "create",
          objectType: "obligation",
          objectId: obligationId,
          payload: {
            source: "safety_incident",
            incidentId: row.id,
            ruleId: determination.governingRuleId,
            deadline: due,
          },
          storePayload: true,
        });
      }
    } else if (obligationId) {
      /* The facts have changed and no notification is due any more — the lost
       * time was corrected from nine days to five, or the regimes were
       * narrowed. The incident's own columns are cleared below, but the
       * obligation this assessment created is a row in a REGISTER OTHER
       * PEOPLE READ: left open it shows a breached statutory duty against an
       * incident the safety register says is not reportable, and the two
       * screens then contradict each other in front of an auditor.
       *
       * It is withdrawn rather than deleted, and the reassessment that
       * withdrew it is named in the ledger, because "this duty was raised and
       * then found not to apply" is itself a fact somebody may need to
       * defend. `obligationId` is deliberately KEPT on the incident so the
       * withdrawn obligation stays reachable from it. */
      const withdrawn = await app.db
        .update(obligations)
        .set({ status: "waived" })
        .where(and(eq(obligations.id, obligationId), eq(obligations.status, "open")))
        .returning({ id: obligations.id });
      if (withdrawn.length > 0) {
        await appendLedger(app.db, {
          companyId: row.companyId,
          projectId: row.projectId,
          actorId,
          action: "state_change",
          objectType: "obligation",
          objectId: obligationId,
          payload: {
            act: "withdraw",
            from: "open",
            to: "waived",
            source: "safety_incident",
            incidentId: row.id,
            reference: row.reference,
            reason: "reportability_reassessed_not_reportable",
            note:
              `Withdrawn on reassessment of incident ${row.reference}: on the facts now held no ` +
              `statutory notification is due. ` +
              (determination.reasons[0] ?? "") +
              (determination.needsHumanReview
                ? " The determination still carries open questions — if they resolve the other way " +
                  "this obligation must be reinstated."
                : ""),
            regimes: determination.regimes,
            assessedRegimes: determination.assessedRegimes,
            needsHumanReview: determination.needsHumanReview,
          },
          storePayload: true,
        });
      }
    }

    const now = new Date().toISOString();
    await app.db
      .update(safetyIncidents)
      .set({
        isReportable: determination.isReportable ? 1 : 0,
        reportableRegimes: determination.regimes,
        riddorCategory: determination.riddorCategory,
        oshaCaseType: determination.oshaCaseType,
        reportDueAt: due,
        obligationId,
        detail,
        updatedAt: now,
      })
      .where(eq(safetyIncidents.id, row.id));

    await appendLedger(app.db, {
      companyId: row.companyId,
      projectId: row.projectId,
      actorId,
      action: "state_change",
      objectType: "safety_incident",
      objectId: row.id,
      payload: {
        act: "reportability_assessed",
        isReportable: determination.isReportable,
        regimes: determination.regimes,
        riddorCategory: determination.riddorCategory,
        oshaCaseType: determination.oshaCaseType,
        reportDueAt: due,
        governingRuleId: determination.governingRuleId,
        metRuleIds: determination.metRuleIds,
        indeterminateRuleIds: determination.indeterminateRuleIds,
        needsHumanReview: determination.needsHumanReview,
        obligationId,
      },
      storePayload: true,
    });

    const refreshed = await fetchIncident(row.id, row.companyId, row.projectId);
    return { row: refreshed, determination };
  }

  /* ---------------------------------------------------------------- */
  /* THE LAZY SWEEP                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Six detectors, each keyed in `evidenceRefs.key` so a repeated read never
   * raises the same finding twice:
   *
   *   safety_notification_deadline_missed   key = incidentId:regime
   *   safety_investigation_overdue          key = incidentId
   *   safety_corrective_action_overdue      key = actionId
   *   safety_statutory_inspection_overdue   key = inspectionId
   *   safety_programme_record_expired       key = recordId
   *   safety_device_alarm_unanswered        key = sensorEventId
   *
   * The notification key carries the REGIME because an incident answerable to
   * two authorities owes two duties, and one missed duty must be able to raise
   * a finding while the other is discharged.
   *
   * Status flips (an expired record → `expired`, a scheduled inspection past
   * its date → `overdue`) are a second, independent guard: the candidate
   * query selects on the pre-flip status, so a swept row leaves the set.
   *
   * `projectId === null` sweeps company-wide, which is what the scheduler and
   * the company-level programme-record routes need.
   */
  async function sweepSafety(
    companyId: string,
    projectId: string | null,
    /** null when the scheduler runs it — the system actor (see lib/scheduler.ts) */
    actorId: string | null,
  ): Promise<void> {
    const asOf = todayISO();
    const nowISO = new Date().toISOString();

    /* (1) a statutory notification deadline passed, PER REGIME.
     *
     * The candidate set is every reportable incident that is not closed —
     * NOT, as it once was, every incident with a null `regulator_notified_at`.
     * That column is a derived summary of the per-regime entries and is only
     * set once every duty is discharged; selecting on it hid the second duty
     * of a dual-regime incident the moment the first was recorded. */
    const dueIncidents = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          ...(projectId ? [eq(safetyIncidents.projectId, projectId)] : []),
          eq(safetyIncidents.isReportable, 1),
          ne(safetyIncidents.status, "void"),
        ),
      );
    const withMissedDuty: Array<{ row: IncidentRow; state: NotificationState }> = [];
    for (const inc of dueIncidents) {
      const state = incidentNotificationState(inc, nowISO);
      if (state.duties.some((d) => d.state === "missed")) withMissedDuty.push({ row: inc, state });
    }
    if (withMissedDuty.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_notification_deadline_missed", projectId);
      for (const { row: inc, state } of withMissedDuty) {
        if (inc.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, inc.obligationId), eq(obligations.status, "open")));
        }
        let lastSignalId: string | null = null;
        for (const duty of state.duties) {
          if (duty.state !== "missed") continue;
          const key = missedNotificationKey(inc.id, duty.regime);
          if (seen.has(key)) continue;
          seen.add(key);
          const sigId = newId("sig");
          lastSignalId = sigId;
          const others = state.duties.filter((d) => d.regime !== duty.regime);
          await app.db.insert(signals).values({
            id: sigId,
            companyId,
            projectId: inc.projectId,
            detector: "safety_notification_deadline_missed",
            severity: "critical",
            confidence: 1,
            title: `Statutory notification deadline missed (${duty.regime}) — ${inc.reference}: ${inc.title}`,
            explanation:
              `Incident ${inc.reference} is reportable under ${duty.regime} and the notification to ` +
              `${duty.authority ?? "the enforcing authority"} was due by ${duty.dueAt}. No notification ` +
              `under that regime has been recorded and the deadline has passed by ` +
              `${duty.hoursLate ?? "an unknown number of"} hour(s). ` +
              (duty.ruleId ? `The governing rule is ${duty.ruleId} — ${duty.citation}. ` : "") +
              (others.length > 0
                ? `\n\nThis incident is answerable under ${others.length + 1} regimes; the others stand ` +
                  `as: ${others.map((o) => `${o.regime} — ${o.state.replace(/_/g, " ")}`).join("; ")}. ` +
                  `Discharging one duty discharges nothing of the others.`
                : "") +
              `\n\nWhat this now means: failing to notify within the statutory period is itself an offence, ` +
              `separate from anything the investigation finds about the accident. It is trivially provable ` +
              `from this record and from the incident's own timestamps, it removes any argument that the ` +
              `site's systems were under control, and it is the first thing an inspector establishes. ` +
              (duty.consequenceIfMissed ?? "") +
              `\n\nNotify now — a late report is materially better than an absent one — record the ` +
              `notification and its reference against this incident, and treat the delay itself as a ` +
              `finding of the investigation.`,
            evidenceRefs: {
              key,
              incidentId: inc.id,
              reference: inc.reference,
              regime: duty.regime,
              reportDueAt: duty.dueAt,
              hoursLate: duty.hoursLate,
              regimes: inc.reportableRegimes,
              riddorCategory: inc.riddorCategory,
              oshaCaseType: inc.oshaCaseType,
              governingRuleId: duty.ruleId,
              citation: duty.citation,
              obligationId: inc.obligationId,
            },
          });
        }
        if (lastSignalId) {
          await app.db
            .update(safetyIncidents)
            .set({ signalId: lastSignalId, updatedAt: nowISO })
            .where(eq(safetyIncidents.id, inc.id));
        }
      }
    }

    /* (2) an incident with no investigation past its due date */
    const uninvestigated = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          ...(projectId ? [eq(safetyIncidents.projectId, projectId)] : []),
          inArray(safetyIncidents.investigationStatus, ["not_started", "in_progress", "reopened"]),
          inArray(safetyIncidents.status, ["reported", "under_investigation", "actions_open", "reopened"]),
        ),
      );
    const lateInvestigations = uninvestigated.filter(
      (i) => i.investigationDueDate != null && i.investigationDueDate < asOf,
    );
    if (lateInvestigations.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_investigation_overdue", projectId);
      for (const inc of lateInvestigations) {
        if (seen.has(inc.id)) continue;
        seen.add(inc.id);
        const daysLate = daysBetweenDates(inc.investigationDueDate!, asOf);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: inc.projectId,
          detector: "safety_investigation_overdue",
          severity: inc.severity === "catastrophic" || inc.severity === "major" ? "critical" : "high",
          confidence: 1,
          title: `Investigation overdue — ${inc.reference}: ${inc.title}`,
          explanation:
            `The investigation of ${inc.reference} (${inc.incidentType}, severity ${inc.severity}) was due ` +
            `by ${inc.investigationDueDate} and is ${daysLate} day(s) late; its status is still ` +
            `\`${inc.investigationStatus}\`. Evidence decays on a schedule of its own: the scene is ` +
            `restored, the plant is repaired or returned, the CCTV is overwritten and the witnesses ` +
            `reconstruct rather than recall. An investigation started late produces a root cause that ` +
            `cannot be tested, which means the corrective actions taken from it cannot be defended — ` +
            `to a regulator, to an insurer, or to the next person hurt the same way. ` +
            `Appoint a lead who is not in the line management of the injured person and start it.`,
          evidenceRefs: {
            key: inc.id,
            incidentId: inc.id,
            reference: inc.reference,
            investigationDueDate: inc.investigationDueDate,
            investigationStatus: inc.investigationStatus,
            daysLate,
          },
        });
      }
    }

    /* (3) overdue corrective actions */
    const openActions = await app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          ...(projectId ? [eq(safetyCorrectiveActions.projectId, projectId)] : []),
          inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
        ),
      );
    const overdueActions = openActions.filter((a) => a.dueDate < asOf);
    if (overdueActions.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_corrective_action_overdue", projectId);
      for (const act of overdueActions) {
        if (seen.has(act.id)) continue;
        seen.add(act.id);
        const daysLate = daysBetweenDates(act.dueDate, asOf);
        const weak =
          act.hierarchyOfControl === "administrative" || act.hierarchyOfControl === "ppe";
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: act.projectId,
          detector: "safety_corrective_action_overdue",
          severity: PRIORITY_TO_SIGNAL_SEVERITY[act.priority] ?? "medium",
          confidence: 1,
          title: `Corrective action overdue — ${act.reference}: ${act.title}`,
          explanation:
            `Corrective action ${act.reference}, raised from ${act.sourceType} ` +
            `${act.sourceReference ?? act.sourceId}, was due on ${act.dueDate} and is ${daysLate} day(s) ` +
            `late. Its status is \`${act.status}\` and its control is \`${act.hierarchyOfControl ?? "not recorded"}\`.` +
            `\n\nThe hazard this action was raised against is still present, and the register now shows ` +
            `that it was identified, owned and left. That is the single worst evidential position after ` +
            `an event: knowledge without action is what turns an accident into a prosecution and a claim ` +
            `into an uninsured one. ` +
            (weak
              ? `It is also worth noting that this action sits at the weak end of the hierarchy of ` +
                `control — a briefing or an item of PPE, not an elimination or an engineering fix. If a ` +
                `weak control cannot even be delivered on time, the case for a stronger one is stronger still. `
              : "") +
            `Deliver it, revise the date with a recorded reason, or escalate it — but do not leave it.`,
          evidenceRefs: {
            key: act.id,
            actionId: act.id,
            reference: act.reference,
            sourceType: act.sourceType,
            sourceId: act.sourceId,
            dueDate: act.dueDate,
            daysLate,
            ownerId: act.ownerId,
            hierarchyOfControl: act.hierarchyOfControl,
          },
        });
      }
    }

    /* (4) statutory inspections past their next-due date */
    const statutory = await app.db
      .select()
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.companyId, companyId),
          ...(projectId ? [eq(safetyInspections.projectId, projectId)] : []),
          eq(safetyInspections.isStatutory, 1),
        ),
      );
    const overdueStatutory = statutory.filter(
      (i) => i.nextDueDate != null && i.nextDueDate < asOf && i.status !== "void",
    );
    if (overdueStatutory.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_statutory_inspection_overdue", projectId);
      for (const insp of overdueStatutory) {
        if (seen.has(insp.id)) continue;
        seen.add(insp.id);
        const daysLate = daysBetweenDates(insp.nextDueDate!, asOf);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: insp.projectId,
          detector: "safety_statutory_inspection_overdue",
          severity: "high",
          confidence: 1,
          title: `Statutory re-inspection overdue — ${insp.reference}: ${insp.title}`,
          explanation:
            `The statutory re-inspection following ${insp.reference} (${insp.inspectionType}) fell due on ` +
            `${insp.nextDueDate} and is ${daysLate} day(s) overdue. ` +
            `\n\nA statutory inspection interval is not a housekeeping target; it is the condition on which ` +
            `the equipment or the structure may lawfully continue in use. Once the interval has lapsed the ` +
            `item is, for the purposes of the regime and usually for the purposes of the insurer, ` +
            `uninspected — and the last valid report says nothing about its condition today. Take it out ` +
            `of service or re-inspect it, and record which of those you did.`,
          evidenceRefs: {
            key: insp.id,
            inspectionId: insp.id,
            reference: insp.reference,
            inspectionType: insp.inspectionType,
            nextDueDate: insp.nextDueDate,
            daysLate,
            equipmentId: insp.equipmentId,
          },
        });
      }
    }

    /* scheduled inspections whose date has passed — a status flip, not a signal */
    const scheduled = await app.db
      .select({ id: safetyInspections.id, scheduledFor: safetyInspections.scheduledFor, projectId: safetyInspections.projectId, reference: safetyInspections.reference })
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.companyId, companyId),
          ...(projectId ? [eq(safetyInspections.projectId, projectId)] : []),
          eq(safetyInspections.status, "scheduled"),
        ),
      );
    for (const insp of scheduled) {
      if (!insp.scheduledFor || insp.scheduledFor >= asOf) continue;
      await app.db
        .update(safetyInspections)
        .set({ status: "overdue", updatedAt: nowISO })
        .where(and(eq(safetyInspections.id, insp.id), eq(safetyInspections.status, "scheduled")));
      await appendLedger(app.db, {
        companyId,
        projectId: insp.projectId,
        actorId,
        action: "state_change",
        objectType: "safety_inspection",
        objectId: insp.id,
        payload: { from: "scheduled", to: "overdue", scheduledFor: insp.scheduledFor, derived: true },
      });
    }

    /* (5) expired competencies, permits and other programme records */
    const liveRecords = await app.db
      .select()
      .from(safetyProgrammeRecords)
      .where(
        and(
          eq(safetyProgrammeRecords.companyId, companyId),
          ...(projectId
            ? [
                or(
                  eq(safetyProgrammeRecords.projectId, projectId),
                  isNull(safetyProgrammeRecords.projectId),
                )!,
              ]
            : []),
          inArray(safetyProgrammeRecords.status, ["draft", "in_review", "approved", "active"]),
        ),
      );
    const expired = liveRecords.filter((r) => r.expiresAt != null && r.expiresAt < asOf);
    if (expired.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_programme_record_expired", projectId);
      for (const rec of expired) {
        await app.db
          .update(safetyProgrammeRecords)
          .set({ status: "expired", updatedAt: nowISO })
          .where(
            and(
              eq(safetyProgrammeRecords.id, rec.id),
              inArray(safetyProgrammeRecords.status, ["draft", "in_review", "approved", "active"]),
            ),
          );
        await appendLedger(app.db, {
          companyId,
          projectId: rec.projectId,
          actorId,
          action: "state_change",
          objectType: "safety_programme_record",
          objectId: rec.id,
          payload: { from: rec.status, to: "expired", expiresAt: rec.expiresAt, derived: true },
        });
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
        const critical = CRITICAL_RECORD_KINDS.has(rec.recordKind);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: rec.projectId,
          detector: "safety_programme_record_expired",
          severity: critical ? "critical" : "high",
          confidence: 1,
          title: `${critical ? "Permit or competency expired" : "Safety programme record expired"} — ${rec.reference}: ${rec.title}`,
          explanation:
            `${rec.recordKind.replace(/_/g, " ")} ${rec.reference} ("${rec.title}"${rec.version ? `, version ${rec.version}` : ""}) ` +
            `expired on ${rec.expiresAt} and has not been replaced or superseded.` +
            (rec.workerId
              ? `\n\nThis is a personal record. Until it is renewed the worker it belongs to is, on the ` +
                `documentation the site holds, not competent for the activity it covers. If they are ` +
                `working on it today, the site is both in breach and — should anything happen — without ` +
                `the one document that would have answered the first question asked.`
              : rec.recordKind === "permit_to_work"
                ? `\n\nAn expired permit does not merely lapse: the activity it authorised is now ` +
                  `unauthorised, and any control it imposed (isolation, atmospheric testing, standby ` +
                  `attendance) is no longer being verified by anyone. Stop the activity or reissue.`
                : `\n\nA risk assessment, method statement or plan that has passed its expiry has not ` +
                  `been shown to reflect the works as they are being carried out now. It is the document ` +
                  `an inspector will ask for and the one that will be dated.`) +
            `\n\nRenew it, supersede it with a current version, or withdraw it and stop the work it covers.`,
          evidenceRefs: {
            key: rec.id,
            recordId: rec.id,
            reference: rec.reference,
            recordKind: rec.recordKind,
            expiresAt: rec.expiresAt,
            workerId: rec.workerId,
            vendorId: rec.vendorId,
          },
        });
      }
    }

    /* (6) a life-safety device alarm nobody answered.
     *
     * A lone-worker device whose man-down alarm sits unacknowledged is not
     * protecting the person wearing it, and the response TIME is the only
     * thing the register can prove afterwards. The clock is set on ingest
     * from the alarm class, so this sweep is a straight date comparison. */
    const openAlarms = await app.db
      .select()
      .from(safetySensorEvents)
      .where(
        and(
          eq(safetySensorEvents.companyId, companyId),
          ...(projectId ? [eq(safetySensorEvents.projectId, projectId)] : []),
          eq(safetySensorEvents.status, "open"),
        ),
      );
    const unanswered = openAlarms.filter(
      (a) => a.acknowledgeDueAt != null && Date.parse(a.acknowledgeDueAt) < Date.parse(nowISO),
    );
    if (unanswered.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_device_alarm_unanswered", projectId);
      for (const alarm of unanswered) {
        if (seen.has(alarm.id)) continue;
        seen.add(alarm.id);
        const lifeSafety = LIFE_SAFETY_ALARMS.has(alarm.kind);
        const minutesLate = Math.round(
          (Date.parse(nowISO) - Date.parse(alarm.acknowledgeDueAt!)) / 60_000,
        );
        const sigId = newId("sig");
        await app.db.insert(signals).values({
          id: sigId,
          companyId,
          projectId: alarm.projectId,
          detector: "safety_device_alarm_unanswered",
          severity: lifeSafety ? "critical" : "medium",
          confidence: 1,
          title: `${lifeSafety ? "Life-safety" : "Device"} alarm unanswered — ${alarm.reference}: ${alarm.kind.replace(/_/g, " ")}`,
          explanation:
            `A \`${alarm.kind.replace(/_/g, " ")}\` alarm was received from ` +
            `${alarm.deviceId ?? "an unidentified device"} at ${alarm.occurredAt} and required ` +
            `acknowledgement by ${alarm.acknowledgeDueAt}. Nobody has acknowledged it; it is ` +
            `${minutesLate} minute(s) past that point.` +
            (lifeSafety
              ? `\n\nThis is a life-safety class: the device is asserting that the person wearing it ` +
                `may be unconscious, immobile or in an atmosphere that will kill them. The only ` +
                `acceptable response is somebody physically confirming otherwise. An alarm of this ` +
                `class left unanswered converts a device that would have saved somebody into a record ` +
                `that the site was told and did nothing — which is the worst possible evidential ` +
                `position and the one the coroner reads out.`
              : `\n\nAn unanswered alarm is a device the workforce will stop trusting. Either respond ` +
                `to them or turn off the class that nobody is going to act on — a fleet generating ` +
                `alarms into silence is worse than no fleet, because it looks like coverage.`) +
            `\n\nAcknowledge it with what was actually found, or convert it to an incident or an ` +
            `observation if something happened.`,
          evidenceRefs: {
            key: alarm.id,
            sensorEventId: alarm.id,
            reference: alarm.reference,
            kind: alarm.kind,
            deviceId: alarm.deviceId,
            workerId: alarm.workerId,
            occurredAt: alarm.occurredAt,
            acknowledgeDueAt: alarm.acknowledgeDueAt,
            minutesLate,
          },
        });
        await app.db
          .update(safetySensorEvents)
          .set({ signalId: sigId, updatedAt: nowISO })
          .where(eq(safetySensorEvents.id, alarm.id));
      }
    }
  }

  /**
   * The read-path sweep, rate-limited per project.
   *
   * The sweep used to run on every list AND every detail GET, which meant
   * opening one incident drawer cost five register-wide selects plus a scan of
   * every signal the company had ever raised for a detector. It now runs on
   * LIST reads only, at most once every few minutes per project, and the
   * scheduler (`safety.sweeps`) owns the guarantee that it runs at all. The
   * throttle is in memory and per process: a replica that has not swept
   * recently will sweep, which is harmless because every detector is
   * idempotent on its key.
   */
  const lastSweptAt = new Map<string, number>();
  /** Off under test, where determinism beats latency and nothing is at scale. */
  const SWEEP_THROTTLE_MS = app.appConfig.NODE_ENV === "test" ? 0 : 5 * 60_000;

  async function sweepThrottled(
    companyId: string,
    projectId: string | null,
    actorId: string,
  ): Promise<boolean> {
    const key = `${companyId}:${projectId ?? "*"}`;
    const now = Date.now();
    const last = lastSweptAt.get(key);
    if (SWEEP_THROTTLE_MS > 0 && last !== undefined && now - last < SWEEP_THROTTLE_MS) return false;
    // claim the slot BEFORE the await so two concurrent reads do not both sweep
    lastSweptAt.set(key, now);
    try {
      await sweepSafety(companyId, projectId, actorId);
      return true;
    } catch (err) {
      // a failed sweep must not fail the read it was riding on, and it must
      // not poison the throttle either — clear the claim so the next read retries
      lastSweptAt.delete(key);
      app.log.error({ err, companyId, projectId }, "safety sweep failed on read path");
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Presentation                                                      */
  /* ---------------------------------------------------------------- */

  const OBSERVATION_CLOSED_STATUSES = ["closed", "void"];

  function decorateObservation(o: ObservationRow, asOf: string) {
    const risk = optionalRiskScore(o.riskLikelihood, o.riskSeverity);
    const live = !OBSERVATION_CLOSED_STATUSES.includes(o.status);
    const isOverdue = live && o.dueDate != null && o.dueDate < asOf;
    return {
      ...o,
      workStopped: asBool(o.workStopped),
      risk: risk.score,
      riskReasons: risk.reasons,
      isOverdue,
      daysOverdue: isOverdue && o.dueDate ? daysBetweenDates(o.dueDate, asOf) : null,
      /** the state an enforcement officer asks about first */
      workStoppedAndNotResumed: asBool(o.workStopped) && o.workResumedAt == null,
    };
  }

  /**
   * Names resolved for a batch of incidents. The register used to render the
   * injured person through the COMPANY USER directory, so every incident whose
   * injured person was a registered worker showed a raw `wrk_` id in the
   * column an inspector reads first. Names come from the worker register
   * itself, resolved once per response rather than per row.
   */
  async function resolveWorkerNames(
    workerIds: readonly (string | null | undefined)[],
    companyId: string,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(workerIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const found = await app.db
      .select({ id: workers.id, fullName: workers.fullName })
      .from(workers)
      .where(and(eq(workers.companyId, companyId), inArray(workers.id, ids)));
    return new Map(found.map((w) => [w.id, w.fullName]));
  }

  async function resolveInjuredNames(
    rows: readonly IncidentRow[],
    companyId: string,
  ): Promise<Map<string, string>> {
    return resolveWorkerNames(
      rows.map((r) => r.workerId),
      companyId,
    );
  }

  function decorateIncident(i: IncidentRow, asOf: string, workerNames?: Map<string, string>) {
    const det = storedDetermination(i);
    const delay = computeReportingDelay(i.occurredAt, i.reportedAt);
    const nowISO = new Date().toISOString();
    const notification = incidentNotificationState(i, nowISO);
    const missed = notification.anyMissed;
    const hoursRemaining =
      notification.duties.find((d) => d.state === "outstanding" && d.hoursRemaining !== null)
        ?.hoursRemaining ??
      (i.reportDueAt && !i.regulatorNotifiedAt
        ? Math.round(((Date.parse(i.reportDueAt) - Date.parse(nowISO)) / 3_600_000) * 10) / 10
        : null);
    const investigationOverdue =
      i.investigationDueDate != null &&
      i.investigationDueDate < asOf &&
      ["not_started", "in_progress", "reopened"].includes(i.investigationStatus);
    return {
      ...i,
      isFatality: asBool(i.isFatality),
      isLostTime: asBool(i.isLostTime),
      workStopped: asBool(i.workStopped),
      thirdPartyInvolved: asBool(i.thirdPartyInvolved),
      emergencyServicesAttended: asBool(i.emergencyServicesAttended),
      isReportable: asBool(i.isReportable),
      isInsurableClaim: asBool(i.isInsurableClaim),
      regulatorVisitExpected: asBool(i.regulatorVisitExpected),
      enforcementNoticeReceived: asBool(i.enforcementNoticeReceived),
      isConfidential: asBool(i.isConfidential),
      reportingDelay: delay,
      reportability: det,
      /** the injured person's name, resolved from the worker register */
      injuredPersonDisplayName: i.workerId
        ? (workerNames?.get(i.workerId) ?? null)
        : i.injuredPersonName,
      notification: {
        required: asBool(i.isReportable),
        regimes: i.reportableRegimes ?? [],
        riddorCategory: i.riddorCategory,
        oshaCaseType: i.oshaCaseType,
        dueAt: notification.earliestDueAt ?? i.reportDueAt,
        notifiedAt: i.regulatorNotifiedAt,
        notifiedBy: i.regulatorNotifiedBy,
        reference: i.regulatorReference,
        notifications: i.notifications ?? [],
        missed,
        hoursRemaining,
        obligationId: i.obligationId,
        needsHumanReview: det?.needsHumanReview ?? null,
        openQuestions: det?.openQuestions ?? [],
        /** one entry per regime — the whole duty, not a single flag */
        duties: notification.duties,
        outstandingRegimes: notification.outstanding,
        missedRegimes: notification.missed,
        allDischarged: notification.allDischarged,
        reasons: notification.reasons,
      },
      investigation: {
        status: i.investigationStatus,
        leadId: i.investigationLeadId,
        dueDate: i.investigationDueDate,
        isOverdue: investigationOverdue,
        daysOverdue:
          investigationOverdue && i.investigationDueDate
            ? daysBetweenDates(i.investigationDueDate, asOf)
            : null,
        startedAt: i.investigationStartedAt,
        completedAt: i.investigationCompletedAt,
        rootCauseMethod: i.rootCauseMethod,
        rootCause: i.rootCause,
        contributingFactors: i.contributingFactors ?? [],
        findings: i.investigationFindings,
        reportFileId: i.investigationReportFileId,
        approvedBy: i.approvedBy,
        approvedAt: i.approvedAt,
      },
    };
  }

  function decorateAction(a: ActionRow, asOf: string) {
    const live = (LIVE_ACTION_STATUSES as readonly string[]).includes(a.status);
    const isOverdue = live && a.dueDate < asOf && a.completedAt == null;
    return {
      ...a,
      isOverdue,
      daysOverdue: isOverdue ? daysBetweenDates(a.dueDate, asOf) : null,
      /** an action completed but never shown to have worked is not closed */
      effectivenessOutstanding: a.status !== "cancelled" && a.effectivenessVerdict === "pending",
      isWeakControl: a.hierarchyOfControl === "administrative" || a.hierarchyOfControl === "ppe",
      canClose: a.effectivenessVerdict === "effective" || a.effectivenessVerdict === "partially_effective",
    };
  }

  function decorateInspection(i: InspectionRow, asOf: string) {
    const reInspectionOverdue =
      asBool(i.isStatutory) && i.nextDueDate != null && i.nextDueDate < asOf && i.status !== "void";
    return {
      ...i,
      isStatutory: asBool(i.isStatutory),
      reInspectionOverdue,
      daysOverdue: reInspectionOverdue && i.nextDueDate ? daysBetweenDates(i.nextDueDate, asOf) : null,
    };
  }

  function decorateRecord(r: RecordRow, asOf: string) {
    const daysToExpiry = r.expiresAt ? daysBetweenDates(asOf, r.expiresAt) : null;
    return {
      ...r,
      isExpired: r.expiresAt != null && r.expiresAt < asOf,
      daysToExpiry,
      reviewOverdue: r.reviewDueDate != null && r.reviewDueDate < asOf,
      acknowledgementShortfall:
        r.requiredAcknowledgementCount != null
          ? Math.max(0, r.requiredAcknowledgementCount - r.acknowledgementCount)
          : null,
      isCriticalKind: CRITICAL_RECORD_KINDS.has(r.recordKind),
    };
  }

  /** Keep `openActionCount` on the parent register honest after any action move. */
  /**
   * The observation lifecycle, derived from the actions raised off it.
   *
   * `SAFETY_OBSERVATION_STATUSES` documents raised → assigned → actioned →
   * verified → closed, and the board draws a lane for each. Nothing ever set
   * `actioned` or `verified`: create set open/action_assigned, assign set
   * action_assigned and close set closed, so the two middle lanes of the
   * primary view were permanently empty and the documented lifecycle did not
   * exist. Completing the corrective actions IS what moves an observation, so
   * the status is derived from them here rather than invented by a button
   * somebody has to remember to press.
   *
   *   every live action verified/closed  → `verified`
   *   every live action at least completed → `actioned`
   *   any action still open/in progress   → `action_assigned`
   *   no live action at all               → `open`
   *
   * `closed` and `void` are terminal human decisions and are never overwritten.
   */
  function deriveObservationStatus(
    current: string,
    statuses: readonly string[],
  ): { status: string; basis: string } | null {
    if (current === "closed" || current === "void") return null;
    const live = statuses.filter((st) => st !== "cancelled");
    let next: string;
    let basis: string;
    if (live.length === 0) {
      /* Every action was cancelled, or none was ever raised. The status is
       * left exactly as the humans set it: an observation assigned to
       * somebody without a formal corrective action is a legitimate state,
       * and resetting it to `open` here would silently undo an assignment. */
      return null;
    } else if (live.some((st) => st === "open" || st === "in_progress")) {
      next = "action_assigned";
      basis = `${live.filter((st) => st === "open" || st === "in_progress").length} of ${live.length} corrective action(s) are still open`;
    } else if (live.every((st) => st === "verified" || st === "closed")) {
      next = "verified";
      basis = `all ${live.length} corrective action(s) have been verified by somebody other than the person who did the work`;
    } else {
      next = "actioned";
      basis = `all ${live.length} corrective action(s) are complete but not yet verified`;
    }
    return next === current ? null : { status: next, basis };
  }

  async function refreshOpenActionCount(sourceType: string, sourceId: string, companyId: string) {
    const actionRows = await app.db
      .select({ status: safetyCorrectiveActions.status })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.sourceType, sourceType),
          eq(safetyCorrectiveActions.sourceId, sourceId),
        ),
      );
    const statuses = actionRows.map((r) => r.status);
    const n = statuses.filter((st) => (OPEN_ACTION_STATUSES as readonly string[]).includes(st)).length;
    const now = new Date().toISOString();
    if (sourceType === "incident") {
      await app.db
        .update(safetyIncidents)
        .set({ openActionCount: n, updatedAt: now })
        .where(eq(safetyIncidents.id, sourceId));
    } else if (sourceType === "observation") {
      const existing = await app.db
        .select({
          id: safetyObservations.id,
          companyId: safetyObservations.companyId,
          projectId: safetyObservations.projectId,
          reference: safetyObservations.reference,
          status: safetyObservations.status,
        })
        .from(safetyObservations)
        .where(and(eq(safetyObservations.id, sourceId), eq(safetyObservations.companyId, companyId)))
        .limit(1);
      const obs = existing[0];
      const move = obs ? deriveObservationStatus(obs.status, statuses) : null;
      await app.db
        .update(safetyObservations)
        .set({ openActionCount: n, ...(move ? { status: move.status } : {}), updatedAt: now })
        .where(eq(safetyObservations.id, sourceId));
      if (obs && move) {
        await appendLedger(app.db, {
          companyId,
          projectId: obs.projectId,
          actorId: null,
          action: "state_change",
          objectType: "safety_observation",
          objectId: sourceId,
          payload: {
            act: "derive_status",
            reference: obs.reference,
            from: obs.status,
            to: move.status,
            basis: move.basis,
            actionStatuses: statuses,
            derived: true,
          },
        });
      }
    } else if (sourceType === "inspection") {
      await app.db
        .update(safetyInspections)
        .set({ openActionCount: n, updatedAt: now })
        .where(eq(safetyInspections.id, sourceId));
    }
  }

  /* ================================================================ */
  /* OBSERVATIONS                                                      */
  /* ================================================================ */

  app.get("/projects/:projectId/safety/observations", { preHandler: readGate }, async (req) => {
    const q = observationListQuery.parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    const asOf = todayISO();
    const filters = [
      eq(safetyObservations.companyId, req.companyId!),
      eq(safetyObservations.projectId, req.projectId!),
    ];
    if (q.kind) filters.push(eq(safetyObservations.kind, q.kind));
    if (q.category) filters.push(eq(safetyObservations.category, q.category));
    if (q.severity) filters.push(eq(safetyObservations.severity, q.severity));
    if (q.status) filters.push(eq(safetyObservations.status, q.status));
    if (q.vendorId) filters.push(eq(safetyObservations.vendorId, q.vendorId));
    if (q.assigneeId) filters.push(eq(safetyObservations.assigneeId, q.assigneeId));
    if (q.workStopped) filters.push(eq(safetyObservations.workStopped, q.workStopped === "true" ? 1 : 0));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetyObservations)
      .where(where)
      .orderBy(desc(safetyObservations.observedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db.select({ n: count() }).from(safetyObservations).where(where);
    let items = rows.map((r) => decorateObservation(r, asOf));
    if (q.overdue === "true") items = items.filter((i) => i.isOverdue);
    if (q.overdue === "false") items = items.filter((i) => !i.isOverdue);
    return paginate(items, Number(totalRows[0]?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/safety/observations",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = observationCreateSchema.parse(req.body);
      const kind = body.kind ?? "negative";
      if (body.workStopped === true && kind === "positive") {
        throw badRequest(
          "Work cannot be stopped on a positive observation. A stoppage is a response to a hazard; " +
            "recording it against a commendation makes the register unreadable.",
        );
      }
      if (body.workStopped === true && !body.immediateActionTaken) {
        throw badRequest(
          "An observation that stopped work must record what was done at the time " +
            "(`immediateActionTaken`). The stoppage is the first fact an enforcement officer asks " +
            "about, and \"work was stopped\" with no account of why or what was put in place is worse " +
            "than no record at all.",
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.workerId) await assertWorker(body.workerId, req.companyId!, req.projectId!);

      const risk = optionalRiskScore(body.riskLikelihood ?? null, body.riskSeverity ?? null);
      const seq = await nextRecordNumber(app.db, req.projectId!, "safety_observation");
      const reference = `OBS-${pad(seq)}`;
      const id = newId("obs");
      await app.db.insert(safetyObservations).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        kind,
        category: body.category ?? "other",
        severity: body.severity ?? "low",
        title: body.title,
        description: body.description ?? null,
        observedAt: body.observedAt,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        vendorId: body.vendorId ?? null,
        trade: body.trade ?? null,
        workerId: body.workerId ?? null,
        crewId: body.crewId ?? null,
        riskLikelihood: body.riskLikelihood ?? null,
        riskSeverity: body.riskSeverity ?? null,
        riskScore: risk.score?.score ?? null,
        immediateActionTaken: body.immediateActionTaken ?? null,
        workStopped: fromBool(body.workStopped),
        status: body.assigneeId ? "action_assigned" : "open",
        assigneeId: body.assigneeId ?? null,
        dueDate: body.dueDate ?? null,
        photoFileIds: body.photoFileIds ?? [],
        relatedIncidentId: body.relatedIncidentId ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_observation",
        objectId: id,
        payload: {
          reference,
          kind,
          category: body.category ?? "other",
          severity: body.severity ?? "low",
          riskLikelihood: body.riskLikelihood ?? null,
          riskSeverity: body.riskSeverity ?? null,
          riskScore: risk.score?.score ?? null,
          workStopped: body.workStopped === true,
        },
        storePayload: true,
      });
      const created = await fetchObservation(id, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...decorateObservation(created, todayISO()),
        riskAssessment: risk,
      });
    },
  );

  app.get(
    "/projects/:projectId/safety/observations/:observationId",
    { preHandler: readGate },
    async (req) => {
      const { observationId } = req.params as { observationId: string };
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      const actions = await app.db
        .select()
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "observation"),
            eq(safetyCorrectiveActions.sourceId, observationId),
          ),
        )
        .orderBy(asc(safetyCorrectiveActions.dueDate));
      const asOf = todayISO();
      return {
        ...decorateObservation(row, asOf),
        actions: actions.map((a) => decorateAction(a, asOf)),
      };
    },
  );

  app.patch(
    "/projects/:projectId/safety/observations/:observationId",
    { preHandler: standardGate },
    async (req) => {
      const { observationId } = req.params as { observationId: string };
      const body = observationPatchSchema.parse(req.body);
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw conflict(
          `Observation ${row.reference} is ${row.status}. Editing a closed observation rewrites the ` +
            `record of what was found and when — reopen it or raise a new one.`,
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.workerId) await assertWorker(body.workerId, req.companyId!, req.projectId!);
      const likelihood = body.riskLikelihood !== undefined ? body.riskLikelihood : row.riskLikelihood;
      const severity = body.riskSeverity !== undefined ? body.riskSeverity : row.riskSeverity;
      const risk = optionalRiskScore(likelihood, severity);
      const patch: Partial<typeof safetyObservations.$inferInsert> = {
        updatedAt: new Date().toISOString(),
        riskLikelihood: likelihood ?? null,
        riskSeverity: severity ?? null,
        riskScore: risk.score?.score ?? null,
      };
      for (const key of [
        "kind",
        "category",
        "severity",
        "title",
        "description",
        "observedAt",
        "locationId",
        "locationText",
        "latitude",
        "longitude",
        "vendorId",
        "trade",
        "workerId",
        "crewId",
        "immediateActionTaken",
        "assigneeId",
        "dueDate",
        "photoFileIds",
        "relatedIncidentId",
        "detail",
      ] as const) {
        if (body[key] !== undefined) {
          (patch as Record<string, unknown>)[key] = body[key];
        }
      }
      if (body.workStopped !== undefined) patch.workStopped = body.workStopped ? 1 : 0;
      await app.db
        .update(safetyObservations)
        .set(patch)
        .where(eq(safetyObservations.id, observationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_observation",
        objectId: observationId,
        payload: { reference: row.reference, changed: Object.keys(body) },
        storePayload: true,
      });
      const updated = await fetchObservation(observationId, req.companyId!, req.projectId!);
      return { ...decorateObservation(updated, todayISO()), riskAssessment: risk };
    },
  );

  app.post(
    "/projects/:projectId/safety/observations/:observationId/assign",
    { preHandler: standardGate },
    async (req) => {
      const { observationId } = req.params as { observationId: string };
      const body = observationAssignSchema.parse(req.body);
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw conflict(`Observation ${row.reference} is ${row.status} and cannot be assigned.`);
      }
      await app.db
        .update(safetyObservations)
        .set({
          assigneeId: body.assigneeId,
          dueDate: body.dueDate,
          status: row.status === "open" ? "action_assigned" : row.status,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(safetyObservations.id, observationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_observation",
        objectId: observationId,
        payload: {
          act: "assign",
          reference: row.reference,
          assigneeId: body.assigneeId,
          dueDate: body.dueDate,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return decorateObservation(
        await fetchObservation(observationId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/observations/:observationId/resume-work",
    { preHandler: standardGate },
    async (req) => {
      const { observationId } = req.params as { observationId: string };
      const body = resumeWorkSchema.parse(req.body);
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      if (!asBool(row.workStopped)) {
        throw badRequest(`Observation ${row.reference} did not stop work, so there is nothing to resume.`);
      }
      if (row.workResumedAt) {
        throw conflict(
          `Work was already recorded as resumed at ${row.workResumedAt}. A second record would ` +
            `overwrite the time the site actually went back to work.`,
        );
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who stopped the work may not be the person who declares it safe to resume. " +
            "A stoppage and its lifting are two judgements, and the second one is worth nothing if " +
            "it is made by the person under pressure to undo the first.",
        );
      }
      const resumedAt = body.resumedAt ?? new Date().toISOString();
      await app.db
        .update(safetyObservations)
        .set({ workResumedAt: resumedAt, updatedAt: new Date().toISOString() })
        .where(eq(safetyObservations.id, observationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_observation",
        objectId: observationId,
        payload: {
          act: "resume_work",
          reference: row.reference,
          resumedAt,
          controlsInPlace: body.controlsInPlace,
          stoppedBy: row.createdBy,
          resumedBy: req.user!.id,
        },
        storePayload: true,
      });
      return decorateObservation(
        await fetchObservation(observationId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/observations/:observationId/close",
    { preHandler: standardGate },
    async (req) => {
      const { observationId } = req.params as { observationId: string };
      const body = observationCloseSchema.parse(req.body);
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      if (row.status === "closed") throw conflict(`Observation ${row.reference} is already closed.`);
      if (row.status === "void") throw conflict(`Observation ${row.reference} is void.`);
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "An observation may not be closed by the person who raised it. Closure is an assertion " +
            "that the hazard is gone, and the observer is the one person who cannot test their own " +
            "assertion — see the schema note on `closedBy`.",
        );
      }
      if (asBool(row.workStopped) && row.workResumedAt == null && !body.workNotResumedReason) {
        throw badRequest(
          `Observation ${row.reference} stopped work and the stoppage has never been lifted. Either ` +
            `record the resumption (POST .../resume-work, by someone other than the observer) or ` +
            `state why the work was never resumed (\`workNotResumedReason\`). Closing a live stoppage ` +
            `silently leaves the site believing work is halted when the register says the matter is shut.`,
        );
      }
      const openActions = await app.db
        .select({ n: count() })
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "observation"),
            eq(safetyCorrectiveActions.sourceId, observationId),
            inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
          ),
        );
      if (Number(openActions[0]?.n ?? 0) > 0) {
        throw conflict(
          `Observation ${row.reference} still has ${openActions[0]?.n} open corrective action(s). ` +
            `Closing the observation would take the finding off the list while the fix is outstanding.`,
        );
      }
      const now = new Date().toISOString();
      const detail = { ...row.detail } as Record<string, unknown>;
      detail["closure"] = {
        note: body.note,
        evidenceFileIds: body.evidenceFileIds ?? [],
        workNotResumedReason: body.workNotResumedReason ?? null,
        closedBy: req.user!.id,
        closedAt: now,
      };
      await app.db
        .update(safetyObservations)
        .set({ status: "closed", closedBy: req.user!.id, closedAt: now, detail, updatedAt: now })
        .where(eq(safetyObservations.id, observationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_observation",
        objectId: observationId,
        payload: {
          act: "close",
          reference: row.reference,
          from: row.status,
          to: "closed",
          raisedBy: row.createdBy,
          closedBy: req.user!.id,
          note: body.note,
          evidenceFileIds: body.evidenceFileIds ?? [],
        },
        storePayload: true,
      });
      return decorateObservation(
        await fetchObservation(observationId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.delete(
    "/projects/:projectId/safety/observations/:observationId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { observationId } = req.params as { observationId: string };
      const row = await fetchObservation(observationId, req.companyId!, req.projectId!);
      if (row.status === "closed") {
        throw conflict(
          `Observation ${row.reference} is closed. A closed safety record is evidence — void it ` +
            `instead if it was raised in error, so the number is not silently reused.`,
        );
      }
      const actions = await app.db
        .select({ n: count() })
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "observation"),
            eq(safetyCorrectiveActions.sourceId, observationId),
          ),
        );
      if (Number(actions[0]?.n ?? 0) > 0) {
        throw conflict(
          `Observation ${row.reference} has corrective actions raised from it and cannot be deleted.`,
        );
      }
      await app.db
        .update(safetyObservations)
        .set({ status: "void", updatedAt: new Date().toISOString() })
        .where(eq(safetyObservations.id, observationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "safety_observation",
        objectId: observationId,
        payload: { reference: row.reference, from: row.status, to: "void" },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* INCIDENTS — the centre of the module                              */
  /* ================================================================ */

  /**
   * How long an investigation may take before it is late. Severity-driven
   * because evidence decays at the same rate whatever the outcome, and the
   * more serious the event the less of it survives an unhurried start.
   */
  const INVESTIGATION_DAYS: Record<string, number> = {
    catastrophic: 3,
    major: 5,
    serious: 7,
    minor: 14,
    negligible: 21,
  };

  app.get("/safety/reportability/rules", { preHandler: companyRead }, async () => ({
    /**
     * The rule catalogue, so a UI can show a duty-holder which tests the
     * platform actually applies and which it does not. Everything the engine
     * knows is in this list; anything absent from it has not been assessed.
     */
    rules: ruleCatalogue(),
    riddorSchedule2Classes: Object.entries(RIDDOR_SCHEDULE_2_CLASSES).map(([key, label]) => ({
      key,
      label,
    })),
    hospitalAdmissions: HOSPITAL_ADMISSIONS,
    note:
      "RIDDOR 2013 and 29 CFR Part 1904 are implemented. No other regime is — a project outside " +
      "GB or the US must have its classification recorded by hand, and the engine says so rather " +
      "than returning `not reportable`.",
  }));

  app.get("/projects/:projectId/safety/incidents", { preHandler: readGate }, async (req) => {
    const q = incidentListQuery.parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    const asOf = todayISO();
    const filters = [
      eq(safetyIncidents.companyId, req.companyId!),
      eq(safetyIncidents.projectId, req.projectId!),
    ];
    if (q.incidentType) filters.push(eq(safetyIncidents.incidentType, q.incidentType));
    if (q.severity) filters.push(eq(safetyIncidents.severity, q.severity));
    if (q.status) filters.push(eq(safetyIncidents.status, q.status));
    if (q.vendorId) filters.push(eq(safetyIncidents.vendorId, q.vendorId));
    if (q.workerId) filters.push(eq(safetyIncidents.workerId, q.workerId));
    if (q.investigationStatus) {
      filters.push(eq(safetyIncidents.investigationStatus, q.investigationStatus));
    }
    if (q.reportable) filters.push(eq(safetyIncidents.isReportable, q.reportable === "true" ? 1 : 0));
    if (q.from) filters.push(gte(safetyIncidents.occurredAt, `${q.from}T00:00:00Z`));
    if (q.to) filters.push(lte(safetyIncidents.occurredAt, `${q.to}T23:59:59Z`));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetyIncidents)
      .where(where)
      .orderBy(desc(safetyIncidents.occurredAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db.select({ n: count() }).from(safetyIncidents).where(where);
    const names = await resolveInjuredNames(rows, req.companyId!);
    return paginate(
      rows.map((r) => decorateIncident(r, asOf, names)),
      Number(totalRows[0]?.n ?? 0),
      q,
    );
  });

  app.post(
    "/projects/:projectId/safety/incidents",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = incidentCreateSchema.parse(req.body);
      const reportedAt = body.reportedAt ?? new Date().toISOString();
      if (Date.parse(reportedAt) < Date.parse(body.occurredAt)) {
        throw badRequest(
          `reportedAt ${reportedAt} falls before occurredAt ${body.occurredAt}. An incident cannot be ` +
            `reported before it happens, and the gap between those two timestamps is evidence — it is ` +
            `stored, not silently corrected.`,
        );
      }
      if (body.discoveredAt && Date.parse(body.discoveredAt) < Date.parse(body.occurredAt)) {
        throw badRequest(`discoveredAt ${body.discoveredAt} falls before occurredAt ${body.occurredAt}.`);
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.workerId) await assertWorker(body.workerId, req.companyId!, req.projectId!);
      if (!body.workerId && !body.injuredPersonName && (body.incidentType === "injury" || body.isFatality)) {
        throw badRequest(
          "An injury incident must identify the injured person: `workerId` for anyone in the worker " +
            "register (the same register that carries induction and site access), or " +
            "`injuredPersonName` for a visitor or member of the public who is in no register at all.",
        );
      }

      const severity = body.severity ?? (body.isFatality ? "catastrophic" : "minor");
      const treatmentLevel = body.treatmentLevel ?? (body.isFatality ? "fatality" : null);
      const delay = computeReportingDelay(body.occurredAt, reportedAt);
      const investigationDueDate =
        body.investigationDueDate ??
        addDaysISO(reportedAt.slice(0, 10), INVESTIGATION_DAYS[severity] ?? 14);

      const seq = await nextRecordNumber(app.db, req.projectId!, "safety_incident");
      const reference = `INC-${pad(seq)}`;
      const id = newId("inc");
      const detail: Record<string, unknown> = { ...(body.detail ?? {}) };
      detail["reportabilityInputs"] = {
        ...(body.reportabilityInputs ?? {}),
        ...(body.regimes ? { regimes: body.regimes } : {}),
      };
      if (!body.investigationDueDate) {
        detail["investigationDueDateDerived"] = {
          from: "severity",
          severity,
          days: INVESTIGATION_DAYS[severity] ?? 14,
        };
      }

      await app.db.insert(safetyIncidents).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        incidentType: body.incidentType,
        severity,
        title: body.title,
        description: body.description,
        occurredAt: body.occurredAt,
        discoveredAt: body.discoveredAt ?? null,
        reportedAt,
        reportingDelayHours: delay.hours,
        hoursIntoShift: body.hoursIntoShift ?? null,
        shift: body.shift ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        weatherConditions: body.weatherConditions ?? null,
        lightingConditions: body.lightingConditions ?? null,
        activityAtTime: body.activityAtTime ?? null,
        workerId: body.workerId ?? null,
        injuredPersonName: body.injuredPersonName ?? null,
        injuredPersonType: body.injuredPersonType ?? null,
        vendorId: body.vendorId ?? null,
        injuredPersonTrade: body.injuredPersonTrade ?? null,
        injuredPersonAge: body.injuredPersonAge ?? null,
        yearsExperience: body.yearsExperience ?? null,
        daysSinceInduction: body.daysSinceInduction ?? null,
        treatmentLevel,
        bodyPart: body.bodyPart ?? null,
        additionalBodyParts: body.additionalBodyParts ?? [],
        injuryNature: body.injuryNature ?? null,
        mechanism: body.mechanism ?? null,
        treatmentProvider: body.treatmentProvider ?? null,
        hospitalName: body.hospitalName ?? null,
        isLostTime: fromBool(body.isLostTime),
        lostTimeDays: body.lostTimeDays ?? null,
        restrictedDutyDays: body.restrictedDutyDays ?? null,
        returnToWorkDate: body.returnToWorkDate ?? null,
        isFatality: fromBool(body.isFatality),
        equipmentId: body.equipmentId ?? null,
        propertyDamageDescription: body.propertyDamageDescription ?? null,
        environmentalReleaseDescription: body.environmentalReleaseDescription ?? null,
        releaseQuantity: body.releaseQuantity ?? null,
        releaseUnit: body.releaseUnit ?? null,
        thirdPartyInvolved: fromBool(body.thirdPartyInvolved),
        thirdPartyDetail: body.thirdPartyDetail ?? null,
        immediateCause: body.immediateCause ?? null,
        immediateActionTaken: body.immediateActionTaken ?? null,
        workStopped: fromBool(body.workStopped),
        emergencyServicesAttended: fromBool(body.emergencyServicesAttended),
        witnesses: body.witnesses ?? [],
        witnessCount: (body.witnesses ?? []).length,
        investigationDueDate,
        estimatedCost: body.estimatedCost ?? null,
        currency: body.currency ?? "USD",
        isConfidential: fromBool(body.isConfidential),
        photoFileIds: body.photoFileIds ?? [],
        attachmentFileIds: body.attachmentFileIds ?? [],
        status: "reported",
        detail,
        createdBy: req.user!.id,
        reportedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_incident",
        objectId: id,
        payload: {
          reference,
          incidentType: body.incidentType,
          severity,
          occurredAt: body.occurredAt,
          reportedAt,
          reportingDelayHours: delay.hours,
          isFatality: body.isFatality === true,
          workerId: body.workerId ?? null,
          injuredPersonType: body.injuredPersonType ?? null,
          treatmentLevel,
          investigationDueDate,
        },
        storePayload: true,
      });

      const stored = await fetchIncident(id, req.companyId!, req.projectId!);
      const { row, determination } = await applyReportability(
        stored,
        req.user!.id,
        body.regimes ?? null,
      );
      return reply.status(201).send({
        ...decorateIncident(row, todayISO()),
        reportingDelay: delay,
        reportability: determination,
      });
    },
  );

  app.get(
    "/projects/:projectId/safety/incidents/:incidentId",
    { preHandler: readGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const actions = await app.db
        .select()
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "incident"),
            eq(safetyCorrectiveActions.sourceId, incidentId),
          ),
        )
        .orderBy(asc(safetyCorrectiveActions.dueDate));
      const talks = await app.db
        .select({
          id: toolboxTalks.id,
          reference: toolboxTalks.reference,
          title: toolboxTalks.title,
          talkDate: toolboxTalks.talkDate,
          attendeeCount: toolboxTalks.attendeeCount,
          status: toolboxTalks.status,
        })
        .from(toolboxTalks)
        .where(
          and(
            eq(toolboxTalks.companyId, req.companyId!),
            eq(toolboxTalks.relatedIncidentId, incidentId),
          ),
        );
      const asOf = todayISO();
      const names = await resolveInjuredNames([row], req.companyId!);
      return {
        ...decorateIncident(row, asOf, names),
        actions: actions.map((a) => decorateAction(a, asOf)),
        /** the briefings given BECAUSE of this incident — the loop closed */
        briefings: talks,
      };
    },
  );

  app.get(
    "/projects/:projectId/safety/incidents/:incidentId/reportability",
    { preHandler: readGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const country = await projectCountry(row.projectId, row.companyId);
      const regimeChoice = resolveRegimes(storedRegimes(row), country);
      const determination = assessReportability(factsFromIncident(row), regimeChoice.regimes);
      determination.reasons.push(...regimeChoice.reasons);
      return {
        incidentId: row.id,
        reference: row.reference,
        stored: {
          isReportable: asBool(row.isReportable),
          regimes: row.reportableRegimes ?? [],
          riddorCategory: row.riddorCategory,
          oshaCaseType: row.oshaCaseType,
          reportDueAt: row.reportDueAt,
          obligationId: row.obligationId,
        },
        /** recomputed from current facts — differs from `stored` if facts changed */
        current: determination,
        regimeBasis: regimeChoice.basis,
        facts: factsFromIncident(row),
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/reportability",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = z
        .object({
          regimes: z.array(z.enum(REPORTABLE_REGIMES)).max(9).optional(),
          reportabilityInputs: reportabilityInputsSchema.optional(),
        })
        .parse(req.body ?? {});
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status === "void") throw conflict(`Incident ${row.reference} is void.`);
      if (body.reportabilityInputs) {
        const detail = { ...row.detail } as Record<string, unknown>;
        detail["reportabilityInputs"] = {
          ...detailObject(row, "reportabilityInputs"),
          ...body.reportabilityInputs,
        };
        await app.db
          .update(safetyIncidents)
          .set({ detail, updatedAt: new Date().toISOString() })
          .where(eq(safetyIncidents.id, incidentId));
      }
      const fresh = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const { row: updated, determination } = await applyReportability(
        fresh,
        req.user!.id,
        body.regimes ?? null,
      );
      return { ...decorateIncident(updated, todayISO()), reportability: determination };
    },
  );

  app.patch(
    "/projects/:projectId/safety/incidents/:incidentId",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = incidentPatchSchema.parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw conflict(
          `Incident ${row.reference} is ${row.status}. Reopen it before amending the facts — an ` +
            `investigated incident whose facts change after closure is a different incident, and the ` +
            `reportability classification computed from those facts has to be recomputed on the record.`,
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.workerId) await assertWorker(body.workerId, req.companyId!, req.projectId!);

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "incidentType",
        "severity",
        "title",
        "description",
        "discoveredAt",
        "hoursIntoShift",
        "shift",
        "locationId",
        "locationText",
        "latitude",
        "longitude",
        "weatherConditions",
        "lightingConditions",
        "activityAtTime",
        "workerId",
        "injuredPersonName",
        "injuredPersonType",
        "vendorId",
        "injuredPersonTrade",
        "injuredPersonAge",
        "yearsExperience",
        "daysSinceInduction",
        "treatmentLevel",
        "bodyPart",
        "additionalBodyParts",
        "injuryNature",
        "mechanism",
        "treatmentProvider",
        "hospitalName",
        "lostTimeDays",
        "restrictedDutyDays",
        "returnToWorkDate",
        "equipmentId",
        "propertyDamageDescription",
        "environmentalReleaseDescription",
        "releaseQuantity",
        "releaseUnit",
        "thirdPartyDetail",
        "immediateCause",
        "immediateActionTaken",
        "investigationDueDate",
        "estimatedCost",
        "currency",
        "photoFileIds",
        "attachmentFileIds",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      for (const key of [
        "isLostTime",
        "isFatality",
        "workStopped",
        "thirdPartyInvolved",
        "emergencyServicesAttended",
        "isConfidential",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key] ? 1 : 0;
      }
      if (body.witnesses !== undefined) {
        patch["witnesses"] = body.witnesses;
        patch["witnessCount"] = body.witnesses.length;
      }
      if (body.reportedAt !== undefined && body.reportedAt !== null) {
        if (Date.parse(body.reportedAt) < Date.parse(row.occurredAt)) {
          throw badRequest(`reportedAt ${body.reportedAt} falls before occurredAt ${row.occurredAt}.`);
        }
        patch["reportedAt"] = body.reportedAt;
        patch["reportingDelayHours"] = computeReportingDelay(row.occurredAt, body.reportedAt).hours;
      }
      const detail = { ...row.detail } as Record<string, unknown>;
      if (body.detail) Object.assign(detail, body.detail);
      if (body.reportabilityInputs || body.regimes) {
        detail["reportabilityInputs"] = {
          ...detailObject(row, "reportabilityInputs"),
          ...(body.reportabilityInputs ?? {}),
          ...(body.regimes ? { regimes: body.regimes } : {}),
        };
      }
      patch["detail"] = detail;

      await app.db.update(safetyIncidents).set(patch).where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: { reference: row.reference, changed: Object.keys(body) },
        storePayload: true,
      });

      // Facts changed, so the classification and the clock may have changed
      // with them. Recomputing here is the whole reason reportability lives in
      // a pure function: a worker who goes from 5 days off to 9 crosses the
      // RIDDOR reg. 4(2) threshold, and nobody is going to notice by hand.
      const fresh = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const { row: updated, determination } = await applyReportability(
        fresh,
        req.user!.id,
        body.regimes ?? null,
      );
      return { ...decorateIncident(updated, todayISO()), reportability: determination };
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/notify-regulator",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = notifyRegulatorSchema.parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const existing = (row.notifications ?? []) as Array<Record<string, unknown>>;
      if (existing.some((n) => n["regime"] === body.regime)) {
        throw conflict(
          `Incident ${row.reference} has already been notified under ${body.regime}. A second entry ` +
            `would rewrite the record of when the regulator was actually told, which is the one fact ` +
            `the whole notification duty turns on.`,
        );
      }
      const notifiedAt = body.notifiedAt ?? new Date().toISOString();
      if (Date.parse(notifiedAt) < Date.parse(row.occurredAt)) {
        throw badRequest(`notifiedAt ${notifiedAt} falls before the incident occurred.`);
      }
      /* The deadline this notification is measured against is THIS REGIME'S,
       * not the incident's earliest across all regimes. A RIDDOR F2508 filed
       * on day 12 of a 15-day clock is in time even where an OSHA eight-hour
       * duty on the same event was missed on the first day. */
      const before = incidentNotificationState(row, notifiedAt);
      const duty = before.duties.find((d) => d.regime === body.regime) ?? null;
      const dutyDueAt = duty?.dueAt ?? row.reportDueAt;
      const late = isNotificationMissed(dutyDueAt, notifiedAt, notifiedAt);
      const hoursLate =
        late && dutyDueAt
          ? Math.round(((Date.parse(notifiedAt) - Date.parse(dutyDueAt)) / 3_600_000) * 10) / 10
          : null;
      const notifications = [
        ...existing,
        {
          regime: body.regime,
          notifiedAt,
          reference: body.reference ?? null,
          method: body.method ?? "unspecified",
          notifiedBy: req.user!.id,
          fileId: body.fileId ?? null,
          late,
          hoursLate,
        },
      ];
      const now = new Date().toISOString();

      /* `regulator_notified_at` is a DERIVED summary of the per-regime
       * entries, and it is the single column the old code set on the first
       * notification. That is what let the second duty of a dual-regime
       * incident disappear: the sweep, the drawer and the close gate all read
       * this column. It is now set only once EVERY notifiable regime has been
       * notified, and it carries the last of those timestamps — the moment the
       * incident's statutory duties were actually discharged. */
      const after = notificationState({
        determination: storedDetermination(row),
        storedRegimes: (row.reportableRegimes ?? []) as string[],
        reportDueAt: row.reportDueAt,
        notifications: notifications as unknown as NotificationEntry[],
        isReportable: asBool(row.isReportable),
        asOfISO: now,
      });
      const derivedNotifiedAt = derivedRegulatorNotifiedAt(after);

      await app.db
        .update(safetyIncidents)
        .set({
          notifications,
          regulatorNotifiedAt: derivedNotifiedAt,
          regulatorNotifiedBy: derivedNotifiedAt ? (row.regulatorNotifiedBy ?? req.user!.id) : null,
          regulatorReference: body.reference ?? row.regulatorReference,
          regulatorNotificationFileId: body.fileId ?? row.regulatorNotificationFileId,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incidentId));

      /* The obligation carries the whole incident's statutory duty, so it is
       * satisfied only when every regime has been discharged — and breached
       * the moment ANY duty was missed, whether or not this one was. */
      if (row.obligationId) {
        const obligationStatus = after.anyMissed
          ? "breached"
          : after.allDischarged
            ? "satisfied"
            : null;
        if (obligationStatus) {
          await app.db
            .update(obligations)
            .set({ status: obligationStatus })
            .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
        }
      }

      if (late) {
        const det = storedDetermination(row);
        const governing = det?.rules.find((r) => r.ruleId === det.governingRuleId) ?? null;
        const seen = await alreadySignalled(
          req.companyId!,
          "safety_notification_deadline_missed",
          req.projectId!,
        );
        if (!seen.has(missedNotificationKey(incidentId, body.regime))) {
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            detector: "safety_notification_deadline_missed",
            severity: "critical",
            confidence: 1,
            title: `Statutory notification made out of time (${body.regime}) — ${row.reference}: ${row.title}`,
            explanation:
              `Incident ${row.reference} was notified under ${body.regime} at ${notifiedAt}, ` +
              `${hoursLate} hour(s) after the statutory deadline of ${dutyDueAt}` +
              (governing ? ` set by ${governing.ruleId} (${governing.citation})` : "") +
              `.\n\nThe notification has been made, which is materially better than an absent one, but ` +
              `the lateness is now a fact on the record and it is independently actionable: reporting ` +
              `out of time is an offence in its own right, separate from anything the investigation ` +
              `finds. ` +
              (governing?.consequenceIfMissed ?? "") +
              `\n\nExpect the delay to be the opening question. Establish and record WHY it was late — ` +
              `when the site first knew, who held the decision, and what in the process failed — ` +
              `because that account is the only mitigation available, and it is far more credible ` +
              `produced now than reconstructed later.`,
            evidenceRefs: {
              key: missedNotificationKey(incidentId, body.regime),
              incidentId,
              reference: row.reference,
              regime: body.regime,
              reportDueAt: dutyDueAt,
              notifiedAt,
              hoursLate,
              governingRuleId: duty?.ruleId ?? det?.governingRuleId ?? null,
              citation: duty?.citation ?? governing?.citation ?? null,
            },
          });
        }
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: {
          act: "notify_regulator",
          reference: row.reference,
          regime: body.regime,
          notifiedAt,
          reportDueAt: row.reportDueAt,
          late,
          hoursLate,
          regulatorReference: body.reference ?? null,
        },
        storePayload: true,
      });

      const updated = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const outstanding = after.duties.filter((d) => d.state === "outstanding");
      return {
        ...decorateIncident(updated, todayISO()),
        notificationResult: {
          regime: body.regime,
          notifiedAt,
          dueAt: dutyDueAt,
          late,
          hoursLate,
          obligationId: row.obligationId,
          obligationStatus: row.obligationId
            ? after.anyMissed
              ? "breached"
              : after.allDischarged
                ? "satisfied"
                : "open"
            : null,
          /** what is STILL owed after this notification — the whole point */
          outstandingRegimes: outstanding.map((d) => ({
            regime: d.regime,
            dueAt: d.dueAt,
            authority: d.authority,
            citation: d.citation,
            hoursRemaining: d.hoursRemaining,
          })),
          allDischarged: after.allDischarged,
          note:
            outstanding.length > 0
              ? `This incident is answerable under more than one regime and ${outstanding.length} ` +
                `duty/duties remain outstanding (${outstanding.map((d) => d.regime).join(", ")}). ` +
                `Recording the ${body.regime} notification discharges nothing of them, and the ` +
                `incident cannot be closed until they are answered.`
              : null,
        },
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/investigation",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = investigationSchema.parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw conflict(`Incident ${row.reference} is ${row.status} — reopen it before investigating.`);
      }
      if (row.investigationStatus === "complete") {
        throw conflict(
          `The investigation of ${row.reference} is complete and approved. Amending its findings now ` +
            `would change a signed-off conclusion without a record that it changed — reopen the ` +
            `incident instead.`,
        );
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {
        investigationStatus: row.investigationStatus === "not_started" ? "in_progress" : row.investigationStatus,
        investigationStartedAt: row.investigationStartedAt ?? now,
        status: row.status === "reported" ? "under_investigation" : row.status,
        updatedAt: now,
      };
      for (const key of [
        "investigationLeadId",
        "investigationDueDate",
        "rootCauseMethod",
        "rootCause",
        "investigationFindings",
        "investigationReportFileId",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.contributingFactors !== undefined) patch["contributingFactors"] = body.contributingFactors;
      await app.db.update(safetyIncidents).set(patch).where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: { act: "investigation_update", reference: row.reference, changed: Object.keys(body) },
        storePayload: true,
      });
      const updated = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const leadId = updated.investigationLeadId;
      return {
        ...decorateIncident(updated, todayISO()),
        segregationNote:
          leadId && leadId === updated.createdBy
            ? "The investigation lead is the same person who reported the incident. That is permitted, " +
              "but it is not independent, and it is the pairing an inspector notices. Note also that " +
              "sign-off is refused to the investigation lead, so a second person will be required " +
              "before this investigation can be approved."
            : null,
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/investigation/complete",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.investigationStatus === "complete") {
        throw conflict(`The investigation of ${row.reference} is already complete.`);
      }
      if (row.investigationStatus === "not_started") {
        throw conflict(
          `The investigation of ${row.reference} has not been started. Record a lead and a method first.`,
        );
      }
      const missing: string[] = [];
      if (row.rootCauseMethod === "none") {
        missing.push(
          "a root-cause method (`rootCauseMethod`) — \"we asked around\" is not a method, and a " +
            "conclusion reached without one cannot be tested by anybody else",
        );
      }
      if (!row.rootCause || row.rootCause.trim() === "") missing.push("a stated root cause");
      if ((row.contributingFactors ?? []).length === 0) {
        missing.push(
          "at least one contributing factor — an incident with a single cause and nothing around it " +
            "has been described, not investigated, and the organisational factors are precisely the " +
            "ones that produce the next one",
        );
      }
      if (!row.investigationFindings || row.investigationFindings.trim() === "") {
        missing.push("written findings");
      }
      if (missing.length > 0) {
        throw badRequest(
          `The investigation of ${row.reference} cannot be completed. Missing: ${missing.join("; ")}.`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyIncidents)
        .set({ investigationStatus: "under_review", investigationCompletedAt: now, updatedAt: now })
        .where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: {
          act: "investigation_complete",
          reference: row.reference,
          from: row.investigationStatus,
          to: "under_review",
          rootCauseMethod: row.rootCauseMethod,
          contributingFactorCount: (row.contributingFactors ?? []).length,
          leadId: row.investigationLeadId,
        },
        storePayload: true,
      });
      return decorateIncident(
        await fetchIncident(incidentId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/investigation/approve",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.investigationStatus !== "under_review") {
        throw conflict(
          `The investigation of ${row.reference} is \`${row.investigationStatus}\` — only an ` +
            `investigation submitted for review can be signed off.`,
        );
      }
      if (row.investigationLeadId && row.investigationLeadId === req.user!.id) {
        throw forbidden(
          "The investigation lead may not sign off their own investigation. The whole value of the " +
            "sign-off is that a second person has read the root cause and agreed it is supported by " +
            "the evidence — see the schema note on `approvedBy`.",
        );
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who reported the incident may not sign off its investigation. Reporting and " +
            "approving are the two ends of the same chain, and one person holding both is the " +
            "arrangement that produces investigations concluding that nothing needs to change.",
        );
      }
      const now = new Date().toISOString();
      const openActions = await app.db
        .select({ n: count() })
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "incident"),
            eq(safetyCorrectiveActions.sourceId, incidentId),
            inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
          ),
        );
      const openCount = Number(openActions[0]?.n ?? 0);
      await app.db
        .update(safetyIncidents)
        .set({
          investigationStatus: "complete",
          approvedBy: req.user!.id,
          approvedAt: now,
          status: openCount > 0 ? "actions_open" : "pending_closure",
          openActionCount: openCount,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: {
          act: "investigation_approved",
          reference: row.reference,
          leadId: row.investigationLeadId,
          approvedBy: req.user!.id,
          note: body.note ?? null,
          openActionCount: openCount,
        },
        storePayload: true,
      });
      return decorateIncident(
        await fetchIncident(incidentId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/close",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = incidentCloseSchema.parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status === "closed") throw conflict(`Incident ${row.reference} is already closed.`);
      if (row.status === "void") throw conflict(`Incident ${row.reference} is void.`);
      if (row.investigationStatus !== "complete") {
        throw conflict(
          `Incident ${row.reference} cannot be closed: its investigation is ` +
            `\`${row.investigationStatus}\`. An incident closed without an approved investigation is a ` +
            `record that something happened and nothing was learned.`,
        );
      }
      /* Closure is gated on EVERY regime's duty, not on the single derived
       * `regulator_notified_at` column. An incident assessed under both RIDDOR
       * and OSHA whose F2508 was filed still owes the OSHA notification, and
       * closing it would take that live duty off the register. */
      if (asBool(row.isReportable)) {
        const state = incidentNotificationState(row, new Date().toISOString());
        const owed = state.duties.filter(
          (d) => d.state === "outstanding" || d.state === "missed",
        );
        if (owed.length > 0) {
          throw conflict(
            `Incident ${row.reference} is classified reportable and ${owed.length} statutory ` +
              `notification duty/duties are undischarged: ` +
              owed
                .map(
                  (d) =>
                    `${d.regime} (${d.state === "missed" ? "deadline passed" : "due"} ${d.dueAt ?? "— no deadline recorded"}` +
                    `${d.authority ? `, ${d.authority}` : ""})`,
                )
                .join("; ") +
              `. Closing it would take a live statutory duty off the register. Notify each authority ` +
              `and record it, or reassess the classification if it is wrong.`,
          );
        }
      }
      const liveActions = await app.db
        .select({ n: count() })
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "incident"),
            eq(safetyCorrectiveActions.sourceId, incidentId),
            inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
          ),
        );
      if (Number(liveActions[0]?.n ?? 0) > 0) {
        throw conflict(
          `Incident ${row.reference} has ${liveActions[0]?.n} corrective action(s) still open.`,
        );
      }
      const now = new Date().toISOString();
      const detail = { ...row.detail } as Record<string, unknown>;
      detail["closure"] = { note: body.note, closedBy: req.user!.id, closedAt: now };
      await app.db
        .update(safetyIncidents)
        .set({
          status: "closed",
          closedBy: req.user!.id,
          closedAt: now,
          lessonId: body.lessonId ?? row.lessonId,
          detail,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: {
          act: "close",
          reference: row.reference,
          from: row.status,
          to: "closed",
          note: body.note,
          lessonId: body.lessonId ?? row.lessonId,
        },
        storePayload: true,
      });
      return decorateIncident(
        await fetchIncident(incidentId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/reopen",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status !== "closed" && row.status !== "pending_closure") {
        throw conflict(`Incident ${row.reference} is \`${row.status}\` and is not closed.`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyIncidents)
        .set({
          status: "reopened",
          investigationStatus: "reopened",
          closedBy: null,
          closedAt: null,
          reopenedCount: row.reopenedCount + 1,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incidentId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: { act: "reopen", reference: row.reference, from: row.status, reason: body.reason },
        storePayload: true,
      });
      return decorateIncident(
        await fetchIncident(incidentId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  /* ================================================================ */
  /* CORRECTIVE ACTIONS — one register for the whole platform          */
  /* ================================================================ */

  /**
   * Every safety register feeds this table, and so does quality (NCRs land
   * here through `sourceType: "ncr"`). The discriminator is
   * `sourceType`/`sourceId`, which is why a project has ONE overdue-actions
   * list rather than one per module — the list a site manager will actually
   * read on a Monday morning.
   */
  async function assertSource(
    sourceType: CorrectiveActionSource,
    sourceId: string,
    companyId: string,
    projectId: string,
  ): Promise<string | null> {
    if (!IN_MODULE_SOURCES.has(sourceType)) {
      // Sources owned by other modules (`ncr`, `audit`, `meeting_action`,
      // `regulator_notice`, …) are accepted on trust: this module must not
      // reach into another module's tables to validate them, and refusing an
      // action because its origin lives elsewhere would defeat the point of a
      // shared register.
      return null;
    }
    if (sourceType === "incident") {
      const r = await fetchIncident(sourceId, companyId, projectId);
      return r.reference;
    }
    if (sourceType === "observation") {
      const r = await fetchObservation(sourceId, companyId, projectId);
      return r.reference;
    }
    if (sourceType === "inspection") {
      const r = await fetchInspection(sourceId, companyId, projectId);
      return r.reference;
    }
    const r = await fetchTalk(sourceId, companyId, projectId);
    return r.reference;
  }

  async function createAction(
    input: {
      companyId: string;
      projectId: string;
      actorId: string;
      sourceType: CorrectiveActionSource;
      sourceId: string;
      sourceReference: string | null;
      title: string;
      description: string | null;
      actionKind: string;
      hierarchyOfControl: string;
      category: string | null;
      priority: string;
      ownerId: string | null;
      ownerVendorId: string | null;
      ownerName: string | null;
      dueDate: string;
      costToImplement: number | null;
      currency: string | null;
      detail: Record<string, unknown>;
    },
  ): Promise<string> {
    const seq = await nextRecordNumber(app.db, input.projectId, "safety_corrective_action");
    const reference = `CA-${pad(seq)}`;
    const id = newId("cact");
    await app.db.insert(safetyCorrectiveActions).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      number: seq,
      reference,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceReference: input.sourceReference,
      title: input.title,
      description: input.description,
      actionKind: input.actionKind,
      hierarchyOfControl: input.hierarchyOfControl,
      category: input.category,
      priority: input.priority,
      status: "open",
      ownerId: input.ownerId,
      ownerVendorId: input.ownerVendorId,
      ownerName: input.ownerName,
      dueDate: input.dueDate,
      originalDueDate: input.dueDate,
      costToImplement: input.costToImplement,
      currency: input.currency,
      detail: input.detail,
      createdBy: input.actorId,
    });
    await appendLedger(app.db, {
      companyId: input.companyId,
      projectId: input.projectId,
      actorId: input.actorId,
      action: "create",
      objectType: "safety_corrective_action",
      objectId: id,
      payload: {
        reference,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceReference: input.sourceReference,
        hierarchyOfControl: input.hierarchyOfControl,
        actionKind: input.actionKind,
        priority: input.priority,
        dueDate: input.dueDate,
        ownerId: input.ownerId,
      },
      storePayload: true,
    });
    await refreshOpenActionCount(input.sourceType, input.sourceId, input.companyId);
    return id;
  }

  app.get(
    "/projects/:projectId/safety/corrective-actions",
    { preHandler: readGate },
    async (req) => {
      const q = actionListQuery.parse(req.query);
      await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
      const asOf = todayISO();
      const filters = [
        eq(safetyCorrectiveActions.companyId, req.companyId!),
        eq(safetyCorrectiveActions.projectId, req.projectId!),
      ];
      if (q.sourceType) filters.push(eq(safetyCorrectiveActions.sourceType, q.sourceType));
      if (q.sourceId) filters.push(eq(safetyCorrectiveActions.sourceId, q.sourceId));
      if (q.status) filters.push(eq(safetyCorrectiveActions.status, q.status));
      if (q.ownerId) filters.push(eq(safetyCorrectiveActions.ownerId, q.ownerId));
      if (q.hierarchyOfControl) {
        filters.push(eq(safetyCorrectiveActions.hierarchyOfControl, q.hierarchyOfControl));
      }
      if (q.effectiveness) {
        filters.push(eq(safetyCorrectiveActions.effectivenessVerdict, q.effectiveness));
      }
      const where = and(...filters);
      const rows = await app.db
        .select()
        .from(safetyCorrectiveActions)
        .where(where)
        .orderBy(asc(safetyCorrectiveActions.dueDate))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const totalRows = await app.db
        .select({ n: count() })
        .from(safetyCorrectiveActions)
        .where(where);
      let items = rows.map((r) => decorateAction(r, asOf));
      if (q.overdue === "true") items = items.filter((i) => i.isOverdue);
      if (q.overdue === "false") items = items.filter((i) => !i.isOverdue);

      // The hierarchy-of-control profile of the whole register. A programme
      // whose actions are overwhelmingly `administrative` and `ppe` is a
      // programme that briefs and issues gloves; it is not engineering the
      // hazard out, and it will see the same incident again.
      const all = await app.db
        .select({ h: safetyCorrectiveActions.hierarchyOfControl, n: count() })
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.projectId, req.projectId!),
          ),
        )
        .groupBy(safetyCorrectiveActions.hierarchyOfControl);
      const profile: Record<string, number> = {};
      for (const h of HIERARCHY_OF_CONTROLS) profile[h] = 0;
      let unrecorded = 0;
      let total = 0;
      for (const r of all) {
        const n = Number(r.n);
        total += n;
        if (r.h && r.h in profile) profile[r.h] = n;
        else unrecorded += n;
      }
      const weak = profile["administrative"]! + profile["ppe"]!;
      return {
        ...paginate(items, Number(totalRows[0]?.n ?? 0), q),
        hierarchyProfile: {
          counts: profile,
          unrecorded,
          total,
          weakControlShare: total > 0 ? Math.round((weak / total) * 1000) / 10 : null,
          reasons:
            total > 0
              ? []
              : ["No corrective actions on this project, so no hierarchy-of-control profile exists."],
        },
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = actionCreateSchema.parse(req.body);
      const sourceReference =
        body.sourceReference ??
        (await assertSource(body.sourceType, body.sourceId, req.companyId!, req.projectId!));
      if (body.ownerVendorId) await assertVendor(body.ownerVendorId, req.companyId!);
      if (!body.ownerId && !body.ownerVendorId && !body.ownerName) {
        throw badRequest(
          "A corrective action needs an owner (`ownerId`, `ownerVendorId` or `ownerName`). An action " +
            "with a date and no name is a wish; the register exists to say who is accountable by when.",
        );
      }
      const id = await createAction({
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        sourceReference,
        title: body.title,
        description: body.description ?? null,
        actionKind: body.actionKind ?? "corrective",
        hierarchyOfControl: body.hierarchyOfControl,
        category: body.category ?? null,
        priority: body.priority ?? "medium",
        ownerId: body.ownerId ?? null,
        ownerVendorId: body.ownerVendorId ?? null,
        ownerName: body.ownerName ?? null,
        dueDate: body.dueDate,
        costToImplement: body.costToImplement ?? null,
        currency: body.currency ?? null,
        detail: body.detail ?? {},
      });
      const created = await fetchAction(id, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...decorateAction(created, todayISO()),
        controlNote:
          body.hierarchyOfControl === "administrative" || body.hierarchyOfControl === "ppe"
            ? "This action sits at the weak end of the hierarchy of control. Retraining an operative " +
              "and eliminating a hazard are both actions, and the register records which one was " +
              "chosen precisely because they are not equivalent — a control that depends on a person " +
              "behaving correctly every time is the control that fails on the day it matters."
            : null,
      });
    },
  );

  app.get(
    "/projects/:projectId/safety/corrective-actions/:actionId",
    { preHandler: readGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      return decorateAction(row, todayISO());
    },
  );

  app.patch(
    "/projects/:projectId/safety/corrective-actions/:actionId",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = actionPatchSchema.parse(req.body);
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "cancelled") {
        throw conflict(`Action ${row.reference} is ${row.status} and cannot be edited.`);
      }
      if (body.ownerVendorId) await assertVendor(body.ownerVendorId, req.companyId!);
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "description",
        "actionKind",
        "hierarchyOfControl",
        "category",
        "priority",
        "ownerId",
        "ownerVendorId",
        "ownerName",
        "costToImplement",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.detail) patch["detail"] = { ...row.detail, ...body.detail };
      if (body.dueDate !== undefined && body.dueDate !== row.dueDate) {
        if (!body.revisionReason) {
          throw badRequest(
            `Moving the due date of ${row.reference} from ${row.dueDate} to ${body.dueDate} requires a ` +
              `\`revisionReason\`. A date that moves without a reason is how an action register becomes ` +
              `a record of nothing having been late.`,
          );
        }
        patch["dueDate"] = body.dueDate;
        patch["originalDueDate"] = row.originalDueDate ?? row.dueDate;
        patch["revisedCount"] = row.revisedCount + 1;
        const detail = { ...(patch["detail"] as Record<string, unknown> | undefined) ?? row.detail };
        const history = Array.isArray(detail["dueDateRevisions"]) ? [...(detail["dueDateRevisions"] as unknown[])] : [];
        history.push({
          from: row.dueDate,
          to: body.dueDate,
          reason: body.revisionReason,
          by: req.user!.id,
          at: new Date().toISOString(),
        });
        detail["dueDateRevisions"] = history;
        patch["detail"] = detail;
      }
      await app.db
        .update(safetyCorrectiveActions)
        .set(patch)
        .where(eq(safetyCorrectiveActions.id, actionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: {
          reference: row.reference,
          changed: Object.keys(body),
          dueDateFrom: body.dueDate ? row.dueDate : undefined,
          dueDateTo: body.dueDate,
          revisionReason: body.revisionReason ?? null,
        },
        storePayload: true,
      });
      return decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO());
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions/:actionId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = actionCompleteSchema.parse(req.body);
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (!(OPEN_ACTION_STATUSES as readonly string[]).includes(row.status)) {
        throw conflict(`Action ${row.reference} is \`${row.status}\` and is not open for completion.`);
      }
      const completedAt = body.completedAt ?? new Date().toISOString();
      const now = new Date().toISOString();
      await app.db
        .update(safetyCorrectiveActions)
        .set({
          status: "completed",
          completedAt,
          completedBy: req.user!.id,
          completionNote: body.completionNote,
          evidenceFileIds: body.evidenceFileIds ?? [],
          updatedAt: now,
        })
        .where(eq(safetyCorrectiveActions.id, actionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: {
          act: "complete",
          reference: row.reference,
          from: row.status,
          to: "completed",
          completedBy: req.user!.id,
          completedAt,
          onTime: completedAt.slice(0, 10) <= row.dueDate,
          evidenceFileIds: body.evidenceFileIds ?? [],
        },
        storePayload: true,
      });
      await refreshOpenActionCount(row.sourceType, row.sourceId, req.companyId!);
      return decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO());
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions/:actionId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = actionVerifySchema.parse(req.body);
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (row.status !== "completed") {
        throw conflict(
          `Action ${row.reference} is \`${row.status}\` — only a completed action can be verified.`,
        );
      }
      if (row.completedBy === req.user!.id) {
        throw forbidden(
          "The person who completed an action may not verify it. Verification is the assertion that " +
            "the work described was actually done, and the only person who cannot make that assertion " +
            "credibly is the person who described it — see the schema note on `verifiedBy`.",
        );
      }
      if (row.ownerId && row.ownerId === req.user!.id) {
        throw forbidden(
          "The owner of an action may not verify their own action's completion.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyCorrectiveActions)
        .set({
          status: "verified",
          verifiedBy: req.user!.id,
          verifiedAt: now,
          verificationMethod: body.verificationMethod,
          updatedAt: now,
        })
        .where(eq(safetyCorrectiveActions.id, actionId));
      /* The source record's derived state moves with its actions: an
       * observation whose every action has been verified is `verified`, which
       * is a lane the board draws and nothing used to reach. */
      await refreshOpenActionCount(row.sourceType, row.sourceId, req.companyId!);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: {
          act: "verify",
          reference: row.reference,
          completedBy: row.completedBy,
          verifiedBy: req.user!.id,
          verificationMethod: body.verificationMethod,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return {
        ...decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO()),
        nextStep:
          "Verification confirms the action was DONE. It does not confirm it WORKED. Record an " +
          "effectiveness check (POST .../effectiveness-check) before this action can be closed.",
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions/:actionId/effectiveness-check",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = effectivenessSchema.parse(req.body);
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (row.status === "cancelled") {
        throw conflict(`Action ${row.reference} was cancelled — there is nothing to check.`);
      }
      if (row.status === "open" || row.status === "in_progress") {
        throw conflict(
          `Action ${row.reference} is \`${row.status}\`. An effectiveness check is a judgement made ` +
            `AFTER the fix is in place and has had time to work — it cannot be made about an action ` +
            `that has not been done.`,
        );
      }
      if (row.completedBy === req.user!.id) {
        throw forbidden(
          "The person who completed an action may not judge whether it worked. An effectiveness " +
            "check made by the implementer is a self-assessment, and every register full of them " +
            "reads `effective`.",
        );
      }
      if (row.ownerId && row.ownerId === req.user!.id) {
        throw forbidden("The owner of an action may not sign off its own effectiveness.");
      }
      const checkDate = body.checkDate ?? todayISO();
      const now = new Date().toISOString();
      // `not_effective` sends the action back to open. An action shown not to
      // have worked is not a closed action with a bad verdict — it is a live
      // hazard with a failed control, and the register has to show it as one.
      const nextStatus = body.verdict === "not_effective" ? "open" : row.status;
      await app.db
        .update(safetyCorrectiveActions)
        .set({
          effectivenessVerdict: body.verdict,
          effectivenessCheckDate: checkDate,
          effectivenessCheckedBy: req.user!.id,
          effectivenessNote: body.note,
          status: nextStatus,
          updatedAt: now,
        })
        .where(eq(safetyCorrectiveActions.id, actionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: {
          act: "effectiveness_check",
          reference: row.reference,
          verdict: body.verdict,
          checkDate,
          checkedBy: req.user!.id,
          completedBy: row.completedBy,
          note: body.note,
          statusTo: nextStatus,
        },
        storePayload: true,
      });
      await refreshOpenActionCount(row.sourceType, row.sourceId, req.companyId!);
      return {
        ...decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO()),
        verdictNote:
          body.verdict === "not_effective"
            ? "The action has been reopened. A control shown not to work leaves the hazard exactly " +
              "where it was, and the right response is a stronger control — look up the hierarchy, " +
              "not sideways."
            : body.verdict === "partially_effective"
              ? "Partially effective is a real answer and it should be followed by a second action " +
                "addressing the part that did not work."
              : null,
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions/:actionId/close",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (row.status === "closed") throw conflict(`Action ${row.reference} is already closed.`);
      if (row.status === "cancelled") throw conflict(`Action ${row.reference} was cancelled.`);
      // Checked before the status guard on purpose: a `not_effective` action is
      // reopened, so the status guard alone would answer "it is not complete"
      // when the useful answer is "it was done, and it did not work".
      if (row.effectivenessVerdict === "not_effective") {
        throw conflict(
          `Action ${row.reference} was checked and found NOT effective. It cannot be closed: the ` +
            `hazard it was raised against is still present. Raise a stronger control — higher up the ` +
            `hierarchy than \`${row.hierarchyOfControl ?? "the one recorded"}\` — and close this one ` +
            `when that control has itself been shown to work.`,
        );
      }
      if (row.status !== "verified" && row.status !== "completed") {
        throw conflict(`Action ${row.reference} is \`${row.status}\` and has not been completed.`);
      }
      // THE GATE. An action closed but never checked is not closed.
      if (row.effectivenessVerdict === "pending") {
        throw conflict(
          `Action ${row.reference} has no effectiveness check. Completion evidence shows the action ` +
            `was DONE; it does not show it WORKED, and those are different findings made at different ` +
            `times by different people. Record an effectiveness check (POST ` +
            `.../effectiveness-check) — a register of actions closed on completion evidence alone is ` +
            `a register that will show the same hazard again with a different number.`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyCorrectiveActions)
        .set({ status: "closed", closedBy: req.user!.id, closedAt: now, updatedAt: now })
        .where(eq(safetyCorrectiveActions.id, actionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: {
          act: "close",
          reference: row.reference,
          from: row.status,
          to: "closed",
          effectivenessVerdict: row.effectivenessVerdict,
          effectivenessCheckedBy: row.effectivenessCheckedBy,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      await refreshOpenActionCount(row.sourceType, row.sourceId, req.companyId!);
      return decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO());
    },
  );

  app.post(
    "/projects/:projectId/safety/corrective-actions/:actionId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z.object({ reason: z.string().min(1).max(4000) }).parse(req.body);
      const row = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "cancelled") {
        throw conflict(`Action ${row.reference} is already ${row.status}.`);
      }
      const now = new Date().toISOString();
      const detail = { ...row.detail, cancellation: { reason: body.reason, by: req.user!.id, at: now } };
      await app.db
        .update(safetyCorrectiveActions)
        .set({ status: "cancelled", closedBy: req.user!.id, closedAt: now, detail, updatedAt: now })
        .where(eq(safetyCorrectiveActions.id, actionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_corrective_action",
        objectId: actionId,
        payload: { act: "cancel", reference: row.reference, from: row.status, reason: body.reason },
        storePayload: true,
      });
      await refreshOpenActionCount(row.sourceType, row.sourceId, req.companyId!);
      return decorateAction(await fetchAction(actionId, req.companyId!, req.projectId!), todayISO());
    },
  );

  /* ================================================================ */
  /* INSPECTION TEMPLATES (company-level)                              */
  /* ================================================================ */

  function decorateTemplate(t: TemplateRow) {
    const items = normaliseItems(t.items);
    return {
      ...t,
      isStatutory: asBool(t.isStatutory),
      items,
      criticalItemCount: items.filter((i) => i.isCritical).length,
      requiredItemCount: items.filter((i) => i.required).length,
      isUsable: t.status === "active",
    };
  }

  app.get("/companies/current/safety/inspection-templates", { preHandler: companyRead }, async (req) => {
    const q = pageQuerySchema
      .extend({
        inspectionType: z.enum(SAFETY_INSPECTION_TYPES).optional(),
        status: z.enum(["draft", "active", "retired"]).optional(),
        statutory: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const filters = [eq(safetyInspectionTemplates.companyId, req.companyId!)];
    if (q.inspectionType) filters.push(eq(safetyInspectionTemplates.inspectionType, q.inspectionType));
    if (q.status) filters.push(eq(safetyInspectionTemplates.status, q.status));
    if (q.statutory) {
      filters.push(eq(safetyInspectionTemplates.isStatutory, q.statutory === "true" ? 1 : 0));
    }
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetyInspectionTemplates)
      .where(where)
      .orderBy(asc(safetyInspectionTemplates.reference), desc(safetyInspectionTemplates.version))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db
      .select({ n: count() })
      .from(safetyInspectionTemplates)
      .where(where);
    return paginate(rows.map(decorateTemplate), Number(totalRows[0]?.n ?? 0), q);
  });

  app.post(
    "/companies/current/safety/inspection-templates",
    { preHandler: companyWrite },
    async (req, reply) => {
      const body = templateCreateSchema.parse(req.body);
      const items = normaliseItems(
        body.items.map((it, i) => ({ ...it, id: it.id ?? `item-${i + 1}` })),
      );
      const ids = new Set(items.map((i) => i.id));
      if (ids.size !== items.length) {
        throw badRequest("Template item ids must be unique — responses are keyed to them.");
      }
      if (body.isStatutory && (body.frequency ?? "ad_hoc") === "ad_hoc") {
        throw badRequest(
          "A statutory template must carry a re-inspection frequency. The interval is the condition " +
            "on which the item may lawfully stay in use, and without one nothing can ever be swept " +
            "as overdue — which is the same as not having the duty at all.",
        );
      }
      if (body.isStatutory && !body.regulatoryBasis) {
        throw badRequest(
          "A statutory template must name the regulation it discharges (`regulatoryBasis`), e.g. " +
            "\"Work at Height Regulations 2005 reg. 12(3)\" or \"LOLER 1998 reg. 9\". A form that " +
            "claims statutory force without naming its source cannot be defended.",
        );
      }
      const id = newId("sit");
      await app.db.insert(safetyInspectionTemplates).values({
        id,
        companyId: req.companyId!,
        projectId: body.projectId ?? null,
        reference: body.reference,
        name: body.name,
        description: body.description ?? null,
        inspectionType: body.inspectionType ?? "general_site",
        version: 1,
        status: "draft",
        items,
        itemCount: items.length,
        scoringMethod: body.scoringMethod ?? "percentage",
        passThreshold: body.passThreshold ?? null,
        frequency: body.frequency ?? "ad_hoc",
        regulatoryBasis: body.regulatoryBasis ?? null,
        isStatutory: fromBool(body.isStatutory),
        appliesToTrades: body.appliesToTrades ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_inspection_template",
        objectId: id,
        payload: {
          reference: body.reference,
          name: body.name,
          version: 1,
          itemCount: items.length,
          isStatutory: body.isStatutory === true,
          scoringMethod: body.scoringMethod ?? "percentage",
        },
        storePayload: true,
      });
      return reply.status(201).send(decorateTemplate(await fetchTemplate(id, req.companyId!)));
    },
  );

  app.get(
    "/companies/current/safety/inspection-templates/:templateId",
    { preHandler: companyRead },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      return decorateTemplate(await fetchTemplate(templateId, req.companyId!));
    },
  );

  app.patch(
    "/companies/current/safety/inspection-templates/:templateId",
    { preHandler: companyWrite },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const body = templatePatchSchema.parse(req.body);
      const row = await fetchTemplate(templateId, req.companyId!);
      if (row.status !== "draft") {
        throw conflict(
          `Template ${row.reference} v${row.version} is \`${row.status}\`. An issued form cannot be ` +
            `edited in place: inspections already performed against it stamped its version, and ` +
            `changing the items now would silently rewrite what was inspected. Create a new version.`,
        );
      }
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "name",
        "description",
        "inspectionType",
        "scoringMethod",
        "passThreshold",
        "frequency",
        "regulatoryBasis",
        "appliesToTrades",
        "detail",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.isStatutory !== undefined) patch["isStatutory"] = body.isStatutory ? 1 : 0;
      if (body.items) {
        const items = normaliseItems(body.items.map((it, i) => ({ ...it, id: it.id ?? `item-${i + 1}` })));
        patch["items"] = items;
        patch["itemCount"] = items.length;
      }
      await app.db
        .update(safetyInspectionTemplates)
        .set(patch)
        .where(eq(safetyInspectionTemplates.id, templateId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_inspection_template",
        objectId: templateId,
        payload: { reference: row.reference, version: row.version, changed: Object.keys(body) },
        storePayload: true,
      });
      return decorateTemplate(await fetchTemplate(templateId, req.companyId!));
    },
  );

  app.post(
    "/companies/current/safety/inspection-templates/:templateId/approve",
    { preHandler: companyWrite },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const row = await fetchTemplate(templateId, req.companyId!);
      if (row.status !== "draft") throw conflict(`Template ${row.reference} is already ${row.status}.`);
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "A template may not be approved by its author. The approval is the assertion that the form " +
            "asks the right questions, and the author has already made that assertion by writing it — " +
            "see the schema note on `approvedBy`.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyInspectionTemplates)
        .set({ status: "active", approvedBy: req.user!.id, approvedAt: now, updatedAt: now })
        .where(eq(safetyInspectionTemplates.id, templateId));
      if (row.supersedesId) {
        await app.db
          .update(safetyInspectionTemplates)
          .set({ status: "retired", updatedAt: now })
          .where(
            and(
              eq(safetyInspectionTemplates.id, row.supersedesId),
              eq(safetyInspectionTemplates.status, "active"),
            ),
          );
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_inspection_template",
        objectId: templateId,
        payload: {
          act: "approve",
          reference: row.reference,
          version: row.version,
          author: row.createdBy,
          approvedBy: req.user!.id,
          retired: row.supersedesId ?? null,
        },
        storePayload: true,
      });
      return decorateTemplate(await fetchTemplate(templateId, req.companyId!));
    },
  );

  app.post(
    "/companies/current/safety/inspection-templates/:templateId/new-version",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { templateId } = req.params as { templateId: string };
      const body = templatePatchSchema.parse(req.body ?? {});
      const row = await fetchTemplate(templateId, req.companyId!);
      const items = body.items
        ? normaliseItems(body.items.map((it, i) => ({ ...it, id: it.id ?? `item-${i + 1}` })))
        : normaliseItems(row.items);
      const id = newId("sit");
      await app.db.insert(safetyInspectionTemplates).values({
        id,
        companyId: req.companyId!,
        projectId: body.projectId !== undefined ? body.projectId : row.projectId,
        reference: row.reference,
        name: body.name ?? row.name,
        description: body.description !== undefined ? body.description : row.description,
        inspectionType: body.inspectionType ?? row.inspectionType,
        version: row.version + 1,
        status: "draft",
        items,
        itemCount: items.length,
        scoringMethod: body.scoringMethod ?? row.scoringMethod,
        passThreshold: body.passThreshold !== undefined ? body.passThreshold : row.passThreshold,
        frequency: body.frequency ?? row.frequency,
        regulatoryBasis:
          body.regulatoryBasis !== undefined ? body.regulatoryBasis : row.regulatoryBasis,
        isStatutory: body.isStatutory !== undefined ? (body.isStatutory ? 1 : 0) : row.isStatutory,
        appliesToTrades: body.appliesToTrades ?? row.appliesToTrades,
        supersedesId: row.id,
        detail: body.detail ?? row.detail,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_inspection_template",
        objectId: id,
        payload: {
          act: "new_version",
          reference: row.reference,
          version: row.version + 1,
          supersedesId: row.id,
        },
        storePayload: true,
      });
      return reply.status(201).send(decorateTemplate(await fetchTemplate(id, req.companyId!)));
    },
  );

  /* ================================================================ */
  /* INSPECTIONS                                                       */
  /* ================================================================ */

  app.get("/projects/:projectId/safety/inspections", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.string().max(40).optional(),
        inspectionType: z.enum(SAFETY_INSPECTION_TYPES).optional(),
        result: z.string().max(40).optional(),
        statutory: z.enum(["true", "false"]).optional(),
        vendorId: z.string().max(64).optional(),
        overdue: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    const asOf = todayISO();
    const filters = [
      eq(safetyInspections.companyId, req.companyId!),
      eq(safetyInspections.projectId, req.projectId!),
    ];
    if (q.status) filters.push(eq(safetyInspections.status, q.status));
    if (q.inspectionType) filters.push(eq(safetyInspections.inspectionType, q.inspectionType));
    if (q.result) filters.push(eq(safetyInspections.result, q.result));
    if (q.vendorId) filters.push(eq(safetyInspections.vendorId, q.vendorId));
    if (q.statutory) filters.push(eq(safetyInspections.isStatutory, q.statutory === "true" ? 1 : 0));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetyInspections)
      .where(where)
      .orderBy(desc(safetyInspections.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db.select({ n: count() }).from(safetyInspections).where(where);
    let items = rows.map((r) => decorateInspection(r, asOf));
    if (q.overdue === "true") items = items.filter((i) => i.reInspectionOverdue);
    if (q.overdue === "false") items = items.filter((i) => !i.reInspectionOverdue);
    return paginate(items, Number(totalRows[0]?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/safety/inspections",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = inspectionCreateSchema.parse(req.body);
      let template: TemplateRow | null = null;
      if (body.templateId) {
        template = await fetchTemplate(body.templateId, req.companyId!);
        if (template.projectId && template.projectId !== req.projectId!) {
          throw badRequest(
            `Template ${template.reference} belongs to another project and cannot be used here.`,
          );
        }
        if (template.status !== "active") {
          throw badRequest(
            `Template ${template.reference} v${template.version} is \`${template.status}\`. Only an ` +
              `approved, active form may be used for an inspection — a draft has not been reviewed by ` +
              `anyone but its author.`,
          );
        }
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      const seq = await nextRecordNumber(app.db, req.projectId!, "safety_inspection");
      const reference = `SI-${pad(seq)}`;
      const id = newId("insp");
      const isStatutory =
        body.isStatutory !== undefined ? (body.isStatutory ? 1 : 0) : (template?.isStatutory ?? 0);
      await app.db.insert(safetyInspections).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        title: body.title,
        inspectionType: body.inspectionType ?? template?.inspectionType ?? "general_site",
        status: body.scheduledFor ? "scheduled" : "in_progress",
        scheduledFor: body.scheduledFor ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        vendorId: body.vendorId ?? null,
        equipmentId: body.equipmentId ?? null,
        inspectorId: body.inspectorId ?? req.user!.id,
        inspectorName: body.inspectorName ?? null,
        accompaniedBy: body.accompaniedBy ?? [],
        isStatutory,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_inspection",
        objectId: id,
        payload: {
          reference,
          templateId: template?.id ?? null,
          templateVersion: template?.version ?? null,
          isStatutory: isStatutory === 1,
          scheduledFor: body.scheduledFor ?? null,
        },
        storePayload: true,
      });
      const created = await fetchInspection(id, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...decorateInspection(created, todayISO()),
        template: template ? decorateTemplate(template) : null,
      });
    },
  );

  app.get(
    "/projects/:projectId/safety/inspections/:inspectionId",
    { preHandler: readGate },
    async (req) => {
      const { inspectionId } = req.params as { inspectionId: string };
      const row = await fetchInspection(inspectionId, req.companyId!, req.projectId!);
      const template = row.templateId
        ? await fetchTemplate(row.templateId, req.companyId!).catch(() => null)
        : null;
      const actions = await app.db
        .select()
        .from(safetyCorrectiveActions)
        .where(
          and(
            eq(safetyCorrectiveActions.companyId, req.companyId!),
            eq(safetyCorrectiveActions.sourceType, "inspection"),
            eq(safetyCorrectiveActions.sourceId, inspectionId),
          ),
        );
      const asOf = todayISO();
      return {
        ...decorateInspection(row, asOf),
        template: template ? decorateTemplate(template) : null,
        actions: actions.map((a) => decorateAction(a, asOf)),
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/inspections/:inspectionId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { inspectionId } = req.params as { inspectionId: string };
      const body = inspectionCompleteSchema.parse(req.body);
      const row = await fetchInspection(inspectionId, req.companyId!, req.projectId!);
      if (row.status === "complete" || row.status === "reviewed" || row.status === "closed") {
        throw conflict(
          `Inspection ${row.reference} is \`${row.status}\`. Re-recording the answers would overwrite ` +
            `what was found on the day — raise a new inspection.`,
        );
      }
      if (!row.templateId) {
        throw badRequest(
          `Inspection ${row.reference} has no template, so its answers cannot be scored or even ` +
            `checked against a question list. Attach a template before completing it.`,
        );
      }
      const template = await fetchTemplate(row.templateId, req.companyId!);
      const items = normaliseItems(template.items);
      const answers: InspectionAnswer[] = body.responses.map((r) => ({
        itemId: r.itemId,
        response: r.response ?? null,
        numericValue: r.numericValue ?? null,
        isPass: r.isPass === undefined ? undefined : r.isPass,
        note: r.note ?? null,
        photoFileIds: r.photoFileIds ?? [],
      }));
      const scored = scoreInspection(
        items,
        answers,
        template.scoringMethod as InspectionScoringMethod,
        template.passThreshold,
      );
      if (scored.unknownItemIds.length > 0) {
        throw badRequest(
          `Responses reference items that are not in template ${template.reference} ` +
            `v${row.templateVersion ?? template.version}: ${scored.unknownItemIds.join(", ")}. The ` +
            `stamped template version is what the inspection was performed against; answers to ` +
            `questions it does not contain cannot be scored or defended.`,
        );
      }
      if (scored.unansweredRequired.length > 0) {
        throw badRequest(
          `Required items on template ${template.reference} were not answered: ` +
            `${scored.unansweredRequired.join(", ")}. An inspection with unanswered mandatory items ` +
            `is an incomplete inspection, and scoring it would report a percentage over a shorter ` +
            `question list than the form actually asks.`,
        );
      }
      /* A template item marked `photoRequired` means the answer is not
       * believable without the photograph. The flag existed on the schema and
       * on the create/patch schema, and nothing read it: a pass could be
       * recorded against "guardrail continuous to the east edge" with no
       * image, which is exactly the answer somebody gives from the site
       * cabin. The quality module has always enforced it on the same
       * vocabulary; safety now does too. */
      if (scored.missingPhotos.length > 0) {
        const labels = scored.missingPhotos
          .map((id) => {
            const item = items.find((i) => i.id === id);
            return item ? `${id} (${item.text})` : id;
          })
          .join("; ");
        throw badRequest(
          `Template ${template.reference} marks these items photo-required and they were answered ` +
            `with no photograph: ${labels}. The photograph is what distinguishes an inspection that ` +
            `was carried out from one that was filled in — attach one to each, or answer the item ` +
            `not-applicable if the feature is not present.`,
        );
      }

      const performedAt = body.performedAt ?? new Date().toISOString();
      const nextDue =
        body.nextDueDate !== undefined
          ? { nextDueDate: body.nextDueDate, reasons: [] as string[] }
          : asBool(row.isStatutory)
            ? nextStatutoryDueDate(performedAt.slice(0, 10), template.frequency)
            : { nextDueDate: null, reasons: ["Not a statutory inspection — no re-inspection interval applies."] };

      const now = new Date().toISOString();
      await app.db
        .update(safetyInspections)
        .set({
          status: "complete",
          performedAt,
          responses: body.responses,
          score: scored.score,
          maxScore: scored.maxScore,
          scorePercent: scored.scorePercent,
          result: scored.result,
          defectCount: scored.defectCount,
          criticalDefectCount: scored.criticalDefectCount,
          nextDueDate: nextDue.nextDueDate,
          signatureFileId: body.signatureFileId ?? null,
          reportFileId: body.reportFileId ?? null,
          photoFileIds: body.photoFileIds ?? [],
          updatedAt: now,
        })
        .where(eq(safetyInspections.id, inspectionId));

      const raisedActions: Array<{ id: string; itemId: string; isCritical: boolean }> = [];
      if (body.raiseActions !== false && scored.defects.length > 0) {
        const dueDate = body.defectActionDueDate ?? addDaysISO(todayISO(), 7);
        for (const d of scored.defects) {
          const actionId = await createAction({
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            sourceType: "inspection",
            sourceId: inspectionId,
            sourceReference: row.reference,
            title: `${d.isCritical ? "CRITICAL defect" : "Defect"} — ${d.text}`.slice(0, 300),
            description: d.note,
            actionKind: "corrective",
            hierarchyOfControl: body.defectHierarchyOfControl ?? "engineering",
            category: null,
            priority: d.isCritical ? "critical" : "medium",
            ownerId: body.defectActionOwnerId ?? row.inspectorId,
            ownerVendorId: row.vendorId,
            ownerName: null,
            dueDate: d.isCritical ? todayISO() : dueDate,
            costToImplement: null,
            currency: null,
            detail: { itemId: d.itemId, section: d.section, photoFileIds: d.photoFileIds },
          });
          raisedActions.push({ id: actionId, itemId: d.itemId, isCritical: d.isCritical });
        }
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_inspection",
        objectId: inspectionId,
        payload: {
          act: "complete",
          reference: row.reference,
          templateId: template.id,
          templateVersion: row.templateVersion ?? template.version,
          scoringMethod: template.scoringMethod,
          score: scored.score,
          maxScore: scored.maxScore,
          scorePercent: scored.scorePercent,
          result: scored.result,
          defectCount: scored.defectCount,
          criticalDefectCount: scored.criticalDefectCount,
          actionsRaised: raisedActions.map((a) => a.id),
          nextDueDate: nextDue.nextDueDate,
        },
        storePayload: true,
      });

      const updated = await fetchInspection(inspectionId, req.companyId!, req.projectId!);
      return {
        ...decorateInspection(updated, todayISO()),
        scoring: {
          method: template.scoringMethod,
          passThreshold: template.passThreshold,
          score: scored.score,
          maxScore: scored.maxScore,
          scorePercent: scored.scorePercent,
          result: scored.result,
          answeredCount: scored.answeredCount,
          notApplicableCount: scored.notApplicableCount,
          defects: scored.defects,
          criticalDefectCount: scored.criticalDefectCount,
          reasons: scored.reasons,
        },
        nextDue,
        actionsRaised: raisedActions,
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/inspections/:inspectionId/review",
    { preHandler: standardGate },
    async (req) => {
      const { inspectionId } = req.params as { inspectionId: string };
      const body = inspectionReviewSchema.parse(req.body ?? {});
      const row = await fetchInspection(inspectionId, req.companyId!, req.projectId!);
      if (row.status !== "complete") {
        throw conflict(
          `Inspection ${row.reference} is \`${row.status}\` — only a completed inspection can be reviewed.`,
        );
      }
      if (row.inspectorId && row.inspectorId === req.user!.id) {
        throw forbidden(
          "The inspector may not review their own inspection. The review is a second reading of what " +
            "was recorded, and it is worth nothing performed by the person who recorded it — see the " +
            "schema note on `reviewedBy`.",
        );
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden("The person who raised the inspection may not review it.");
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetyInspections)
        .set({
          status: body.close === true ? "closed" : "reviewed",
          reviewedBy: req.user!.id,
          reviewedAt: now,
          closedBy: body.close === true ? req.user!.id : null,
          closedAt: body.close === true ? now : null,
          updatedAt: now,
        })
        .where(eq(safetyInspections.id, inspectionId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_inspection",
        objectId: inspectionId,
        payload: {
          act: "review",
          reference: row.reference,
          inspectorId: row.inspectorId,
          reviewedBy: req.user!.id,
          result: row.result,
          note: body.note ?? null,
          closed: body.close === true,
        },
        storePayload: true,
      });
      return decorateInspection(
        await fetchInspection(inspectionId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  /* ================================================================ */
  /* TOOLBOX TALKS                                                     */
  /* ================================================================ */

  function decorateTalk(t: TalkRow) {
    return {
      ...t,
      interpreterUsed: asBool(t.interpreterUsed),
      attendanceShortfall:
        t.expectedAttendeeCount != null
          ? Math.max(0, t.expectedAttendeeCount - t.attendeeCount)
          : null,
    };
  }

  async function refreshAttendeeCount(talkId: string) {
    const rows = await app.db
      .select({ n: count() })
      .from(toolboxTalkAttendees)
      .where(eq(toolboxTalkAttendees.talkId, talkId));
    await app.db
      .update(toolboxTalks)
      .set({ attendeeCount: Number(rows[0]?.n ?? 0), updatedAt: new Date().toISOString() })
      .where(eq(toolboxTalks.id, talkId));
  }

  app.get("/projects/:projectId/safety/toolbox-talks", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        category: z.enum(SAFETY_CATEGORIES).optional(),
        status: z.string().max(40).optional(),
        vendorId: z.string().max(64).optional(),
        from: isoDateSchema.optional(),
        to: isoDateSchema.optional(),
      })
      .parse(req.query);
    const filters = [
      eq(toolboxTalks.companyId, req.companyId!),
      eq(toolboxTalks.projectId, req.projectId!),
    ];
    if (q.category) filters.push(eq(toolboxTalks.category, q.category));
    if (q.status) filters.push(eq(toolboxTalks.status, q.status));
    if (q.vendorId) filters.push(eq(toolboxTalks.vendorId, q.vendorId));
    if (q.from) filters.push(gte(toolboxTalks.talkDate, q.from));
    if (q.to) filters.push(lte(toolboxTalks.talkDate, q.to));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(toolboxTalks)
      .where(where)
      .orderBy(desc(toolboxTalks.talkDate))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db.select({ n: count() }).from(toolboxTalks).where(where);
    return paginate(rows.map(decorateTalk), Number(totalRows[0]?.n ?? 0), q);
  });

  app.post(
    "/projects/:projectId/safety/toolbox-talks",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = talkCreateSchema.parse(req.body);
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.relatedIncidentId) {
        await fetchIncident(body.relatedIncidentId, req.companyId!, req.projectId!);
      }
      if (body.relatedObservationId) {
        await fetchObservation(body.relatedObservationId, req.companyId!, req.projectId!);
      }
      const seq = await nextRecordNumber(app.db, req.projectId!, "toolbox_talk");
      const reference = `TBT-${pad(seq)}`;
      const id = newId("tbt");
      await app.db.insert(toolboxTalks).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        title: body.title,
        topic: body.topic ?? null,
        category: body.category ?? "other",
        talkDate: body.talkDate,
        startTime: body.startTime ?? null,
        durationMinutes: body.durationMinutes ?? null,
        locationId: body.locationId ?? null,
        locationText: body.locationText ?? null,
        presenterId: body.presenterId ?? req.user!.id,
        presenterName: body.presenterName ?? null,
        vendorId: body.vendorId ?? null,
        crewId: body.crewId ?? null,
        contentSummary: body.contentSummary ?? null,
        contentFileId: body.contentFileId ?? null,
        language: body.language ?? null,
        interpreterUsed: fromBool(body.interpreterUsed),
        expectedAttendeeCount: body.expectedAttendeeCount ?? null,
        relatedIncidentId: body.relatedIncidentId ?? null,
        relatedObservationId: body.relatedObservationId ?? null,
        status: "planned",
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "toolbox_talk",
        objectId: id,
        payload: {
          reference,
          title: body.title,
          category: body.category ?? "other",
          talkDate: body.talkDate,
          relatedIncidentId: body.relatedIncidentId ?? null,
          language: body.language ?? null,
        },
        storePayload: true,
      });
      return reply
        .status(201)
        .send(decorateTalk(await fetchTalk(id, req.companyId!, req.projectId!)));
    },
  );

  app.get(
    "/projects/:projectId/safety/toolbox-talks/:talkId",
    { preHandler: readGate },
    async (req) => {
      const { talkId } = req.params as { talkId: string };
      const row = await fetchTalk(talkId, req.companyId!, req.projectId!);
      const attendees = await app.db
        .select()
        .from(toolboxTalkAttendees)
        .where(eq(toolboxTalkAttendees.talkId, talkId))
        .orderBy(asc(toolboxTalkAttendees.name));
      return {
        ...decorateTalk(row),
        attendees: attendees.map((a) => ({
          ...a,
          comprehensionChecked: asBool(a.comprehensionChecked),
        })),
        comprehensionCheckedCount: attendees.filter((a) => asBool(a.comprehensionChecked)).length,
        registeredWorkerCount: attendees.filter((a) => a.workerId != null).length,
      };
    },
  );

  app.patch(
    "/projects/:projectId/safety/toolbox-talks/:talkId",
    { preHandler: standardGate },
    async (req) => {
      const { talkId } = req.params as { talkId: string };
      const body = talkPatchSchema.parse(req.body);
      const row = await fetchTalk(talkId, req.companyId!, req.projectId!);
      if (row.status === "verified") {
        throw conflict(
          `Talk ${row.reference} has been verified. Editing it now would change a record a second ` +
            `person has already attested to.`,
        );
      }
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "topic",
        "category",
        "talkDate",
        "startTime",
        "durationMinutes",
        "locationId",
        "locationText",
        "presenterId",
        "presenterName",
        "vendorId",
        "crewId",
        "contentSummary",
        "contentFileId",
        "language",
        "expectedAttendeeCount",
        "relatedIncidentId",
        "relatedObservationId",
        "detail",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.interpreterUsed !== undefined) patch["interpreterUsed"] = body.interpreterUsed ? 1 : 0;
      await app.db.update(toolboxTalks).set(patch).where(eq(toolboxTalks.id, talkId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "toolbox_talk",
        objectId: talkId,
        payload: { reference: row.reference, changed: Object.keys(body) },
        storePayload: true,
      });
      return decorateTalk(await fetchTalk(talkId, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/safety/toolbox-talks/:talkId/attendees",
    { preHandler: standardGate },
    async (req, reply) => {
      const { talkId } = req.params as { talkId: string };
      const body = attendeesSchema.parse(req.body);
      const talk = await fetchTalk(talkId, req.companyId!, req.projectId!);
      if (talk.status === "verified" || talk.status === "cancelled") {
        throw conflict(`Talk ${talk.reference} is ${talk.status} — attendance can no longer be added.`);
      }
      const existing = await app.db
        .select({ workerId: toolboxTalkAttendees.workerId })
        .from(toolboxTalkAttendees)
        .where(eq(toolboxTalkAttendees.talkId, talkId));
      const seenWorkers = new Set(existing.map((e) => e.workerId).filter((w): w is string => w != null));

      const rows: Array<typeof toolboxTalkAttendees.$inferInsert> = [];
      for (const a of body.attendees) {
        let name = a.name ?? null;
        let vendorId = a.vendorId ?? null;
        let trade = a.trade ?? null;
        if (a.workerId) {
          if (seenWorkers.has(a.workerId)) {
            throw conflict(
              `Worker ${a.workerId} is already recorded as attending talk ${talk.reference}. ` +
                `Duplicate attendance would inflate the count and the evidence.`,
            );
          }
          seenWorkers.add(a.workerId);
          const worker = await assertWorker(a.workerId, req.companyId!, req.projectId!);
          name = name ?? worker.fullName;
          vendorId = vendorId ?? worker.vendorId;
          trade = trade ?? worker.trade;
        }
        if (!name) {
          throw badRequest(
            "Each attendee needs either a `workerId` from the project's worker register or a `name`. " +
              "Only people who exist in no register at all — a visitor, a delivery driver — fall back " +
              "to a bare name.",
          );
        }
        rows.push({
          id: newId("tba"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          talkId,
          workerId: a.workerId ?? null,
          userId: a.userId ?? null,
          name,
          vendorId,
          trade,
          acknowledgementMethod: a.acknowledgementMethod ?? "wet_signature",
          signedAt: a.signedAt ?? new Date().toISOString(),
          signatureFileId: a.signatureFileId ?? null,
          comprehensionChecked: fromBool(a.comprehensionChecked),
          comprehensionNote: a.comprehensionNote ?? null,
        });
      }
      await app.db.insert(toolboxTalkAttendees).values(rows);
      await refreshAttendeeCount(talkId);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "toolbox_talk_attendance",
        objectId: talkId,
        payload: {
          reference: talk.reference,
          added: rows.length,
          workerIds: rows.map((r) => r.workerId).filter(Boolean),
          comprehensionChecked: rows.filter((r) => r.comprehensionChecked === 1).length,
        },
        storePayload: true,
      });
      const updated = await fetchTalk(talkId, req.companyId!, req.projectId!);
      const unchecked = rows.filter((r) => r.comprehensionChecked !== 1).length;
      return reply.status(201).send({
        ...decorateTalk(updated),
        added: rows.length,
        comprehensionNote:
          unchecked > 0
            ? `${unchecked} of ${rows.length} attendee(s) were recorded as present without a ` +
              `comprehension check. A signature proves attendance, not understanding — and where the ` +
              `talk was delivered in a language the attendee does not work in, it proves neither.`
            : null,
      });
    },
  );

  app.delete(
    "/projects/:projectId/safety/toolbox-talks/:talkId/attendees/:attendeeId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { talkId, attendeeId } = req.params as { talkId: string; attendeeId: string };
      const talk = await fetchTalk(talkId, req.companyId!, req.projectId!);
      if (talk.status === "verified") {
        throw conflict(`Talk ${talk.reference} is verified — its attendance list is now evidence.`);
      }
      const rows = await app.db
        .select()
        .from(toolboxTalkAttendees)
        .where(and(eq(toolboxTalkAttendees.id, attendeeId), eq(toolboxTalkAttendees.talkId, talkId)))
        .limit(1);
      if (!rows[0]) throw notFound("Attendee not found on this talk");
      await app.db.delete(toolboxTalkAttendees).where(eq(toolboxTalkAttendees.id, attendeeId));
      await refreshAttendeeCount(talkId);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "toolbox_talk_attendance",
        objectId: attendeeId,
        payload: { talkId, reference: talk.reference, workerId: rows[0].workerId, name: rows[0].name },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/projects/:projectId/safety/toolbox-talks/:talkId/deliver",
    { preHandler: standardGate },
    async (req) => {
      const { talkId } = req.params as { talkId: string };
      const row = await fetchTalk(talkId, req.companyId!, req.projectId!);
      if (row.status !== "planned") throw conflict(`Talk ${row.reference} is already ${row.status}.`);
      if (row.attendeeCount === 0) {
        throw badRequest(
          `Talk ${row.reference} has no attendance recorded. A briefing with no attendees is a ` +
            `document, not a briefing — record who was there first.`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(toolboxTalks)
        .set({ status: "delivered", updatedAt: now })
        .where(eq(toolboxTalks.id, talkId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "toolbox_talk",
        objectId: talkId,
        payload: {
          act: "deliver",
          reference: row.reference,
          attendeeCount: row.attendeeCount,
          expectedAttendeeCount: row.expectedAttendeeCount,
        },
        storePayload: true,
      });
      return decorateTalk(await fetchTalk(talkId, req.companyId!, req.projectId!));
    },
  );

  app.post(
    "/projects/:projectId/safety/toolbox-talks/:talkId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { talkId } = req.params as { talkId: string };
      const body = z.object({ note: z.string().max(4000).optional() }).parse(req.body ?? {});
      const row = await fetchTalk(talkId, req.companyId!, req.projectId!);
      if (row.status !== "delivered") {
        throw conflict(`Talk ${row.reference} is \`${row.status}\` — only a delivered talk can be verified.`);
      }
      if (row.presenterId && row.presenterId === req.user!.id) {
        throw forbidden(
          "The presenter may not verify their own talk. Verification is the attestation that the " +
            "briefing actually happened and that the people on the sheet were in the room — see the " +
            "schema note on `verifiedBy`.",
        );
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden("The person who recorded the talk may not verify it.");
      }
      const now = new Date().toISOString();
      await app.db
        .update(toolboxTalks)
        .set({ status: "verified", verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
        .where(eq(toolboxTalks.id, talkId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "toolbox_talk",
        objectId: talkId,
        payload: {
          act: "verify",
          reference: row.reference,
          presenterId: row.presenterId,
          verifiedBy: req.user!.id,
          attendeeCount: row.attendeeCount,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return decorateTalk(await fetchTalk(talkId, req.companyId!, req.projectId!));
    },
  );

  /**
   * The inverse query, and the reason attendance is a table rather than a
   * jsonb array: "has this worker been briefed on confined spaces this
   * month" is asked about a PERSON, by a supervisor at a gate, not about a
   * talk.
   */
  app.get(
    "/projects/:projectId/safety/workers/:workerId/briefings",
    { preHandler: readGate },
    async (req) => {
      const { workerId } = req.params as { workerId: string };
      const q = z
        .object({
          category: z.enum(SAFETY_CATEGORIES).optional(),
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
        })
        .parse(req.query);
      const worker = await assertWorker(workerId, req.companyId!, req.projectId!);
      const filters = [
        eq(toolboxTalkAttendees.workerId, workerId),
        eq(toolboxTalks.companyId, req.companyId!),
        eq(toolboxTalks.projectId, req.projectId!),
      ];
      if (q.category) filters.push(eq(toolboxTalks.category, q.category));
      if (q.from) filters.push(gte(toolboxTalks.talkDate, q.from));
      if (q.to) filters.push(lte(toolboxTalks.talkDate, q.to));
      const rows = await app.db
        .select({
          talkId: toolboxTalks.id,
          reference: toolboxTalks.reference,
          title: toolboxTalks.title,
          topic: toolboxTalks.topic,
          category: toolboxTalks.category,
          talkDate: toolboxTalks.talkDate,
          language: toolboxTalks.language,
          status: toolboxTalks.status,
          relatedIncidentId: toolboxTalks.relatedIncidentId,
          acknowledgementMethod: toolboxTalkAttendees.acknowledgementMethod,
          signedAt: toolboxTalkAttendees.signedAt,
          comprehensionChecked: toolboxTalkAttendees.comprehensionChecked,
          comprehensionNote: toolboxTalkAttendees.comprehensionNote,
        })
        .from(toolboxTalkAttendees)
        .innerJoin(toolboxTalks, eq(toolboxTalkAttendees.talkId, toolboxTalks.id))
        .where(and(...filters))
        .orderBy(desc(toolboxTalks.talkDate));
      const categories = [...new Set(rows.map((r) => r.category))];
      return {
        worker: { id: worker.id, fullName: worker.fullName, vendorId: worker.vendorId, trade: worker.trade },
        briefings: rows.map((r) => ({ ...r, comprehensionChecked: asBool(r.comprehensionChecked) })),
        count: rows.length,
        categoriesCovered: categories,
        lastBriefedAt: rows[0]?.talkDate ?? null,
        comprehensionCheckedCount: rows.filter((r) => asBool(r.comprehensionChecked)).length,
        reasons:
          rows.length === 0
            ? [
                `No briefing attendance is recorded for ${worker.fullName} on this project` +
                  `${q.category ? ` in category \`${q.category}\`` : ""}. That is a statement about the ` +
                  `RECORD, not about the person — a talk delivered and never recorded looks identical here.`,
              ]
            : [],
      };
    },
  );

  /* ================================================================ */
  /* SAFETY PROGRAMME RECORDS                                          */
  /* ================================================================ */

  async function listRecords(
    companyId: string,
    projectId: string | null,
    q: z.infer<typeof recordListQuery>,
  ) {
    const asOf = todayISO();
    const filters = [eq(safetyProgrammeRecords.companyId, companyId)];
    if (projectId) {
      // A project view sees its own records AND the company-level programme
      // that applies across projects (the policy, the training matrix).
      filters.push(
        or(
          eq(safetyProgrammeRecords.projectId, projectId),
          isNull(safetyProgrammeRecords.projectId),
        )!,
      );
    } else if (q.projectId) {
      filters.push(eq(safetyProgrammeRecords.projectId, q.projectId));
    }
    if (q.recordKind) filters.push(eq(safetyProgrammeRecords.recordKind, q.recordKind));
    if (q.status) filters.push(eq(safetyProgrammeRecords.status, q.status));
    if (q.workerId) filters.push(eq(safetyProgrammeRecords.workerId, q.workerId));
    if (q.vendorId) filters.push(eq(safetyProgrammeRecords.vendorId, q.vendorId));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetyProgrammeRecords)
      .where(where)
      .orderBy(desc(safetyProgrammeRecords.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db
      .select({ n: count() })
      .from(safetyProgrammeRecords)
      .where(where);
    let items = rows.map((r) => decorateRecord(r, asOf));
    if (q.expiringWithinDays !== undefined) {
      const horizon = addDaysISO(asOf, q.expiringWithinDays);
      items = items.filter((i) => i.expiresAt != null && i.expiresAt <= horizon);
    }
    return paginate(items, Number(totalRows[0]?.n ?? 0), q);
  }

  app.get("/companies/current/safety/programme-records", { preHandler: companyRead }, async (req) => {
    const q = recordListQuery.parse(req.query);
    await sweepThrottled(req.companyId!, null, req.user!.id);
    return listRecords(req.companyId!, null, q);
  });

  app.get("/projects/:projectId/safety/programme-records", { preHandler: readGate }, async (req) => {
    const q = recordListQuery.parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    return listRecords(req.companyId!, req.projectId!, q);
  });

  app.post(
    "/companies/current/safety/programme-records",
    { preHandler: companyWrite },
    async (req, reply) => {
      const body = recordCreateSchema.parse(req.body);
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      if (body.workerId) {
        if (!body.projectId) {
          throw badRequest(
            "A personal record (a competency card, an induction) needs the `projectId` of the worker " +
              "it belongs to — the worker register is per project.",
          );
        }
        await assertWorker(body.workerId, req.companyId!, body.projectId);
      }
      if (CRITICAL_RECORD_KINDS.has(body.recordKind) && !body.expiresAt) {
        throw badRequest(
          `A \`${body.recordKind}\` must carry an expiry date. This table exists because these records ` +
            `expire and something has to be watching the date; one without an expiry is invisible to ` +
            `the sweep and will be relied on indefinitely.`,
        );
      }
      const seq = await nextRecordNumber(app.db, req.companyId!, "safety_programme_record");
      const reference = body.reference ?? `SPR-${pad(seq)}`;
      const reviewDueDate =
        body.reviewDueDate ??
        (body.effectiveFrom && body.reviewIntervalMonths
          ? addMonthsISO(body.effectiveFrom, body.reviewIntervalMonths)
          : null);
      const id = newId("spr");
      await app.db.insert(safetyProgrammeRecords).values({
        id,
        companyId: req.companyId!,
        projectId: body.projectId ?? null,
        number: seq,
        reference,
        recordKind: body.recordKind,
        title: body.title,
        description: body.description ?? null,
        version: body.version ?? null,
        status: "draft",
        documentFileId: body.documentFileId ?? null,
        documentSha256: body.documentSha256 ?? null,
        effectiveFrom: body.effectiveFrom ?? null,
        expiresAt: body.expiresAt ?? null,
        reviewDueDate,
        reviewIntervalMonths: body.reviewIntervalMonths ?? null,
        ownerId: body.ownerId ?? null,
        vendorId: body.vendorId ?? null,
        workerId: body.workerId ?? null,
        appliesToTrades: body.appliesToTrades ?? [],
        appliesToLocationIds: body.appliesToLocationIds ?? [],
        regulatoryReference: body.regulatoryReference ?? null,
        categories: body.categories ?? [],
        requiredAcknowledgementCount: body.requiredAcknowledgementCount ?? null,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: body.projectId ?? null,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_programme_record",
        objectId: id,
        payload: {
          reference,
          recordKind: body.recordKind,
          title: body.title,
          version: body.version ?? null,
          expiresAt: body.expiresAt ?? null,
          reviewDueDate,
          workerId: body.workerId ?? null,
          documentSha256: body.documentSha256 ?? null,
        },
        storePayload: true,
      });
      return reply
        .status(201)
        .send(decorateRecord(await fetchRecord(id, req.companyId!), todayISO()));
    },
  );

  app.get(
    "/companies/current/safety/programme-records/:recordId",
    { preHandler: companyRead },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      return decorateRecord(await fetchRecord(recordId, req.companyId!), todayISO());
    },
  );

  app.patch(
    "/companies/current/safety/programme-records/:recordId",
    { preHandler: companyWrite },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const body = recordPatchSchema.parse(req.body);
      const row = await fetchRecord(recordId, req.companyId!);
      if (row.status === "superseded" || row.status === "withdrawn") {
        throw conflict(
          `Record ${row.reference} is ${row.status} and is now historical. Amend the record that ` +
            `replaced it.`,
        );
      }
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "description",
        "version",
        "reference",
        "documentFileId",
        "documentSha256",
        "effectiveFrom",
        "expiresAt",
        "reviewDueDate",
        "reviewIntervalMonths",
        "ownerId",
        "vendorId",
        "workerId",
        "appliesToTrades",
        "appliesToLocationIds",
        "regulatoryReference",
        "categories",
        "requiredAcknowledgementCount",
        "detail",
      ] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      // An expiry pushed into the future revives a record the sweep expired.
      if (body.expiresAt && row.status === "expired" && body.expiresAt >= todayISO()) {
        patch["status"] = row.approvedAt ? "active" : "draft";
      }
      await app.db
        .update(safetyProgrammeRecords)
        .set(patch)
        .where(eq(safetyProgrammeRecords.id, recordId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_programme_record",
        objectId: recordId,
        payload: { reference: row.reference, changed: Object.keys(body) },
        storePayload: true,
      });
      return decorateRecord(await fetchRecord(recordId, req.companyId!), todayISO());
    },
  );

  app.post(
    "/companies/current/safety/programme-records/:recordId/approve",
    { preHandler: companyWrite },
    async (req) => {
      const { recordId } = req.params as { recordId: string };
      const row = await fetchRecord(recordId, req.companyId!);
      if (row.status !== "draft" && row.status !== "in_review") {
        throw conflict(`Record ${row.reference} is \`${row.status}\` and is not awaiting approval.`);
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "A safety programme record may not be approved by its author. A risk assessment, a method " +
            "statement or a permit signed off by the person who wrote it has been reviewed by nobody " +
            "— see the schema note on `approvedBy`.",
        );
      }
      const now = new Date().toISOString();
      const expiredAlready = row.expiresAt != null && row.expiresAt < todayISO();
      await app.db
        .update(safetyProgrammeRecords)
        .set({
          status: expiredAlready ? "expired" : "active",
          approvedBy: req.user!.id,
          approvedAt: now,
          updatedAt: now,
        })
        .where(eq(safetyProgrammeRecords.id, recordId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_programme_record",
        objectId: recordId,
        payload: {
          act: "approve",
          reference: row.reference,
          author: row.createdBy,
          approvedBy: req.user!.id,
          to: expiredAlready ? "expired" : "active",
        },
        storePayload: true,
      });
      return {
        ...decorateRecord(await fetchRecord(recordId, req.companyId!), todayISO()),
        note: expiredAlready
          ? `This record's expiry date (${row.expiresAt}) has already passed, so approving it made it ` +
            `\`expired\` rather than \`active\`. Approving an out-of-date document does not make it current.`
          : null,
      };
    },
  );

  app.post(
    "/companies/current/safety/programme-records/:recordId/acknowledge",
    { preHandler: companyRead },
    async (req, reply) => {
      const { recordId } = req.params as { recordId: string };
      const body = acknowledgementSchema.parse(req.body ?? {});
      const row = await fetchRecord(recordId, req.companyId!);
      if (row.status !== "active" && row.status !== "approved") {
        throw conflict(
          `Record ${row.reference} is \`${row.status}\`. Acknowledging a draft or an expired document ` +
            `records that somebody read something that is not in force.`,
        );
      }
      if (body.workerId && row.projectId) {
        await assertWorker(body.workerId, req.companyId!, row.projectId);
      }

      /* WHO MAY SAY THAT SOMEBODY READ THIS.
       *
       * An acknowledgement is the evidence an inspector relies on: it is the
       * proof that the person doing the work had seen the method statement,
       * the permit or the policy. This route once trusted `body.userId`
       * outright, so any company member — a guest included — could record that
       * any other named user had read and understood anything. That is the
       * cheapest possible way to manufacture the one document that matters.
       *
       * Now: a caller may acknowledge for THEMSELVES; a company owner or admin
       * may record for another user; and recording for a WORKER — who is not a
       * platform user and cannot press the button — requires a method that
       * carries its own evidence and a written attestation of what was
       * actually witnessed. The on-behalf-of relationship is stored on the
       * entry rather than left to be inferred from `recordedBy`. */
      const isAdmin = req.companyRole === "owner" || req.companyRole === "admin";
      const onBehalfOfUser = body.userId != null && body.userId !== req.user!.id;
      if (onBehalfOfUser && !isAdmin) {
        throw forbidden(
          `You may only record your own acknowledgement of ${row.reference}. Recording that ` +
            `${body.userId} has read and understood a policy, a RAMS or a permit is an assertion ` +
            `about somebody else's knowledge, and it is the exact document relied on after an ` +
            `incident — so it is limited to a company owner or admin, and it is stored as an ` +
            `on-behalf-of entry naming who made it. Ask ${body.userId} to acknowledge it themselves.`,
        );
      }
      if (body.workerId) {
        const method = body.method ?? null;
        if (!method || !ATTESTABLE_METHODS.has(method)) {
          throw badRequest(
            `Recording an acknowledgement for worker ${body.workerId} needs a method that carries ` +
              `its own evidence — a wet signature, a biometric or badge capture, a QR scan, or an ` +
              `explicit supervisor attestation. A worker is not a platform user and cannot have ` +
              `pressed anything, so an unqualified entry here is one person's word that another ` +
              `person read a document. Supplied: ${method ?? "no method"}.`,
          );
        }
        if (method === "supervisor_attested" && !body.attestation) {
          throw badRequest(
            `A supervisor attestation needs \`attestation\`: what was actually witnessed — the ` +
              `briefing given, the questions asked, the date and place. "Attested" with nothing ` +
              `behind it is the weakest evidence in the file.`,
          );
        }
      }

      const acks = [...(row.acknowledgements ?? [])] as Array<Record<string, unknown>>;
      const subject = body.workerId ?? body.userId ?? req.user!.id;
      if (acks.some((a) => (a["workerId"] ?? a["userId"]) === subject)) {
        throw conflict(`${subject} has already acknowledged ${row.reference}.`);
      }
      const selfRecorded = !body.workerId && (!body.userId || body.userId === req.user!.id);
      acks.push({
        workerId: body.workerId ?? null,
        userId: body.workerId ? null : (body.userId ?? req.user!.id),
        acknowledgedAt: body.acknowledgedAt ?? new Date().toISOString(),
        method: body.method ?? "on_device_signature",
        recordedBy: req.user!.id,
        /** false when somebody recorded this for somebody else */
        selfRecorded,
        recordedOnBehalf: selfRecorded ? null : { by: req.user!.id, role: req.companyRole ?? null },
        attestation: body.attestation ?? null,
      });
      await app.db
        .update(safetyProgrammeRecords)
        .set({
          acknowledgements: acks,
          acknowledgementCount: acks.length,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(safetyProgrammeRecords.id, recordId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_programme_record",
        objectId: recordId,
        payload: {
          act: "acknowledge",
          reference: row.reference,
          subject,
          method: body.method ?? "on_device_signature",
          selfRecorded,
          recordedBy: req.user!.id,
          attestation: body.attestation ?? null,
          count: acks.length,
          required: row.requiredAcknowledgementCount,
        },
        storePayload: true,
      });
      return reply
        .status(201)
        .send(decorateRecord(await fetchRecord(recordId, req.companyId!), todayISO()));
    },
  );

  app.post(
    "/companies/current/safety/programme-records/:recordId/supersede",
    { preHandler: companyWrite },
    async (req, reply) => {
      const { recordId } = req.params as { recordId: string };
      const body = supersedeSchema.parse(req.body);
      const row = await fetchRecord(recordId, req.companyId!);
      if (row.supersededById) {
        throw conflict(
          `Record ${row.reference} has already been superseded by ${row.supersededById}. A document ` +
            `with two successors has no successor.`,
        );
      }
      const seq = await nextRecordNumber(app.db, req.companyId!, "safety_programme_record");
      const reference = body.reference ?? `SPR-${pad(seq)}`;
      const id = newId("spr");
      const now = new Date().toISOString();
      const reviewDueDate =
        body.reviewDueDate ??
        (body.effectiveFrom && (body.reviewIntervalMonths ?? row.reviewIntervalMonths)
          ? addMonthsISO(body.effectiveFrom, body.reviewIntervalMonths ?? row.reviewIntervalMonths!)
          : null);
      await app.db.insert(safetyProgrammeRecords).values({
        id,
        companyId: req.companyId!,
        projectId: body.projectId !== undefined ? body.projectId : row.projectId,
        number: seq,
        reference,
        recordKind: row.recordKind,
        title: body.title,
        description: body.description !== undefined ? body.description : row.description,
        version: body.version !== undefined ? body.version : null,
        status: "draft",
        documentFileId: body.documentFileId ?? null,
        documentSha256: body.documentSha256 ?? null,
        effectiveFrom: body.effectiveFrom ?? null,
        expiresAt: body.expiresAt ?? null,
        reviewDueDate,
        reviewIntervalMonths: body.reviewIntervalMonths ?? row.reviewIntervalMonths,
        ownerId: body.ownerId !== undefined ? body.ownerId : row.ownerId,
        vendorId: body.vendorId !== undefined ? body.vendorId : row.vendorId,
        workerId: body.workerId !== undefined ? body.workerId : row.workerId,
        appliesToTrades: body.appliesToTrades ?? row.appliesToTrades,
        appliesToLocationIds: body.appliesToLocationIds ?? row.appliesToLocationIds,
        regulatoryReference:
          body.regulatoryReference !== undefined ? body.regulatoryReference : row.regulatoryReference,
        categories: body.categories ?? row.categories,
        requiredAcknowledgementCount:
          body.requiredAcknowledgementCount !== undefined
            ? body.requiredAcknowledgementCount
            : row.requiredAcknowledgementCount,
        supersedesId: row.id,
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await app.db
        .update(safetyProgrammeRecords)
        .set({ status: "superseded", supersededById: id, updatedAt: now })
        .where(eq(safetyProgrammeRecords.id, recordId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: row.projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_programme_record",
        objectId: recordId,
        payload: {
          act: "supersede",
          reference: row.reference,
          supersededById: id,
          newReference: reference,
          reason: body.reason ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send({
        ...decorateRecord(await fetchRecord(id, req.companyId!), todayISO()),
        supersedes: {
          id: row.id,
          reference: row.reference,
          version: row.version,
          acknowledgementCount: row.acknowledgementCount,
        },
        note:
          row.acknowledgementCount > 0
            ? `The superseded version carried ${row.acknowledgementCount} acknowledgement(s). Those do ` +
              `NOT carry forward: the people who signed for the old document have not seen this one, ` +
              `and re-acknowledgement is the only thing that shows they have.`
            : null,
      });
    },
  );

  /* ================================================================ */
  /* STATISTICS — rates with a real denominator or none at all         */
  /* ================================================================ */

  /**
   * How the statutory duties on a set of incidents actually stand.
   *
   * Counted per DUTY rather than per incident, because an incident answerable
   * to two authorities can have one duty discharged and one missed, and the
   * header of the safety workspace has to be able to say so. The old shape
   * counted `regulator_notified_at == null`, which is a single derived column.
   */
  function statutoryStanding(rows: readonly IncidentRow[]) {
    const nowISO = new Date().toISOString();
    let awaiting = 0;
    let missed = 0;
    let outstandingDuties = 0;
    let missedDuties = 0;
    const missedRefs: Array<{ id: string; reference: string; regimes: string[] }> = [];
    const awaitingRefs: Array<{ id: string; reference: string; regimes: string[] }> = [];
    const reviewRefs: Array<{ id: string; reference: string }> = [];
    for (const row of rows) {
      if (storedDetermination(row)?.needsHumanReview === true) {
        reviewRefs.push({ id: row.id, reference: row.reference });
      }
      if (!asBool(row.isReportable)) continue;
      const state = incidentNotificationState(row, nowISO);
      const rowMissed = state.duties.filter((d) => d.state === "missed");
      const rowOutstanding = state.duties.filter((d) => d.state === "outstanding");
      missedDuties += rowMissed.length;
      outstandingDuties += rowOutstanding.length;
      if (rowMissed.length > 0) {
        missed += 1;
        missedRefs.push({
          id: row.id,
          reference: row.reference,
          regimes: rowMissed.map((d) => d.regime),
        });
      } else if (rowOutstanding.length > 0) {
        awaiting += 1;
        awaitingRefs.push({
          id: row.id,
          reference: row.reference,
          regimes: rowOutstanding.map((d) => d.regime),
        });
      }
    }
    return {
      reportableCount: rows.filter((r) => asBool(r.isReportable)).length,
      notifiedCount: rows.filter((r) => r.regulatorNotifiedAt != null).length,
      /** incidents with at least one live, unexpired duty */
      awaitingNotification: awaiting,
      /** incidents with at least one deadline already passed and nothing filed */
      missedNotification: missed,
      outstandingDuties,
      missedDuties,
      needsHumanReview: reviewRefs.length,
      missedRefs,
      awaitingRefs,
      reviewRefs,
      note:
        "Counted per DUTY, not per incident. An incident answerable under two regimes owes two " +
        "notifications on two clocks; discharging one discharges nothing of the other.",
    };
  }

  /** Timecard states that represent hours actually worked and stood behind. */
  const COUNTED_TIMECARD_STATUSES = ["submitted", "approved", "revised", "locked", "exported"];

  app.get("/projects/:projectId/safety/statistics", { preHandler: readGate }, async (req) => {
    const q = statisticsQuery.parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    const to = q.to ?? todayISO();
    const from = q.from ?? addDaysISO(to, -365);
    if (from > to) throw badRequest(`from ${from} falls after to ${to}.`);

    /* --- the denominator, read from real records only --- */
    const tcAgg = await app.db
      .select({
        hours: sql<number>`coalesce(sum(${timecards.totalHours}), 0)`,
        n: count(),
      })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, req.companyId!),
          eq(timecards.projectId, req.projectId!),
          gte(timecards.workDate, from),
          lte(timecards.workDate, to),
          inArray(timecards.status, COUNTED_TIMECARD_STATUSES),
        ),
      );
    const saAgg = await app.db
      .select({
        hours: sql<number>`coalesce(sum(${siteAccessRecords.hoursOnSite}), 0)`,
        n: count(),
      })
      .from(siteAccessRecords)
      .where(
        and(
          eq(siteAccessRecords.companyId, req.companyId!),
          eq(siteAccessRecords.projectId, req.projectId!),
          gte(siteAccessRecords.accessDate, from),
          lte(siteAccessRecords.accessDate, to),
        ),
      );
    const timecardCount = Number(tcAgg[0]?.n ?? 0);
    const siteAccessCount = Number(saAgg[0]?.n ?? 0);
    const exposure = resolveExposureHours({
      timecardHours: timecardCount > 0 ? Number(tcAgg[0]?.hours ?? 0) : null,
      timecardCount,
      siteAccessHours: siteAccessCount > 0 ? Number(saAgg[0]?.hours ?? 0) : null,
      siteAccessCount,
      from,
      to,
    });

    /* --- the numerators, from the incident register --- */
    const incidents = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, req.companyId!),
          eq(safetyIncidents.projectId, req.projectId!),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
          sql`${safetyIncidents.status} <> 'void'`,
        ),
      );
    const RECORDABLE = ["death", "days_away_from_work", "job_transfer_or_restriction", "other_recordable"];
    const DART = ["days_away_from_work", "job_transfer_or_restriction"];
    const counts: RateCounts = {
      recordableCases: incidents.filter((i) => RECORDABLE.includes(i.oshaCaseType ?? "")).length,
      lostTimeCases: incidents.filter((i) => asBool(i.isLostTime)).length,
      dartCases: incidents.filter((i) => DART.includes(i.oshaCaseType ?? "")).length,
      fatalities: incidents.filter((i) => asBool(i.isFatality)).length,
      daysLost: incidents.reduce((s, i) => s + (i.lostTimeDays ?? 0), 0),
      allInjuries: incidents.filter(
        (i) => i.incidentType === "injury" || i.incidentType === "occupational_illness",
      ).length,
      nearMisses: incidents.filter((i) => i.incidentType === "near_miss").length,
      // "Still under assessment" means a RULE could not be decided — not that a
      // regime does not apply here. A GB project's OSHA case type reads
      // `under_assessment` because OSHA was never assessed, and counting that
      // as an open classification would put a permanent caveat on every rate.
      underAssessment: incidents.filter(
        (i) => (storedDetermination(i)?.indeterminateRuleIds ?? []).length > 0,
      ).length,
      /* Incidents on which the OSHA question was never asked at all. On a
       * RIDDOR-only project every incident carries `oshaCaseType:
       * "under_assessment"` because 29 CFR 1904 was not among the assessed
       * regimes — so counting recordable cases by OSHA case type returns zero,
       * and TRIR 0.00 goes onto a prequalification questionnaire from a
       * register holding specified injuries. computeSafetyRates refuses TRIR
       * and DART when this is non-zero. */
      unassessedForOsha: incidents.filter((i) => !assessedUnderOsha(i)).length,
    };

    const observationRows = await app.db
      .select({ kind: safetyObservations.kind, n: count() })
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, req.companyId!),
          eq(safetyObservations.projectId, req.projectId!),
          gte(safetyObservations.observedAt, `${from}T00:00:00Z`),
          lte(safetyObservations.observedAt, `${to}T23:59:59Z`),
        ),
      )
      .groupBy(safetyObservations.kind);
    const positive = Number(observationRows.find((r) => r.kind === "positive")?.n ?? 0);
    const negative = Number(observationRows.find((r) => r.kind === "negative")?.n ?? 0);

    const rates = computeSafetyRates(from, to, counts, exposure);
    return {
      projectId: req.projectId!,
      ...rates,
      reportable: statutoryStanding(incidents),
      leadingIndicators: {
        observationsPositive: positive,
        observationsNegative: negative,
        positiveShare:
          positive + negative > 0
            ? Math.round((positive / (positive + negative)) * 1000) / 10
            : null,
        reasons:
          positive + negative === 0
            ? ["No observations recorded in the window, so no positive/negative ratio exists."]
            : positive === 0
              ? [
                  "Every observation in the window is negative. A site reporting only hazards has a " +
                    "reporting culture problem rather than a safe one — the ratio is the point of " +
                    "recording positives at all.",
                ]
              : [],
      },
      /** every figure above whose denominator the platform does not hold */
      honesty:
        exposure.hours == null
          ? "No rate has been computed. The platform does not hold exposure hours for this window, " +
            "and a rate published against an estimated denominator is a misrepresentation — it goes " +
            "into a prequalification questionnaire and is relied on. The case counts below are real " +
            "and are reported; the rates are null with reasons."
          : null,
    };
  });

  /* ================================================================ */
  /* SUMMARY                                                           */
  /* ================================================================ */

  app.get("/projects/:projectId/safety/summary", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    await sweepThrottled(companyId, projectId, req.user!.id);
    const asOf = todayISO();

    const [obsByStatus, incByStatus, actByStatus, inspByStatus, talkByStatus, recByStatus] =
      await Promise.all([
        app.db
          .select({ k: safetyObservations.status, n: count() })
          .from(safetyObservations)
          .where(
            and(
              eq(safetyObservations.companyId, companyId),
              eq(safetyObservations.projectId, projectId),
            ),
          )
          .groupBy(safetyObservations.status),
        app.db
          .select({ k: safetyIncidents.status, n: count() })
          .from(safetyIncidents)
          .where(
            and(eq(safetyIncidents.companyId, companyId), eq(safetyIncidents.projectId, projectId)),
          )
          .groupBy(safetyIncidents.status),
        app.db
          .select({ k: safetyCorrectiveActions.status, n: count() })
          .from(safetyCorrectiveActions)
          .where(
            and(
              eq(safetyCorrectiveActions.companyId, companyId),
              eq(safetyCorrectiveActions.projectId, projectId),
            ),
          )
          .groupBy(safetyCorrectiveActions.status),
        app.db
          .select({ k: safetyInspections.status, n: count() })
          .from(safetyInspections)
          .where(
            and(
              eq(safetyInspections.companyId, companyId),
              eq(safetyInspections.projectId, projectId),
            ),
          )
          .groupBy(safetyInspections.status),
        app.db
          .select({ k: toolboxTalks.status, n: count() })
          .from(toolboxTalks)
          .where(and(eq(toolboxTalks.companyId, companyId), eq(toolboxTalks.projectId, projectId)))
          .groupBy(toolboxTalks.status),
        app.db
          .select({ k: safetyProgrammeRecords.status, n: count() })
          .from(safetyProgrammeRecords)
          .where(
            and(
              eq(safetyProgrammeRecords.companyId, companyId),
              or(
                eq(safetyProgrammeRecords.projectId, projectId),
                isNull(safetyProgrammeRecords.projectId),
              ),
            ),
          )
          .groupBy(safetyProgrammeRecords.status),
      ]);
    const tally = (rows: Array<{ k: string; n: number | string }>) => {
      const out: Record<string, number> = {};
      let total = 0;
      for (const r of rows) {
        out[r.k] = Number(r.n);
        total += Number(r.n);
      }
      return { byStatus: out, total };
    };

    const overdueActionRows = await app.db
      .select({ n: count() })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
          inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
          lte(safetyCorrectiveActions.dueDate, addDaysISO(asOf, -1)),
        ),
      );
    const unverifiedEffectiveness = await app.db
      .select({ n: count() })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
          inArray(safetyCorrectiveActions.status, ["completed", "verified"]),
          eq(safetyCorrectiveActions.effectivenessVerdict, "pending"),
        ),
      );

    const obligationRows = await app.db
      .select({ status: obligations.status, n: count() })
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, companyId),
          eq(obligations.projectId, projectId),
          sql`${obligations.sourceClause} LIKE ${`${OBLIGATION_PREFIX} %`}`,
        ),
      )
      .groupBy(obligations.status);
    const obligationsByStatus: Record<string, number> = {};
    let obligationsTotal = 0;
    for (const r of obligationRows) {
      obligationsByStatus[r.status] = Number(r.n);
      obligationsTotal += Number(r.n);
    }

    const signalRows = await app.db
      .select({ detector: signals.detector, disposition: signals.disposition, n: count() })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...SAFETY_DETECTORS]),
        ),
      )
      .groupBy(signals.detector, signals.disposition);
    const signalsByDetector: Record<string, number> = {};
    for (const d of SAFETY_DETECTORS) signalsByDetector[d] = 0;
    let signalsOpen = 0;
    let signalsTotal = 0;
    for (const r of signalRows) {
      signalsByDetector[r.detector] = (signalsByDetector[r.detector] ?? 0) + Number(r.n);
      signalsTotal += Number(r.n);
      if (r.disposition === "new" || r.disposition === "under_review") signalsOpen += Number(r.n);
    }

    /* The statutory standing of the WHOLE register, unwindowed and unfiltered.
     *
     * The workspace header used to derive its red banner from the incident
     * list on screen — the current tab's filtered first page — so applying any
     * filter that excluded the offending incident, or holding more incidents
     * than one page, removed the "a statutory deadline has passed" warning
     * from the whole workspace while the duty was live. The banner is driven
     * from here instead. Bounded to reportable incidents that are not closed
     * or void, which is the only set that can carry a live duty. */
    const liveReportable = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
          eq(safetyIncidents.isReportable, 1),
          ne(safetyIncidents.status, "void"),
        ),
      );
    const statutory = statutoryStanding(liveReportable);

    return {
      projectId,
      asOf,
      statutory,
      observations: tally(obsByStatus),
      incidents: tally(incByStatus),
      correctiveActions: {
        ...tally(actByStatus),
        overdue: Number(overdueActionRows[0]?.n ?? 0),
        awaitingEffectivenessCheck: Number(unverifiedEffectiveness[0]?.n ?? 0),
      },
      inspections: tally(inspByStatus),
      toolboxTalks: tally(talkByStatus),
      programmeRecords: tally(recByStatus),
      obligations: {
        total: obligationsTotal,
        byStatus: obligationsByStatus,
        note:
          "Statutory notification deadlines are carried in the platform's obligations register, the " +
          "same one that holds contractual time bars and insurance notification periods (ADR 0012). " +
          "A breached obligation here is a missed statutory report.",
      },
      signals: {
        total: signalsTotal,
        open: signalsOpen,
        byDetector: signalsByDetector,
        detectors: SAFETY_DETECTORS,
      },
    };
  });

  /* ================================================================ */
  /* DEVICE AND LONE-WORKER ALARMS (#1070-1073)                        */
  /* ================================================================ */

  /**
   * A wearable, a lone-worker device, a gas detector or a proximity tag,
   * reporting what it measured.
   *
   * These are NOT incidents and are deliberately not filed as them. A man-down
   * alarm is an accelerometer reading; whether an incident occurred is a
   * human's determination made afterwards, and a platform that converts every
   * alarm into an incident produces a register nobody can close and a rate
   * nobody believes. What this register owns instead is the RESPONSE CLOCK:
   * the only thing that can be proved afterwards about a device alarm is
   * whether somebody answered it and how long that took.
   */
  const sensorEventSchema = z.object({
    kind: z.enum(SAFETY_SENSOR_EVENT_KINDS),
    source: z.enum(SAFETY_SENSOR_SOURCES).optional(),
    severity: z.enum(SAFETY_SEVERITIES).optional(),
    deviceId: z.string().max(120).nullable().optional(),
    deviceModel: z.string().max(120).nullable().optional(),
    workerId: z.string().max(64).nullable().optional(),
    reportedPersonName: z.string().max(200).nullable().optional(),
    vendorId: z.string().max(64).nullable().optional(),
    occurredAt: isoTimestamp,
    receivedAt: isoTimestamp.optional(),
    locationId: z.string().max(64).nullable().optional(),
    locationText: z.string().max(300).nullable().optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    measurementValue: z.number().nullable().optional(),
    measurementUnit: z.string().max(30).nullable().optional(),
    thresholdValue: z.number().nullable().optional(),
    rawPayload: z.record(z.string(), z.unknown()).optional(),
    /** the device's own event id — a retry with the same one is not a new alarm */
    externalId: z.string().max(160).nullable().optional(),
  });

  const sensorIngestSchema = z.union([
    sensorEventSchema,
    z.object({ events: z.array(sensorEventSchema).min(1).max(200) }),
  ]);

  const sensorListQuery = pageQuerySchema.extend({
    status: z.string().max(30).optional(),
    kind: z.enum(SAFETY_SENSOR_EVENT_KINDS).optional(),
    source: z.enum(SAFETY_SENSOR_SOURCES).optional(),
    workerId: z.string().max(64).optional(),
    deviceId: z.string().max(120).optional(),
    unacknowledged: z.enum(["true", "false"]).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  });

  const sensorAcknowledgeSchema = z.object({
    note: z.string().min(1).max(2000),
    acknowledgedAt: isoTimestamp.optional(),
  });

  const sensorResolveSchema = z.object({
    status: z.enum(["resolved", "false_alarm", "auto_resolved", "escalated"]),
    outcome: z.string().min(1).max(2000),
    resolvedAt: isoTimestamp.optional(),
  });

  const sensorLinkSchema = z
    .object({
      incidentId: z.string().max(64).optional(),
      observationId: z.string().max(64).optional(),
    })
    .refine((v) => v.incidentId != null || v.observationId != null, {
      message: "Supply incidentId or observationId — a link to nothing is not a link.",
    });

  const sensorRaiseObservationSchema = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(8000).nullable().optional(),
    category: z.enum(SAFETY_CATEGORIES).optional(),
    severity: z.enum(SAFETY_SEVERITIES).optional(),
    riskLikelihood: z.number().int().min(1).max(5).nullable().optional(),
    riskSeverity: z.number().int().min(1).max(5).nullable().optional(),
    immediateActionTaken: z.string().max(4000).nullable().optional(),
  });

  /** The response deadline one alarm class carries, from the moment received. */
  function alarmDeadline(kind: string, receivedAt: string): string {
    const minutes = ALARM_RESPONSE_MINUTES[kind] ?? 240;
    return new Date(Date.parse(receivedAt) + minutes * 60_000).toISOString();
  }

  function defaultAlarmSeverity(kind: string): string {
    if (LIFE_SAFETY_ALARMS.has(kind)) return "critical";
    if (kind === "impact" || kind === "exclusion_zone_breach") return "high";
    if (kind === "panic_test" || kind === "device_offline") return "low";
    return "medium";
  }

  async function fetchSensorEvent(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetySensorEvents)
      .where(
        and(
          eq(safetySensorEvents.id, id),
          eq(safetySensorEvents.companyId, companyId),
          eq(safetySensorEvents.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Device alarm not found");
    return rows[0];
  }

  type SensorRow = Awaited<ReturnType<typeof fetchSensorEvent>>;

  function decorateSensorEvent(row: SensorRow, nowISO: string) {
    const overdue =
      row.status === "open" &&
      row.acknowledgeDueAt != null &&
      Date.parse(row.acknowledgeDueAt) < Date.parse(nowISO);
    const minutesLate =
      overdue && row.acknowledgeDueAt
        ? Math.round((Date.parse(nowISO) - Date.parse(row.acknowledgeDueAt)) / 60_000)
        : null;
    return {
      ...row,
      isLifeSafety: LIFE_SAFETY_ALARMS.has(row.kind),
      responseDeadlineMinutes: ALARM_RESPONSE_MINUTES[row.kind] ?? 240,
      acknowledgementOverdue: overdue,
      minutesLate,
      responseMinutes:
        row.responseSeconds != null ? Math.round((row.responseSeconds / 60) * 10) / 10 : null,
      /** what a reader must know before treating this row as reassurance */
      note: LIFE_SAFETY_ALARMS.has(row.kind)
        ? "A life-safety alarm is the device asserting that the person wearing it may be " +
          "unconscious, immobile or in an atmosphere that will kill them. Only somebody physically " +
          "confirming otherwise closes it; an acknowledgement recorded from an office is a record " +
          "that the alarm was seen, not that the person was found."
        : null,
    };
  }

  app.post(
    "/projects/:projectId/safety/sensor-events",
    { preHandler: standardGate },
    async (req, reply) => {
      const parsed = sensorIngestSchema.parse(req.body);
      const incoming = "events" in parsed ? parsed.events : [parsed];
      const nowISO = new Date().toISOString();
      const accepted: unknown[] = [];
      const duplicates: Array<{ externalId: string; id: string }> = [];

      for (const body of incoming) {
        if (body.workerId) await assertWorker(body.workerId, req.companyId!, req.projectId!);
        if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
        if (Date.parse(body.occurredAt) > Date.parse(nowISO) + 60_000) {
          throw badRequest(
            `Alarm occurredAt ${body.occurredAt} is in the future. A device clock ahead of the ` +
              `platform's makes every response time it produces meaningless, and the response time ` +
              `is the only thing this register can prove.`,
          );
        }
        /* A device that loses its uplink retries. The device's own event id is
         * the idempotency key: the same alarm arriving twice is one alarm, and
         * a duplicate row would double-count the fleet's alarm load and reset
         * a response clock somebody has already answered. */
        if (body.externalId) {
          const existing = await app.db
            .select()
            .from(safetySensorEvents)
            .where(
              and(
                eq(safetySensorEvents.companyId, req.companyId!),
                eq(safetySensorEvents.externalId, body.externalId),
              ),
            )
            .limit(1);
          if (existing[0]) {
            duplicates.push({ externalId: body.externalId, id: existing[0].id });
            accepted.push(decorateSensorEvent(existing[0], nowISO));
            continue;
          }
        }
        const receivedAt = body.receivedAt ?? nowISO;
        const seq = await nextRecordNumber(app.db, req.projectId!, "safety_sensor_event");
        const id = newId("sev");
        const kind = body.kind;
        await app.db.insert(safetySensorEvents).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number: seq,
          reference: `SE-${pad(seq)}`,
          source: body.source ?? "wearable",
          kind,
          severity: body.severity ?? defaultAlarmSeverity(kind),
          deviceId: body.deviceId ?? null,
          deviceModel: body.deviceModel ?? null,
          workerId: body.workerId ?? null,
          reportedPersonName: body.reportedPersonName ?? null,
          vendorId: body.vendorId ?? null,
          occurredAt: body.occurredAt,
          receivedAt,
          locationId: body.locationId ?? null,
          locationText: body.locationText ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          measurementValue: body.measurementValue ?? null,
          measurementUnit: body.measurementUnit ?? null,
          thresholdValue: body.thresholdValue ?? null,
          rawPayload: body.rawPayload ?? {},
          status: "open",
          acknowledgeDueAt: alarmDeadline(kind, receivedAt),
          externalId: body.externalId ?? null,
          createdBy: req.user!.id,
        });
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "safety_sensor_event",
          objectId: id,
          payload: {
            reference: `SE-${pad(seq)}`,
            kind,
            source: body.source ?? "wearable",
            deviceId: body.deviceId ?? null,
            workerId: body.workerId ?? null,
            occurredAt: body.occurredAt,
            receivedAt,
            acknowledgeDueAt: alarmDeadline(kind, receivedAt),
            lifeSafety: LIFE_SAFETY_ALARMS.has(kind),
          },
          storePayload: true,
        });
        accepted.push(
          decorateSensorEvent(await fetchSensorEvent(id, req.companyId!, req.projectId!), nowISO),
        );
      }

      reply.code(201);
      return {
        accepted: accepted.length,
        duplicates,
        events: accepted,
        note:
          duplicates.length > 0
            ? `${duplicates.length} event(s) carried an externalId already held and were treated as ` +
              `retries rather than new alarms.`
            : null,
      };
    },
  );

  app.get("/projects/:projectId/safety/sensor-events", { preHandler: readGate }, async (req) => {
    const q = sensorListQuery.parse(req.query);
    await sweepThrottled(req.companyId!, req.projectId!, req.user!.id);
    const nowISO = new Date().toISOString();
    const filters = [
      eq(safetySensorEvents.companyId, req.companyId!),
      eq(safetySensorEvents.projectId, req.projectId!),
    ];
    if (q.status) filters.push(eq(safetySensorEvents.status, q.status));
    if (q.kind) filters.push(eq(safetySensorEvents.kind, q.kind));
    if (q.source) filters.push(eq(safetySensorEvents.source, q.source));
    if (q.workerId) filters.push(eq(safetySensorEvents.workerId, q.workerId));
    if (q.deviceId) filters.push(eq(safetySensorEvents.deviceId, q.deviceId));
    if (q.unacknowledged === "true") filters.push(isNull(safetySensorEvents.acknowledgedAt));
    if (q.from) filters.push(gte(safetySensorEvents.occurredAt, `${q.from}T00:00:00Z`));
    if (q.to) filters.push(lte(safetySensorEvents.occurredAt, `${q.to}T23:59:59Z`));
    const where = and(...filters);
    const rows = await app.db
      .select()
      .from(safetySensorEvents)
      .where(where)
      .orderBy(desc(safetySensorEvents.occurredAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const totalRows = await app.db.select({ n: count() }).from(safetySensorEvents).where(where);
    return paginate(
      rows.map((r) => decorateSensorEvent(r, nowISO)),
      Number(totalRows[0]?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/safety/sensor-events/:eventId",
    { preHandler: readGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const row = await fetchSensorEvent(eventId, req.companyId!, req.projectId!);
      const names = await resolveWorkerNames([row.workerId], req.companyId!);
      const workerName = row.workerId ? (names.get(row.workerId) ?? null) : null;
      return {
        ...decorateSensorEvent(row, new Date().toISOString()),
        workerName: workerName ?? row.reportedPersonName,
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/sensor-events/:eventId/acknowledge",
    { preHandler: standardGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = sensorAcknowledgeSchema.parse(req.body);
      const row = await fetchSensorEvent(eventId, req.companyId!, req.projectId!);
      if (row.acknowledgedAt) {
        throw conflict(
          `Alarm ${row.reference} was acknowledged at ${row.acknowledgedAt}. The first response is ` +
            `the one the record turns on; re-acknowledging it would overwrite the response time.`,
        );
      }
      if (row.status === "void") throw conflict(`Alarm ${row.reference} is void.`);
      const acknowledgedAt = body.acknowledgedAt ?? new Date().toISOString();
      if (Date.parse(acknowledgedAt) < Date.parse(row.receivedAt)) {
        throw badRequest(
          `An acknowledgement at ${acknowledgedAt} predates the alarm's arrival at ${row.receivedAt}.`,
        );
      }
      const responseSeconds =
        Math.round(((Date.parse(acknowledgedAt) - Date.parse(row.receivedAt)) / 1000) * 10) / 10;
      const late =
        row.acknowledgeDueAt != null && Date.parse(acknowledgedAt) > Date.parse(row.acknowledgeDueAt);
      const now = new Date().toISOString();
      await app.db
        .update(safetySensorEvents)
        .set({
          status: "acknowledged",
          acknowledgedAt,
          acknowledgedBy: req.user!.id,
          responseSeconds,
          responseNote: body.note,
          updatedAt: now,
        })
        .where(eq(safetySensorEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_sensor_event",
        objectId: eventId,
        payload: {
          act: "acknowledge",
          reference: row.reference,
          from: row.status,
          to: "acknowledged",
          acknowledgedAt,
          responseSeconds,
          deadline: row.acknowledgeDueAt,
          late,
          note: body.note,
        },
        storePayload: true,
      });
      return {
        ...decorateSensorEvent(
          await fetchSensorEvent(eventId, req.companyId!, req.projectId!),
          now,
        ),
        response: {
          responseSeconds,
          deadline: row.acknowledgeDueAt,
          late,
          note: late
            ? `This alarm was answered ${Math.round(((Date.parse(acknowledgedAt) - Date.parse(row.acknowledgeDueAt!)) / 60_000) * 10) / 10} minute(s) after its ` +
              `deadline. The lateness stays on the record: a fleet whose alarms are answered late is ` +
              `a fleet the workforce will stop relying on, and the response time is the only thing ` +
              `about a device programme that can be audited.`
            : null,
        },
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/sensor-events/:eventId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = sensorResolveSchema.parse(req.body);
      const row = await fetchSensorEvent(eventId, req.companyId!, req.projectId!);
      if (row.resolvedAt) throw conflict(`Alarm ${row.reference} was resolved at ${row.resolvedAt}.`);
      if (row.status === "void") throw conflict(`Alarm ${row.reference} is void.`);
      if (body.status === "false_alarm" && LIFE_SAFETY_ALARMS.has(row.kind) && !row.acknowledgedAt) {
        throw conflict(
          `Alarm ${row.reference} is a life-safety class (${row.kind.replace(/_/g, " ")}) and has ` +
            `never been acknowledged. Marking it a false alarm without anybody having gone to look ` +
            `is a determination about a person's condition made from a screen. Acknowledge it with ` +
            `what was found first.`,
        );
      }
      const resolvedAt = body.resolvedAt ?? new Date().toISOString();
      const now = new Date().toISOString();
      await app.db
        .update(safetySensorEvents)
        .set({
          status: body.status,
          resolvedAt,
          resolvedBy: req.user!.id,
          outcome: body.outcome,
          updatedAt: now,
        })
        .where(eq(safetySensorEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_sensor_event",
        objectId: eventId,
        payload: {
          act: "resolve",
          reference: row.reference,
          from: row.status,
          to: body.status,
          resolvedAt,
          outcome: body.outcome,
          wasAcknowledged: row.acknowledgedAt != null,
        },
        storePayload: true,
      });
      return decorateSensorEvent(
        await fetchSensorEvent(eventId, req.companyId!, req.projectId!),
        now,
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/sensor-events/:eventId/link",
    { preHandler: standardGate },
    async (req) => {
      const { eventId } = req.params as { eventId: string };
      const body = sensorLinkSchema.parse(req.body);
      const row = await fetchSensorEvent(eventId, req.companyId!, req.projectId!);
      if (body.incidentId) await fetchIncident(body.incidentId, req.companyId!, req.projectId!);
      if (body.observationId) {
        await fetchObservation(body.observationId, req.companyId!, req.projectId!);
      }
      const now = new Date().toISOString();
      await app.db
        .update(safetySensorEvents)
        .set({
          incidentId: body.incidentId ?? row.incidentId,
          observationId: body.observationId ?? row.observationId,
          updatedAt: now,
        })
        .where(eq(safetySensorEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_sensor_event",
        objectId: eventId,
        payload: {
          act: "link",
          reference: row.reference,
          incidentId: body.incidentId ?? null,
          observationId: body.observationId ?? null,
        },
        storePayload: true,
      });
      return decorateSensorEvent(
        await fetchSensorEvent(eventId, req.companyId!, req.projectId!),
        now,
      );
    },
  );

  app.post(
    "/projects/:projectId/safety/sensor-events/:eventId/raise-observation",
    { preHandler: standardGate },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const body = sensorRaiseObservationSchema.parse(req.body);
      const row = await fetchSensorEvent(eventId, req.companyId!, req.projectId!);
      if (row.observationId) {
        throw conflict(
          `Alarm ${row.reference} already raised observation ${row.observationId}. Raising a second ` +
            `one would double-count a single event on the leading indicators.`,
        );
      }
      const risk = optionalRiskScore(body.riskLikelihood, body.riskSeverity);
      const seq = await nextRecordNumber(app.db, req.projectId!, "safety_observation");
      const obsId = newId("sobs");
      const reference = `OBS-${pad(seq)}`;
      const now = new Date().toISOString();
      await app.db.insert(safetyObservations).values({
        id: obsId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        kind: "negative",
        category: body.category ?? "other",
        severity: body.severity ?? row.severity,
        title: body.title,
        description: body.description ?? null,
        observedAt: row.occurredAt,
        locationId: row.locationId,
        locationText: row.locationText,
        latitude: row.latitude,
        longitude: row.longitude,
        vendorId: row.vendorId,
        workerId: row.workerId,
        riskLikelihood: body.riskLikelihood ?? null,
        riskSeverity: body.riskSeverity ?? null,
        riskScore: risk.score?.score ?? null,
        immediateActionTaken: body.immediateActionTaken ?? null,
        status: "open",
        detail: {
          raisedFromSensorEvent: {
            id: row.id,
            reference: row.reference,
            kind: row.kind,
            deviceId: row.deviceId,
            measurementValue: row.measurementValue,
            measurementUnit: row.measurementUnit,
            thresholdValue: row.thresholdValue,
          },
        },
        createdBy: req.user!.id,
      });
      await app.db
        .update(safetySensorEvents)
        .set({ observationId: obsId, updatedAt: now })
        .where(eq(safetySensorEvents.id, eventId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_observation",
        objectId: obsId,
        payload: {
          reference,
          title: body.title,
          raisedFrom: "safety_sensor_event",
          sensorEventId: row.id,
          sensorEventReference: row.reference,
          kind: row.kind,
        },
        storePayload: true,
      });
      reply.code(201);
      return {
        observation: decorateObservation(
          await fetchObservation(obsId, req.companyId!, req.projectId!),
          todayISO(),
        ),
        sensorEvent: decorateSensorEvent(
          await fetchSensorEvent(eventId, req.companyId!, req.projectId!),
          now,
        ),
        riskAssessment: risk,
      };
    },
  );

  /* ================================================================ */
  /* STATUTORY FORM GENERATION (#652)                                  */
  /* ================================================================ */

  const regulatoryGenerateSchema = z
    .object({
      form: z.enum(SAFETY_REGULATORY_FORMS),
      /** the calendar year an establishment log covers */
      year: z.number().int().min(1970).max(2200).optional(),
      /** the incident a per-case form is about */
      incidentId: z.string().max(64).optional(),
      note: z.string().max(2000).optional(),
    })
    .refine((v) => (v.form === "osha_300" || v.form === "osha_300a" ? v.year != null : true), {
      message: "The OSHA 300 log and its 300A summary cover a calendar year — supply `year`.",
    })
    .refine(
      (v) =>
        v.form === "osha_301" || v.form === "riddor_f2508" || v.form === "riddor_f2508a"
          ? v.incidentId != null
          : true,
      { message: "A 301 or an F2508 is about one case — supply `incidentId`." },
    );

  const regulatoryListQuery = pageQuerySchema.extend({
    form: z.enum(SAFETY_REGULATORY_FORMS).optional(),
    status: z.string().max(30).optional(),
    year: z.coerce.number().int().min(1970).max(2200).optional(),
    incidentId: z.string().max(64).optional(),
  });

  const regulatoryCertifySchema = z.object({
    certifierTitle: z.string().min(1).max(200),
    certifiedAt: isoTimestamp.optional(),
    statement: z.string().max(4000).optional(),
  });

  const regulatorySubmitSchema = z.object({
    submissionReference: z.string().max(200).nullable().optional(),
    submittedAt: isoTimestamp.optional(),
    note: z.string().max(2000).optional(),
  });

  /**
   * The names and addresses the forms ask for, resolved once.
   *
   * Everything here is looked up rather than typed by whoever asked for the
   * form: an establishment address retyped onto a 300A each year is an
   * establishment address that will eventually differ from the project's.
   */
  async function buildFormContext(
    companyId: string,
    projectId: string,
    incidents: readonly FormIncident[],
  ): Promise<FormContext> {
    const projectRows = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        address: projects.address,
        city: projects.city,
        country: projects.country,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    const project = projectRows[0];
    if (!project) throw notFound("Project not found");
    const companyRows = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const ctx = emptyFormContext(project.name, project.id);
    ctx.companyName = companyRows[0]?.name ?? null;
    ctx.street = project.address;
    ctx.city = project.city;
    ctx.country = project.country;

    const workerIds = [
      ...new Set(incidents.map((i) => i.workerId).filter((id): id is string => !!id)),
    ];
    if (workerIds.length > 0) {
      const rows = await app.db
        .select({ id: workers.id, fullName: workers.fullName, trade: workers.trade })
        .from(workers)
        .where(and(eq(workers.companyId, companyId), inArray(workers.id, workerIds)));
      for (const w of rows) {
        ctx.workerNames.set(w.id, w.fullName);
        ctx.workerTrades.set(w.id, w.trade);
      }
    }
    const vendorIds = [
      ...new Set(incidents.map((i) => i.vendorId).filter((id): id is string => !!id)),
    ];
    if (vendorIds.length > 0) {
      const rows = await app.db
        .select({ id: vendors.id, name: vendors.name })
        .from(vendors)
        .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, vendorIds)));
      for (const v of rows) ctx.vendorNames.set(v.id, v.name);
    }
    const locationIds = [
      ...new Set(incidents.map((i) => i.locationId).filter((id): id is string => !!id)),
    ];
    if (locationIds.length > 0) {
      const rows = await app.db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds)));
      for (const l of rows) ctx.locationNames.set(l.id, l.name);
    }
    return ctx;
  }

  /** Non-void incidents whose occurrence falls in the window. */
  async function loadFormIncidents(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<IncidentRow[]> {
    return app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
          ne(safetyIncidents.status, "void"),
        ),
      )
      .orderBy(asc(safetyIncidents.occurredAt));
  }

  /**
   * The annual average number of employees, derived — never estimated.
   *
   * OSHA defines this over PAY PERIODS, and this platform holds no payroll
   * periods. What it does hold is the site-access register, so the figure is
   * the mean of the distinct people on site per month across the months that
   * register actually covers, and the derivation is printed on the form beside
   * the number. Where there is no access data the field is null with the
   * reason: a made-up denominator on a 300A is a misstatement of a rate a
   * client will rely on, not a rounding.
   */
  async function annualAverageEmployees(
    companyId: string,
    projectId: string,
    year: number,
  ): Promise<{ value: number | null; basis: string | null; reasons: string[] }> {
    const rows = await app.db
      .select({
        month: sql<string>`substr(${siteAccessRecords.accessDate}, 1, 7)`,
        people: sql<number>`count(distinct ${siteAccessRecords.workerId})`,
      })
      .from(siteAccessRecords)
      .where(
        and(
          eq(siteAccessRecords.companyId, companyId),
          eq(siteAccessRecords.projectId, projectId),
          gte(siteAccessRecords.accessDate, `${year}-01-01`),
          lte(siteAccessRecords.accessDate, `${year}-12-31`),
        ),
      )
      .groupBy(sql`substr(${siteAccessRecords.accessDate}, 1, 7)`);
    if (rows.length === 0) {
      return {
        value: null,
        basis: null,
        reasons: [
          `The site-access register holds no record for ${year} on this project, and the platform ` +
            `holds no payroll pay periods, so the annual average number of employees cannot be ` +
            `derived from anything. Leave the box for the person who holds the payroll to complete.`,
        ],
      };
    }
    const total = rows.reduce((sum, r) => sum + Number(r.people ?? 0), 0);
    const value = Math.round(total / rows.length);
    return {
      value,
      basis:
        `Derived: the mean of the distinct people recorded on site per month across the ` +
        `${rows.length} month(s) of ${year} the site-access register covers (${rows
          .map((r) => `${r.month}: ${Number(r.people ?? 0)}`)
          .join(", ")}). OSHA defines this figure over payroll pay periods, which this platform does ` +
        `not hold — check it against payroll before the summary is signed.`,
      reasons: [],
    };
  }

  /** Everything a form needs about exposure hours for one window. */
  async function exposureForWindow(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
  ): Promise<ExposureHours> {
    const tcAgg = await app.db
      .select({ hours: sql<number>`coalesce(sum(${timecards.totalHours}), 0)`, n: count() })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, companyId),
          eq(timecards.projectId, projectId),
          gte(timecards.workDate, from),
          lte(timecards.workDate, to),
          inArray(timecards.status, COUNTED_TIMECARD_STATUSES),
        ),
      );
    const saAgg = await app.db
      .select({
        hours: sql<number>`coalesce(sum(${siteAccessRecords.hoursOnSite}), 0)`,
        n: count(),
      })
      .from(siteAccessRecords)
      .where(
        and(
          eq(siteAccessRecords.companyId, companyId),
          eq(siteAccessRecords.projectId, projectId),
          gte(siteAccessRecords.accessDate, from),
          lte(siteAccessRecords.accessDate, to),
        ),
      );
    const timecardCount = Number(tcAgg[0]?.n ?? 0);
    const siteAccessCount = Number(saAgg[0]?.n ?? 0);
    return resolveExposureHours({
      timecardHours: timecardCount > 0 ? Number(tcAgg[0]?.hours ?? 0) : null,
      timecardCount,
      siteAccessHours: siteAccessCount > 0 ? Number(saAgg[0]?.hours ?? 0) : null,
      siteAccessCount,
      from,
      to,
    });
  }

  interface BuiltForm {
    payload: Record<string, unknown>;
    rowCount: number;
    caveats: string[];
    periodYear: number | null;
    periodFrom: string | null;
    periodTo: string | null;
    incidentId: string | null;
  }

  /**
   * Build one statutory artefact. Pure assembly on top of `regulatory.ts` —
   * the only thing this adds is reading the records.
   */
  async function buildRegulatoryForm(
    companyId: string,
    projectId: string,
    input: { form: string; year?: number; incidentId?: string },
    generatedAt: string,
  ): Promise<BuiltForm> {
    if (input.form === "osha_300" || input.form === "osha_300a") {
      const year = input.year!;
      const from = `${year}-01-01`;
      const to = `${year}-12-31`;
      const rows = await loadFormIncidents(companyId, projectId, from, to);
      const ctx = await buildFormContext(companyId, projectId, rows);
      const log = buildOsha300(rows, ctx, year, generatedAt);
      if (input.form === "osha_300") {
        return {
          payload: log as unknown as Record<string, unknown>,
          rowCount: log.rows.length,
          caveats: log.caveats,
          periodYear: year,
          periodFrom: from,
          periodTo: to,
          incidentId: null,
        };
      }
      const exposure = await exposureForWindow(companyId, projectId, from, to);
      const employees = await annualAverageEmployees(companyId, projectId, year);
      const summary = buildOsha300A(
        {
          log,
          totalHoursWorked: exposure.hours,
          hoursReasons: exposure.reasons,
          hoursSource: exposure.source,
          annualAverageEmployees: employees.value,
          employeeReasons: employees.reasons,
          employeesBasis: employees.basis,
          generatedAt,
        },
        ctx,
      );
      return {
        payload: summary as unknown as Record<string, unknown>,
        rowCount: log.rows.length,
        caveats: summary.caveats,
        periodYear: year,
        periodFrom: from,
        periodTo: to,
        incidentId: null,
      };
    }

    const incident = await fetchIncident(input.incidentId!, companyId, projectId);
    const ctx = await buildFormContext(companyId, projectId, [incident]);
    if (input.form === "osha_301") {
      const report = buildOsha301(incident, ctx, generatedAt);
      return {
        payload: report as unknown as Record<string, unknown>,
        rowCount: 1,
        caveats: report.caveats,
        periodYear: Number(incident.occurredAt.slice(0, 4)),
        periodFrom: incident.occurredAt.slice(0, 10),
        periodTo: incident.occurredAt.slice(0, 10),
        incidentId: incident.id,
      };
    }
    const report = buildRiddorF2508(incident, ctx, storedDetermination(incident), generatedAt);
    if (input.form === "riddor_f2508a" && report.form !== "riddor_f2508a") {
      throw badRequest(
        `Incident ${incident.reference} is not classified as a reportable occupational disease, so ` +
          `the F2508A (the disease form) is not the form it goes on. Its RIDDOR category is ` +
          `\`${incident.riddorCategory ?? "not assessed"}\` — reassess it, or generate the F2508.`,
      );
    }
    if (input.form === "riddor_f2508" && report.form === "riddor_f2508a") {
      throw badRequest(
        `Incident ${incident.reference} is classified as a reportable occupational disease, which is ` +
          `reported on the F2508A rather than the F2508.`,
      );
    }
    return {
      payload: report as unknown as Record<string, unknown>,
      rowCount: 1,
      caveats: report.caveats,
      periodYear: Number(incident.occurredAt.slice(0, 4)),
      periodFrom: incident.occurredAt.slice(0, 10),
      periodTo: incident.occurredAt.slice(0, 10),
      incidentId: incident.id,
    };
  }

  app.get(
    "/projects/:projectId/safety/regulatory/preview",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({
          form: z.enum(SAFETY_REGULATORY_FORMS),
          year: z.coerce.number().int().min(1970).max(2200).optional(),
          incidentId: z.string().max(64).optional(),
        })
        .parse(req.query);
      const generatedAt = new Date().toISOString();
      const built = await buildRegulatoryForm(
        req.companyId!,
        req.projectId!,
        { form: q.form, year: q.year ?? Number(todayISO().slice(0, 4)), incidentId: q.incidentId },
        generatedAt,
      );
      return {
        form: q.form,
        stored: false,
        note:
          "This is a preview computed from the register as it stands right now. Nothing has been " +
          "stored and nothing has been hashed — generate the artefact when the figures are the ones " +
          "you intend to stand behind, because a form is an assertion made on a date.",
        ...built,
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/regulatory/reports",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = regulatoryGenerateSchema.parse(req.body);
      const generatedAt = new Date().toISOString();
      const built = await buildRegulatoryForm(
        req.companyId!,
        req.projectId!,
        body,
        generatedAt,
      );

      /* The artefact is frozen HERE. A 300A is posted on a wall for three
       * months and signed by an executive; an F2508 is what was actually said
       * to the authority. Regenerating either later from a register that has
       * since been corrected produces a different document with the same name,
       * which is precisely what an inspector is entitled to ask about. So the
       * payload is canonicalised, hashed and written to the file store, and a
       * correction is a NEW artefact that supersedes this one. */
      const canonical = canonicalJson(built.payload);
      const sha256 = createHash("sha256").update(canonical).digest("hex");
      const saved = await app.storage.saveBuffer(req.companyId!, Buffer.from(canonical, "utf8"));

      const seq = await nextRecordNumber(app.db, req.companyId!, "safety_regulatory_report");
      const reference = `REG-${pad(seq)}`;
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId: null,
        name: `${reference}-${body.form}.json`,
        contentType: "application/json",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        documentType: "safety",
        metadata: {
          safetyRegulatoryForm: body.form,
          periodYear: built.periodYear,
          incidentId: built.incidentId,
        },
        uploadedBy: req.user!.id,
      });

      /* Only one live artefact per (form, period or case): the previous one is
       * superseded rather than deleted, because "what we filed then" and "what
       * we would file now" are both facts. */
      const priorFilters = [
        eq(safetyRegulatoryReports.companyId, req.companyId!),
        eq(safetyRegulatoryReports.form, body.form),
        inArray(safetyRegulatoryReports.status, ["generated", "submitted"]),
      ];
      if (built.incidentId) {
        priorFilters.push(eq(safetyRegulatoryReports.incidentId, built.incidentId));
      } else {
        priorFilters.push(eq(safetyRegulatoryReports.projectId, req.projectId!));
        priorFilters.push(eq(safetyRegulatoryReports.periodYear, built.periodYear!));
      }
      const prior = await app.db
        .select({ id: safetyRegulatoryReports.id, reference: safetyRegulatoryReports.reference })
        .from(safetyRegulatoryReports)
        .where(and(...priorFilters));

      const id = newId("sreg");
      await app.db.insert(safetyRegulatoryReports).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number: seq,
        reference,
        form: body.form,
        status: "generated",
        periodYear: built.periodYear,
        periodFrom: built.periodFrom,
        periodTo: built.periodTo,
        incidentId: built.incidentId,
        payload: built.payload,
        sha256,
        fileId,
        rowCount: built.rowCount,
        caveats: built.caveats,
        supersedesId: prior[0]?.id ?? null,
        detail: { note: body.note ?? null, storageKey: saved.storageKey },
        generatedBy: req.user!.id,
      });
      for (const p of prior) {
        await app.db
          .update(safetyRegulatoryReports)
          .set({
            status: "superseded",
            supersededById: id,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(safetyRegulatoryReports.id, p.id));
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "safety_regulatory_report",
        objectId: id,
        payload: {
          reference,
          form: body.form,
          periodYear: built.periodYear,
          incidentId: built.incidentId,
          sha256,
          fileId,
          rowCount: built.rowCount,
          caveatCount: built.caveats.length,
          supersedes: prior.map((p) => p.reference),
        },
        storePayload: true,
      });

      reply.code(201);
      return {
        id,
        reference,
        form: body.form,
        sha256,
        fileId,
        rowCount: built.rowCount,
        caveats: built.caveats,
        payload: built.payload,
        supersedes: prior.map((p) => ({ id: p.id, reference: p.reference })),
        note:
          "The artefact is frozen and hashed. Nothing here has been transmitted to any authority — " +
          "this platform produces the document a competent person checks and files.",
      };
    },
  );

  app.get(
    "/projects/:projectId/safety/regulatory/reports",
    { preHandler: readGate },
    async (req) => {
      const q = regulatoryListQuery.parse(req.query);
      const filters = [
        eq(safetyRegulatoryReports.companyId, req.companyId!),
        eq(safetyRegulatoryReports.projectId, req.projectId!),
      ];
      if (q.form) filters.push(eq(safetyRegulatoryReports.form, q.form));
      if (q.status) filters.push(eq(safetyRegulatoryReports.status, q.status));
      if (q.year != null) filters.push(eq(safetyRegulatoryReports.periodYear, q.year));
      if (q.incidentId) filters.push(eq(safetyRegulatoryReports.incidentId, q.incidentId));
      const where = and(...filters);
      const rows = await app.db
        .select({
          id: safetyRegulatoryReports.id,
          reference: safetyRegulatoryReports.reference,
          form: safetyRegulatoryReports.form,
          status: safetyRegulatoryReports.status,
          periodYear: safetyRegulatoryReports.periodYear,
          periodFrom: safetyRegulatoryReports.periodFrom,
          periodTo: safetyRegulatoryReports.periodTo,
          incidentId: safetyRegulatoryReports.incidentId,
          sha256: safetyRegulatoryReports.sha256,
          fileId: safetyRegulatoryReports.fileId,
          rowCount: safetyRegulatoryReports.rowCount,
          caveats: safetyRegulatoryReports.caveats,
          certifiedBy: safetyRegulatoryReports.certifiedBy,
          certifiedAt: safetyRegulatoryReports.certifiedAt,
          certifierTitle: safetyRegulatoryReports.certifierTitle,
          submittedAt: safetyRegulatoryReports.submittedAt,
          submissionReference: safetyRegulatoryReports.submissionReference,
          supersedesId: safetyRegulatoryReports.supersedesId,
          supersededById: safetyRegulatoryReports.supersededById,
          generatedBy: safetyRegulatoryReports.generatedBy,
          createdAt: safetyRegulatoryReports.createdAt,
        })
        .from(safetyRegulatoryReports)
        .where(where)
        .orderBy(desc(safetyRegulatoryReports.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const totalRows = await app.db
        .select({ n: count() })
        .from(safetyRegulatoryReports)
        .where(where);
      return paginate(rows, Number(totalRows[0]?.n ?? 0), q);
    },
  );

  async function fetchRegulatoryReport(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(safetyRegulatoryReports)
      .where(
        and(
          eq(safetyRegulatoryReports.id, id),
          eq(safetyRegulatoryReports.companyId, companyId),
          eq(safetyRegulatoryReports.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Regulatory report not found");
    return rows[0];
  }

  app.get(
    "/projects/:projectId/safety/regulatory/reports/:reportId",
    { preHandler: readGate },
    async (req) => {
      const { reportId } = req.params as { reportId: string };
      const row = await fetchRegulatoryReport(reportId, req.companyId!, req.projectId!);
      return {
        ...row,
        integrity: {
          sha256: row.sha256,
          recomputed: createHash("sha256").update(canonicalJson(row.payload)).digest("hex"),
          note:
            "`recomputed` is the hash of the stored payload as it sits in the row. It must equal " +
            "`sha256`; if it does not, the row has been altered since it was generated and the " +
            "artefact should not be relied on.",
        },
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/regulatory/reports/:reportId/certify",
    { preHandler: adminGate },
    async (req) => {
      const { reportId } = req.params as { reportId: string };
      const body = regulatoryCertifySchema.parse(req.body);
      const row = await fetchRegulatoryReport(reportId, req.companyId!, req.projectId!);
      if (row.form !== "osha_300a") {
        throw badRequest(
          `Only the 300A carries an executive certification (29 CFR 1904.32(b)(3)). ` +
            `${row.reference} is a ${row.form.replace(/_/g, " ")}.`,
        );
      }
      if (row.status === "superseded" || row.status === "void") {
        throw conflict(
          `${row.reference} is ${row.status}. Certifying a superseded summary would put an ` +
            `executive's name against figures that have since been replaced.`,
        );
      }
      if (row.certifiedAt) {
        throw conflict(
          `${row.reference} was certified by ${row.certifiedBy} at ${row.certifiedAt}. A second ` +
            `certification on the same document would leave two people answerable for one statement.`,
        );
      }
      const certifiedAt = body.certifiedAt ?? new Date().toISOString();
      await app.db
        .update(safetyRegulatoryReports)
        .set({
          certifiedBy: req.user!.id,
          certifiedAt,
          certifierTitle: body.certifierTitle,
          detail: {
            ...(row.detail as Record<string, unknown>),
            certificationStatement: body.statement ?? null,
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(safetyRegulatoryReports.id, reportId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_regulatory_report",
        objectId: reportId,
        payload: {
          act: "certify",
          reference: row.reference,
          certifierTitle: body.certifierTitle,
          certifiedAt,
          sha256: row.sha256,
          caveatCount: (row.caveats as string[]).length,
        },
        storePayload: true,
      });
      return {
        ...(await fetchRegulatoryReport(reportId, req.companyId!, req.projectId!)),
        note:
          "1904.32(b)(3) makes the certifier personally responsible for having examined the 300 " +
          "log and reasonably believing the summary correct and complete. The caveats on this " +
          "artefact are part of what was certified — they are stored with it.",
      };
    },
  );

  app.post(
    "/projects/:projectId/safety/regulatory/reports/:reportId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { reportId } = req.params as { reportId: string };
      const body = regulatorySubmitSchema.parse(req.body);
      const row = await fetchRegulatoryReport(reportId, req.companyId!, req.projectId!);
      if (row.status !== "generated") {
        throw conflict(`${row.reference} is \`${row.status}\` and cannot be marked submitted.`);
      }
      const submittedAt = body.submittedAt ?? new Date().toISOString();
      await app.db
        .update(safetyRegulatoryReports)
        .set({
          status: "submitted",
          submittedAt,
          submittedBy: req.user!.id,
          submissionReference: body.submissionReference ?? null,
          detail: {
            ...(row.detail as Record<string, unknown>),
            submissionNote: body.note ?? null,
          },
          updatedAt: new Date().toISOString(),
        })
        .where(eq(safetyRegulatoryReports.id, reportId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "safety_regulatory_report",
        objectId: reportId,
        payload: {
          act: "submit",
          reference: row.reference,
          form: row.form,
          submittedAt,
          submissionReference: body.submissionReference ?? null,
          incidentId: row.incidentId,
        },
        storePayload: true,
      });
      return {
        ...(await fetchRegulatoryReport(reportId, req.companyId!, req.projectId!)),
        note:
          "Marking an artefact submitted records that a human filed it with the authority. It does " +
          "not, on its own, discharge the incident's notification duty — record that against the " +
          "incident with POST .../notify-regulator so the per-regime clock is closed.",
      };
    },
  );

  /* ================================================================ */
  /* VENDOR SAFETY SCORECARD (#646, #661, #1100)                       */
  /* ================================================================ */

  const scorecardQuery = z.object({
    vendorId: z.string().max(64).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  });

  const WEAK_CONTROLS: ReadonlySet<string> = new Set(["administrative", "ppe"]);

  /**
   * Every figure on one vendor's scorecard, read from the registers they are
   * actually in.
   *
   * `projectId === null` rolls the company up across projects. The exposure
   * denominator is the vendor's OWN hours, never the project's: dividing a
   * subcontractor's injuries by everybody's hours produces a flattering rate
   * for the small firm and a punishing one for the large, and both are wrong.
   */
  async function collectVendorScorecardInput(
    companyId: string,
    projectId: string | null,
    vendorId: string,
    vendorName: string | null,
    from: string,
    to: string,
  ): Promise<VendorScorecardInput> {
    const incidentRows = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          ...(projectId ? [eq(safetyIncidents.projectId, projectId)] : []),
          eq(safetyIncidents.vendorId, vendorId),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
          ne(safetyIncidents.status, "void"),
        ),
      );
    const bySeverity: Record<string, number> = {};
    for (const i of incidentRows) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    const RECORDABLE = [
      "death",
      "days_away_from_work",
      "job_transfer_or_restriction",
      "other_recordable",
    ];

    const observationRows = await app.db
      .select({
        kind: safetyObservations.kind,
        severity: safetyObservations.severity,
        workStopped: safetyObservations.workStopped,
      })
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, companyId),
          ...(projectId ? [eq(safetyObservations.projectId, projectId)] : []),
          eq(safetyObservations.vendorId, vendorId),
          gte(safetyObservations.observedAt, `${from}T00:00:00Z`),
          lte(safetyObservations.observedAt, `${to}T23:59:59Z`),
        ),
      );

    const actionRows = await app.db
      .select({
        status: safetyCorrectiveActions.status,
        dueDate: safetyCorrectiveActions.dueDate,
        closedAt: safetyCorrectiveActions.closedAt,
        hierarchyOfControl: safetyCorrectiveActions.hierarchyOfControl,
        effectivenessVerdict: safetyCorrectiveActions.effectivenessVerdict,
      })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          ...(projectId ? [eq(safetyCorrectiveActions.projectId, projectId)] : []),
          eq(safetyCorrectiveActions.ownerVendorId, vendorId),
          gte(safetyCorrectiveActions.dueDate, from),
          lte(safetyCorrectiveActions.dueDate, to),
        ),
      );
    const asOf = todayISO();
    const closedOnTime = actionRows.filter(
      (a) =>
        (a.status === "closed" || a.status === "verified") &&
        a.closedAt != null &&
        a.closedAt.slice(0, 10) <= a.dueDate,
    ).length;
    const closedLate = actionRows.filter(
      (a) =>
        (a.status === "closed" || a.status === "verified") &&
        (a.closedAt == null || a.closedAt.slice(0, 10) > a.dueDate),
    ).length;

    const inspectionRows = await app.db
      .select({
        status: safetyInspections.status,
        result: safetyInspections.result,
        criticalDefectCount: safetyInspections.criticalDefectCount,
      })
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.companyId, companyId),
          ...(projectId ? [eq(safetyInspections.projectId, projectId)] : []),
          eq(safetyInspections.vendorId, vendorId),
          gte(safetyInspections.performedAt, `${from}T00:00:00Z`),
          lte(safetyInspections.performedAt, `${to}T23:59:59Z`),
        ),
      );

    const ncrRows = await app.db
      .select({
        severity: nonConformanceReports.severity,
        status: nonConformanceReports.status,
        isBackcharged: nonConformanceReports.isBackcharged,
        costImpact: nonConformanceReports.costImpact,
        currency: nonConformanceReports.currency,
      })
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.companyId, companyId),
          ...(projectId ? [eq(nonConformanceReports.projectId, projectId)] : []),
          eq(nonConformanceReports.raisedAgainstVendorId, vendorId),
          gte(nonConformanceReports.createdAt, `${from}T00:00:00Z`),
          lte(nonConformanceReports.createdAt, `${to}T23:59:59Z`),
        ),
      );
    const ncrSeverity: Record<string, number> = {};
    const costByCurrency: Record<string, number> = {};
    for (const n of ncrRows) {
      ncrSeverity[n.severity] = (ncrSeverity[n.severity] ?? 0) + 1;
      if (n.costImpact != null && n.costImpact !== 0) {
        costByCurrency[n.currency] = (costByCurrency[n.currency] ?? 0) + n.costImpact;
      }
    }

    const programmeRows = await app.db
      .select({ status: safetyProgrammeRecords.status, expiresAt: safetyProgrammeRecords.expiresAt })
      .from(safetyProgrammeRecords)
      .where(
        and(
          eq(safetyProgrammeRecords.companyId, companyId),
          ...(projectId ? [eq(safetyProgrammeRecords.projectId, projectId)] : []),
          eq(safetyProgrammeRecords.vendorId, vendorId),
        ),
      );
    const soon = addDaysISO(asOf, 30);

    const talkRows = await app.db
      .select({ n: count() })
      .from(toolboxTalks)
      .where(
        and(
          eq(toolboxTalks.companyId, companyId),
          ...(projectId ? [eq(toolboxTalks.projectId, projectId)] : []),
          eq(toolboxTalks.vendorId, vendorId),
          gte(toolboxTalks.talkDate, from),
          lte(toolboxTalks.talkDate, to),
          inArray(toolboxTalks.status, ["delivered", "verified"]),
        ),
      );

    const alarmRows = await app.db
      .select({ n: count() })
      .from(safetySensorEvents)
      .where(
        and(
          eq(safetySensorEvents.companyId, companyId),
          ...(projectId ? [eq(safetySensorEvents.projectId, projectId)] : []),
          eq(safetySensorEvents.vendorId, vendorId),
          eq(safetySensorEvents.status, "open"),
          gte(safetySensorEvents.occurredAt, `${from}T00:00:00Z`),
          lte(safetySensorEvents.occurredAt, `${to}T23:59:59Z`),
        ),
      );

    /* The vendor's own exposure hours. Timecards carry vendorId, so this is
     * the one denominator that belongs to this supplier rather than to the
     * site they happened to be on. */
    const tcAgg = await app.db
      .select({ hours: sql<number>`coalesce(sum(${timecards.totalHours}), 0)`, n: count() })
      .from(timecards)
      .where(
        and(
          eq(timecards.companyId, companyId),
          ...(projectId ? [eq(timecards.projectId, projectId)] : []),
          eq(timecards.vendorId, vendorId),
          gte(timecards.workDate, from),
          lte(timecards.workDate, to),
          inArray(timecards.status, COUNTED_TIMECARD_STATUSES),
        ),
      );
    const timecardCount = Number(tcAgg[0]?.n ?? 0);
    const exposure = resolveExposureHours({
      timecardHours: timecardCount > 0 ? Number(tcAgg[0]?.hours ?? 0) : null,
      timecardCount,
      siteAccessHours: null,
      siteAccessCount: 0,
      from,
      to,
    });

    return {
      vendorId,
      vendorName,
      projectId,
      from,
      to,
      incidents: {
        total: incidentRows.length,
        bySeverity,
        fatalities: incidentRows.filter((i) => asBool(i.isFatality)).length,
        lostTimeCases: incidentRows.filter((i) => asBool(i.isLostTime)).length,
        recordableCases: incidentRows.filter((i) => RECORDABLE.includes(i.oshaCaseType ?? "")).length,
        oshaAssessedAll:
          incidentRows.length > 0 && incidentRows.every((i) => assessedUnderOsha(i)),
        underAssessment: incidentRows.filter(
          (i) => (storedDetermination(i)?.indeterminateRuleIds ?? []).length > 0,
        ).length,
        nearMisses: incidentRows.filter((i) => i.incidentType === "near_miss").length,
      },
      observations: {
        positive: observationRows.filter((o) => o.kind === "positive").length,
        negative: observationRows.filter((o) => o.kind === "negative").length,
        workStopped: observationRows.filter((o) => asBool(o.workStopped)).length,
        highRisk: observationRows.filter((o) => o.severity === "high" || o.severity === "critical")
          .length,
      },
      actions: {
        total: actionRows.length,
        open: actionRows.filter((a) => a.status === "open" || a.status === "in_progress").length,
        overdue: actionRows.filter(
          (a) => (a.status === "open" || a.status === "in_progress") && a.dueDate < asOf,
        ).length,
        closedOnTime,
        closedLate,
        weakControl: actionRows.filter((a) => WEAK_CONTROLS.has(a.hierarchyOfControl ?? "")).length,
        ineffective: actionRows.filter((a) => a.effectivenessVerdict === "not_effective").length,
      },
      inspections: {
        completed: inspectionRows.length,
        passed: inspectionRows.filter((i) => i.result === "pass").length,
        passedWithObservations: inspectionRows.filter((i) => i.result === "pass_with_observations")
          .length,
        failed: inspectionRows.filter((i) => i.result === "fail").length,
        criticalDefects: inspectionRows.reduce((s, i) => s + (i.criticalDefectCount ?? 0), 0),
      },
      ncrs: {
        total: ncrRows.length,
        bySeverity: ncrSeverity,
        open: ncrRows.filter((n) => n.status !== "closed" && n.status !== "void").length,
        backcharged: ncrRows.filter((n) => asBool(n.isBackcharged)).length,
        costByCurrency,
      },
      programme: {
        expired: programmeRows.filter((r) => r.status === "expired").length,
        expiringSoon: programmeRows.filter(
          (r) => r.status !== "expired" && r.expiresAt != null && r.expiresAt <= soon && r.expiresAt >= asOf,
        ).length,
        active: programmeRows.filter((r) => r.status === "active" || r.status === "approved").length,
      },
      exposure,
      toolboxTalksAttended: Number(talkRows[0]?.n ?? 0),
      deviceAlarmsUnacknowledged: Number(alarmRows[0]?.n ?? 0),
    };
  }

  /** Vendors that appear anywhere in the safety or quality registers in the window. */
  async function vendorsWithSafetyRecords(
    companyId: string,
    projectId: string | null,
    from: string,
    to: string,
  ): Promise<string[]> {
    const ids = new Set<string>();
    const incidentVendors = await app.db
      .selectDistinct({ id: safetyIncidents.vendorId })
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          ...(projectId ? [eq(safetyIncidents.projectId, projectId)] : []),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
        ),
      );
    const observationVendors = await app.db
      .selectDistinct({ id: safetyObservations.vendorId })
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, companyId),
          ...(projectId ? [eq(safetyObservations.projectId, projectId)] : []),
          gte(safetyObservations.observedAt, `${from}T00:00:00Z`),
          lte(safetyObservations.observedAt, `${to}T23:59:59Z`),
        ),
      );
    const actionVendors = await app.db
      .selectDistinct({ id: safetyCorrectiveActions.ownerVendorId })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          ...(projectId ? [eq(safetyCorrectiveActions.projectId, projectId)] : []),
          gte(safetyCorrectiveActions.dueDate, from),
          lte(safetyCorrectiveActions.dueDate, to),
        ),
      );
    for (const row of [...incidentVendors, ...observationVendors, ...actionVendors]) {
      if (row.id) ids.add(row.id);
    }
    return [...ids];
  }

  async function scorecardsFor(
    companyId: string,
    projectId: string | null,
    from: string,
    to: string,
    onlyVendorId: string | null,
  ): Promise<{ scorecards: VendorScorecard[]; reasons: string[] }> {
    const ids = onlyVendorId
      ? [onlyVendorId]
      : await vendorsWithSafetyRecords(companyId, projectId, from, to);
    if (ids.length === 0) {
      return {
        scorecards: [],
        reasons: [
          `No vendor appears in the safety registers for ${from} to ${to}${projectId ? " on this project" : ""}. ` +
            `A scorecard is a reading of records; with no records there is nothing to read, and a ` +
            `grade invented from that would be the worst possible input to a bid evaluation.`,
        ],
      };
    }
    const names = new Map<string, string>();
    const vendorRows = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
    for (const v of vendorRows) names.set(v.id, v.name);
    const computedAt = new Date().toISOString();
    const scorecards: VendorScorecard[] = [];
    for (const id of ids) {
      if (!names.has(id)) continue;
      const input = await collectVendorScorecardInput(
        companyId,
        projectId,
        id,
        names.get(id) ?? null,
        from,
        to,
      );
      scorecards.push(buildVendorScorecard(input, computedAt));
    }
    scorecards.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
    return { scorecards, reasons: [] };
  }

  app.get(
    "/projects/:projectId/safety/vendor-scorecard",
    { preHandler: readGate },
    async (req) => {
      const q = scorecardQuery.parse(req.query);
      const to = q.to ?? todayISO();
      const from = q.from ?? addDaysISO(to, -365);
      if (from > to) throw badRequest(`from ${from} falls after to ${to}.`);
      if (q.vendorId) await assertVendor(q.vendorId, req.companyId!);
      const result = await scorecardsFor(
        req.companyId!,
        req.projectId!,
        from,
        to,
        q.vendorId ?? null,
      );
      return {
        projectId: req.projectId!,
        from,
        to,
        ...result,
        note:
          "Every metric is null where the platform does not hold what it divides by — a supplier " +
          "with no timecards on this project gets no rate, not a zero. The composite is weighted " +
          "towards leading behaviour (action closure) rather than outcomes, because outcomes are " +
          "small-sample and lagging on any single project.",
      };
    },
  );

  app.get(
    "/companies/current/safety/vendor-scorecard",
    { preHandler: companyRead },
    async (req) => {
      const q = scorecardQuery.parse(req.query);
      const to = q.to ?? todayISO();
      const from = q.from ?? addDaysISO(to, -365);
      if (from > to) throw badRequest(`from ${from} falls after to ${to}.`);
      if (q.vendorId) await assertVendor(q.vendorId, req.companyId!);
      const result = await scorecardsFor(req.companyId!, null, from, to, q.vendorId ?? null);
      return {
        companyId: req.companyId!,
        from,
        to,
        ...result,
        note:
          "The company roll-up reads every project's registers. It is the figure a prequalification " +
          "team should hold beside the questionnaire answers — one is what the supplier says about " +
          "itself, the other is what its record on your sites actually shows.",
      };
    },
  );

  /**
   * Publish the roll-up onto the vendor's live prequalification submission.
   *
   * A prequalification questionnaire is what a supplier says about itself. The
   * scorecard is what their record on this company's sites shows, and the
   * whole value of computing it is lost if a bid evaluator has to know it
   * exists. It is written onto the submission's `detail` as an OBSERVED
   * record, clearly separated from the assessed answers, never overwriting a
   * score somebody assigned.
   */
  app.post(
    "/companies/current/safety/vendor-scorecard/publish",
    { preHandler: companyWrite },
    async (req) => {
      const body = z
        .object({
          vendorId: z.string().max(64).optional(),
          from: isoDateSchema.optional(),
          to: isoDateSchema.optional(),
        })
        .parse(req.body ?? {});
      const to = body.to ?? todayISO();
      const from = body.from ?? addDaysISO(to, -365);
      const { scorecards } = await scorecardsFor(
        req.companyId!,
        null,
        from,
        to,
        body.vendorId ?? null,
      );
      const published: Array<{ vendorId: string; submissionId: string; score: number | null }> = [];
      const skipped: Array<{ vendorId: string; reason: string }> = [];
      const now = new Date().toISOString();
      for (const card of scorecards) {
        const submissions = await app.db
          .select({
            id: prequalificationSubmissions.id,
            reference: prequalificationSubmissions.reference,
            detail: prequalificationSubmissions.detail,
            projectId: prequalificationSubmissions.projectId,
          })
          .from(prequalificationSubmissions)
          .where(
            and(
              eq(prequalificationSubmissions.companyId, req.companyId!),
              eq(prequalificationSubmissions.vendorId, card.vendorId),
              inArray(prequalificationSubmissions.status, ["assessed", "under_review", "submitted"]),
            ),
          )
          .orderBy(desc(prequalificationSubmissions.createdAt))
          .limit(1);
        const submission = submissions[0];
        if (!submission) {
          skipped.push({
            vendorId: card.vendorId,
            reason:
              "No live prequalification submission holds this vendor, so there is nothing to publish " +
              "onto. The scorecard remains available on the company endpoint.",
          });
          continue;
        }
        await app.db
          .update(prequalificationSubmissions)
          .set({
            detail: {
              ...(submission.detail as Record<string, unknown>),
              observedSafetyRecord: {
                source: "safety_vendor_scorecard",
                from,
                to,
                score: card.score,
                grade: card.grade,
                coverage: card.coverage,
                recordCount: card.recordCount,
                flags: card.flags,
                reasons: card.reasons,
                metrics: card.metrics.map((m) => ({
                  key: m.key,
                  name: m.name,
                  value: m.value,
                  unit: m.unit,
                  reasons: m.reasons,
                })),
                computedAt: card.computedAt,
                note:
                  "Observed from this company's own registers. It does not replace the assessed " +
                  "questionnaire score and no assessor's figure has been altered.",
              },
            },
            updatedAt: now,
          })
          .where(eq(prequalificationSubmissions.id, submission.id));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: submission.projectId,
          actorId: req.user!.id,
          action: "update",
          objectType: "prequalification_submission",
          objectId: submission.id,
          payload: {
            act: "publish_observed_safety_record",
            reference: submission.reference,
            vendorId: card.vendorId,
            from,
            to,
            score: card.score,
            grade: card.grade,
            coverage: card.coverage,
            flags: card.flags,
          },
          storePayload: true,
        });
        published.push({
          vendorId: card.vendorId,
          submissionId: submission.id,
          score: card.score,
        });
      }
      return { from, to, published, skipped, scorecards };
    },
  );

  /* ================================================================ */
  /* PREDICTIVE SAFETY RISK INDEX                                      */
  /* ================================================================ */

  const riskIndexQuery = z.object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    trendDays: z.coerce.number().int().min(7).max(365).optional(),
  });

  /** Every input the leading-indicator index reads, for one project's window. */
  async function collectRiskIndexInput(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
    asOf: string,
  ): Promise<RiskIndexInput> {
    const actionRows = await app.db
      .select({
        status: safetyCorrectiveActions.status,
        dueDate: safetyCorrectiveActions.dueDate,
        hierarchyOfControl: safetyCorrectiveActions.hierarchyOfControl,
        effectivenessVerdict: safetyCorrectiveActions.effectivenessVerdict,
      })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
        ),
      );
    const observationRows = await app.db
      .select({ kind: safetyObservations.kind, severity: safetyObservations.severity })
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, companyId),
          eq(safetyObservations.projectId, projectId),
          gte(safetyObservations.observedAt, `${from}T00:00:00Z`),
          lte(safetyObservations.observedAt, `${to}T23:59:59Z`),
        ),
      );
    const inspectionRows = await app.db
      .select({
        result: safetyInspections.result,
        criticalDefectCount: safetyInspections.criticalDefectCount,
      })
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.companyId, companyId),
          eq(safetyInspections.projectId, projectId),
          gte(safetyInspections.performedAt, `${from}T00:00:00Z`),
          lte(safetyInspections.performedAt, `${to}T23:59:59Z`),
        ),
      );
    const talkRows = await app.db
      .select({ id: toolboxTalks.id })
      .from(toolboxTalks)
      .where(
        and(
          eq(toolboxTalks.companyId, companyId),
          eq(toolboxTalks.projectId, projectId),
          gte(toolboxTalks.talkDate, from),
          lte(toolboxTalks.talkDate, to),
          inArray(toolboxTalks.status, ["delivered", "verified"]),
        ),
      );
    const briefedRows = await app.db
      .selectDistinct({ workerId: toolboxTalkAttendees.workerId })
      .from(toolboxTalkAttendees)
      .where(
        and(
          eq(toolboxTalkAttendees.companyId, companyId),
          eq(toolboxTalkAttendees.projectId, projectId),
          inArray(
            toolboxTalkAttendees.talkId,
            talkRows.length > 0 ? talkRows.map((t) => t.id) : ["__none__"],
          ),
        ),
      );
    const onSiteRows = await app.db
      .select({ n: count() })
      .from(workers)
      .where(
        and(
          eq(workers.companyId, companyId),
          eq(workers.projectId, projectId),
          eq(workers.status, "active"),
        ),
      );
    const programmeRows = await app.db
      .select({
        status: safetyProgrammeRecords.status,
        expiresAt: safetyProgrammeRecords.expiresAt,
        recordKind: safetyProgrammeRecords.recordKind,
      })
      .from(safetyProgrammeRecords)
      .where(
        and(
          eq(safetyProgrammeRecords.companyId, companyId),
          eq(safetyProgrammeRecords.projectId, projectId),
        ),
      );
    const incidentRows = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
          ne(safetyIncidents.status, "void"),
        ),
      );

    const nowISO = `${asOf}T23:59:59Z`;
    let notificationsMissed = 0;
    let notificationsLate = 0;
    let outstandingDuties = 0;
    for (const inc of incidentRows) {
      if (!asBool(inc.isReportable)) continue;
      const state = incidentNotificationState(inc, nowISO);
      for (const duty of state.duties) {
        if (duty.state === "missed") notificationsMissed += 1;
        else if (duty.state === "notified_late") notificationsLate += 1;
        else if (duty.state === "outstanding") outstandingDuties += 1;
      }
    }

    const alarmRows = await app.db
      .select({
        status: safetySensorEvents.status,
        acknowledgedAt: safetySensorEvents.acknowledgedAt,
        acknowledgeDueAt: safetySensorEvents.acknowledgeDueAt,
      })
      .from(safetySensorEvents)
      .where(
        and(
          eq(safetySensorEvents.companyId, companyId),
          eq(safetySensorEvents.projectId, projectId),
          gte(safetySensorEvents.occurredAt, `${from}T00:00:00Z`),
          lte(safetySensorEvents.occurredAt, `${to}T23:59:59Z`),
        ),
      );

    const soon = addDaysISO(asOf, 30);
    const lastIncident = incidentRows
      .map((i) => i.occurredAt)
      .sort()
      .at(-1);
    const weeks = Math.max(
      1,
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000)),
    );

    return {
      projectId,
      from,
      to,
      asOf,
      actions: {
        open: actionRows.filter((a) => a.status === "open" || a.status === "in_progress").length,
        overdue: actionRows.filter(
          (a) => (a.status === "open" || a.status === "in_progress") && a.dueDate < asOf,
        ).length,
        total: actionRows.length,
        weakControl: actionRows.filter((a) => WEAK_CONTROLS.has(a.hierarchyOfControl ?? "")).length,
        ineffective: actionRows.filter((a) => a.effectivenessVerdict === "not_effective").length,
      },
      observations: {
        positive: observationRows.filter((o) => o.kind === "positive").length,
        negative: observationRows.filter((o) => o.kind === "negative").length,
        total: observationRows.length,
        highRisk: observationRows.filter((o) => o.severity === "high" || o.severity === "critical")
          .length,
      },
      inspections: {
        completed: inspectionRows.length,
        failed: inspectionRows.filter((i) => i.result === "fail").length,
        criticalDefects: inspectionRows.reduce((s, i) => s + (i.criticalDefectCount ?? 0), 0),
      },
      briefings: {
        talksDelivered: talkRows.length,
        weeksInWindow: weeks,
        workersBriefed: briefedRows.filter((r) => r.workerId != null).length,
        workersOnSite: Number(onSiteRows[0]?.n ?? 0),
      },
      programme: {
        expired: programmeRows.filter((r) => r.status === "expired").length,
        expiringSoon: programmeRows.filter(
          (r) =>
            r.status !== "expired" && r.expiresAt != null && r.expiresAt >= asOf && r.expiresAt <= soon,
        ).length,
        criticalExpired: programmeRows.filter(
          (r) => r.status === "expired" && CRITICAL_RECORD_KINDS.has(r.recordKind),
        ).length,
        active: programmeRows.filter((r) => r.status === "active" || r.status === "approved").length,
      },
      incidents: {
        total: incidentRows.length,
        lostTime: incidentRows.filter((i) => asBool(i.isLostTime)).length,
        recordableOrReportable: incidentRows.filter(
          (i) =>
            asBool(i.isReportable) ||
            ["death", "days_away_from_work", "job_transfer_or_restriction", "other_recordable"].includes(
              i.oshaCaseType ?? "",
            ),
        ).length,
        daysSinceLast:
          lastIncident != null
            ? Math.max(
                0,
                Math.floor(
                  (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(lastIncident)) / 86_400_000,
                ),
              )
            : null,
        investigationsOverdue: incidentRows.filter(
          (i) =>
            i.investigationDueDate != null &&
            i.investigationDueDate < asOf &&
            i.investigationStatus !== "complete" &&
            i.investigationStatus !== "approved",
        ).length,
      },
      statutory: { notificationsMissed, notificationsLate, outstandingDuties },
      devices: {
        alarms: alarmRows.length,
        unacknowledged: alarmRows.filter((a) => a.acknowledgedAt == null).length,
        overdueAcknowledgement: alarmRows.filter(
          (a) =>
            a.acknowledgedAt == null &&
            a.acknowledgeDueAt != null &&
            Date.parse(a.acknowledgeDueAt) < Date.parse(nowISO),
        ).length,
      },
    };
  }

  /**
   * Compute the index and, when asked, store the reading.
   *
   * The snapshot is what makes the index useful: an index of 62 means nothing,
   * an index that has moved 38 → 62 in three weeks is a conversation. The
   * upsert is keyed on the day, so recomputing twice in one day replaces the
   * reading rather than creating a second one.
   */
  async function computeAndMaybeStoreRiskIndex(
    companyId: string,
    projectId: string,
    from: string,
    to: string,
    asOf: string,
    store: boolean,
    actorId: string | null,
  ): Promise<{ result: RiskIndexResult; snapshotId: string | null; signalId: string | null }> {
    const input = await collectRiskIndexInput(companyId, projectId, from, to, asOf);
    const result = computeRiskIndex(input);
    if (!store) return { result, snapshotId: null, signalId: null };

    const computedAt = new Date().toISOString();
    const existing = await app.db
      .select({ id: safetyRiskSnapshots.id, signalId: safetyRiskSnapshots.signalId })
      .from(safetyRiskSnapshots)
      .where(
        and(eq(safetyRiskSnapshots.projectId, projectId), eq(safetyRiskSnapshots.asOfDate, asOf)),
      )
      .limit(1);
    const snapshotId = existing[0]?.id ?? newId("srisk");

    /* A signal only where the band is one a project director must act on, and
     * only once per project per band per day — the sweep is idempotent on the
     * snapshot key, so a second run the same day replaces the reading rather
     * than raising the finding again. */
    let signalId = existing[0]?.signalId ?? null;
    if ((result.band === "high" || result.band === "severe") && signalId == null) {
      const seen = await alreadySignalled(companyId, "safety_risk_index_elevated", projectId);
      const key = `${projectId}:${asOf}`;
      if (!seen.has(key)) {
        signalId = newId("sig");
        await app.db.insert(signals).values({
          id: signalId,
          companyId,
          projectId,
          detector: "safety_risk_index_elevated",
          severity: result.band === "severe" ? "critical" : "high",
          confidence: Math.min(1, Math.max(0, result.coverage)),
          title: `Leading-indicator safety risk index is ${result.band} (${result.score}) — ${projectId}`,
          explanation:
            `${result.explanation}\n\nThe drivers, in order of how much they contribute: ` +
            result.drivers
              .map((d) => `${d.name} (${d.contribution} points) — ${d.advice}`)
              .join("\n\n") +
            `\n\nThis is a LEADING index: nothing here has hurt anybody yet, which is the entire ` +
            `point of raising it. Every component is a number the site can change this week. ` +
            `Coverage of the index's weight was ${Math.round(result.coverage * 100)}% — the components that could not ` +
            `be computed are listed on the snapshot rather than being scored as zero.`,
          evidenceRefs: {
            key,
            projectId,
            asOfDate: asOf,
            score: result.score,
            band: result.band,
            coverage: result.coverage,
            drivers: result.drivers,
            snapshotId,
          },
        });
      }
    }

    const values = {
      id: snapshotId,
      companyId,
      projectId,
      computedAt,
      asOfDate: asOf,
      windowFrom: from,
      windowTo: to,
      score: result.score,
      band: result.band,
      components: result.components as unknown[],
      reasons: result.reasons,
      coverage: result.coverage,
      signalId,
      detail: { drivers: result.drivers, explanation: result.explanation },
    };
    if (existing[0]) {
      await app.db
        .update(safetyRiskSnapshots)
        .set(values)
        .where(eq(safetyRiskSnapshots.id, snapshotId));
    } else {
      await app.db.insert(safetyRiskSnapshots).values(values);
    }
    await appendLedger(app.db, {
      companyId,
      projectId,
      actorId,
      action: "create",
      objectType: "safety_risk_snapshot",
      objectId: snapshotId,
      payload: {
        asOfDate: asOf,
        windowFrom: from,
        windowTo: to,
        score: result.score,
        band: result.band,
        coverage: result.coverage,
        drivers: result.drivers.map((d) => d.key),
        signalId,
      },
    });
    return { result, snapshotId, signalId };
  }

  app.get("/projects/:projectId/safety/risk-index", { preHandler: readGate }, async (req) => {
    const q = riskIndexQuery.parse(req.query);
    const asOf = q.to ?? todayISO();
    const from = q.from ?? addDaysISO(asOf, -90);
    if (from > asOf) throw badRequest(`from ${from} falls after to ${asOf}.`);
    const { result } = await computeAndMaybeStoreRiskIndex(
      req.companyId!,
      req.projectId!,
      from,
      asOf,
      asOf,
      false,
      req.user!.id,
    );
    const trendFrom = addDaysISO(asOf, -(q.trendDays ?? 90));
    const trend = await app.db
      .select({
        asOfDate: safetyRiskSnapshots.asOfDate,
        score: safetyRiskSnapshots.score,
        band: safetyRiskSnapshots.band,
        coverage: safetyRiskSnapshots.coverage,
      })
      .from(safetyRiskSnapshots)
      .where(
        and(
          eq(safetyRiskSnapshots.companyId, req.companyId!),
          eq(safetyRiskSnapshots.projectId, req.projectId!),
          gte(safetyRiskSnapshots.asOfDate, trendFrom),
        ),
      )
      .orderBy(asc(safetyRiskSnapshots.asOfDate));
    return {
      ...result,
      trend,
      note:
        "This is a LEADING index built only from things a site can change this week. It is not a " +
        "prediction of an accident and it is not a rate — a project with a low index and no " +
        "exposure hours still has no publishable TRIR. Where fewer than 40% of the index's weight " +
        "could be computed the score is withheld rather than published thin.",
    };
  });

  app.post(
    "/projects/:projectId/safety/risk-index/recompute",
    { preHandler: standardGate },
    async (req) => {
      const body = riskIndexQuery.parse(req.body ?? {});
      const asOf = body.to ?? todayISO();
      const from = body.from ?? addDaysISO(asOf, -90);
      if (from > asOf) throw badRequest(`from ${from} falls after to ${asOf}.`);
      const out = await computeAndMaybeStoreRiskIndex(
        req.companyId!,
        req.projectId!,
        from,
        asOf,
        asOf,
        true,
        req.user!.id,
      );
      return { ...out.result, snapshotId: out.snapshotId, signalId: out.signalId };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Under-reporting (Vol II M #701-702)                               */
  /* ---------------------------------------------------------------- */

  /**
   * The counts an under-reporting read is made from, for one project.
   *
   * This is the module's most consequential output and it is stated as
   * EVIDENCE, never as a finding: the honest answer to most of these is "the
   * site really was that quiet", so every finding carries what would refute it.
   */
  async function collectUnderReporting(
    companyId: string,
    projectId: string,
    projectName: string,
    from: string,
    to: string,
  ) {
    const rows = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
          gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
          lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
          ne(safetyIncidents.status, "void"),
        ),
      );
    const observationCount = await app.db
      .select({ n: count() })
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, companyId),
          eq(safetyObservations.projectId, projectId),
          gte(safetyObservations.observedAt, `${from}T00:00:00Z`),
          lte(safetyObservations.observedAt, `${to}T23:59:59Z`),
        ),
      );
    const exposure = await exposureForWindow(companyId, projectId, from, to);

    /* The peer read: the company's other projects over the same window. A
     * project quiet on its own is ambiguous; a project quiet while its
     * siblings are not is a question. */
    const peerProjects = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), ne(projects.id, projectId)));
    const peers: Array<{ projectId: string; incidents: number; exposureHours: number | null }> = [];
    for (const peer of peerProjects.slice(0, 50)) {
      const n = await app.db
        .select({ n: count() })
        .from(safetyIncidents)
        .where(
          and(
            eq(safetyIncidents.companyId, companyId),
            eq(safetyIncidents.projectId, peer.id),
            gte(safetyIncidents.occurredAt, `${from}T00:00:00Z`),
            lte(safetyIncidents.occurredAt, `${to}T23:59:59Z`),
            ne(safetyIncidents.status, "void"),
          ),
        );
      const peerExposure = await exposureForWindow(companyId, peer.id, from, to);
      peers.push({
        projectId: peer.id,
        incidents: Number(n[0]?.n ?? 0),
        exposureHours: peerExposure.hours,
      });
    }

    return assessUnderReporting({
      projectId,
      projectName,
      from,
      to,
      exposureHours: exposure.hours,
      exposureSource: exposure.source,
      counts: {
        incidents: rows.length,
        injuries: rows.filter(
          (i) => i.incidentType === "injury" || i.incidentType === "occupational_illness",
        ).length,
        nearMisses: rows.filter((i) => i.incidentType === "near_miss").length,
        observations: Number(observationCount[0]?.n ?? 0),
        fatalities: rows.filter((i) => asBool(i.isFatality)).length,
        lostTime: rows.filter((i) => asBool(i.isLostTime)).length,
      },
      peers,
    });
  }

  app.get("/projects/:projectId/safety/under-reporting", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() })
      .parse(req.query);
    const to = q.to ?? todayISO();
    const from = q.from ?? addDaysISO(to, -365);
    if (from > to) throw badRequest(`from ${from} falls after to ${to}.`);
    const projectRows = await app.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
      .limit(1);
    const result = await collectUnderReporting(
      req.companyId!,
      req.projectId!,
      projectRows[0]?.name ?? req.projectId!,
      from,
      to,
    );
    return {
      ...result,
      note:
        "These are readings about the REGISTER, not about the site. Each states what was expected " +
        "and on what basis, what was observed, and what would refute it — because the honest answer " +
        "to most of them is that the site really was that quiet, and a register that cannot say so " +
        "is worse than one that never asked.",
    };
  });

  /* ================================================================ */
  /* INVESTIGATION ASSISTANT (AI, cited)                               */
  /* ================================================================ */

  const assistAcceptSchema = z.object({
    runId: z.string().max(64),
    contributingFactors: z
      .array(
        z.object({
          factor: z.string().min(1).max(500),
          category: z.enum(["immediate", "underlying", "organisational"]),
          note: z.string().max(2000).optional(),
          sourceIds: z.array(z.string().max(64)).max(20).optional(),
        }),
      )
      .max(30)
      .optional(),
    actions: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          description: z.string().max(4000).nullable().optional(),
          hierarchyOfControl: z.enum(HIERARCHY_OF_CONTROLS),
          dueDate: isoDateSchema,
          ownerId: z.string().max(64).nullable().optional(),
          ownerVendorId: z.string().max(64).nullable().optional(),
          priority: z.enum(["low", "medium", "high", "critical"]).optional(),
          sourceIds: z.array(z.string().max(64)).max(20).optional(),
        }),
      )
      .max(20)
      .optional(),
  });

  const summarise = (text: string | null | undefined, max = 240): string =>
    (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  /** Assemble the records around one incident — everything the model may cite. */
  async function buildAssistContext(
    companyId: string,
    projectId: string,
    incident: IncidentRow,
  ): Promise<AssistContext> {
    const windowStart = new Date(Date.parse(incident.occurredAt) - 90 * 86_400_000).toISOString();
    const vendorName = incident.vendorId
      ? ((
          await app.db
            .select({ name: vendors.name })
            .from(vendors)
            .where(and(eq(vendors.companyId, companyId), eq(vendors.id, incident.vendorId)))
            .limit(1)
        )[0]?.name ?? null)
      : null;

    const priorObservationRows = await app.db
      .select()
      .from(safetyObservations)
      .where(
        and(
          eq(safetyObservations.companyId, companyId),
          eq(safetyObservations.projectId, projectId),
          gte(safetyObservations.observedAt, windowStart),
          lte(safetyObservations.observedAt, incident.occurredAt),
          or(
            ...[
              incident.vendorId ? eq(safetyObservations.vendorId, incident.vendorId) : undefined,
              incident.locationId ? eq(safetyObservations.locationId, incident.locationId) : undefined,
              incident.locationText
                ? eq(safetyObservations.locationText, incident.locationText)
                : undefined,
            ].filter((c): c is NonNullable<typeof c> => c !== undefined),
          ),
        ),
      )
      .orderBy(desc(safetyObservations.observedAt))
      .limit(25);

    const priorIncidentRows = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          eq(safetyIncidents.projectId, projectId),
          ne(safetyIncidents.id, incident.id),
          ne(safetyIncidents.status, "void"),
          lte(safetyIncidents.occurredAt, incident.occurredAt),
          ...(incident.mechanism ? [eq(safetyIncidents.mechanism, incident.mechanism)] : []),
        ),
      )
      .orderBy(desc(safetyIncidents.occurredAt))
      .limit(15);

    const inspectionRows = await app.db
      .select()
      .from(safetyInspections)
      .where(
        and(
          eq(safetyInspections.companyId, companyId),
          eq(safetyInspections.projectId, projectId),
          gte(safetyInspections.performedAt, windowStart),
          lte(safetyInspections.performedAt, incident.occurredAt),
          ...(incident.vendorId ? [eq(safetyInspections.vendorId, incident.vendorId)] : []),
        ),
      )
      .orderBy(desc(safetyInspections.performedAt))
      .limit(15);

    const briefingRows = await app.db
      .select()
      .from(toolboxTalks)
      .where(
        and(
          eq(toolboxTalks.companyId, companyId),
          eq(toolboxTalks.projectId, projectId),
          gte(toolboxTalks.talkDate, windowStart.slice(0, 10)),
          lte(toolboxTalks.talkDate, incident.occurredAt.slice(0, 10)),
          ...(incident.vendorId ? [eq(toolboxTalks.vendorId, incident.vendorId)] : []),
        ),
      )
      .orderBy(desc(toolboxTalks.talkDate))
      .limit(15);

    const openActionRows = await app.db
      .select()
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.projectId, projectId),
          inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
        ),
      )
      .orderBy(asc(safetyCorrectiveActions.dueDate))
      .limit(25);

    const programmeRows = await app.db
      .select()
      .from(safetyProgrammeRecords)
      .where(
        and(
          eq(safetyProgrammeRecords.companyId, companyId),
          or(
            eq(safetyProgrammeRecords.projectId, projectId),
            isNull(safetyProgrammeRecords.projectId),
          ),
          ...(incident.vendorId ? [eq(safetyProgrammeRecords.vendorId, incident.vendorId)] : []),
        ),
      )
      .orderBy(desc(safetyProgrammeRecords.updatedAt))
      .limit(20);

    const ref = (
      type: string,
      id: string,
      reference: string,
      label: string,
      summary: string,
      occurredAt: string | null,
    ): AssistRecordRef => ({ type, id, reference, label, summary, occurredAt });

    const witnessList = (incident.witnesses as unknown[])
      .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
      .map((w) => ({
        name: typeof w["name"] === "string" ? w["name"] : "unnamed witness",
        organisation: typeof w["organisation"] === "string" ? w["organisation"] : null,
        statement:
          typeof w["statement"] === "string"
            ? w["statement"]
            : typeof w["statementFileId"] === "string"
              ? "(a statement file is attached; its text is not held in the record)"
              : null,
      }));

    return {
      incident: {
        id: incident.id,
        reference: incident.reference,
        incidentType: incident.incidentType,
        severity: incident.severity,
        title: incident.title,
        description: incident.description,
        occurredAt: incident.occurredAt,
        locationText: incident.locationText,
        mechanism: incident.mechanism,
        injuryNature: incident.injuryNature,
        bodyPart: incident.bodyPart,
        activityAtTime: incident.activityAtTime,
        immediateCause: incident.immediateCause,
        hoursIntoShift: incident.hoursIntoShift,
        shift: incident.shift,
        vendorName,
        injuredPersonType: incident.injuredPersonType,
        daysSinceInduction: incident.daysSinceInduction,
        yearsExperience: incident.yearsExperience,
        witnesses: witnessList,
      },
      determination: storedDetermination(incident),
      priorObservations: priorObservationRows.map((o) =>
        ref(
          "safety_observation",
          o.id,
          o.reference,
          `${o.kind} observation — ${o.title}`,
          `${summarise(o.description)} (severity ${o.severity}, category ${o.category}${
            asBool(o.workStopped) ? ", work stopped" : ""
          }, status ${o.status})`,
          o.observedAt,
        ),
      ),
      priorIncidents: priorIncidentRows.map((i) =>
        ref(
          "safety_incident",
          i.id,
          i.reference,
          `${i.incidentType} — ${i.title}`,
          `${summarise(i.description)} (mechanism ${i.mechanism ?? "not coded"}, severity ${i.severity})`,
          i.occurredAt,
        ),
      ),
      inspections: inspectionRows.map((i) =>
        ref(
          "safety_inspection",
          i.id,
          i.reference,
          `${i.inspectionType} inspection — ${i.title}`,
          `result ${i.result ?? "not scored"}, ${i.defectCount} defect(s), ${i.criticalDefectCount} critical`,
          i.performedAt,
        ),
      ),
      briefings: briefingRows.map((t) =>
        ref(
          "toolbox_talk",
          t.id,
          t.reference,
          `toolbox talk — ${t.title}`,
          `${summarise(t.contentSummary)} (${t.attendeeCount} attended, status ${t.status})`,
          `${t.talkDate}T00:00:00Z`,
        ),
      ),
      openActions: openActionRows.map((a) =>
        ref(
          "safety_corrective_action",
          a.id,
          a.reference,
          `open action — ${a.title}`,
          `due ${a.dueDate}, control level ${a.hierarchyOfControl ?? "not stated"}, status ${a.status}`,
          null,
        ),
      ),
      programmeRecords: programmeRows.map((r) =>
        ref(
          "safety_programme_record",
          r.id,
          r.reference,
          `${r.recordKind} — ${r.title}`,
          `status ${r.status}${r.expiresAt ? `, expires ${r.expiresAt}` : ""}`,
          null,
        ),
      ),
    };
  }

  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/assist",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const incident = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      const ctx = await buildAssistContext(req.companyId!, req.projectId!, incident);
      const prompt = buildAssistPrompt(ctx);

      if (!aiEnabled(app)) {
        /* Degrading, not failing: the assembly is the useful half and it is
         * deterministic. What the model would have added is a reading of the
         * pattern; what the site still gets is every record that bears on this
         * incident, in one place, with nothing invented. */
        return {
          available: false,
          reason:
            "The AI layer is not configured (ANTHROPIC_API_KEY is unset), so no reading of the " +
            "pattern was generated. Everything below is the deterministic assembly the model would " +
            "have been given: the records around this incident, gathered by location, subcontractor " +
            "and mechanism. Nothing here is inferred.",
          context: {
            priorObservations: ctx.priorObservations,
            priorIncidents: ctx.priorIncidents,
            inspections: ctx.inspections,
            briefings: ctx.briefings,
            openActions: ctx.openActions,
            programmeRecords: ctx.programmeRecords,
            witnesses: ctx.incident.witnesses,
            openQuestions: ctx.determination?.openQuestions ?? [],
          },
          assist: null,
        };
      }

      try {
        const result = await runAgent({
          app,
          req,
          agentKind: "incident_investigation_assistant",
          projectId: req.projectId!,
          system: prompt.system,
          user: prompt.user,
          inputRefs: prompt.inputRefs,
          schema: assistOutputSchema,
          contextChars: prompt.contextChars,
          maxTokens: 4000,
        });
        const assist = result.json
          ? reconcileAssist(result.json, prompt.allowedIds)
          : null;
        await appendLedger(app.db, {
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          action: "access",
          objectType: "safety_incident",
          objectId: incidentId,
          payload: {
            act: "investigation_assist",
            reference: incident.reference,
            runId: result.runId,
            recordsOffered: prompt.inputRefs.length,
            droppedCitations: assist?.droppedCitations ?? null,
            onlyWeakControls: assist?.onlyWeakControls ?? null,
          },
          storePayload: true,
        });
        return {
          available: true,
          runId: result.runId,
          incidentId,
          reference: incident.reference,
          assist,
          grounding: result.grounding,
          context: {
            recordsOffered: prompt.inputRefs.length,
            openQuestions: ctx.determination?.openQuestions ?? [],
          },
          note:
            "NOTHING here has been written to the incident. Every suggestion is a proposal a human " +
            "accepts or discards, and acceptance is a separate ledgered act carrying this run id. " +
            "Citations to records that were not in the prompt have been dropped rather than shown.",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          available: false,
          reason: `The AI layer was configured but the call did not succeed: ${message.slice(0, 300)}.`,
          context: {
            priorObservations: ctx.priorObservations,
            priorIncidents: ctx.priorIncidents,
            inspections: ctx.inspections,
            briefings: ctx.briefings,
            openActions: ctx.openActions,
            programmeRecords: ctx.programmeRecords,
            witnesses: ctx.incident.witnesses,
            openQuestions: ctx.determination?.openQuestions ?? [],
          },
          assist: null,
        };
      }
    },
  );

  /**
   * Accept some of what the assistant proposed.
   *
   * This is the ONLY route that writes anything the assistant produced, and it
   * writes what the HUMAN sent back — not what the model returned. The run id
   * is recorded against every row created so that, a year later, an
   * investigation's contributing factors can be traced to the run that
   * suggested them and the person who accepted them.
   */
  app.post(
    "/projects/:projectId/safety/incidents/:incidentId/assist/accept",
    { preHandler: standardGate },
    async (req) => {
      const { incidentId } = req.params as { incidentId: string };
      const body = assistAcceptSchema.parse(req.body);
      const row = await fetchIncident(incidentId, req.companyId!, req.projectId!);
      if (row.status === "closed" || row.status === "void") {
        throw conflict(
          `Incident ${row.reference} is ${row.status}. Accepting suggestions onto it would change ` +
            `an investigation that has been signed off.`,
        );
      }
      const factors = body.contributingFactors ?? [];
      const actions = body.actions ?? [];
      if (factors.length === 0 && actions.length === 0) {
        throw badRequest(
          "Nothing was accepted. Send the contributing factors and/or the corrective actions you " +
            "want written; an empty acceptance would leave a ledger entry claiming a human agreed " +
            "with something.",
        );
      }
      const now = new Date().toISOString();
      const existingFactors = [...(row.contributingFactors as unknown[])];
      for (const f of factors) {
        existingFactors.push({
          factor: f.factor,
          category: f.category,
          note: f.note ?? null,
          sourceIds: f.sourceIds ?? [],
          proposedBy: "incident_investigation_assistant",
          agentRunId: body.runId,
          acceptedBy: req.user!.id,
          acceptedAt: now,
        });
      }
      if (factors.length > 0) {
        await app.db
          .update(safetyIncidents)
          .set({ contributingFactors: existingFactors, updatedAt: now })
          .where(eq(safetyIncidents.id, incidentId));
      }

      const created: Array<{ id: string; title: string; hierarchyOfControl: string }> = [];
      for (const a of actions) {
        if (a.ownerVendorId) await assertVendor(a.ownerVendorId, req.companyId!);
        const actionId = await createAction({
          companyId: req.companyId!,
          projectId: req.projectId!,
          actorId: req.user!.id,
          sourceType: "incident",
          sourceId: incidentId,
          sourceReference: row.reference,
          title: a.title,
          description: a.description ?? null,
          actionKind: "corrective",
          hierarchyOfControl: a.hierarchyOfControl,
          category: null,
          priority: a.priority ?? "medium",
          ownerId: a.ownerId ?? null,
          ownerVendorId: a.ownerVendorId ?? null,
          ownerName: null,
          dueDate: a.dueDate,
          costToImplement: null,
          currency: null,
          detail: {
            proposedBy: "incident_investigation_assistant",
            agentRunId: body.runId,
            sourceIds: a.sourceIds ?? [],
            acceptedBy: req.user!.id,
          },
        });
        created.push({ id: actionId, title: a.title, hierarchyOfControl: a.hierarchyOfControl });
      }

      const weakOnly =
        created.length > 0 &&
        created.every((c) => WEAK_CONTROLS.has(c.hierarchyOfControl));

      await appendLedger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "safety_incident",
        objectId: incidentId,
        payload: {
          act: "accept_investigation_assist",
          reference: row.reference,
          agentRunId: body.runId,
          contributingFactorsAccepted: factors.length,
          actionsCreated: created.map((c) => c.id),
          onlyWeakControlsAccepted: weakOnly,
          acceptedBy: req.user!.id,
        },
        storePayload: true,
      });

      return {
        incidentId,
        reference: row.reference,
        runId: body.runId,
        contributingFactorsAccepted: factors.length,
        actionsCreated: created,
        warning: weakOnly
          ? "Every action accepted sits at the administrative or PPE end of the hierarchy of " +
            "control. Those depend on a person at the sharp end doing the right thing every time " +
            "under production pressure; a register full of them will see this event again. Before " +
            "closing the investigation, record why the hazard could not be designed out, guarded " +
            "or isolated."
          : null,
      };
    },
  );

  /* ================================================================ */
  /* HEALTH INPUTS (contract 3.5)                                      */
  /* ================================================================ */

  app.get("/projects/:projectId/safety/health-inputs", { preHandler: readGate }, async (req) => {
    const to = todayISO();
    const from = addDaysISO(to, -90);
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const input = await collectRiskIndexInput(companyId, projectId, from, to, to);
    const index = computeRiskIndex(input);
    const exposure = await exposureForWindow(companyId, projectId, addDaysISO(to, -365), to);
    const reasons: string[] = [...index.reasons];
    if (exposure.hours == null) {
      reasons.push(
        "No exposure hours are held for the last 12 months, so no incident RATE is offered here — " +
          "only counts. A rate computed against an estimated denominator would be relied on.",
      );
    }
    return {
      metrics: {
        safetyRiskIndex: index.score,
        safetyRiskCoverage: index.coverage,
        openCorrectiveActions: input.actions.open,
        overdueCorrectiveActions: input.actions.overdue,
        weakControlActions: input.actions.weakControl,
        incidents90d: input.incidents.total,
        lostTimeIncidents90d: input.incidents.lostTime,
        reportableIncidents90d: input.incidents.recordableOrReportable,
        daysSinceLastIncident: input.incidents.daysSinceLast,
        investigationsOverdue: input.incidents.investigationsOverdue,
        statutoryNotificationsMissed: input.statutory.notificationsMissed,
        statutoryDutiesOutstanding: input.statutory.outstandingDuties,
        expiredProgrammeRecords: input.programme.expired,
        criticalExpiredProgrammeRecords: input.programme.criticalExpired,
        failedInspections90d: input.inspections.failed,
        observationsPositive90d: input.observations.positive,
        observationsNegative90d: input.observations.negative,
        unacknowledgedDeviceAlarms: input.devices.unacknowledged,
        exposureHours365d: exposure.hours,
      },
      reasons,
      window: { from, to },
      band: index.band,
    };
  });

  /* ================================================================ */
  /* SCHEDULED JOBS                                                    */
  /* ================================================================ */

  /**
   * The sweeps used to run only when somebody opened a page. A module whose
   * product is "the statutory deadline passed and here is the record" cannot
   * depend on a browser tab to notice the deadline, so the guarantee lives
   * here and the read path only ever hurries it along.
   */
  app.scheduler.register({
    name: "safety.sweeps",
    description:
      "Statutory notification deadlines per regime, overdue investigations and corrective actions, statutory inspections past their date, expired programme records and unanswered device alarms — over every company",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async () =>
      forEachCompany(app.db, async (companyId) => {
        await sweepSafety(companyId, null, null);
        return { companyId };
      }),
  });

  app.scheduler.register({
    name: "safety.risk-index",
    description:
      "Compute and store the leading-indicator safety risk index for every project holding safety records, and raise a signal where the band is high or severe",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async () => {
      const asOf = todayISO();
      const from = addDaysISO(asOf, -90);
      let scored = 0;
      let elevated = 0;
      const outcome = await forEachCompany(app.db, async (companyId) => {
        const projectIds = await projectsWithSafetyRecords(companyId);
        for (const projectId of projectIds) {
          const out = await computeAndMaybeStoreRiskIndex(
            companyId,
            projectId,
            from,
            asOf,
            asOf,
            true,
            null,
          );
          scored += 1;
          if (out.result.band === "high" || out.result.band === "severe") elevated += 1;
        }
        return { projects: projectIds.length };
      });
      return { ...outcome, scored, elevated };
    },
  });

  app.scheduler.register({
    name: "safety.under-reporting",
    description:
      "Compare each project's incident, injury and near-miss counts against its exposure and its sibling projects, and raise a signal where the register has gone quiet",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async () => {
      const to = todayISO();
      const from = addDaysISO(to, -365);
      let raised = 0;
      const outcome = await forEachCompany(app.db, async (companyId) => {
        const projectIds = await projectsWithSafetyRecords(companyId);
        const names = new Map<string, string>();
        if (projectIds.length > 0) {
          const rows = await app.db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
          for (const r of rows) names.set(r.id, r.name);
        }
        for (const projectId of projectIds) {
          const result = await collectUnderReporting(
            companyId,
            projectId,
            names.get(projectId) ?? projectId,
            from,
            to,
          );
          if (result.findings.length === 0) continue;
          const seen = await alreadySignalled(
            companyId,
            "safety_under_reporting_suspected",
            projectId,
          );
          for (const finding of result.findings) {
            const key = `${projectId}:${finding.key}:${to.slice(0, 7)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            raised += 1;
            await app.db.insert(signals).values({
              id: newId("sig"),
              companyId,
              projectId,
              detector: "safety_under_reporting_suspected",
              severity: finding.severity,
              confidence: finding.confidence,
              title: `${finding.title} — ${names.get(projectId) ?? projectId}`,
              explanation:
                `${finding.explanation}\n\nExpected: ${finding.expected}\n\nObserved: ${finding.observed}` +
                `\n\nWHAT WOULD REFUTE THIS: ${finding.refutedBy}\n\nThis is a reading about the ` +
                `REGISTER, not a finding about the site, and it is deliberately raised at a ` +
                `confidence below one. Under-reporting is the one safety failure that makes every ` +
                `other number on the project look better, which is exactly why nobody notices it ` +
                `from inside.`,
              evidenceRefs: {
                key,
                projectId,
                findingKey: finding.key,
                from,
                to,
                inputs: finding.inputs,
              },
            });
          }
        }
        return { projects: projectIds.length };
      });
      return { ...outcome, raised };
    },
  });

  /** Projects that hold any safety record at all — the sweep's bounded scope. */
  async function projectsWithSafetyRecords(companyId: string): Promise<string[]> {
    const ids = new Set<string>();
    const fromIncidents = await app.db
      .selectDistinct({ id: safetyIncidents.projectId })
      .from(safetyIncidents)
      .where(eq(safetyIncidents.companyId, companyId));
    const fromObservations = await app.db
      .selectDistinct({ id: safetyObservations.projectId })
      .from(safetyObservations)
      .where(eq(safetyObservations.companyId, companyId));
    const fromActions = await app.db
      .selectDistinct({ id: safetyCorrectiveActions.projectId })
      .from(safetyCorrectiveActions)
      .where(eq(safetyCorrectiveActions.companyId, companyId));
    for (const row of [...fromIncidents, ...fromObservations, ...fromActions]) {
      if (row.id) ids.add(row.id);
    }
    return [...ids];
  }

};
