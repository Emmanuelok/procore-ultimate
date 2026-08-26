import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  obligations,
  projects,
  safetyCorrectiveActions,
  safetyIncidents,
  safetyInspectionTemplates,
  safetyInspections,
  safetyObservations,
  safetyProgrammeRecords,
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
  SAFETY_PROGRAMME_RECORD_KINDS,
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
import { computeSafetyRates, resolveExposureHours, type RateCounts } from "./rates.js";

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
] as const;

/** Obligations created here carry this prefix so they can be counted back. */
const OBLIGATION_PREFIX = "safety";

/** Programme record kinds whose expiry stops work rather than merely dating a file. */
const CRITICAL_RECORD_KINDS = new Set(["permit_to_work", "competency_card", "temporary_works_design"]);

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
});

const recordCreateSchema = z.object({
  projectId: z.string().max(64).nullable().optional(),
  recordKind: z.enum(SAFETY_PROGRAMME_RECORD_KINDS),
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
  recordKind: z.enum(SAFETY_PROGRAMME_RECORD_KINDS).optional(),
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

  /** Signal keys already raised for a detector in this company. */
  async function alreadySignalled(companyId: string, detector: string): Promise<Set<string>> {
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(and(eq(signals.companyId, companyId), eq(signals.detector, detector)));
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
   * Five detectors, each keyed in `evidenceRefs.key` so a repeated read never
   * raises the same finding twice:
   *
   *   safety_notification_deadline_missed   key = incidentId
   *   safety_investigation_overdue          key = incidentId
   *   safety_corrective_action_overdue      key = actionId
   *   safety_statutory_inspection_overdue   key = inspectionId
   *   safety_programme_record_expired       key = recordId
   *
   * Status flips (an expired record → `expired`, a scheduled inspection past
   * its date → `overdue`) are a second, independent guard: the candidate
   * query selects on the pre-flip status, so a swept row leaves the set.
   *
   * `projectId === null` sweeps company-wide, which is what the company-level
   * programme-record routes need.
   */
  async function sweepSafety(
    companyId: string,
    projectId: string | null,
    actorId: string,
  ): Promise<void> {
    const asOf = todayISO();
    const nowISO = new Date().toISOString();

    /* (1) statutory notification deadline passed without a notification */
    const dueIncidents = await app.db
      .select()
      .from(safetyIncidents)
      .where(
        projectId
          ? and(
              eq(safetyIncidents.companyId, companyId),
              eq(safetyIncidents.projectId, projectId),
              eq(safetyIncidents.isReportable, 1),
              isNull(safetyIncidents.regulatorNotifiedAt),
            )
          : and(
              eq(safetyIncidents.companyId, companyId),
              eq(safetyIncidents.isReportable, 1),
              isNull(safetyIncidents.regulatorNotifiedAt),
            ),
      );
    const missed = dueIncidents.filter((i) => isNotificationMissed(i.reportDueAt, null, nowISO));
    if (missed.length > 0) {
      const seen = await alreadySignalled(companyId, "safety_notification_deadline_missed");
      for (const inc of missed) {
        if (inc.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, inc.obligationId), eq(obligations.status, "open")));
        }
        if (seen.has(inc.id)) continue;
        seen.add(inc.id);
        const det = storedDetermination(inc);
        const governing = det?.rules.find((r) => r.ruleId === det.governingRuleId) ?? null;
        const sigId = newId("sig");
        await app.db.insert(signals).values({
          id: sigId,
          companyId,
          projectId: inc.projectId,
          detector: "safety_notification_deadline_missed",
          severity: "critical",
          confidence: 1,
          title: `Statutory notification deadline missed — ${inc.reference}: ${inc.title}`,
          explanation:
            `Incident ${inc.reference} was classified as reportable under ` +
            `${(inc.reportableRegimes ?? []).join(", ") || "a statutory regime"} and the notification was due ` +
            `by ${inc.reportDueAt}. No notification has been recorded and that deadline has passed. ` +
            (governing
              ? `The governing rule is ${governing.ruleId} — ${governing.citation} `
              : "") +
            `\n\nWhat this now means: failing to notify within the statutory period is itself an offence, ` +
            `separate from anything the investigation finds about the accident. It is trivially provable ` +
            `from this record and from the incident's own timestamps, it removes any argument that the ` +
            `site's systems were under control, and it is the first thing an inspector establishes. ` +
            (governing?.consequenceIfMissed ?? "") +
            `\n\nNotify now — a late report is materially better than an absent one — record the ` +
            `notification and its reference against this incident, and treat the delay itself as a ` +
            `finding of the investigation.`,
          evidenceRefs: {
            key: inc.id,
            incidentId: inc.id,
            reference: inc.reference,
            reportDueAt: inc.reportDueAt,
            regimes: inc.reportableRegimes,
            riddorCategory: inc.riddorCategory,
            oshaCaseType: inc.oshaCaseType,
            governingRuleId: det?.governingRuleId ?? null,
            citation: governing?.citation ?? null,
            obligationId: inc.obligationId,
          },
        });
        await app.db
          .update(safetyIncidents)
          .set({ signalId: sigId, updatedAt: nowISO })
          .where(eq(safetyIncidents.id, inc.id));
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
      const seen = await alreadySignalled(companyId, "safety_investigation_overdue");
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
      const seen = await alreadySignalled(companyId, "safety_corrective_action_overdue");
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
      const seen = await alreadySignalled(companyId, "safety_statutory_inspection_overdue");
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
      const seen = await alreadySignalled(companyId, "safety_programme_record_expired");
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

  function decorateIncident(i: IncidentRow, asOf: string) {
    const det = storedDetermination(i);
    const delay = computeReportingDelay(i.occurredAt, i.reportedAt);
    const nowISO = new Date().toISOString();
    const missed = isNotificationMissed(i.reportDueAt, i.regulatorNotifiedAt, nowISO);
    const hoursRemaining =
      i.reportDueAt && !i.regulatorNotifiedAt
        ? Math.round(((Date.parse(i.reportDueAt) - Date.parse(nowISO)) / 3_600_000) * 10) / 10
        : null;
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
      notification: {
        required: asBool(i.isReportable),
        regimes: i.reportableRegimes ?? [],
        riddorCategory: i.riddorCategory,
        oshaCaseType: i.oshaCaseType,
        dueAt: i.reportDueAt,
        notifiedAt: i.regulatorNotifiedAt,
        notifiedBy: i.regulatorNotifiedBy,
        reference: i.regulatorReference,
        notifications: i.notifications ?? [],
        missed,
        hoursRemaining,
        obligationId: i.obligationId,
        needsHumanReview: det?.needsHumanReview ?? null,
        openQuestions: det?.openQuestions ?? [],
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
  async function refreshOpenActionCount(sourceType: string, sourceId: string, companyId: string) {
    const rows = await app.db
      .select({ n: count() })
      .from(safetyCorrectiveActions)
      .where(
        and(
          eq(safetyCorrectiveActions.companyId, companyId),
          eq(safetyCorrectiveActions.sourceType, sourceType),
          eq(safetyCorrectiveActions.sourceId, sourceId),
          inArray(safetyCorrectiveActions.status, [...OPEN_ACTION_STATUSES]),
        ),
      );
    const n = Number(rows[0]?.n ?? 0);
    const now = new Date().toISOString();
    if (sourceType === "incident") {
      await app.db
        .update(safetyIncidents)
        .set({ openActionCount: n, updatedAt: now })
        .where(eq(safetyIncidents.id, sourceId));
    } else if (sourceType === "observation") {
      await app.db
        .update(safetyObservations)
        .set({ openActionCount: n, updatedAt: now })
        .where(eq(safetyObservations.id, sourceId));
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
    await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
    await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
    return paginate(
      rows.map((r) => decorateIncident(r, asOf)),
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
      await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      return {
        ...decorateIncident(row, asOf),
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
      const late = isNotificationMissed(row.reportDueAt, notifiedAt, notifiedAt);
      const hoursLate =
        late && row.reportDueAt
          ? Math.round(((Date.parse(notifiedAt) - Date.parse(row.reportDueAt)) / 3_600_000) * 10) / 10
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
      await app.db
        .update(safetyIncidents)
        .set({
          notifications,
          regulatorNotifiedAt: row.regulatorNotifiedAt ?? notifiedAt,
          regulatorNotifiedBy: row.regulatorNotifiedBy ?? req.user!.id,
          regulatorReference: body.reference ?? row.regulatorReference,
          regulatorNotificationFileId: body.fileId ?? row.regulatorNotificationFileId,
          updatedAt: now,
        })
        .where(eq(safetyIncidents.id, incidentId));

      if (row.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: late ? "breached" : "satisfied" })
          .where(and(eq(obligations.id, row.obligationId), eq(obligations.status, "open")));
      }

      if (late) {
        const det = storedDetermination(row);
        const governing = det?.rules.find((r) => r.ruleId === det.governingRuleId) ?? null;
        const seen = await alreadySignalled(req.companyId!, "safety_notification_deadline_missed");
        if (!seen.has(incidentId)) {
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            detector: "safety_notification_deadline_missed",
            severity: "critical",
            confidence: 1,
            title: `Statutory notification made out of time — ${row.reference}: ${row.title}`,
            explanation:
              `Incident ${row.reference} was notified under ${body.regime} at ${notifiedAt}, ` +
              `${hoursLate} hour(s) after the statutory deadline of ${row.reportDueAt}` +
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
              key: incidentId,
              incidentId,
              reference: row.reference,
              regime: body.regime,
              reportDueAt: row.reportDueAt,
              notifiedAt,
              hoursLate,
              governingRuleId: det?.governingRuleId ?? null,
              citation: governing?.citation ?? null,
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
      return {
        ...decorateIncident(updated, todayISO()),
        notificationResult: {
          regime: body.regime,
          notifiedAt,
          dueAt: row.reportDueAt,
          late,
          hoursLate,
          obligationId: row.obligationId,
          obligationStatus: row.obligationId ? (late ? "breached" : "satisfied") : null,
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
      if (asBool(row.isReportable) && !row.regulatorNotifiedAt) {
        throw conflict(
          `Incident ${row.reference} is classified reportable under ` +
            `${(row.reportableRegimes ?? []).join(", ") || "a statutory regime"} and no notification has ` +
            `been recorded. Closing it would take a live statutory duty off the register. Notify and ` +
            `record it, or reassess the classification if it is wrong.`,
        );
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
      await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
    await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
    await sweepSafety(req.companyId!, null, req.user!.id);
    return listRecords(req.companyId!, null, q);
  });

  app.get("/projects/:projectId/safety/programme-records", { preHandler: readGate }, async (req) => {
    const q = recordListQuery.parse(req.query);
    await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepSafety(req.companyId!, null, req.user!.id);
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
      const acks = [...(row.acknowledgements ?? [])] as Array<Record<string, unknown>>;
      const subject = body.workerId ?? body.userId ?? req.user!.id;
      if (acks.some((a) => (a["workerId"] ?? a["userId"]) === subject)) {
        throw conflict(`${subject} has already acknowledged ${row.reference}.`);
      }
      acks.push({
        workerId: body.workerId ?? null,
        userId: body.workerId ? null : (body.userId ?? req.user!.id),
        acknowledgedAt: body.acknowledgedAt ?? new Date().toISOString(),
        method: body.method ?? "on_device_signature",
        recordedBy: req.user!.id,
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

  /** Timecard states that represent hours actually worked and stood behind. */
  const COUNTED_TIMECARD_STATUSES = ["submitted", "approved", "revised", "locked", "exported"];

  app.get("/projects/:projectId/safety/statistics", { preHandler: readGate }, async (req) => {
    const q = statisticsQuery.parse(req.query);
    await sweepSafety(req.companyId!, req.projectId!, req.user!.id);
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
      reportable: {
        reportableCount: incidents.filter((i) => asBool(i.isReportable)).length,
        notifiedCount: incidents.filter((i) => i.regulatorNotifiedAt != null).length,
        awaitingNotification: incidents.filter(
          (i) => asBool(i.isReportable) && i.regulatorNotifiedAt == null,
        ).length,
        needsHumanReview: incidents.filter((i) => storedDetermination(i)?.needsHumanReview === true)
          .length,
      },
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
    await sweepSafety(companyId, projectId, req.user!.id);
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

    return {
      projectId,
      asOf,
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
};
