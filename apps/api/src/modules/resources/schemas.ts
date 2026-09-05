/**
 * Request schemas for the resource module. Zod v4; a ZodError becomes a 400
 * automatically. Every bound is deliberate — `pageSize` caps at 500 upstream,
 * date windows cap at ten years, and hours cap at a plausible week rather
 * than at Number.MAX_SAFE_INTEGER, because a typo that allocates 1e9 hours to
 * one week silently destroys every chart it lands on.
 */
import { z } from "zod";
import {
  FORECAST_CONFIDENCES,
  HOURS_FORECAST_METHODS,
  PRODUCTIVITY_SCOPES,
  RESOURCE_ASSIGNMENT_STATUSES,
  RESOURCE_AVAILABILITY_SOURCES,
  RESOURCE_DEMAND_SOURCES,
  RESOURCE_KINDS,
  RESOURCE_PLAN_KINDS,
  RESOURCE_PLAN_STATUSES,
  RESOURCE_TYPE_STATUSES,
  SKILL_CATEGORIES,
  SKILL_LEVELS,
  WORKER_SKILL_STATUSES,
} from "@constructos/shared";
import { pageQuerySchema } from "../../lib/pagination.js";

export const idSchema = z.string().min(1).max(64);
export const detailSchema = z.record(z.string(), z.unknown());
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a real calendar date");

/** One week of one trade. 24 × 7 × 500 people is already absurd. */
const weekHoursSchema = z.number().min(0).max(100_000);

/* ================================================================== */
/* Resource types                                                      */
/* ================================================================== */

export const resourceTypeCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  kind: z.enum(RESOURCE_KINDS).optional(),
  trade: z.string().max(200).nullable().optional(),
  equipmentCategory: z.string().max(200).nullable().optional(),
  unit: z.string().max(50).optional(),
  standardHoursPerDay: z.number().min(0).max(24).nullable().optional(),
  workingDaysPerWeek: z.number().min(0).max(7).nullable().optional(),
  defaultHourlyCost: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  requiredSkillIds: z.array(idSchema).max(50).optional(),
  mapsToTrade: z.string().max(200).nullable().optional(),
  /** null keeps the type in the company library */
  projectId: idSchema.nullable().optional(),
  status: z.enum(RESOURCE_TYPE_STATUSES).optional(),
  detail: detailSchema.optional(),
});

export const resourceTypePatchSchema = resourceTypeCreateSchema.omit({ code: true }).partial();

export const resourceTypeListQuery = pageQuerySchema.extend({
  kind: z.enum(RESOURCE_KINDS).optional(),
  status: z.enum(RESOURCE_TYPE_STATUSES).optional(),
  projectId: idSchema.optional(),
  q: z.string().max(200).optional(),
});

/* ================================================================== */
/* Plans, demand and availability                                      */
/* ================================================================== */

export const planCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  planKind: z.enum(RESOURCE_PLAN_KINDS).optional(),
  scheduleId: idSchema.nullable().optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
  supersedesPlanId: idSchema.nullable().optional(),
  detail: detailSchema.optional(),
});

/** `status` is absent on purpose: activation and archiving are distinct acts
 *  with their own routes, and a generic PATCH must never move a lifecycle. */
export const planPatchSchema = planCreateSchema.omit({ supersedesPlanId: true }).partial();

export const planListQuery = pageQuerySchema.extend({
  status: z.enum(RESOURCE_PLAN_STATUSES).optional(),
  planKind: z.enum(RESOURCE_PLAN_KINDS).optional(),
});

export const deriveSchema = z.object({
  scheduleId: idSchema.nullable().optional(),
  /** spread only the hours still to spend, using remaining units / % complete */
  remainingOnly: z.boolean().optional(),
  /** replace every derived row on the plan; manual rows are kept */
  replaceDerived: z.boolean().optional(),
  /** map a schedule resource name (lower-cased) to a resource type id */
  typeMap: z.record(z.string(), idSchema).optional(),
  /** the type activities with no resource lines are attributed to */
  defaultResourceTypeId: idSchema.nullable().optional(),
  /** keep one row per activity rather than one per (type, week) */
  perActivity: z.boolean().optional(),
});

export const demandCreateSchema = z.object({
  resourceTypeId: idSchema,
  weekStart: isoDateSchema,
  demandHours: weekHoursSchema,
  headcount: z.number().min(0).max(100_000).nullable().optional(),
  sourceTaskId: idSchema.nullable().optional(),
  basis: z.string().max(4000).nullable().optional(),
  locationId: idSchema.nullable().optional(),
  crewId: idSchema.nullable().optional(),
  detail: detailSchema.optional(),
});

export const demandPatchSchema = demandCreateSchema
  .omit({ resourceTypeId: true, weekStart: true })
  .partial();

export const demandListQuery = pageQuerySchema.extend({
  resourceTypeId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  source: z.enum(RESOURCE_DEMAND_SOURCES).optional(),
});

export const availabilityUpsertSchema = z.object({
  resourceTypeId: idSchema,
  weekStart: isoDateSchema,
  availableHours: weekHoursSchema,
  availableHeadcount: z.number().min(0).max(100_000).nullable().optional(),
  source: z.enum(RESOURCE_AVAILABILITY_SOURCES).optional(),
  vendorId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  detail: detailSchema.optional(),
});

/** Bulk supply entry: a planner fills a term in one go, not week by week. */
export const availabilityBulkSchema = z.object({
  resourceTypeId: idSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  availableHours: weekHoursSchema,
  availableHeadcount: z.number().min(0).max(100_000).nullable().optional(),
  source: z.enum(RESOURCE_AVAILABILITY_SOURCES).optional(),
  vendorId: idSchema.nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

export const availabilityListQuery = pageQuerySchema.extend({
  resourceTypeId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const histogramQuery = z.object({
  planId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  resourceTypeId: idSchema.optional(),
  kind: z.enum(RESOURCE_KINDS).optional(),
  includeLevelling: z.enum(["true", "false"]).optional(),
});

/* ================================================================== */
/* Assignments                                                         */
/* ================================================================== */

export const assignmentCreateSchema = z.object({
  crewId: idSchema.nullable().optional(),
  workerId: idSchema.nullable().optional(),
  equipmentId: idSchema.nullable().optional(),
  resourceTypeId: idSchema.nullable().optional(),
  scheduleTaskId: idSchema.nullable().optional(),
  locationId: idSchema.nullable().optional(),
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  shift: z.string().max(50).optional(),
  hoursPerDay: z.number().min(0).max(24).nullable().optional(),
  allocationPercent: z.number().min(1).max(100).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  detail: detailSchema.optional(),
});

export const assignmentPatchSchema = assignmentCreateSchema
  .omit({ crewId: true, workerId: true, equipmentId: true })
  .partial();

export const assignmentListQuery = pageQuerySchema.extend({
  status: z.enum(RESOURCE_ASSIGNMENT_STATUSES).optional(),
  subjectKind: z.enum(["crew", "worker", "equipment"]).optional(),
  crewId: idSchema.optional(),
  workerId: idSchema.optional(),
  equipmentId: idSchema.optional(),
  scheduleTaskId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const assignmentCancelSchema = z.object({
  reason: z.string().min(1).max(4000),
});

export const assignmentTransitionSchema = z.object({
  note: z.string().max(4000).nullable().optional(),
});

export const calendarQuery = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  subjectKind: z.enum(["crew", "worker", "equipment"]).optional(),
});

/* ================================================================== */
/* Productivity, forecasting, measured mile                            */
/* ================================================================== */

export const productivityQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  resourceTypeId: idSchema.optional(),
  crewId: idSchema.optional(),
});

export const snapshotCreateSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  /** also write one row per week of the window, for the trend */
  includeWeeks: z.boolean().optional(),
  scopes: z.array(z.enum(PRODUCTIVITY_SCOPES)).max(4).optional(),
});

export const snapshotListQuery = pageQuerySchema.extend({
  scope: z.enum(PRODUCTIVITY_SCOPES).optional(),
  scopeId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const forecastQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  method: z.enum(HOURS_FORECAST_METHODS).optional(),
  resourceTypeId: idSchema.optional(),
});

export const forecastCreateSchema = z.object({
  method: z.enum(HOURS_FORECAST_METHODS).optional(),
  resourceTypeId: idSchema.nullable().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  manualForecastHours: z.number().min(0).max(10_000_000).nullable().optional(),
  confidence: z.enum(FORECAST_CONFIDENCES).nullable().optional(),
  basis: z.string().max(10_000).nullable().optional(),
});

export const measuredMileQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  minWeeks: z.coerce.number().int().min(2).max(52).optional(),
  resourceTypeId: idSchema.optional(),
  crewId: idSchema.optional(),
});

export const utilisationQuery = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  subjectKind: z.enum(["crew", "worker", "equipment"]).optional(),
});

/* ================================================================== */
/* Skills                                                              */
/* ================================================================== */

export const skillCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  category: z.enum(SKILL_CATEGORIES).optional(),
  trade: z.string().max(200).nullable().optional(),
  issuingBody: z.string().max(200).nullable().optional(),
  validityMonths: z.number().int().min(1).max(600).nullable().optional(),
  requiresEvidence: z.boolean().optional(),
  isMandatory: z.boolean().optional(),
  status: z.enum(RESOURCE_TYPE_STATUSES).optional(),
  detail: detailSchema.optional(),
});

export const skillPatchSchema = skillCreateSchema.omit({ code: true }).partial();

export const skillListQuery = pageQuerySchema.extend({
  category: z.enum(SKILL_CATEGORIES).optional(),
  status: z.enum(RESOURCE_TYPE_STATUSES).optional(),
  q: z.string().max(200).optional(),
});

export const workerSkillUpsertSchema = z.object({
  workerId: idSchema,
  skillId: idSchema,
  level: z.enum(SKILL_LEVELS).optional(),
  certificateRef: z.string().max(200).nullable().optional(),
  issuingBody: z.string().max(200).nullable().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  evidenceFileIds: z.array(idSchema).max(20).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  detail: detailSchema.optional(),
});

export const workerSkillPatchSchema = workerSkillUpsertSchema
  .omit({ workerId: true, skillId: true })
  .partial();

/** Verification is a separate act from the claim, so it has its own route
 *  and its own body — a generic PATCH may not set `status`. */
export const workerSkillVerifySchema = z.object({
  decision: z.enum(["verify", "reject", "revoke"]),
  reason: z.string().max(4000).nullable().optional(),
});

export const matrixQuery = z.object({
  category: z.enum(SKILL_CATEGORIES).optional(),
  trade: z.string().max(200).optional(),
  warnDays: z.coerce.number().int().min(1).max(365).optional(),
  onlyGaps: z.enum(["true", "false"]).optional(),
});

export const workerSkillListQuery = pageQuerySchema.extend({
  workerId: idSchema.optional(),
  skillId: idSchema.optional(),
  status: z.enum(WORKER_SKILL_STATUSES).optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(365).optional(),
});

export const skillGapQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const sweepRunSchema = z.object({
  job: z
    .enum([
      "resources.plan-coverage",
      "resources.assignment-conflicts",
      "resources.certification-expiry",
      "resources.productivity",
    ])
    .optional(),
});
