import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assuranceGrants,
  bondCalls,
  bondFacilities,
  bonds,
  files,
  insuranceCertificates,
  insuranceClaims,
  insurancePolicies,
  insurancePremiums,
  insuranceRequirements,
  nonConformanceReports,
  obligations,
  projects,
  recordLinks,
  safetyIncidents,
  signals,
  vendors,
  workers,
} from "@constructos/db";
import {
  BOND_FACILITY_STATUSES,
  BOND_TYPES,
  INSURANCE_CLAIM_STATUSES,
  INSURANCE_PREMIUM_KINDS,
  INSURANCE_REQUIREMENT_STATUSES,
  POLICY_RENEWAL_STATUSES,
  POLICY_TYPES,
  type AssuranceRole,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isExpired } from "../../lib/time.js";
import { addDaysISO, isoDateSchema, todayISO } from "../field/dates.js";
import {
  bondCurrentExposure,
  bondsPastDemandDeadline,
  certificatesExpiringWithin,
  computeCoverGaps,
  computeExpiryReport,
  computeNotificationWindow,
  daysBetweenISO,
  derivePolicyStatus,
  expiredBonds,
  expiredCertificates,
  isCertificateInDate,
  isDemandOutOfTime,
  isNotificationLate,
  lapsedPolicies,
  policiesExpiringWithin,
  type BondLike,
  type CertificateLike,
  type PolicyLike,
  type VendorAtWork,
} from "./expiry.js";
import {
  buildRenewalPipeline,
  checkRequirement,
  computeExperience,
  computePeriodGaps,
  evaluateHold,
  facilityUtilisation,
  findUninsuredLosses,
  requiredTypesForProject,
  type ClaimLike,
  type HoldDecision,
  type LossEventLike,
  type RequirementLike,
} from "./programme.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import {
  companyScopeOf,
  companyToolGate,
  scopeAllows,
  scopeProjectsOrCompanyWide,
} from "../meetings/scope.js";

/* ------------------------------------------------------------------ */
/* Local vocabularies (not in shared enums — kept honest here)          */
/* ------------------------------------------------------------------ */

const LIMIT_BASES = ["per_occurrence", "in_the_aggregate"] as const;
const CERTIFICATE_STATUSES = ["active", "expired", "superseded", "withdrawn"] as const;
const VERIFICATION_METHODS = [
  "insurer_confirmation",
  "broker_confirmation",
  "document_review",
  "portal_check",
  "other",
] as const;
const BOND_CALL_OUTCOMES = [
  "pending",
  "paid",
  "partially_paid",
  "rejected",
  "withdrawn",
] as const;
const NOTIFICATION_METHODS = ["email", "letter", "portal", "broker", "telephone"] as const;

/** Every detector this module owns — the summary counts exactly these. */
const INSURANCE_DETECTORS = [
  "insurance_certificate_expired",
  "insurance_cover_gap",
  "bond_demand_deadline_passed",
  "policy_lapsed_during_works",
  "insurance_notification_missed",
  /* WP-MEET upgrade: the two the engine could compute but nothing called */
  "policy_period_gap",
  "uninsured_loss_candidate",
  "policy_renewal_overdue",
] as const;

/** Obligations created here all carry this prefix so they can be counted back. */
const OBLIGATION_PREFIX = "insurance";

/**
 * How far ahead of a claim's notification deadline the platform starts
 * warning. The deadline is normally a condition precedent to liability, so a
 * message that arrives after it is a record of the loss, not a warning.
 */
const CLAIM_WARN_DAYS = 14;

/** Project stages during which a lapse in cover actually bites. */
const WORKS_ONGOING_STAGES = ["course_of_construction", "warranty"];

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const insuredPartySchema = z.object({
  name: z.string().min(1).max(300),
  capacity: z.string().max(200).optional(),
  vendorId: z.string().max(64).nullable().optional(),
});

const conditionSchema = z.object({
  ref: z.string().min(1).max(60),
  text: z.string().min(1).max(8000),
  isConditionPrecedent: z.boolean().optional(),
});

const policyCreateSchema = z.object({
  policyType: z.enum(POLICY_TYPES),
  insurer: z.string().min(1).max(300),
  policyNumber: z.string().min(1).max(200),
  brokerVendorId: z.string().max(64).nullable().optional(),
  insuredParties: z.array(insuredPartySchema).max(200).optional(),
  limitOfIndemnity: z.number().nonnegative().nullable().optional(),
  limitBasis: z.enum(LIMIT_BASES).nullable().optional(),
  currency: z.string().length(3).optional(),
  deductible: z.number().nonnegative().nullable().optional(),
  deductibleBasis: z.string().max(200).nullable().optional(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  notificationDays: z.number().int().min(0).max(3650).nullable().optional(),
  territorialLimits: z.string().max(2000).nullable().optional(),
  conditions: z.array(conditionSchema).max(200).optional(),
  requiredByClause: z.string().max(200).nullable().optional(),
  contractId: z.string().max(64).nullable().optional(),
  documentId: z.string().max(64).nullable().optional(),
});

const policyPatchSchema = policyCreateSchema.partial();

const policyListQuery = pageQuerySchema.extend({
  policyType: z.enum(POLICY_TYPES).optional(),
  status: z.enum(["draft", "active", "expired", "lapsed", "cancelled"]).optional(),
});

const companyPolicyListQuery = policyListQuery.extend({
  projectId: z.string().max(64).optional(),
  /** company-level programme only (projectId is null) */
  companyLevelOnly: z.coerce.boolean().optional(),
});

const policyStatusSchema = z.object({
  status: z.enum(["active", "expired", "lapsed", "cancelled"]),
  reason: z.string().max(4000).optional(),
});

const POLICY_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "cancelled"],
  active: ["lapsed", "cancelled"],
  lapsed: ["active", "cancelled"],
  expired: [],
  cancelled: [],
};

const certificateCreateSchema = z.object({
  policyId: z.string().max(64).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  subjectName: z.string().min(1).max(300),
  policyType: z.enum(POLICY_TYPES),
  certificateNumber: z.string().max(200).nullable().optional(),
  insurer: z.string().max(300).nullable().optional(),
  limitOfIndemnity: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema,
});

const certificatePatchSchema = certificateCreateSchema.partial().extend({
  status: z.enum(CERTIFICATE_STATUSES).optional(),
});

const certificateListQuery = pageQuerySchema.extend({
  policyType: z.enum(POLICY_TYPES).optional(),
  status: z.enum(CERTIFICATE_STATUSES).optional(),
  vendorId: z.string().max(64).optional(),
  verified: z.enum(["true", "false"]).optional(),
});

const verifySchema = z.object({
  verificationMethod: z.enum(VERIFICATION_METHODS),
  reference: z.string().max(300).nullable().optional(),
  /*
   * `z.string().min(4)` accepted "abcd" and "2026-13-45", and the route then
   * called `new Date(...).toISOString()`, which throws RangeError and
   * surfaced as an unhandled 500 rather than a 400. A verification is an
   * assertion about WHEN somebody checked; a date that does not exist, or one
   * in the future, is not that.
   */
  verifiedAt: z
    .string()
    .min(4)
    .max(40)
    .refine((v) => !Number.isNaN(Date.parse(v)), "verifiedAt is not a parseable date")
    .refine(
      (v) => Date.parse(v) <= Date.now() + 60_000,
      "verifiedAt cannot be in the future — a verification is a record of something already done",
    )
    .optional(),
});

const reductionStepSchema = z.object({
  trigger: z.string().min(1).max(200),
  reducesToPercent: z.number().min(0).max(100),
  occurredAt: isoDateSchema.nullable().optional(),
});

const bondCreateSchema = z.object({
  bondType: z.enum(BOND_TYPES),
  guarantor: z.string().min(1).max(300),
  bondNumber: z.string().max(200).nullable().optional(),
  principalVendorId: z.string().max(64).nullable().optional(),
  beneficiary: z.string().max(300).nullable().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  percentOfContract: z.number().min(0).max(100).nullable().optional(),
  isOnDemand: z.boolean().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
  expiryAt: isoDateSchema.nullable().optional(),
  demandDeadline: isoDateSchema.nullable().optional(),
  reductionSchedule: z.array(reductionStepSchema).max(50).optional(),
  contractId: z.string().max(64).nullable().optional(),
  documentId: z.string().max(64).nullable().optional(),
});

const bondPatchSchema = bondCreateSchema.partial();

const bondListQuery = pageQuerySchema.extend({
  bondType: z.enum(BOND_TYPES).optional(),
  status: z.enum(["draft", "issued", "active", "called", "released", "expired"]).optional(),
});

const bondStatusSchema = z.object({
  status: z.enum(["draft", "issued", "active", "called", "released", "expired"]),
});

const bondCallSchema = z.object({
  calledAt: isoDateSchema.optional(),
  amount: z.number().positive(),
  reason: z.string().min(1).max(20000),
  evidenceRefs: z.record(z.string(), z.unknown()).optional(),
  outcome: z.enum(BOND_CALL_OUTCOMES).optional(),
});

const bondCallOutcomeSchema = z.object({
  outcome: z.enum(BOND_CALL_OUTCOMES),
  proceedsAmount: z.number().nonnegative().nullable().optional(),
  proceedsReceivedAt: isoDateSchema.nullable().optional(),
});

const bondReleaseSchema = z.object({
  releasedAt: isoDateSchema.optional(),
  reason: z.string().max(4000).optional(),
});

const bondReduceSchema = z.object({
  trigger: z.string().min(1).max(200),
  occurredAt: isoDateSchema.optional(),
});

const linkedRecordSchema = z.object({
  recordType: z.string().min(1).max(60),
  recordId: z.string().min(1).max(64),
  note: z.string().max(1000).optional(),
});

const claimCreateSchema = z.object({
  policyId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  incidentDate: isoDateSchema,
  awareDate: isoDateSchema,
  quantum: z.number().nonnegative().nullable().optional(),
  reserve: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  insurerRef: z.string().max(200).nullable().optional(),
  lossAdjuster: z.string().max(300).nullable().optional(),
  linkedRecords: z.array(linkedRecordSchema).max(200).optional(),
});

const claimPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  quantum: z.number().nonnegative().nullable().optional(),
  reserve: z.number().nonnegative().nullable().optional(),
  insurerRef: z.string().max(200).nullable().optional(),
  lossAdjuster: z.string().max(300).nullable().optional(),
  linkedRecords: z.array(linkedRecordSchema).max(200).optional(),
});

const claimListQuery = pageQuerySchema.extend({
  status: z.enum(INSURANCE_CLAIM_STATUSES).optional(),
  policyId: z.string().max(64).optional(),
  notified: z.enum(["true", "false"]).optional(),
});

const notifySchema = z.object({
  notifiedAt: isoDateSchema.optional(),
  method: z.enum(NOTIFICATION_METHODS).optional(),
  reference: z.string().max(300).nullable().optional(),
  insurerRef: z.string().max(200).nullable().optional(),
});

const claimStatusSchema = z.object({
  status: z.enum([
    "acknowledged",
    "under_assessment",
    "accepted",
    "repudiated",
    "settled",
    "withdrawn",
  ]),
  repudiationReason: z.string().min(1).max(20000).optional(),
  settledAmount: z.number().nonnegative().optional(),
  settledAt: isoDateSchema.optional(),
  insurerRef: z.string().max(200).optional(),
  lossAdjuster: z.string().max(300).optional(),
});

const CLAIM_TRANSITIONS: Record<string, string[]> = {
  notified: ["acknowledged", "withdrawn"],
  acknowledged: ["under_assessment", "withdrawn"],
  under_assessment: ["accepted", "repudiated", "withdrawn"],
  accepted: ["settled", "withdrawn"],
  repudiated: [],
  settled: [],
  withdrawn: [],
};

const windowQuery = z.object({
  days: z.coerce.number().int().min(1).max(730).default(30),
  requiredTypes: z.string().max(500).optional(),
});

/* ---- WP-MEET upgrade: facilities, requirements, premiums, renewal ---- */

const facilityCreateSchema = z.object({
  name: z.string().min(1).max(300),
  provider: z.string().min(1).max(300),
  providerVendorId: z.string().max(64).nullable().optional(),
  facilityReference: z.string().max(200).nullable().optional(),
  projectId: z.string().max(64).nullable().optional(),
  limitAmount: z.number().positive(),
  currency: z.string().length(3).optional(),
  permittedBondTypes: z.array(z.enum(BOND_TYPES)).max(20).optional(),
  commissionRatePct: z.number().min(0).max(100).nullable().optional(),
  collateralAmount: z.number().nonnegative().nullable().optional(),
  collateralNote: z.string().max(2000).nullable().optional(),
  effectiveFrom: isoDateSchema.nullable().optional(),
  effectiveTo: isoDateSchema.nullable().optional(),
  reviewDate: isoDateSchema.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

/* No `status` — /facilities/:id/status owns the transitions. */
const facilityPatchSchema = facilityCreateSchema.partial().omit({ projectId: true });

const facilityStatusSchema = z.object({
  status: z.enum(BOND_FACILITY_STATUSES),
  reason: z.string().max(4000).optional(),
});

const requirementCreateSchema = z.object({
  policyType: z.enum(POLICY_TYPES),
  /** a requirement with no clause is an opinion, so this is mandatory */
  requiredByClause: z.string().min(1).max(200),
  contractId: z.string().max(64).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  minimumLimit: z.number().nonnegative().nullable().optional(),
  limitBasis: z.enum(LIMIT_BASES).nullable().optional(),
  currency: z.string().length(3).optional(),
  maximumDeductible: z.number().nonnegative().nullable().optional(),
  waiverOfSubrogation: z.boolean().optional(),
  additionalInsuredRequired: z.boolean().optional(),
  maintainMonthsAfterCompletion: z.number().int().min(0).max(600).nullable().optional(),
  territorialLimits: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

/* No `status` — /requirements/:id/waive records WHO waived it and why. */
const requirementPatchSchema = requirementCreateSchema.partial();

const requirementWaiveSchema = z.object({
  reason: z.string().min(1).max(4000),
});

const requirementListQuery = pageQuerySchema.extend({
  policyType: z.enum(POLICY_TYPES).optional(),
  status: z.enum(INSURANCE_REQUIREMENT_STATUSES).optional(),
  vendorId: z.string().max(64).optional(),
  /**
   * Include the company-wide standards that also bind this project. An enum
   * rather than `z.coerce.boolean()`, which turns the string "false" into
   * `true` — a filter that silently means its opposite is worse than no
   * filter at all.
   */
  includeCompanyWide: z.enum(["true", "false"]).optional(),
});

const premiumCreateSchema = z.object({
  kind: z.enum(INSURANCE_PREMIUM_KINDS).optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  periodStart: isoDateSchema.nullable().optional(),
  periodEnd: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  paidAt: isoDateSchema.nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const renewalPatchSchema = z.object({
  renewalStatus: z.enum(POLICY_RENEWAL_STATUSES),
  renewalOwnerId: z.string().max(64).nullable().optional(),
  renewalTargetDate: isoDateSchema.nullable().optional(),
  renewalNotes: z.string().max(4000).nullable().optional(),
  /** the policy that renewed this one, once it exists */
  renewedByPolicyId: z.string().max(64).nullable().optional(),
});

const renewalQuery = z.object({
  horizonDays: z.coerce.number().int().min(1).max(730).default(120),
  leadTimeDays: z.coerce.number().int().min(0).max(365).default(30),
});

const holdQuery = z.object({
  vendorId: z.string().min(1).max(64),
  projectId: z.string().max(64).optional(),
  asOf: isoDateSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;

const pad = (n: number): string => String(n).padStart(4, "0");

function parseRequiredTypesParam(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const types = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = types.filter((t) => !(POLICY_TYPES as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw badRequest(`Unknown policy type(s) in requiredTypes: ${unknown.join(", ")}`);
  }
  return types.length > 0 ? types : null;
}

/* ================================================================== */
/* THE PAYMENT-HOLD HOOK — module-level, so other modules can call it  */
/* ================================================================== */

export interface InsuranceHoldQuery {
  companyId: string;
  /** null asks the company-wide question; a project narrows the requirements */
  projectId: string | null;
  vendorId: string;
  asOf?: string;
}

/**
 * SHOULD A PAYMENT TO THIS VENDOR BE HELD ON INSURANCE GROUNDS?
 *
 * Exported as a plain `(db, query)` function rather than only as an HTTP
 * route so WP-FIN2 can call it inside the SAME transaction that releases the
 * money. A compliance check that runs in a different transaction from the
 * payment is a check that can be true when it is read and false when the
 * money moves.
 *
 * It reads three things and decides nothing else: the recorded requirements
 * for this vendor on this scope, the certificates they have given, and the
 * principal-arranged policies that might discharge the requirement instead.
 * When NO requirement is recorded it returns `hold: false` with
 * `requirementsKnown: false` and a note saying in terms that this is not a
 * finding of compliance — a caller that treats "we asked nothing of them" as
 * "they satisfied it" has misread the answer, and the note is there so that
 * misreading has to be deliberate.
 */
export async function insuranceHoldDecision(
  db: Db,
  query: InsuranceHoldQuery,
): Promise<HoldDecision> {
  const asOf = query.asOf ?? todayISO();
  const requirementRows = await db
    .select()
    .from(insuranceRequirements)
    .where(eq(insuranceRequirements.companyId, query.companyId));
  const certRows = await db
    .select()
    .from(insuranceCertificates)
    .where(
      and(
        eq(insuranceCertificates.companyId, query.companyId),
        eq(insuranceCertificates.vendorId, query.vendorId),
      ),
    );
  const policyRows = await db
    .select()
    .from(insurancePolicies)
    .where(
      query.projectId
        ? and(
            eq(insurancePolicies.companyId, query.companyId),
            or(
              eq(insurancePolicies.projectId, query.projectId),
              isNull(insurancePolicies.projectId),
            ),
          )
        : eq(insurancePolicies.companyId, query.companyId),
    );
  return evaluateHold({
    vendorId: query.vendorId,
    projectId: query.projectId,
    requirements: requirementRows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      vendorId: r.vendorId,
      policyType: r.policyType,
      requiredByClause: r.requiredByClause,
      minimumLimit: r.minimumLimit,
      limitBasis: r.limitBasis,
      currency: r.currency,
      maximumDeductible: r.maximumDeductible,
      waiverOfSubrogation: r.waiverOfSubrogation,
      additionalInsuredRequired: r.additionalInsuredRequired,
      maintainMonthsAfterCompletion: r.maintainMonthsAfterCompletion,
      territorialLimits: r.territorialLimits,
      status: r.status,
    })),
    certificates: certRows,
    certificateLimits: new Map(
      certRows.map((c) => [c.id, { limit: c.limitOfIndemnity, currency: c.currency }] as const),
    ),
    policies: policyRows,
    asOf,
  });
}

/**
 * Domain P — insurance & bonding lifecycle (spec Vol II #771-797).
 *
 * The design rule for this module is that it builds NOTHING new. Every idea
 * here already exists on the platform and is bound to, not re-implemented:
 *
 *  - A policy's claim-notification period is an **Obligation** with a hard
 *    date — the identical machinery `modules/contracts` uses for contractual
 *    time bars (#783). Missing it is the insurance analogue of a time bar and
 *    reads like one, because in both cases the notice is a condition
 *    precedent to liability and lateness is usually fatal.
 *  - A certificate that expires while the works continue is a **Signal**,
 *    raised by an idempotent lazy sweep on list/detail reads (#780). Never a
 *    cron: the read is the trigger, and the `evidenceRefs.key` is what stops
 *    the same lapse being raised twice.
 *  - A certificate is **Evidence** about a policy **Assertion** (ADR 0004),
 *    so the actor who submits the evidence may not be the actor who verifies
 *    it; only an integrity reviewer may knowingly self-verify, and that
 *    override is ledgered.
 *  - A bond call is a ledgered event with evidence, refused outright once the
 *    demand deadline has passed (#794) — the only reason that date is tracked.
 */
export const insuranceModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("insurance", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("insurance", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("insurance", "admin")];
  /*
   * COMPANY-LEVEL GATES.
   *
   * `companyRead` (authenticate + requireCompany alone) used to guard
   * /insurance/policies, /insurance/expiring and /insurance/summary. Every
   * company member — `COMPANY_ROLES` includes `guest` — could therefore read
   * every project's policies, certificates, claim reserves and adjusters by
   * choosing the URL without a project in it, which is the module's whole
   * permission model bypassed by routing. `companyScopedRead` resolves the
   * tool the same way `requireTool` does and restricts every row to the
   * projects the caller actually holds `insurance` on.
   *
   * `companyWrite` used to admit `member`, so an ordinary user with no
   * insurance permission anywhere could create and activate a COMPANY-LEVEL
   * master policy — a record merged into every project's programme view that
   * drives cover-gap signals on all of them. Owner/admin only, as learning
   * already does.
   */
  const companyScopedRead = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "insurance", "read"),
  ];
  const companyWrite = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const scopeOf = (req: FastifyRequest) => companyScopeOf(req, "insurance");

  /* ---------------------------------------------------------------- */
  /* Fetchers                                                          */
  /* ---------------------------------------------------------------- */

  /** A policy visible from a project: its own, or the company-level programme. */
  async function fetchPolicyForProject(policyId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(insurancePolicies)
      .where(
        and(
          eq(insurancePolicies.id, policyId),
          eq(insurancePolicies.companyId, companyId),
          or(
            eq(insurancePolicies.projectId, projectId),
            isNull(insurancePolicies.projectId),
          ),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Policy not found");
    return rows[0];
  }

  /** A policy owned by this project (mutations never reach across scopes). */
  async function fetchProjectPolicy(policyId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(insurancePolicies)
      .where(
        and(
          eq(insurancePolicies.id, policyId),
          eq(insurancePolicies.companyId, companyId),
          eq(insurancePolicies.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Policy not found");
    return rows[0];
  }

  async function fetchCompanyPolicy(policyId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(insurancePolicies)
      .where(
        and(eq(insurancePolicies.id, policyId), eq(insurancePolicies.companyId, companyId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Policy not found");
    return rows[0];
  }

  async function fetchCertificate(certId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.id, certId),
          eq(insuranceCertificates.companyId, companyId),
          eq(insuranceCertificates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Certificate not found");
    return rows[0];
  }

  async function fetchBond(bondId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(bonds)
      .where(
        and(eq(bonds.id, bondId), eq(bonds.companyId, companyId), eq(bonds.projectId, projectId)),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Bond not found");
    return rows[0];
  }

  async function fetchClaim(claimId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(insuranceClaims)
      .where(
        and(
          eq(insuranceClaims.id, claimId),
          eq(insuranceClaims.companyId, companyId),
          eq(insuranceClaims.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Insurance claim not found");
    return rows[0];
  }

  /** Does the caller hold one of these assurance roles (ADR 0004 override)? */
  async function holdsAssuranceRole(
    req: FastifyRequest,
    roles: AssuranceRole[],
    projectId?: string | null,
  ): Promise<boolean> {
    const rows = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    // Instant comparison, not string comparison — see lib/time.ts: a grant
    // live until 23:00 read as expired at 10:00 on its own expiry day.
    const nowMs = Date.now();
    return rows.some(
      (g) =>
        roles.includes(g.role as AssuranceRole) &&
        !isExpired(g.expiresAt, nowMs) &&
        (!g.projectId || !projectId || g.projectId === projectId),
    );
  }

  async function assertVendor(vendorId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("vendorId is not a vendor in this company directory");
  }

  async function assertProject(projectId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.companyId, companyId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("projectId is not a live project in this company");
  }

  /* ---------------------------------------------------------------- */
  /* Scope loading — one shape for project and company sweeps          */
  /* ---------------------------------------------------------------- */

  interface Scope {
    policies: PolicyLike[];
    certificates: CertificateLike[];
    bonds: BondLike[];
  }

  async function loadScope(companyId: string, projectId: string | null): Promise<Scope> {
    // A project's insurance picture includes the company-level programme:
    // an OCIP/CCIP master policy (#779) is carried at company level and
    // covers every project under it.
    const policyRows = await app.db
      .select()
      .from(insurancePolicies)
      .where(
        projectId
          ? and(
              eq(insurancePolicies.companyId, companyId),
              or(
                eq(insurancePolicies.projectId, projectId),
                isNull(insurancePolicies.projectId),
              ),
            )
          : eq(insurancePolicies.companyId, companyId),
      );
    const certRows = await app.db
      .select()
      .from(insuranceCertificates)
      .where(
        projectId
          ? and(
              eq(insuranceCertificates.companyId, companyId),
              or(
                eq(insuranceCertificates.projectId, projectId),
                isNull(insuranceCertificates.projectId),
              ),
            )
          : eq(insuranceCertificates.companyId, companyId),
      );
    const bondRows = await app.db
      .select()
      .from(bonds)
      .where(
        projectId
          ? and(eq(bonds.companyId, companyId), eq(bonds.projectId, projectId))
          : eq(bonds.companyId, companyId),
      );
    return { policies: policyRows, certificates: certRows, bonds: bondRows };
  }

  /**
   * Vendors actually performing work — the population a cover gap is measured
   * against. Two independent traces, neither of them the insurance record
   * itself: workers on site attributed to the vendor (workforce layer), and
   * vendors whose performance is secured by a live bond.
   */
  async function loadVendorsAtWork(
    companyId: string,
    projectId: string | null,
    scopeBonds: readonly BondLike[],
  ): Promise<VendorAtWork[]> {
    const workerRows = await app.db
      .select({ vendorId: workers.vendorId, projectId: workers.projectId })
      .from(workers)
      .where(
        projectId
          ? and(
              eq(workers.companyId, companyId),
              eq(workers.projectId, projectId),
              eq(workers.status, "active"),
              isNotNull(workers.vendorId),
            )
          : and(
              eq(workers.companyId, companyId),
              eq(workers.status, "active"),
              isNotNull(workers.vendorId),
            ),
      );
    const found = new Map<string, { vendorId: string; projectId: string | null; source: VendorAtWork["source"] }>();
    for (const w of workerRows) {
      if (!w.vendorId) continue;
      found.set(`${w.projectId}:${w.vendorId}`, {
        vendorId: w.vendorId,
        projectId: w.projectId,
        source: "workers_on_site",
      });
    }
    for (const b of scopeBonds) {
      if (!b.principalVendorId) continue;
      if (b.status === "released" || b.status === "expired" || b.status === "draft") continue;
      const key = `${b.projectId}:${b.principalVendorId}`;
      if (!found.has(key)) {
        found.set(key, {
          vendorId: b.principalVendorId,
          projectId: b.projectId,
          source: "bond_principal",
        });
      }
    }
    if (found.size === 0) return [];
    const ids = [...new Set([...found.values()].map((v) => v.vendorId))];
    const vendorRows = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
    const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));
    return [...found.values()]
      .filter((v) => names.has(v.vendorId))
      .map((v) => ({
        vendorId: v.vendorId,
        vendorName: names.get(v.vendorId) ?? v.vendorId,
        projectId: v.projectId,
        source: v.source,
      }));
  }

  /** Every recorded cover requirement in a company, as the engine shape. */
  async function loadRequirements(companyId: string): Promise<RequirementLike[]> {
    const rows = await app.db
      .select()
      .from(insuranceRequirements)
      .where(eq(insuranceRequirements.companyId, companyId));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      vendorId: r.vendorId,
      policyType: r.policyType,
      requiredByClause: r.requiredByClause,
      minimumLimit: r.minimumLimit,
      limitBasis: r.limitBasis,
      currency: r.currency,
      maximumDeductible: r.maximumDeductible,
      waiverOfSubrogation: r.waiverOfSubrogation,
      additionalInsuredRequired: r.additionalInsuredRequired,
      maintainMonthsAfterCompletion: r.maintainMonthsAfterCompletion,
      territorialLimits: r.territorialLimits,
      status: r.status,
    }));
  }

  /**
   * Which policy types does ONE PROJECT actually require?
   *
   * The previous implementation unioned the policy types of every policy
   * anywhere in the company that carried a `requiredByClause`, and applied
   * that union to every project. A PI requirement recorded once on project A
   * therefore raised a high-severity, ledgered, permanently-idempotent
   * `insurance_cover_gap` signal against every vendor on project B, and those
   * signals were counted in project B's summary. A requirement belongs to a
   * scope: `insurance_requirements` rows for this project plus the
   * company-wide ones, and nothing else.
   *
   * The legacy inference (a policy carrying `requiredByClause`) is kept ONLY
   * as a fallback for a scope with no requirement rows at all, and only for
   * that scope's own policies — never a tenant-wide union.
   */
  async function requiredTypesFor(
    companyId: string,
    projectId: string | null,
    requirements?: readonly RequirementLike[],
  ): Promise<string[] | null> {
    const reqs = requirements ?? (await loadRequirements(companyId));
    if (projectId) {
      const types = requiredTypesForProject(reqs, projectId);
      if (types.length > 0) return types;
    } else {
      const types = [...new Set(reqs.filter((r) => r.status === "required").map((r) => r.policyType))].sort();
      if (types.length > 0) return types;
    }
    /* Fallback: policies in THIS scope that name the clause requiring them. */
    const rows = await app.db
      .select({ policyType: insurancePolicies.policyType })
      .from(insurancePolicies)
      .where(
        projectId
          ? and(
              eq(insurancePolicies.companyId, companyId),
              isNotNull(insurancePolicies.requiredByClause),
              or(
                eq(insurancePolicies.projectId, projectId),
                isNull(insurancePolicies.projectId),
              ),
            )
          : and(
              eq(insurancePolicies.companyId, companyId),
              isNotNull(insurancePolicies.requiredByClause),
            ),
      );
    const types = [...new Set(rows.map((r) => r.policyType))].sort();
    return types.length > 0 ? types : null;
  }

  /**
   * Signal keys already raised for a detector in this company.
   *
   * `candidateKeys` narrows the query to the keys actually being considered.
   * The previous version loaded EVERY signal row for the detector into a Set
   * on every list read — up to four detectors per page load — against a table
   * with no index on (company_id, detector), so the cost grew without bound
   * with the tenant's signal history. `signals` belongs to another package,
   * so the fix available here is to ask a bounded question.
   */
  async function alreadySignalled(
    companyId: string,
    detector: string,
    candidateKeys?: readonly string[],
  ): Promise<Set<string>> {
    if (candidateKeys && candidateKeys.length === 0) return new Set();
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.detector, detector),
          candidateKeys ? sql`${signals.evidenceRefs} ->> 'key' in ${candidateKeys}` : undefined,
        ),
      );
    const keys = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { key?: unknown } | null;
      if (typeof refs?.key === "string") keys.add(refs.key);
    }
    return keys;
  }

  /** Project stages, for deciding whether a lapse happened *during works*. */
  async function loadStages(companyId: string): Promise<Map<string, string>> {
    const rows = await app.db
      .select({ id: projects.id, stage: projects.stage })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    return new Map(rows.map((p) => [p.id, p.stage] as const));
  }

  /* ---------------------------------------------------------------- */
  /* THE EXPIRY SWEEP — a scheduled job, not a read side effect         */
  /*                                                                    */
  /* It used to run on EVERY insurance list and detail read. That was    */
  /* wrong twice over. A policy nobody opened never lapsed in the        */
  /* record — the expiry date does not wait for a browser tab — and the  */
  /* ledger attributed the resulting status flips, obligations and       */
  /* signals to whoever happened to open the page, including read-only   */
  /* members and assurance grantees who hold no write permission at all. */
  /* It now runs under the platform scheduler with a null (system)       */
  /* actor; reads are pure, and `POST /insurance/sweep` triggers a cycle */
  /* by hand for operators and tests.                                    */
  /*                                                                    */
  /* Seven detectors, each keyed in `evidenceRefs.key` so a repeated run  */
  /* never raises the same lapse twice:                                  */
  /*                                                                    */
  /*  - `policy_lapsed_during_works`    key = policyId                   */
  /*  - `insurance_certificate_expired` key = certificateId              */
  /*  - `bond_demand_deadline_passed`   key = bondId                     */
  /*  - `insurance_cover_gap`           key = project:vendor:policyType  */
  /*  - `policy_period_gap`             key = project:policyType:reqId   */
  /*  - `uninsured_loss_candidate`      key = recordType:recordId        */
  /*  - `policy_renewal_overdue`        key = policyId:periodEnd         */
  /*                                                                    */
  /* Status flips (policy → expired, certificate → expired, bond →       */
  /* expired) are a second, independent guard: a swept record leaves the */
  /* candidate set.                                                      */
  /* ---------------------------------------------------------------- */

  async function sweepInsurance(
    companyId: string,
    projectId: string | null,
    actorId: string | null,
  ): Promise<{ signals: number }> {
    const asOf = todayISO();
    const scope = await loadScope(companyId, projectId);
    const now = new Date().toISOString();
    let raised = 0;

    /* (1) policies whose period ended while they were still on risk */
    const lapsed = lapsedPolicies(scope.policies, asOf);
    if (lapsed.length > 0) {
      const seen = await alreadySignalled(companyId, "policy_lapsed_during_works");
      const stages = await loadStages(companyId);
      const anyWorksOngoing = [...stages.values()].some((s) => WORKS_ONGOING_STAGES.includes(s));
      for (const p of lapsed) {
        await app.db
          .update(insurancePolicies)
          .set({ status: "expired", updatedAt: now })
          .where(
            and(eq(insurancePolicies.id, p.policyId), eq(insurancePolicies.status, "active")),
          );
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "insurance_policy",
          objectId: p.policyId,
          payload: { from: "active", to: "expired", periodEnd: p.periodEnd, derived: true },
        });
        const worksOngoing = p.projectId
          ? WORKS_ONGOING_STAGES.includes(stages.get(p.projectId) ?? "")
          : anyWorksOngoing;
        // A policy that expires after the works finished is housekeeping. One
        // that expires while people are still on site is an uninsured works.
        if (!worksOngoing || seen.has(p.policyId)) continue;
        seen.add(p.policyId);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: p.projectId,
          detector: "policy_lapsed_during_works",
          severity: "critical",
          confidence: 1,
          title: `Policy lapsed while the works continue — ${p.policyType} ${p.number}`,
          explanation:
            `Policy ${p.number} (${p.policyType}, ${p.insurer}, policy no. ${p.policyNumber}) ran to ` +
            `${p.periodEnd} and has not been renewed or replaced, yet the works are still in progress. ` +
            `From ${p.periodEnd} the works are uninsured for this risk: a loss occurring now falls on the ` +
            `balance sheet, and where the cover is a contractual requirement the lapse is itself a breach ` +
            `that can found a determination. Renew, confirm replacement cover, or record the decision to ` +
            `carry the risk.`,
          evidenceRefs: {
            key: p.policyId,
            policyId: p.policyId,
            periodEnd: p.periodEnd,
            policyType: p.policyType,
          },
        });
      }
    }

    /* (2) certificates that expired while relied on */
    const staleCerts = expiredCertificates(scope.certificates, asOf);
    if (staleCerts.length > 0) {
      const seen = await alreadySignalled(companyId, "insurance_certificate_expired");
      for (const c of staleCerts) {
        await app.db
          .update(insuranceCertificates)
          .set({ status: "expired", updatedAt: now })
          .where(
            and(
              eq(insuranceCertificates.id, c.certificateId),
              eq(insuranceCertificates.status, "active"),
            ),
          );
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "insurance_certificate",
          objectId: c.certificateId,
          payload: { from: "active", to: "expired", validTo: c.validTo, derived: true },
        });
        if (seen.has(c.certificateId)) continue;
        seen.add(c.certificateId);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: c.projectId,
          detector: "insurance_certificate_expired",
          severity: "high",
          confidence: 1,
          title: `Certificate of insurance expired — ${c.subjectName} (${c.policyType})`,
          explanation:
            `The certificate evidencing ${c.policyType} cover for ${c.subjectName} was valid to ` +
            `${c.validTo} and has now expired${c.verified ? "" : " (and was never independently verified)"}. ` +
            `Evidence of cover is not cover, but its absence is the only thing you can see: until a ` +
            `replacement certificate is collected, this party is working with no demonstrable insurance ` +
            `and any indemnity given back to you is unsupported.`,
          evidenceRefs: {
            key: c.certificateId,
            certificateId: c.certificateId,
            vendorId: c.vendorId,
            policyType: c.policyType,
            validTo: c.validTo,
          },
        });
      }
    }

    /* (3) bonds past the last date a demand can be made */
    const pastDeadline = bondsPastDemandDeadline(scope.bonds, asOf);
    if (pastDeadline.length > 0) {
      const seen = await alreadySignalled(companyId, "bond_demand_deadline_passed");
      for (const b of pastDeadline) {
        if (seen.has(b.bondId)) continue;
        seen.add(b.bondId);
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: b.projectId,
          detector: "bond_demand_deadline_passed",
          severity: "high",
          confidence: 1,
          title: `Bond demand deadline passed — ${b.bondType} bond ${b.number}`,
          explanation:
            `The last date for making a demand under ${b.bondType} bond ${b.number} ` +
            `(${b.guarantor}, ${b.currency} ${b.currentAmount}) was ${b.demandDeadline}, which has passed. ` +
            `A demand made now will not be honoured however well founded it is: the security is spent. ` +
            `If a claim against the principal is live, the recovery must now be pursued against the ` +
            `principal directly, and the failure to demand in time should be recorded as a loss event.`,
          evidenceRefs: {
            key: b.bondId,
            bondId: b.bondId,
            demandDeadline: b.demandDeadline,
            amount: b.currentAmount,
            currency: b.currency,
          },
        });
      }
    }

    /* Bond expiry is a status flip, not a signal — the demand deadline above
       is the date that actually matters and is already reported. */
    for (const b of expiredBonds(scope.bonds, asOf)) {
      await app.db
        .update(bonds)
        .set({ status: "expired", updatedAt: now })
        .where(and(eq(bonds.id, b.bondId), inArray(bonds.status, ["issued", "active"])));
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "bond",
        objectId: b.bondId,
        payload: { from: b.status, to: "expired", expiryAt: b.expiryAt, derived: true },
      });
    }

    /*
     * (4) SUPPLY-CHAIN COVER GAPS, EVALUATED PER PROJECT.
     *
     * In company scope this used to compute one tenant-wide union of required
     * types and test every vendor on every project against it, so a PI
     * requirement recorded on project A raised a permanent cover-gap signal
     * for every vendor on project B. Each project is now evaluated against
     * ITS OWN requirement set (its own requirements plus the company-wide
     * ones), which is what a requirement actually means.
     */
    const requirements = await loadRequirements(companyId);
    const vendorsAll = await loadVendorsAtWork(companyId, projectId, scope.bonds);
    const projectBuckets = new Map<string | null, VendorAtWork[]>();
    for (const v of vendorsAll) {
      const list = projectBuckets.get(v.projectId) ?? [];
      list.push(v);
      projectBuckets.set(v.projectId, list);
    }
    for (const [bucketProjectId, bucketVendors] of projectBuckets) {
      const requiredTypes = await requiredTypesFor(companyId, bucketProjectId, requirements);
      if (!requiredTypes) continue;
      const gapResult = computeCoverGaps({
        certificates: scope.certificates,
        vendorsAtWork: bucketVendors,
        requiredPolicyTypes: requiredTypes,
        asOf,
      });
      if (gapResult.gaps.length > 0) {
        const seen = await alreadySignalled(
          companyId,
          "insurance_cover_gap",
          gapResult.gaps.map((g) => g.key),
        );
        for (const gap of gapResult.gaps) {
          if (seen.has(gap.key)) continue;
          seen.add(gap.key);
          raised += 1;
          const because =
            gap.reason === "no_certificate"
              ? "no certificate of that cover has ever been collected from them"
              : gap.reason === "expired"
                ? `their last certificate expired on ${gap.lastValidTo}`
                : `their certificate does not take effect until ${gap.lastValidTo}`;
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId,
            projectId: gap.projectId,
            detector: "insurance_cover_gap",
            severity: "high",
            confidence: 1,
            title: `Cover gap — ${gap.vendorName} has no ${gap.policyType} evidence`,
            explanation:
              `${gap.vendorName} is performing work (${gap.source === "workers_on_site" ? "workers recorded on site" : "principal under a live bond"}) ` +
              `and ${gap.policyType} cover is required on this scope, but ${because}. An uninsured link in ` +
              `the supply chain is not their exposure, it is yours: their liability to you is worth what ` +
              `their balance sheet is worth, and your own policy will look to the indemnity you were ` +
              `supposed to have taken. Collect and verify a certificate before further work.`,
            evidenceRefs: {
              key: gap.key,
              vendorId: gap.vendorId,
              policyType: gap.policyType,
              reason: gap.reason,
              lastValidTo: gap.lastValidTo,
            },
          });
        }
      }
    }

    /*
     * (5) POLICY PERIOD vs THE WORKS (#777).
     *
     * `policyPeriodGap` has existed in expiry.ts since the module was written
     * and nothing ever called it. Cover that starts a month after the works
     * or ends a month before them is not cover for those days, and those are
     * exactly the days a loss will find.
     */
    const projectRows = await app.db
      .select({
        id: projects.id,
        name: projects.name,
        startDate: projects.startDate,
        finishDate: projects.finishDate,
        stage: projects.stage,
      })
      .from(projects)
      .where(
        projectId
          ? and(eq(projects.companyId, companyId), eq(projects.id, projectId))
          : and(eq(projects.companyId, companyId), isNull(projects.deletedAt)),
      );
    for (const project of projectRows) {
      const gapOut = computePeriodGaps({
        projectId: project.id,
        worksStart: project.startDate,
        worksEnd: project.finishDate,
        requirements: requirements.filter(
          (r) => r.projectId === null || r.projectId === project.id,
        ),
        policies: scope.policies,
      });
      if (gapOut.gaps.length === 0) continue;
      const seen = await alreadySignalled(
        companyId,
        "policy_period_gap",
        gapOut.gaps.map((g) => g.key),
      );
      for (const gap of gapOut.gaps) {
        if (seen.has(gap.key)) continue;
        seen.add(gap.key);
        raised += 1;
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: project.id,
          detector: "policy_period_gap",
          severity: "high",
          confidence: 1,
          title: `Policy period does not cover the works — ${gap.policyType} on ${project.name}`,
          explanation: gap.detail,
          evidenceRefs: {
            key: gap.key,
            policyType: gap.policyType,
            requirementId: gap.requirementId,
            requiredByClause: gap.requiredByClause,
            policyId: gap.policyId,
            uncoveredAtStartDays: gap.uncoveredAtStartDays,
            uncoveredAtEndDays: gap.uncoveredAtEndDays,
            worksStart: gap.worksStart,
            worksEnd: gap.worksEnd,
          },
        });
      }
    }

    /*
     * (6) UNINSURED LOSS CANDIDATES (#787).
     *
     * Recorded losses — safety incidents with an estimated cost, NCRs with a
     * cost impact — matched to the class of cover that would respond. The
     * expensive case is the last one: an INSURED loss for which nobody raised
     * a claim, because notification periods are conditions precedent and an
     * insured loss nobody notified becomes an uninsured loss on the day the
     * period expires. Nothing in an incident register notices that.
     */
    const losses = await loadLossEvents(companyId, projectId);
    if (losses.length > 0) {
      const claimedRecordIds = await loadClaimedRecordIds(companyId, projectId);
      const deductibleById = new Map<string, number | null>(
        scope.policies.map((p) => [p.id, (p as { deductible?: number | null }).deductible ?? null]),
      );
      const claimRows = await app.db
        .select()
        .from(insuranceClaims)
        .where(
          projectId
            ? and(eq(insuranceClaims.companyId, companyId), eq(insuranceClaims.projectId, projectId))
            : eq(insuranceClaims.companyId, companyId),
        );
      const findings = findUninsuredLosses({
        losses,
        policies: scope.policies,
        deductibleById,
        claims: claimRows.map(toClaimLike),
        claimedRecordIds,
      });
      if (findings.length > 0) {
        const seen = await alreadySignalled(
          companyId,
          "uninsured_loss_candidate",
          findings.map((f) => f.key),
        );
        for (const f of findings) {
          if (seen.has(f.key)) continue;
          seen.add(f.key);
          raised += 1;
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId,
            projectId: f.projectId,
            detector: "uninsured_loss_candidate",
            severity: f.reason === "no_claim_raised" ? "high" : "medium",
            confidence: f.lossAmount === null ? 0.6 : 0.9,
            title:
              f.reason === "no_claim_raised"
                ? `Insured loss with no claim raised — ${f.title}`
                : `Uninsured loss — ${f.title}`,
            explanation: f.detail,
            evidenceRefs: {
              key: f.key,
              recordType: f.recordType,
              recordId: f.recordId,
              reason: f.reason,
              policyType: f.policyType,
              policyId: f.candidatePolicyId,
              lossAmount: f.lossAmount,
              currency: f.currency,
              deductible: f.deductible,
              occurredAt: f.occurredAt,
            },
          });
        }
      }
    }

    /*
     * (7) RENEWALS THAT ARE ALREADY LATE (#775).
     *
     * Measured against a lead time rather than the expiry date, because a
     * renewal started the week before expiry has already failed even though
     * nothing has expired yet. Keyed on policy + period end so a renewed
     * policy's next period raises its own signal rather than being suppressed
     * by the last one.
     */
    const renewals = buildRenewalPipeline({
      policies: scope.policies.map((p) => ({
        ...p,
        renewalStatus: (p as { renewalStatus?: string }).renewalStatus ?? "not_started",
        renewalOwnerId: (p as { renewalOwnerId?: string | null }).renewalOwnerId ?? null,
        renewalTargetDate: (p as { renewalTargetDate?: string | null }).renewalTargetDate ?? null,
        renewedByPolicyId: (p as { renewedByPolicyId?: string | null }).renewedByPolicyId ?? null,
      })),
      asOf,
    }).filter((r) => r.urgency === "critical" || r.urgency === "overdue");
    if (renewals.length > 0) {
      const keys = renewals.map((r) => `${r.policyId}:${r.periodEnd}`);
      const seen = await alreadySignalled(companyId, "policy_renewal_overdue", keys);
      for (const r of renewals) {
        const key = `${r.policyId}:${r.periodEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raised += 1;
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId: r.projectId,
          detector: "policy_renewal_overdue",
          severity: r.urgency === "overdue" ? "critical" : "high",
          confidence: 1,
          title: `Renewal behind — ${r.policyType} ${r.number} (${r.insurer})`,
          explanation: r.reason,
          evidenceRefs: {
            key,
            policyId: r.policyId,
            periodEnd: r.periodEnd,
            renewalStatus: r.renewalStatus,
            daysToExpiry: r.daysToExpiry,
            behindByDays: r.behindByDays,
          },
        });
      }
    }

    return { signals: raised };
  }

  /* ---------------------------------------------------------------- */
  /* Loss events — the population #787 is measured against              */
  /* ---------------------------------------------------------------- */

  /**
   * Which class of cover would respond to a safety incident.
   *
   * Deliberately coarse and deliberately incomplete: an incident type this
   * map does not know returns null and is skipped rather than guessed at.
   * A wrong mapping produces a confident false signal, which is worse than
   * silence.
   */
  const INCIDENT_POLICY_TYPE: Record<string, string> = {
    /* people on your books: employers' liability */
    injury: "employers_liability",
    occupational_illness: "employers_liability",
    /* damage to the works or to your own plant */
    property_damage: "contractors_all_risks",
    fire: "contractors_all_risks",
    structural_failure: "contractors_all_risks",
    /* harm to people or property outside the site boundary */
    public_impact: "third_party_liability",
    road_traffic: "third_party_liability",
    utility_strike: "third_party_liability",
    /* pollution */
    environmental: "environmental_impairment",
    /*
     * DELIBERATELY ABSENT: near_miss (no loss by definition),
     * dangerous_occurrence and security. A wrong mapping produces a confident
     * false signal, which is worse than silence, so an unmapped type is
     * skipped rather than guessed at.
     */
  };

  /** NCR categories that a professional-indemnity policy would answer for. */
  const NCR_POLICY_TYPE: Record<string, string> = {
    design: "professional_indemnity",
    workmanship: "contractors_all_risks",
    material: "contractors_all_risks",
  };

  async function loadLossEvents(
    companyId: string,
    projectId: string | null,
  ): Promise<LossEventLike[]> {
    const projectCurrency = new Map<string, string>(
      (
        await app.db
          .select({ id: projects.id, currency: projects.currency })
          .from(projects)
          .where(eq(projects.companyId, companyId))
      ).map((p) => [p.id, p.currency] as const),
    );
    const incidents = await app.db
      .select({
        id: safetyIncidents.id,
        projectId: safetyIncidents.projectId,
        reference: safetyIncidents.reference,
        title: safetyIncidents.title,
        incidentType: safetyIncidents.incidentType,
        occurredAt: safetyIncidents.occurredAt,
        estimatedCost: safetyIncidents.estimatedCost,
      })
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.companyId, companyId),
          projectId ? eq(safetyIncidents.projectId, projectId) : undefined,
          gt(safetyIncidents.estimatedCost, 0),
        ),
      )
      .limit(500);
    const ncrs = await app.db
      .select({
        id: nonConformanceReports.id,
        projectId: nonConformanceReports.projectId,
        reference: nonConformanceReports.reference,
        title: nonConformanceReports.title,
        category: nonConformanceReports.category,
        detectedAt: nonConformanceReports.detectedAt,
        createdAt: nonConformanceReports.createdAt,
        costImpact: nonConformanceReports.costImpact,
        currency: nonConformanceReports.currency,
      })
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.companyId, companyId),
          projectId ? eq(nonConformanceReports.projectId, projectId) : undefined,
          gt(nonConformanceReports.costImpact, 0),
        ),
      )
      .limit(500);
    const out: LossEventLike[] = [];
    for (const i of incidents) {
      const policyType = INCIDENT_POLICY_TYPE[i.incidentType] ?? null;
      if (!policyType) continue;
      out.push({
        recordType: "safety_incident",
        recordId: i.id,
        projectId: i.projectId,
        title: `${i.reference} — ${i.title}`,
        occurredAt: i.occurredAt.slice(0, 10),
        lossAmount: i.estimatedCost,
        currency: projectCurrency.get(i.projectId) ?? "GBP",
        policyType,
      });
    }
    for (const n of ncrs) {
      const policyType = NCR_POLICY_TYPE[n.category] ?? null;
      if (!policyType) continue;
      const when = (n.detectedAt ?? n.createdAt).slice(0, 10);
      out.push({
        recordType: "ncr",
        recordId: n.id,
        projectId: n.projectId,
        title: `${n.reference} — ${n.title}`,
        occurredAt: when,
        lossAmount: n.costImpact,
        currency: n.currency,
        policyType,
      });
    }
    return out;
  }

  /** Records already tied to a claim, through record links or linkedRecords. */
  async function loadClaimedRecordIds(
    companyId: string,
    projectId: string | null,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const linkRows = await app.db
      .select({ toId: recordLinks.toId, fromId: recordLinks.fromId })
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, companyId),
          projectId ? eq(recordLinks.projectId, projectId) : undefined,
          or(
            eq(recordLinks.fromType, "insurance_claim"),
            eq(recordLinks.toType, "insurance_claim"),
          ),
        ),
      );
    for (const l of linkRows) {
      out.add(l.toId);
      out.add(l.fromId);
    }
    const claimRows = await app.db
      .select({ linkedRecords: insuranceClaims.linkedRecords })
      .from(insuranceClaims)
      .where(
        projectId
          ? and(eq(insuranceClaims.companyId, companyId), eq(insuranceClaims.projectId, projectId))
          : eq(insuranceClaims.companyId, companyId),
      );
    for (const c of claimRows) {
      const links = c.linkedRecords;
      if (!Array.isArray(links)) continue;
      for (const l of links) {
        if (l && typeof l === "object" && "recordId" in l) {
          const id = (l as { recordId?: unknown }).recordId;
          if (typeof id === "string") out.add(id);
        }
      }
    }
    return out;
  }

  const toClaimLike = (c: typeof insuranceClaims.$inferSelect): ClaimLike => ({
    id: c.id,
    policyId: c.policyId,
    projectId: c.projectId,
    status: c.status,
    quantum: c.quantum,
    reserve: c.reserve,
    settledAmount: c.settledAmount,
    currency: c.currency,
    incidentDate: c.incidentDate,
  });

  /* ---------------------------------------------------------------- */
  /* Presentation helpers                                              */
  /* ---------------------------------------------------------------- */

  function decoratePolicy(p: typeof insurancePolicies.$inferSelect, asOf: string) {
    return {
      ...p,
      derivedStatus: derivePolicyStatus(p, asOf),
      daysToExpiry: daysBetweenISO(asOf, p.periodEnd),
      inForce: derivePolicyStatus(p, asOf) === "active",
    };
  }

  function decorateCertificate(c: typeof insuranceCertificates.$inferSelect, asOf: string) {
    return {
      ...c,
      daysToExpiry: daysBetweenISO(asOf, c.validTo),
      inDate: isCertificateInDate(c, asOf),
      verified: c.verifiedAt !== null,
    };
  }

  function decorateBond(b: typeof bonds.$inferSelect, asOf: string) {
    const exposure = bondCurrentExposure(b, asOf);
    return {
      ...b,
      exposure,
      daysToDemandDeadline: b.demandDeadline ? daysBetweenISO(asOf, b.demandDeadline) : null,
      daysToExpiry: b.expiryAt ? daysBetweenISO(asOf, b.expiryAt) : null,
      demandStillPossible:
        b.demandDeadline === null
          ? null
          : daysBetweenISO(asOf, b.demandDeadline) >= 0 &&
            ["issued", "active"].includes(b.status),
    };
  }

  function decorateClaim(c: typeof insuranceClaims.$inferSelect, asOf: string) {
    return {
      ...c,
      daysToNotificationDue: c.notificationDueAt ? daysBetweenISO(asOf, c.notificationDueAt) : null,
      notificationOutstanding: c.notifiedAt === null,
      notifiedLate:
        c.notifiedAt !== null && isNotificationLate(c.notificationDueAt, c.notifiedAt),
    };
  }

  /* ================================================================ */
  /* POLICIES (#771-776, #779)                                         */
  /* ================================================================ */

  function assertPeriod(periodStart: string, periodEnd: string): void {
    if (daysBetweenISO(periodStart, periodEnd) < 0) {
      throw badRequest(
        `Policy period is inverted: periodEnd ${periodEnd} falls before periodStart ${periodStart}`,
      );
    }
  }

  async function insertPolicy(
    companyId: string,
    projectId: string | null,
    userId: string,
    body: z.infer<typeof policyCreateSchema>,
  ) {
    assertPeriod(body.periodStart, body.periodEnd);
    if (body.brokerVendorId) await assertVendor(body.brokerVendorId, companyId);
    // Company-level policies (#779, an owner- or contractor-controlled
    // programme) number on a company-wide counter; project policies number
    // per project. The counter table is keyed on an opaque scope id, so the
    // company id is a legitimate scope.
    const seq = await nextRecordNumber(
      app.db,
      projectId ?? companyId,
      projectId ? "insurance_policy" : "insurance_policy_company",
    );
    const number = projectId ? `POL-${pad(seq)}` : `CPOL-${pad(seq)}`;
    const id = newId("pol");
    await app.db.insert(insurancePolicies).values({
      id,
      companyId,
      projectId,
      number,
      policyType: body.policyType,
      insurer: body.insurer,
      brokerVendorId: body.brokerVendorId ?? null,
      policyNumber: body.policyNumber,
      insuredParties: body.insuredParties ?? [],
      limitOfIndemnity: body.limitOfIndemnity ?? null,
      limitBasis: body.limitBasis ?? null,
      currency: body.currency ?? "GBP",
      deductible: body.deductible ?? null,
      deductibleBasis: body.deductibleBasis ?? null,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      notificationDays: body.notificationDays ?? null,
      territorialLimits: body.territorialLimits ?? null,
      conditions: body.conditions ?? [],
      requiredByClause: body.requiredByClause ?? null,
      contractId: body.contractId ?? null,
      status: "draft",
      documentId: body.documentId ?? null,
      createdBy: userId,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: userId,
      action: "create",
      objectType: "insurance_policy",
      objectId: id,
      payload: {
        number,
        projectId,
        policyType: body.policyType,
        insurer: body.insurer,
        policyNumber: body.policyNumber,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        limitOfIndemnity: body.limitOfIndemnity ?? null,
        notificationDays: body.notificationDays ?? null,
        requiredByClause: body.requiredByClause ?? null,
      },
      storePayload: true,
    });
    return id;
  }

  app.post(
    "/projects/:projectId/insurance/policies",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = policyCreateSchema.parse(req.body);
      const id = await insertPolicy(req.companyId!, req.projectId!, req.user!.id, body);
      const created = await fetchProjectPolicy(id, req.companyId!, req.projectId!);
      return reply.status(201).send(decoratePolicy(created, todayISO()));
    },
  );

  app.get("/projects/:projectId/insurance/policies", { preHandler: readGate }, async (req) => {
    const q = policyListQuery.parse(req.query);
    const asOf = todayISO();
    const clauses = [
      eq(insurancePolicies.companyId, req.companyId!),
      or(
        eq(insurancePolicies.projectId, req.projectId!),
        isNull(insurancePolicies.projectId),
      )!,
    ];
    if (q.policyType) clauses.push(eq(insurancePolicies.policyType, q.policyType));
    if (q.status) clauses.push(eq(insurancePolicies.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(insurancePolicies).where(where);
    const rows = await app.db
      .select()
      .from(insurancePolicies)
      .where(where)
      .orderBy(desc(insurancePolicies.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((p) => decoratePolicy(p, asOf)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/insurance/policies/:policyId",
    { preHandler: readGate },
    async (req) => {
      const { policyId } = req.params as { policyId: string };
      const policy = await fetchPolicyForProject(policyId, req.companyId!, req.projectId!);
      const asOf = todayISO();
      const certs = await app.db
        .select()
        .from(insuranceCertificates)
        .where(
          and(
            eq(insuranceCertificates.companyId, req.companyId!),
            eq(insuranceCertificates.policyId, policyId),
          ),
        );
      /*
       * Scoped to THIS project. For a company-level (OCIP) policy visible
       * from every project, the unscoped query returned claims raised on
       * other projects — titles, reserves, adjusters — to a member of this
       * one. A claim belongs to the project it was raised on.
       */
      const claimRows = await app.db
        .select()
        .from(insuranceClaims)
        .where(
          and(
            eq(insuranceClaims.companyId, req.companyId!),
            eq(insuranceClaims.policyId, policyId),
            eq(insuranceClaims.projectId, req.projectId!),
          ),
        );
      return {
        ...decoratePolicy(policy, asOf),
        certificates: certs.map((c) => decorateCertificate(c, asOf)),
        claims: claimRows.map((c) => decorateClaim(c, asOf)),
        claimsScope: "this_project_only" as const,
        notificationRule:
          policy.notificationDays === null
            ? {
                notificationDays: null,
                note:
                  "This policy records no claim-notification period, so claims raised against it " +
                  "carry no computed deadline and no obligation. Read the wording and set " +
                  "notificationDays — an unnotified condition precedent is the commonest way a " +
                  "good claim is lost.",
              }
            : {
                notificationDays: policy.notificationDays,
                note:
                  `Claims must be notified within ${policy.notificationDays} day(s) of the insured ` +
                  `becoming aware. The deadline is materialised as an obligation on every claim.`,
              },
      };
    },
  );

  app.patch(
    "/projects/:projectId/insurance/policies/:policyId",
    { preHandler: standardGate },
    async (req) => {
      const { policyId } = req.params as { policyId: string };
      const body = policyPatchSchema.parse(req.body);
      const policy = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      if (policy.status === "cancelled" || policy.status === "expired") {
        throw badRequest(
          `A ${policy.status} policy cannot be edited — record an endorsement or a replacement policy instead`,
        );
      }
      assertPeriod(body.periodStart ?? policy.periodStart, body.periodEnd ?? policy.periodEnd);
      if (body.brokerVendorId) await assertVendor(body.brokerVendorId, req.companyId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      await app.db
        .update(insurancePolicies)
        .set(set)
        .where(eq(insurancePolicies.id, policyId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "insurance_policy",
        objectId: policyId,
        payload: { changed: Object.keys(body) },
      });
      const updated = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      return decoratePolicy(updated, todayISO());
    },
  );

  /**
   * Status transitions. Two rules carry weight:
   *  - `expired` is DERIVED from periodEnd by the sweep and may never be
   *    typed by hand; letting a user type it would make the register lie
   *    about when cover actually ended.
   *  - a policy cannot be activated on a period that has already run out.
   */
  async function transitionPolicy(
    policy: typeof insurancePolicies.$inferSelect,
    body: z.infer<typeof policyStatusSchema>,
    companyId: string,
    userId: string,
  ) {
    if (body.status === "expired") {
      throw badRequest(
        `Expiry is derived from the policy period, not typed: policy ${policy.number} runs to ` +
          `${policy.periodEnd} and will be marked expired automatically once that date passes. ` +
          `To end cover early, use 'cancelled'; to record a lapse for non-payment, use 'lapsed'.`,
      );
    }
    const allowed = POLICY_TRANSITIONS[policy.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw badRequest(`Cannot transition a ${policy.status} policy to ${body.status}`);
    }
    if (body.status === "active") {
      if (!policy.periodStart || !policy.periodEnd) {
        throw badRequest(
          "A policy cannot be made active without both period dates — cover with no period is not cover",
        );
      }
      assertPeriod(policy.periodStart, policy.periodEnd);
      if (daysBetweenISO(todayISO(), policy.periodEnd) < 0) {
        throw badRequest(
          `A policy cannot be made active on a period that has already ended (periodEnd ${policy.periodEnd}). ` +
            `Record the renewal as a new policy with its own period.`,
        );
      }
    }
    await app.db
      .update(insurancePolicies)
      .set({ status: body.status, updatedAt: new Date().toISOString() })
      .where(eq(insurancePolicies.id, policy.id));
    await appendLedger(app.db, {
      companyId,
      actorId: userId,
      action: "state_change",
      objectType: "insurance_policy",
      objectId: policy.id,
      payload: {
        from: policy.status,
        to: body.status,
        reason: body.reason ?? null,
        periodStart: policy.periodStart,
        periodEnd: policy.periodEnd,
      },
      storePayload: true,
    });
  }

  app.post(
    "/projects/:projectId/insurance/policies/:policyId/status",
    { preHandler: standardGate },
    async (req) => {
      const { policyId } = req.params as { policyId: string };
      const body = policyStatusSchema.parse(req.body);
      const policy = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      await transitionPolicy(policy, body, req.companyId!, req.user!.id);
      const updated = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      return decoratePolicy(updated, todayISO());
    },
  );

  app.delete(
    "/projects/:projectId/insurance/policies/:policyId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { policyId } = req.params as { policyId: string };
      const policy = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      if (policy.status !== "draft") {
        throw badRequest(
          `Only a draft policy can be deleted; a ${policy.status} policy is part of the record — cancel it instead`,
        );
      }
      const [claimRow] = await app.db
        .select({ n: count() })
        .from(insuranceClaims)
        .where(eq(insuranceClaims.policyId, policyId));
      if (Number(claimRow?.n ?? 0) > 0) {
        throw badRequest("This policy has claims recorded against it and cannot be deleted");
      }
      await app.db.delete(insurancePolicies).where(eq(insurancePolicies.id, policyId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "insurance_policy",
        objectId: policyId,
        payload: { number: policy.number, policyType: policy.policyType },
      });
      return reply.status(204).send();
    },
  );

  /* ---- Company-level programme view (#771, #779) ------------------ */

  app.get("/insurance/policies", { preHandler: companyScopedRead }, async (req) => {
    const q = companyPolicyListQuery.parse(req.query);
    const scope = scopeOf(req);
    if (q.projectId && !scopeAllows(scope, q.projectId)) {
      throw forbidden(
        "You do not hold insurance on that project. This route sits above the projects and " +
          "returns only the ones you hold the tool on.",
      );
    }
    const asOf = todayISO();
    const clauses = [eq(insurancePolicies.companyId, req.companyId!)];
    const visible = scopeProjectsOrCompanyWide(scope, insurancePolicies.projectId);
    if (visible) clauses.push(visible);
    if (q.projectId) clauses.push(eq(insurancePolicies.projectId, q.projectId));
    if (q.companyLevelOnly) clauses.push(isNull(insurancePolicies.projectId));
    if (q.policyType) clauses.push(eq(insurancePolicies.policyType, q.policyType));
    if (q.status) clauses.push(eq(insurancePolicies.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(insurancePolicies).where(where);
    const rows = await app.db
      .select()
      .from(insurancePolicies)
      .where(where)
      .orderBy(desc(insurancePolicies.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const projectRows = await app.db
      .select({ id: projects.id, name: projects.name, stage: projects.stage })
      .from(projects)
      .where(eq(projects.companyId, req.companyId!));
    const projectNames = new Map(projectRows.map((p) => [p.id, p.name] as const));
    return paginate(
      rows.map((p) => ({
        ...decoratePolicy(p, asOf),
        projectName: p.projectId ? (projectNames.get(p.projectId) ?? null) : null,
        scope: p.projectId ? ("project" as const) : ("company" as const),
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/insurance/policies", { preHandler: companyWrite }, async (req, reply) => {
    const body = policyCreateSchema.parse(req.body);
    const id = await insertPolicy(req.companyId!, null, req.user!.id, body);
    const created = await fetchCompanyPolicy(id, req.companyId!);
    return reply.status(201).send(decoratePolicy(created, todayISO()));
  });

  app.get("/insurance/policies/:policyId", { preHandler: companyScopedRead }, async (req) => {
    const { policyId } = req.params as { policyId: string };
    const policy = await fetchCompanyPolicy(policyId, req.companyId!);
    if (!scopeAllows(scopeOf(req), policy.projectId)) {
      throw notFound("Policy not found");
    }
    const asOf = todayISO();
    const certs = await app.db
      .select()
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.companyId, req.companyId!),
          eq(insuranceCertificates.policyId, policyId),
        ),
      );
    return {
      ...decoratePolicy(policy, asOf),
      scope: policy.projectId ? ("project" as const) : ("company" as const),
      certificates: certs.map((c) => decorateCertificate(c, asOf)),
    };
  });

  app.patch("/insurance/policies/:policyId", { preHandler: companyWrite }, async (req) => {
    const { policyId } = req.params as { policyId: string };
    const body = policyPatchSchema.parse(req.body);
    const policy = await fetchCompanyPolicy(policyId, req.companyId!);
    if (policy.projectId) {
      throw badRequest(
        "This is a project policy — edit it through /projects/:projectId/insurance/policies/:policyId " +
          "so the project's tool permissions apply",
      );
    }
    if (policy.status === "cancelled" || policy.status === "expired") {
      throw badRequest(`A ${policy.status} policy cannot be edited`);
    }
    assertPeriod(body.periodStart ?? policy.periodStart, body.periodEnd ?? policy.periodEnd);
    /* The project PATCH has always checked this; the company one did not, so
       a broker id belonging to another tenant could be stored here. */
    if (body.brokerVendorId) await assertVendor(body.brokerVendorId, req.companyId!);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) set[k] = v;
    }
    await app.db.update(insurancePolicies).set(set).where(eq(insurancePolicies.id, policyId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "insurance_policy",
      objectId: policyId,
      payload: { changed: Object.keys(body), scope: "company", actorRole: req.companyRole ?? null },
    });
    const updated = await fetchCompanyPolicy(policyId, req.companyId!);
    return decoratePolicy(updated, todayISO());
  });

  app.post("/insurance/policies/:policyId/status", { preHandler: companyWrite }, async (req) => {
    const { policyId } = req.params as { policyId: string };
    const body = policyStatusSchema.parse(req.body);
    const policy = await fetchCompanyPolicy(policyId, req.companyId!);
    if (policy.projectId) {
      throw badRequest(
        "This is a project policy — transition it through /projects/:projectId/insurance/policies/:policyId/status",
      );
    }
    await transitionPolicy(policy, body, req.companyId!, req.user!.id);
    const updated = await fetchCompanyPolicy(policyId, req.companyId!);
    return decoratePolicy(updated, todayISO());
  });

  /* ================================================================ */
  /* CERTIFICATES (#780-781) — Evidence, per ADR 0004                  */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/insurance/certificates",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = certificateCreateSchema.parse(req.body);
      if (daysBetweenISO(body.validFrom, body.validTo) < 0) {
        throw badRequest(
          `Certificate validity is inverted: validTo ${body.validTo} falls before validFrom ${body.validFrom}`,
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      let policy: typeof insurancePolicies.$inferSelect | null = null;
      if (body.policyId) {
        policy = await fetchPolicyForProject(body.policyId, req.companyId!, req.projectId!);
        if (policy.policyType !== body.policyType) {
          throw badRequest(
            `Certificate policyType (${body.policyType}) does not match the linked policy's type (${policy.policyType})`,
          );
        }
      }
      const id = newId("cert");
      await app.db.insert(insuranceCertificates).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        policyId: body.policyId ?? null,
        vendorId: body.vendorId ?? null,
        subjectName: body.subjectName,
        policyType: body.policyType,
        certificateNumber: body.certificateNumber ?? null,
        insurer: body.insurer ?? null,
        limitOfIndemnity: body.limitOfIndemnity ?? null,
        currency: body.currency ?? "GBP",
        validFrom: body.validFrom,
        validTo: body.validTo,
        status: "active",
        createdBy: req.user!.id,
      });
      // ADR 0004 §3 — recorded always: a certificate submitted by the same
      // actor who authored the policy it evidences is self-certified. It is
      // not blocked here (collection is administrative), but the ledger
      // carries the fact and verification by that actor is refused below.
      const selfEvidenced = policy !== null && policy.createdBy === req.user!.id;
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "insurance_certificate",
        objectId: id,
        payload: {
          subjectName: body.subjectName,
          policyType: body.policyType,
          vendorId: body.vendorId ?? null,
          policyId: body.policyId ?? null,
          validFrom: body.validFrom,
          validTo: body.validTo,
          selfEvidenced,
        },
        storePayload: true,
      });
      const created = await fetchCertificate(id, req.companyId!, req.projectId!);
      return reply
        .status(201)
        .send({ ...decorateCertificate(created, todayISO()), selfEvidenced });
    },
  );

  app.get("/projects/:projectId/insurance/certificates", { preHandler: readGate }, async (req) => {
    const q = certificateListQuery.parse(req.query);
    const asOf = todayISO();
    const clauses = [
      eq(insuranceCertificates.companyId, req.companyId!),
      eq(insuranceCertificates.projectId, req.projectId!),
    ];
    if (q.policyType) clauses.push(eq(insuranceCertificates.policyType, q.policyType));
    if (q.status) clauses.push(eq(insuranceCertificates.status, q.status));
    if (q.vendorId) clauses.push(eq(insuranceCertificates.vendorId, q.vendorId));
    if (q.verified === "true") clauses.push(isNotNull(insuranceCertificates.verifiedAt));
    if (q.verified === "false") clauses.push(isNull(insuranceCertificates.verifiedAt));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(insuranceCertificates)
      .where(where);
    const rows = await app.db
      .select()
      .from(insuranceCertificates)
      .where(where)
      .orderBy(desc(insuranceCertificates.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((c) => decorateCertificate(c, asOf)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/insurance/certificates/:certId",
    { preHandler: readGate },
    async (req) => {
      const { certId } = req.params as { certId: string };
      await fetchCertificate(certId, req.companyId!, req.projectId!);
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      return decorateCertificate(cert, todayISO());
    },
  );

  app.patch(
    "/projects/:projectId/insurance/certificates/:certId",
    { preHandler: standardGate },
    async (req) => {
      const { certId } = req.params as { certId: string };
      const body = certificatePatchSchema.parse(req.body);
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      const validFrom = body.validFrom ?? cert.validFrom;
      const validTo = body.validTo ?? cert.validTo;
      if (daysBetweenISO(validFrom, validTo) < 0) {
        throw badRequest(
          `Certificate validity is inverted: validTo ${validTo} falls before validFrom ${validFrom}`,
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      // Editing the substance of verified evidence silently would defeat the
      // point of verifying it: the verification is dropped and must be redone.
      const substantive = ["validFrom", "validTo", "limitOfIndemnity", "insurer", "policyType"];
      const touchedSubstance = Object.keys(body).some((k) => substantive.includes(k));
      if (touchedSubstance && cert.verifiedAt) {
        set["verifiedAt"] = null;
        set["verifiedBy"] = null;
        set["verificationMethod"] = null;
      }
      await app.db
        .update(insuranceCertificates)
        .set(set)
        .where(eq(insuranceCertificates.id, certId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "insurance_certificate",
        objectId: certId,
        payload: {
          changed: Object.keys(body),
          verificationCleared: touchedSubstance && cert.verifiedAt !== null,
        },
      });
      const updated = await fetchCertificate(certId, req.companyId!, req.projectId!);
      return decorateCertificate(updated, todayISO());
    },
  );

  /**
   * Verification (#781). ADR 0004, enforced at the join: the actor who
   * submitted the certificate is the party evidencing the cover and may not
   * also be the party attesting that it is genuine. Only an integrity
   * reviewer may knowingly self-verify, and the override is ledgered.
   */
  app.post(
    "/projects/:projectId/insurance/certificates/:certId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { certId } = req.params as { certId: string };
      const body = verifySchema.parse(req.body);
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      if (cert.status === "withdrawn" || cert.status === "superseded") {
        throw badRequest(`A ${cert.status} certificate cannot be verified`);
      }
      let override = false;
      if (cert.createdBy === req.user!.id) {
        override = await holdsAssuranceRole(req, ["integrity_reviewer"], req.projectId);
        if (!override) {
          throw forbidden(
            "certificate not independent of its submitter — the actor who submitted this " +
              "certificate cannot also verify it (ADR 0004). Have another user verify it, or " +
              "an integrity reviewer do so knowingly.",
          );
        }
      }
      const verifiedAt = body.verifiedAt
        ? new Date(body.verifiedAt).toISOString()
        : new Date().toISOString();
      await app.db
        .update(insuranceCertificates)
        .set({
          verifiedBy: req.user!.id,
          verifiedAt,
          verificationMethod: body.verificationMethod,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(insuranceCertificates.id, certId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "insurance_certificate",
        objectId: certId,
        payload: {
          verified: true,
          verificationMethod: body.verificationMethod,
          reference: body.reference ?? null,
          submittedBy: cert.createdBy,
          selfVerifiedUnderOverride: override,
        },
        storePayload: true,
      });
      const updated = await fetchCertificate(certId, req.companyId!, req.projectId!);
      return {
        ...decorateCertificate(updated, todayISO()),
        independentVerification: !override,
        verificationStrength:
          body.verificationMethod === "insurer_confirmation"
            ? "confirmed with the insurer — the strongest evidence available"
            : body.verificationMethod === "broker_confirmation"
              ? "confirmed with the placing broker — strong, but one step removed from the insurer"
              : "documentary only — a certificate is a summary written by the insured's broker, not the policy",
      };
    },
  );

  /** Upload the certificate itself, content-addressed with its sha256 (#772). */
  app.post(
    "/projects/:projectId/insurance/certificates/:certId/file",
    { preHandler: standardGate },
    async (req, reply) => {
      const { certId } = req.params as { certId: string };
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart file upload");
      const buf = await mp.toBuffer();
      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const fileId = newId("fil");
      const now = new Date().toISOString();
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId: null,
        name: mp.filename || `certificate-${cert.id}`,
        contentType: mp.mimetype || "application/octet-stream",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        version: 1,
        isPrivate: 0,
        uploadedBy: req.user!.id,
        createdAt: now,
        updatedAt: now,
      });
      await app.db
        .update(insuranceCertificates)
        .set({ fileId, fileSha256: saved.sha256, updatedAt: now })
        .where(eq(insuranceCertificates.id, certId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "insurance_certificate",
        objectId: certId,
        payload: {
          fileId,
          sha256: saved.sha256,
          sizeBytes: saved.sizeBytes,
          name: mp.filename ?? null,
        },
        storePayload: true,
      });
      const updated = await fetchCertificate(certId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...decorateCertificate(updated, todayISO()),
        file: {
          id: fileId,
          name: mp.filename || `certificate-${cert.id}`,
          contentType: mp.mimetype || "application/octet-stream",
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
        },
      });
    },
  );

  app.get(
    "/projects/:projectId/insurance/certificates/:certId/file",
    { preHandler: readGate },
    async (req, reply) => {
      const { certId } = req.params as { certId: string };
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      if (!cert.fileId) throw notFound("No certificate file has been uploaded");
      const rows = await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, cert.fileId), eq(files.companyId, req.companyId!)))
        .limit(1);
      const f = rows[0];
      if (!f) throw notFound("Certificate file not found");
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "insurance_certificate",
        objectId: certId,
        payload: { action: "download", fileId: f.id, sha256: f.sha256 },
      });
      return reply
        .header("content-type", f.contentType)
        .header("x-content-sha256", f.sha256)
        .header(
          "content-disposition",
          `attachment; filename="${encodeURIComponent(f.name).replace(/['()]/g, "")}"`,
        )
        .send(app.storage.readStream(f.storageKey));
    },
  );

  app.delete(
    "/projects/:projectId/insurance/certificates/:certId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { certId } = req.params as { certId: string };
      const cert = await fetchCertificate(certId, req.companyId!, req.projectId!);
      await app.db.delete(insuranceCertificates).where(eq(insuranceCertificates.id, certId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "insurance_certificate",
        objectId: certId,
        payload: { subjectName: cert.subjectName, policyType: cert.policyType },
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* BONDS (#790-794)                                                  */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/insurance/bonds",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = bondCreateSchema.parse(req.body);
      if (body.principalVendorId) await assertVendor(body.principalVendorId, req.companyId!);
      if (body.expiryAt && body.demandDeadline) {
        if (daysBetweenISO(body.demandDeadline, body.expiryAt) < 0) {
          throw badRequest(
            `demandDeadline ${body.demandDeadline} falls after expiryAt ${body.expiryAt} — a demand ` +
              `cannot be made after the bond has expired`,
          );
        }
      }
      const seq = await nextRecordNumber(app.db, req.projectId!, "bond");
      const number = `BND-${pad(seq)}`;
      const id = newId("bnd");
      await app.db.insert(bonds).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId: body.contractId ?? null,
        number,
        bondType: body.bondType,
        guarantor: body.guarantor,
        bondNumber: body.bondNumber ?? null,
        principalVendorId: body.principalVendorId ?? null,
        beneficiary: body.beneficiary ?? null,
        amount: body.amount,
        currency: body.currency ?? "GBP",
        percentOfContract: body.percentOfContract ?? null,
        isOnDemand: body.isOnDemand ? 1 : 0,
        issuedAt: body.issuedAt ?? null,
        expiryAt: body.expiryAt ?? null,
        demandDeadline: body.demandDeadline ?? null,
        reductionSchedule: (body.reductionSchedule ?? []).map((s) => ({
          trigger: s.trigger,
          reducesToPercent: s.reducesToPercent,
          occurredAt: s.occurredAt ?? null,
        })),
        status: "draft",
        documentId: body.documentId ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "bond",
        objectId: id,
        payload: {
          number,
          bondType: body.bondType,
          guarantor: body.guarantor,
          amount: body.amount,
          currency: body.currency ?? "GBP",
          isOnDemand: body.isOnDemand ?? false,
          expiryAt: body.expiryAt ?? null,
          demandDeadline: body.demandDeadline ?? null,
        },
        storePayload: true,
      });
      const created = await fetchBond(id, req.companyId!, req.projectId!);
      return reply.status(201).send(decorateBond(created, todayISO()));
    },
  );

  app.get("/projects/:projectId/insurance/bonds", { preHandler: readGate }, async (req) => {
    const q = bondListQuery.parse(req.query);
    const asOf = todayISO();
    const clauses = [eq(bonds.companyId, req.companyId!), eq(bonds.projectId, req.projectId!)];
    if (q.bondType) clauses.push(eq(bonds.bondType, q.bondType));
    if (q.status) clauses.push(eq(bonds.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(bonds).where(where);
    const rows = await app.db
      .select()
      .from(bonds)
      .where(where)
      .orderBy(desc(bonds.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((b) => decorateBond(b, asOf)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/insurance/bonds/:bondId",
    { preHandler: readGate },
    async (req) => {
      const { bondId } = req.params as { bondId: string };
      await fetchBond(bondId, req.companyId!, req.projectId!);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      const calls = await app.db
        .select()
        .from(bondCalls)
        .where(eq(bondCalls.bondId, bondId))
        .orderBy(desc(bondCalls.calledAt));
      return { ...decorateBond(bond, todayISO()), calls };
    },
  );

  app.patch(
    "/projects/:projectId/insurance/bonds/:bondId",
    { preHandler: standardGate },
    async (req) => {
      const { bondId } = req.params as { bondId: string };
      const body = bondPatchSchema.parse(req.body);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (["released", "expired", "called"].includes(bond.status)) {
        throw badRequest(`A ${bond.status} bond cannot be edited`);
      }
      if (body.principalVendorId) await assertVendor(body.principalVendorId, req.companyId!);
      const expiryAt = body.expiryAt ?? bond.expiryAt;
      const demandDeadline = body.demandDeadline ?? bond.demandDeadline;
      if (expiryAt && demandDeadline && daysBetweenISO(demandDeadline, expiryAt) < 0) {
        throw badRequest(
          `demandDeadline ${demandDeadline} falls after expiryAt ${expiryAt} — a demand cannot be made after expiry`,
        );
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (k === "isOnDemand") {
          set[k] = v ? 1 : 0;
          continue;
        }
        if (k === "reductionSchedule" && Array.isArray(v)) {
          set[k] = v.map((s) => {
            const step = s as z.infer<typeof reductionStepSchema>;
            return {
              trigger: step.trigger,
              reducesToPercent: step.reducesToPercent,
              occurredAt: step.occurredAt ?? null,
            };
          });
          continue;
        }
        set[k] = v;
      }
      await app.db.update(bonds).set(set).where(eq(bonds.id, bondId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "bond",
        objectId: bondId,
        payload: { changed: Object.keys(body) },
      });
      const updated = await fetchBond(bondId, req.companyId!, req.projectId!);
      return decorateBond(updated, todayISO());
    },
  );

  app.post(
    "/projects/:projectId/insurance/bonds/:bondId/status",
    { preHandler: standardGate },
    async (req) => {
      const { bondId } = req.params as { bondId: string };
      const body = bondStatusSchema.parse(req.body);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (body.status === "expired") {
        throw badRequest(
          `Bond expiry is derived from expiryAt (${bond.expiryAt ?? "not recorded"}), not typed`,
        );
      }
      if (body.status === "called") {
        throw badRequest(
          "Record a demand through POST /bonds/:bondId/call so the deadline check and evidence are captured",
        );
      }
      if (body.status === "released") {
        throw badRequest("Release a bond through POST /bonds/:bondId/release");
      }
      const allowed: Record<string, string[]> = {
        draft: ["issued"],
        issued: ["active"],
        active: [],
        called: [],
        released: [],
        expired: [],
      };
      if (!(allowed[bond.status] ?? []).includes(body.status)) {
        throw badRequest(`Cannot transition a ${bond.status} bond to ${body.status}`);
      }
      if (body.status === "issued" && !bond.issuedAt) {
        throw badRequest("issuedAt must be recorded before a bond can be marked issued");
      }
      await app.db
        .update(bonds)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(bonds.id, bondId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "bond",
        objectId: bondId,
        payload: { from: bond.status, to: body.status },
      });
      const updated = await fetchBond(bondId, req.companyId!, req.projectId!);
      return decorateBond(updated, todayISO());
    },
  );

  /** Milestone reduction (#793): step the bond down when its trigger occurs. */
  app.post(
    "/projects/:projectId/insurance/bonds/:bondId/reduce",
    { preHandler: standardGate },
    async (req) => {
      const { bondId } = req.params as { bondId: string };
      const body = bondReduceSchema.parse(req.body);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (!["issued", "active"].includes(bond.status)) {
        throw badRequest(`A ${bond.status} bond cannot be reduced`);
      }
      const schedule = (Array.isArray(bond.reductionSchedule) ? bond.reductionSchedule : []).map(
        (s) => ({ ...(s as Record<string, unknown>) }),
      );
      const target = schedule.find((s) => s["trigger"] === body.trigger);
      if (!target) {
        throw badRequest(
          `No reduction step with trigger "${body.trigger}" exists on bond ${bond.number}. ` +
            `Recorded triggers: ${schedule.map((s) => String(s["trigger"])).join(", ") || "none"}`,
        );
      }
      if (target["occurredAt"]) {
        throw badRequest(
          `Reduction "${body.trigger}" was already recorded as occurring on ${String(target["occurredAt"])}`,
        );
      }
      target["occurredAt"] = body.occurredAt ?? todayISO();
      await app.db
        .update(bonds)
        .set({ reductionSchedule: schedule, updatedAt: new Date().toISOString() })
        .where(eq(bonds.id, bondId));
      const updated = await fetchBond(bondId, req.companyId!, req.projectId!);
      const exposure = bondCurrentExposure(updated, todayISO());
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "bond",
        objectId: bondId,
        payload: {
          reductionTrigger: body.trigger,
          occurredAt: target["occurredAt"],
          appliedPercent: exposure.appliedPercent,
          currentAmount: exposure.currentAmount,
        },
        storePayload: true,
      });
      return decorateBond(updated, todayISO());
    },
  );

  /**
   * Record a demand under the bond (#794). The deadline check is the reason
   * `demandDeadline` is tracked at all: a demand recorded after it is refused
   * outright and the error names the date, because a late demand under an
   * on-demand bond is simply not paid however good the underlying claim is.
   */
  app.post(
    "/projects/:projectId/insurance/bonds/:bondId/call",
    { preHandler: standardGate },
    async (req, reply) => {
      const { bondId } = req.params as { bondId: string };
      const body = bondCallSchema.parse(req.body);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (!["issued", "active"].includes(bond.status)) {
        throw badRequest(
          `A demand cannot be made under a ${bond.status} bond — only an issued or active bond is callable`,
        );
      }
      const calledAt = body.calledAt ?? todayISO();
      const timeliness = isDemandOutOfTime(bond, calledAt);
      if (timeliness.outOfTime) {
        throw badRequest(
          `Demand out of time: the last date for making a demand under bond ${bond.number} ` +
            `(${bond.bondType}, ${bond.guarantor}) was ${timeliness.deadline}, and this demand is ` +
            `dated ${calledAt} — ${timeliness.daysLate} day(s) late. A demand made after the deadline ` +
            `will not be honoured, so it is not recorded as if it were live. Pursue the principal ` +
            `directly and record the missed deadline as a loss.`,
          { demandDeadline: timeliness.deadline, calledAt, daysLate: timeliness.daysLate },
        );
      }
      const exposure = bondCurrentExposure(bond, calledAt);
      if (body.amount > exposure.currentAmount) {
        throw badRequest(
          `Demand of ${bond.currency} ${body.amount} exceeds the bond's current value of ` +
            `${bond.currency} ${exposure.currentAmount} (face ${bond.currency} ${exposure.faceAmount}, ` +
            `reduced to ${exposure.appliedPercent}% by ${exposure.applied.length} triggered reduction(s))`,
        );
      }
      const refs = body.evidenceRefs ?? {};
      if (bond.isOnDemand === 0 && Object.keys(refs).length === 0) {
        throw badRequest(
          `Bond ${bond.number} is a conditional (not on-demand) bond: the guarantor pays only against ` +
            `proof of the principal's default. Record the evidence relied on in evidenceRefs before ` +
            `making the demand.`,
        );
      }
      const id = newId("bcl");
      await app.db.insert(bondCalls).values({
        id,
        companyId: req.companyId!,
        bondId,
        calledAt,
        amount: body.amount,
        reason: body.reason,
        evidenceRefs: refs,
        outcome: body.outcome ?? "pending",
        calledBy: req.user!.id,
      });
      await app.db
        .update(bonds)
        .set({ status: "called", updatedAt: new Date().toISOString() })
        .where(eq(bonds.id, bondId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "bond_call",
        objectId: id,
        payload: {
          bondId,
          bondNumber: bond.number,
          calledAt,
          amount: body.amount,
          reason: body.reason,
          evidenceRefs: refs,
          demandDeadline: bond.demandDeadline,
          isOnDemand: bond.isOnDemand === 1,
        },
        storePayload: true,
      });
      const call = (
        await app.db.select().from(bondCalls).where(eq(bondCalls.id, id)).limit(1)
      )[0];
      const updated = await fetchBond(bondId, req.companyId!, req.projectId!);
      return reply.status(201).send({
        call,
        bond: decorateBond(updated, todayISO()),
        daysBeforeDeadline: bond.demandDeadline
          ? daysBetweenISO(calledAt, bond.demandDeadline)
          : null,
      });
    },
  );

  app.post(
    "/projects/:projectId/insurance/bond-calls/:callId/outcome",
    { preHandler: standardGate },
    async (req) => {
      const { callId } = req.params as { callId: string };
      const body = bondCallOutcomeSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(bondCalls)
        .where(and(eq(bondCalls.id, callId), eq(bondCalls.companyId, req.companyId!)))
        .limit(1);
      const call = rows[0];
      if (!call) throw notFound("Bond call not found");
      await fetchBond(call.bondId, req.companyId!, req.projectId!); // tenant + project scope
      if (
        (body.outcome === "paid" || body.outcome === "partially_paid") &&
        (body.proceedsAmount === null ||
          body.proceedsAmount === undefined ||
          !body.proceedsReceivedAt)
      ) {
        throw badRequest(
          "Recording a demand as paid requires proceedsAmount and proceedsReceivedAt — money received is a fact, not a status",
        );
      }
      await app.db
        .update(bondCalls)
        .set({
          outcome: body.outcome,
          proceedsAmount: body.proceedsAmount ?? null,
          proceedsReceivedAt: body.proceedsReceivedAt ?? null,
        })
        .where(eq(bondCalls.id, callId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "bond_call",
        objectId: callId,
        payload: {
          from: call.outcome,
          to: body.outcome,
          proceedsAmount: body.proceedsAmount ?? null,
          proceedsReceivedAt: body.proceedsReceivedAt ?? null,
        },
        storePayload: true,
      });
      return (
        await app.db.select().from(bondCalls).where(eq(bondCalls.id, callId)).limit(1)
      )[0];
    },
  );

  app.post(
    "/projects/:projectId/insurance/bonds/:bondId/release",
    { preHandler: standardGate },
    async (req) => {
      const { bondId } = req.params as { bondId: string };
      const body = bondReleaseSchema.parse(req.body);
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (bond.status === "released") {
        throw badRequest(`Bond ${bond.number} was already released on ${bond.releasedAt}`);
      }
      if (bond.status === "draft") {
        throw badRequest("A draft bond has never been issued and cannot be released");
      }
      /*
       * Release used to be allowed from every other state. Releasing a
       * `called` bond with a demand still outstanding flipped the status and
       * hid a live recovery; releasing an `expired` bond rewrote a derived
       * fact — the bond did not end because somebody released it, it ended
       * because its expiry passed. Release now means only what it says:
       * the security was given back while it was still live.
       */
      if (bond.status === "expired") {
        throw conflict(
          `Bond ${bond.number} expired on ${bond.expiryAt ?? "an unrecorded date"}. An expired ` +
            "bond is not released — nothing was given back, the security simply ran out — and " +
            "recording it as released would rewrite what happened.",
        );
      }
      if (bond.status === "called") {
        const calls = await app.db
          .select({ id: bondCalls.id, outcome: bondCalls.outcome })
          .from(bondCalls)
          .where(and(eq(bondCalls.bondId, bondId), eq(bondCalls.companyId, req.companyId!)));
        const outstanding = calls.filter(
          (c) => c.outcome !== "paid" && c.outcome !== "rejected" && c.outcome !== "withdrawn",
        );
        if (outstanding.length > 0) {
          throw conflict(
            `Bond ${bond.number} has ${outstanding.length} demand(s) still outstanding. Releasing ` +
              "it now would hide a live recovery: settle or withdraw every call first, then " +
              "release what is left.",
          );
        }
      }
      const releasedAt = body.releasedAt ?? todayISO();
      await app.db
        .update(bonds)
        .set({ status: "released", releasedAt, updatedAt: new Date().toISOString() })
        .where(eq(bonds.id, bondId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "bond",
        objectId: bondId,
        payload: {
          from: bond.status,
          to: "released",
          releasedAt,
          reason: body.reason ?? null,
          amount: bond.amount,
          currency: bond.currency,
        },
        storePayload: true,
      });
      const updated = await fetchBond(bondId, req.companyId!, req.projectId!);
      return decorateBond(updated, todayISO());
    },
  );

  app.delete(
    "/projects/:projectId/insurance/bonds/:bondId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { bondId } = req.params as { bondId: string };
      const bond = await fetchBond(bondId, req.companyId!, req.projectId!);
      if (bond.status !== "draft") {
        throw badRequest(
          `Only a draft bond can be deleted; a ${bond.status} bond is part of the record`,
        );
      }
      await app.db.delete(bonds).where(eq(bonds.id, bondId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "bond",
        objectId: bondId,
        payload: { number: bond.number, bondType: bond.bondType },
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* CLAIMS (#783-789) — the notification obligation                   */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/insurance/claims",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = claimCreateSchema.parse(req.body);
      if (daysBetweenISO(body.incidentDate, body.awareDate) < 0) {
        throw badRequest(
          `awareDate ${body.awareDate} falls before incidentDate ${body.incidentDate} — the insured ` +
            `cannot become aware of a loss before it happens`,
        );
      }
      const policy = await fetchPolicyForProject(body.policyId, req.companyId!, req.projectId!);
      if (policy.status === "cancelled") {
        throw badRequest(
          `Policy ${policy.number} is cancelled — a claim cannot be notified under it. If cover was ` +
            `in force at the incident date, record the policy that was actually on risk.`,
        );
      }
      if (policy.status === "draft") {
        throw badRequest(
          `Policy ${policy.number} is still draft — activate it before recording claims against it`,
        );
      }

      // #783 — the notification deadline. Counted off awareDate, not the
      // incident date: awareness is the trigger in the standard wordings.
      const window = computeNotificationWindow(body.awareDate, policy.notificationDays);
      let obligationId: string | null = null;
      if (window.notificationDueAt) {
        obligationId = newId("obl");
        await app.db.insert(obligations).values({
          id: obligationId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          sourceClause: `${OBLIGATION_PREFIX} ${policy.policyType} ${policy.number} — claim notification`,
          trigger: `Notify insurer of claim: ${body.title}`,
          deadline: `${window.notificationDueAt}T23:59:59Z`,
          warnDaysBefore: Math.min(14, Math.max(1, Math.ceil((window.notificationDays ?? 1) / 4))),
          evidenceRequirement: "Notification to the insurer with proof of despatch",
          status: "open",
          createdBy: req.user!.id,
        });
      }

      const seq = await nextRecordNumber(app.db, req.projectId!, "insurance_claim");
      const number = `ICL-${pad(seq)}`;
      const id = newId("icl");
      await app.db.insert(insuranceClaims).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        policyId: policy.id,
        number,
        title: body.title,
        description: body.description ?? null,
        incidentDate: body.incidentDate,
        awareDate: body.awareDate,
        notifiedAt: null,
        notificationDueAt: window.notificationDueAt,
        obligationId,
        quantum: body.quantum ?? null,
        reserve: body.reserve ?? null,
        currency: body.currency ?? policy.currency,
        status: "notified",
        insurerRef: body.insurerRef ?? null,
        lossAdjuster: body.lossAdjuster ?? null,
        linkedRecords: body.linkedRecords ?? [],
        createdBy: req.user!.id,
      });
      /*
       * The linked records are also written as REAL LINKS (#784).
       *
       * `linkedRecords` on its own is a JSON note that looks like a link:
       * nothing downstream can traverse it, and the uninsured-loss detector
       * could not tell that this claim answers that incident. A record_links
       * row is traversable from both ends, so the incident shows the claim
       * raised from it and the detector stops flagging it.
       */
      await linkClaimRecords(req, id, body.linkedRecords ?? []);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "insurance_claim",
        objectId: id,
        payload: {
          number,
          policyId: policy.id,
          policyNumber: policy.number,
          incidentDate: body.incidentDate,
          awareDate: body.awareDate,
          notificationDays: policy.notificationDays,
          notificationDueAt: window.notificationDueAt,
          obligationId,
          reserve: body.reserve ?? null,
        },
        storePayload: true,
      });
      const created = await fetchClaim(id, req.companyId!, req.projectId!);
      return reply.status(201).send({
        ...decorateClaim(created, todayISO()),
        notificationRule: {
          notificationDays: window.notificationDays,
          notificationDueAt: window.notificationDueAt,
          obligationId,
          note:
            window.note ??
            `Notification is due by ${window.notificationDueAt} — ${window.notificationDays} day(s) ` +
              `from the aware date ${body.awareDate}. The deadline is carried as an obligation and is ` +
              `typically a condition precedent to liability.`,
        },
      });
    },
  );

  app.get("/projects/:projectId/insurance/claims", { preHandler: readGate }, async (req) => {
    const q = claimListQuery.parse(req.query);
    const asOf = todayISO();
    const clauses = [
      eq(insuranceClaims.companyId, req.companyId!),
      eq(insuranceClaims.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(insuranceClaims.status, q.status));
    if (q.policyId) clauses.push(eq(insuranceClaims.policyId, q.policyId));
    if (q.notified === "true") clauses.push(isNotNull(insuranceClaims.notifiedAt));
    if (q.notified === "false") clauses.push(isNull(insuranceClaims.notifiedAt));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(insuranceClaims).where(where);
    const rows = await app.db
      .select()
      .from(insuranceClaims)
      .where(where)
      .orderBy(desc(insuranceClaims.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((c) => decorateClaim(c, asOf)),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get(
    "/projects/:projectId/insurance/claims/:claimId",
    { preHandler: readGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      await fetchClaim(claimId, req.companyId!, req.projectId!);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const policy = await fetchPolicyForProject(
        claim.policyId,
        req.companyId!,
        req.projectId!,
      ).catch(() => null);
      let obligation = null;
      if (claim.obligationId) {
        const rows = await app.db
          .select()
          .from(obligations)
          .where(eq(obligations.id, claim.obligationId))
          .limit(1);
        obligation = rows[0] ?? null;
      }
      return {
        ...decorateClaim(claim, todayISO()),
        policy: policy ? decoratePolicy(policy, todayISO()) : null,
        obligation,
      };
    },
  );

  app.patch(
    "/projects/:projectId/insurance/claims/:claimId",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = claimPatchSchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (["settled", "repudiated", "withdrawn"].includes(claim.status)) {
        throw badRequest(`A ${claim.status} claim cannot be edited`);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) set[k] = v;
      }
      await app.db.update(insuranceClaims).set(set).where(eq(insuranceClaims.id, claimId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "insurance_claim",
        objectId: claimId,
        payload: { changed: Object.keys(body), reserve: body.reserve ?? claim.reserve },
      });
      const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
      return decorateClaim(updated, todayISO());
    },
  );

  /**
   * Record actual notification to the insurer (#783-784).
   *
   * On time: the obligation is discharged. Late: the obligation is breached
   * and a CRITICAL signal is raised explaining the consequence — notification
   * within the policy period is a condition precedent to liability in almost
   * every wording, and a late notification is usually fatal to the claim
   * whatever its merits. This is the insurance analogue of a contractual time
   * bar and deliberately reads like `time_bar_missed` in modules/contracts.
   */
  app.post(
    "/projects/:projectId/insurance/claims/:claimId/notify",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = notifySchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      if (claim.notifiedAt) {
        throw badRequest(
          `Claim ${claim.number} was already notified on ${claim.notifiedAt} — a second notification ` +
            `would rewrite the record of when the insurer was actually told`,
        );
      }
      if (claim.status === "withdrawn") {
        throw badRequest("A withdrawn claim cannot be notified");
      }
      const notifiedAt = body.notifiedAt ?? todayISO();
      if (daysBetweenISO(claim.awareDate, notifiedAt) < 0) {
        throw badRequest(
          `notifiedAt ${notifiedAt} falls before the aware date ${claim.awareDate}`,
        );
      }
      const late = isNotificationLate(claim.notificationDueAt, notifiedAt);
      const daysLate = claim.notificationDueAt
        ? Math.max(0, daysBetweenISO(claim.notificationDueAt, notifiedAt))
        : null;
      const now = new Date().toISOString();
      await app.db
        .update(insuranceClaims)
        .set({
          notifiedAt,
          insurerRef: body.insurerRef ?? claim.insurerRef,
          updatedAt: now,
        })
        .where(eq(insuranceClaims.id, claimId));

      if (claim.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: late ? "breached" : "satisfied" })
          .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
      }

      if (late) {
        // Idempotent by construction: a second notify is refused above, so
        // this branch runs at most once per claim. The key is belt and braces.
        const seen = await alreadySignalled(req.companyId!, "insurance_notification_missed");
        if (!seen.has(claimId)) {
          await app.db.insert(signals).values({
            id: newId("sig"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            detector: "insurance_notification_missed",
            severity: "critical",
            confidence: 1,
            title: `Claim notified out of time — ${claim.number}: ${claim.title}`,
            explanation:
              `Claim ${claim.number} was notified to the insurer on ${notifiedAt}, ${daysLate} day(s) ` +
              `after the notification deadline of ${claim.notificationDueAt} computed from the aware ` +
              `date ${claim.awareDate}. Notification within the policy period is a condition precedent ` +
              `to liability in almost every wording: where it is, late notification is fatal to the ` +
              `claim however strong its merits, and the insurer need show no prejudice to decline. ` +
              `Treat the loss as uninsured until the insurer confirms otherwise in writing, notify ` +
              `your broker and your own professional indemnity insurers, and preserve the record of ` +
              `when awareness actually arose — that date is now the whole argument.`,
            evidenceRefs: {
              key: claimId,
              claimId,
              policyId: claim.policyId,
              awareDate: claim.awareDate,
              notificationDueAt: claim.notificationDueAt,
              notifiedAt,
              daysLate,
            },
          });
        }
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "insurance_claim",
        objectId: claimId,
        payload: {
          notifiedAt,
          method: body.method ?? null,
          reference: body.reference ?? null,
          notificationDueAt: claim.notificationDueAt,
          late,
          daysLate,
          obligationId: claim.obligationId,
        },
        storePayload: true,
      });

      const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
      return {
        ...decorateClaim(updated, todayISO()),
        late,
        daysLate,
        consequence: late
          ? "Notification was given after the deadline. Notification in time is normally a condition " +
            "precedent to liability, so the claim is at risk of being declined outright."
          : claim.notificationDueAt
            ? "Notification was given in time; the notification obligation is discharged."
            : "No notification deadline was computed for this claim because the policy records no " +
              "notification period — timeliness cannot be asserted either way.",
      };
    },
  );

  app.post(
    "/projects/:projectId/insurance/claims/:claimId/status",
    { preHandler: standardGate },
    async (req) => {
      const { claimId } = req.params as { claimId: string };
      const body = claimStatusSchema.parse(req.body);
      const claim = await fetchClaim(claimId, req.companyId!, req.projectId!);
      const allowed = CLAIM_TRANSITIONS[claim.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(`Cannot transition a ${claim.status} claim to ${body.status}`);
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { status: body.status, updatedAt: now };

      if (body.status === "acknowledged" && !claim.notifiedAt) {
        throw badRequest(
          "A claim cannot be acknowledged before it has been notified to the insurer — record the " +
            "notification first (POST .../notify)",
        );
      }
      if (body.status === "repudiated") {
        if (!body.repudiationReason?.trim()) {
          throw badRequest(
            "Repudiation must state the ground relied on: an unreasoned declinature cannot be " +
              "challenged, and the ground is what any later coverage dispute turns on",
          );
        }
        set["repudiationReason"] = body.repudiationReason;
      }
      if (body.status === "settled") {
        if (body.settledAmount === undefined || !body.settledAt) {
          throw badRequest(
            "Settlement requires both settledAmount and settledAt — a settled claim with no figure " +
              "and no date cannot be reconciled against the reserve",
          );
        }
        set["settledAmount"] = body.settledAmount;
        set["settledAt"] = body.settledAt;
      }
      if (body.insurerRef !== undefined) set["insurerRef"] = body.insurerRef;
      if (body.lossAdjuster !== undefined) set["lossAdjuster"] = body.lossAdjuster;

      await app.db.update(insuranceClaims).set(set).where(eq(insuranceClaims.id, claimId));

      // A claim that is finally disposed of moots an open notification
      // obligation; a breached one stays breached — settling late does not
      // rewrite the register (same rule as payments and contracts).
      if (
        claim.obligationId &&
        ["settled", "repudiated", "withdrawn"].includes(body.status)
      ) {
        await app.db
          .update(obligations)
          .set({ status: body.status === "withdrawn" ? "waived" : "satisfied" })
          .where(and(eq(obligations.id, claim.obligationId), eq(obligations.status, "open")));
      }

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "insurance_claim",
        objectId: claimId,
        payload: {
          from: claim.status,
          to: body.status,
          repudiationReason: body.repudiationReason ?? null,
          settledAmount: body.settledAmount ?? null,
          settledAt: body.settledAt ?? null,
          reserve: claim.reserve,
        },
        storePayload: true,
      });
      const updated = await fetchClaim(claimId, req.companyId!, req.projectId!);
      return decorateClaim(updated, todayISO());
    },
  );

  /**
   * Write the claim's linked records as traversable links, de-duplicated.
   *
   * Deliberately tolerant of an id that does not resolve: the caller may be
   * linking a record type this module does not know how to look up, and
   * refusing the whole claim over a link would be the wrong trade. What it
   * does NOT do is invent a link — only what was actually supplied is written.
   */
  async function linkClaimRecords(
    req: FastifyRequest,
    claimId: string,
    links: ReadonlyArray<{ recordType: string; recordId: string; note?: string }>,
  ): Promise<void> {
    if (links.length === 0) return;
    const existing = await app.db
      .select({ toType: recordLinks.toType, toId: recordLinks.toId })
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, req.companyId!),
          eq(recordLinks.fromType, "insurance_claim"),
          eq(recordLinks.fromId, claimId),
        ),
      );
    const seen = new Set(existing.map((e) => `${e.toType}:${e.toId}`));
    for (const link of links) {
      const key = `${link.recordType}:${link.recordId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await app.db.insert(recordLinks).values({
        id: newId("rln"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        fromType: "insurance_claim",
        fromId: claimId,
        toType: link.recordType,
        toId: link.recordId,
        linkKind: "evidence",
        createdBy: req.user!.id,
      });
    }
  }

  /* ================================================================ */
  /* EXPIRY RADAR — the pure engine, exposed                           */
  /* ================================================================ */

  async function buildExpiryReport(
    companyId: string,
    projectId: string | null,
    explicitTypes: string[] | null,
    days: number,
    /** null = every project; otherwise the ids the caller may see */
    visibleProjectIds: readonly string[] | null = null,
  ) {
    const asOf = todayISO();
    const full = await loadScope(companyId, projectId);
    const visible = <T extends { projectId: string | null }>(rows: readonly T[]): T[] =>
      visibleProjectIds === null
        ? [...rows]
        : rows.filter((r) => r.projectId === null || visibleProjectIds.includes(r.projectId));
    const scope = {
      policies: visible(full.policies),
      certificates: visible(full.certificates),
      bonds: visible(full.bonds),
    };
    const requiredTypes = explicitTypes ?? (await requiredTypesFor(companyId, projectId));
    const vendorsAtWork = visible(
      await loadVendorsAtWork(companyId, projectId, scope.bonds),
    );
    const report = computeExpiryReport({
      asOf,
      windowDays: days,
      policies: scope.policies,
      certificates: scope.certificates,
      bonds: scope.bonds,
      vendorsAtWork,
      requiredPolicyTypes: requiredTypes,
    });
    return {
      ...report,
      scope: projectId ? ("project" as const) : ("company" as const),
      projectId,
      requiredTypes: requiredTypes ?? [],
      requiredTypesSource: explicitTypes
        ? ("query" as const)
        : requiredTypes
          ? ("recorded_requirements" as const)
          : ("none_recorded" as const),
      vendorsAtWork: vendorsAtWork.length,
    };
  }

  app.get("/projects/:projectId/insurance/expiring", { preHandler: readGate }, async (req) => {
    const q = windowQuery.parse(req.query);
    return buildExpiryReport(
      req.companyId!,
      req.projectId!,
      parseRequiredTypesParam(q.requiredTypes),
      q.days,
    );
  });

  /*
   * The company-wide expiry radar, restricted to the projects the caller
   * actually holds `insurance` on. Owners and admins get the whole tenant.
   */
  app.get("/insurance/expiring", { preHandler: companyScopedRead }, async (req) => {
    const q = windowQuery.parse(req.query);
    const scope = scopeOf(req);
    return {
      ...(await buildExpiryReport(
        req.companyId!,
        null,
        parseRequiredTypesParam(q.requiredTypes),
        q.days,
        scope.all ? null : scope.projectIds,
      )),
      visibility: scope.all
        ? { all: true as const, projects: null }
        : { all: false as const, projects: scope.projectIds.length },
    };
  });

  /* ================================================================ */
  /* PROGRAMME SUMMARY (#773, #778, #786, #795-796)                    */
  /* ================================================================ */

  async function buildSummary(
    companyId: string,
    projectId: string | null,
    visibleProjectIds: readonly string[] | null = null,
  ) {
    const asOf = todayISO();
    const full = await loadScope(companyId, projectId);
    const inScope = <T extends { projectId: string | null }>(rows: readonly T[]): T[] =>
      visibleProjectIds === null
        ? [...rows]
        : rows.filter((r) => r.projectId === null || visibleProjectIds.includes(r.projectId));
    const scope = {
      policies: inScope(full.policies),
      certificates: inScope(full.certificates),
      bonds: inScope(full.bonds),
    };
    const requiredTypes = await requiredTypesFor(companyId, projectId);
    const vendorsAtWork = inScope(await loadVendorsAtWork(companyId, projectId, scope.bonds));
    /*
     * Cover gaps are computed PER PROJECT even in the company roll-up, and the
     * results unioned. Evaluating every vendor against one tenant-wide set of
     * required types was how a requirement recorded on one job produced gaps
     * against every vendor on every other one.
     */
    const requirementRows = await loadRequirements(companyId);
    const buckets = new Map<string | null, VendorAtWork[]>();
    for (const v of vendorsAtWork) {
      const list = buckets.get(v.projectId) ?? [];
      list.push(v);
      buckets.set(v.projectId, list);
    }
    const perBucket = await Promise.all(
      [...buckets.entries()].map(async ([bucketProjectId, bucketVendors]) =>
        computeCoverGaps({
          certificates: scope.certificates,
          vendorsAtWork: bucketVendors,
          requiredPolicyTypes: await requiredTypesFor(companyId, bucketProjectId, requirementRows),
          asOf,
        }),
      ),
    );
    const gapResult = {
      gaps: perBucket.flatMap((r) => r.gaps),
      unverified: perBucket.flatMap((r) => r.unverified),
      requirementsKnown:
        requiredTypes !== null || perBucket.some((r) => r.requirementsKnown),
      note:
        requiredTypes === null && !perBucket.some((r) => r.requirementsKnown)
          ? (perBucket[0]?.note ??
            "No cover requirement is recorded for this scope, so supply-chain gaps cannot be " +
              "computed. Record the policy types the contract requires before relying on this figure.")
          : null,
    };

    /* ---- cover by policy type, with gaps named ---- */
    const typesPresent = new Set<string>([
      ...scope.policies.map((p) => p.policyType),
      ...scope.certificates.map((c) => c.policyType),
      ...(requiredTypes ?? []),
    ]);
    const byType = [...typesPresent].sort().map((policyType) => {
      const pols = scope.policies.filter((p) => p.policyType === policyType);
      const active = pols.filter((p) => derivePolicyStatus(p, asOf) === "active");
      const certs = scope.certificates.filter((c) => c.policyType === policyType);
      const inDate = certs.filter((c) => isCertificateInDate(c, asOf));
      const withLimit = active.filter((p) => p.limitOfIndemnity !== null);
      // Limits are never summed across currencies — a GBP 10m and a USD 10m
      // layer are not GBP 20m of cover.
      const limitsByCurrency = new Map<string, number>();
      for (const p of withLimit) {
        limitsByCurrency.set(
          p.currency,
          round2((limitsByCurrency.get(p.currency) ?? 0) + (p.limitOfIndemnity ?? 0)),
        );
      }
      return {
        policyType,
        required: (requiredTypes ?? []).includes(policyType),
        policies: pols.length,
        activePolicies: active.length,
        certificates: certs.length,
        certificatesInDate: inDate.length,
        certificatesVerified: inDate.filter((c) => c.verifiedAt !== null).length,
        covered: active.length > 0 || inDate.length > 0,
        totalLimits:
          withLimit.length === 0
            ? []
            : [...limitsByCurrency.entries()].map(([currency, total]) => ({ currency, total })),
        policiesWithoutLimit: active.length - withLimit.length,
        limitNote:
          active.length === 0
            ? "No policy of this type is in force in this scope."
            : withLimit.length === 0
              ? "No policy of this type records a limit of indemnity, so total cover cannot be computed."
              : withLimit.length < active.length
                ? `${active.length - withLimit.length} of ${active.length} in-force policies record no limit — the total below is a floor, not the programme limit.`
                : null,
        gaps: gapResult.gaps.filter((g) => g.policyType === policyType),
      };
    });

    /* ---- bonds outstanding by type, with aggregate exposure ---- */
    const outstanding = scope.bonds.filter((b) => ["issued", "active"].includes(b.status));
    const bondTypeKeys = [...new Set(outstanding.map((b) => `${b.bondType}|${b.currency}`))].sort();
    const outstandingByType = bondTypeKeys.map((key) => {
      const [bondType = "", currency = ""] = key.split("|");
      const group = outstanding.filter(
        (b) => b.bondType === bondType && b.currency === currency,
      );
      const exposures = group.map((b) => bondCurrentExposure(b, asOf));
      return {
        bondType,
        currency,
        count: group.length,
        faceAmount: round2(exposures.reduce((a, e) => a + e.faceAmount, 0)),
        currentExposure: round2(exposures.reduce((a, e) => a + e.currentAmount, 0)),
      };
    });
    const aggregateByCurrency = [...new Set(outstanding.map((b) => b.currency))].sort().map(
      (currency) => {
        const group = outstanding.filter((b) => b.currency === currency);
        const exposures = group.map((b) => bondCurrentExposure(b, asOf));
        return {
          currency,
          count: group.length,
          faceAmount: round2(exposures.reduce((a, e) => a + e.faceAmount, 0)),
          currentExposure: round2(exposures.reduce((a, e) => a + e.currentAmount, 0)),
        };
      },
    );
    // Surety capacity utilisation (#795). Headroom (#796) is deliberately NOT
    // reported: it is utilisation against an agreed bonding line, and no
    // bonding line limit is recorded anywhere in the schema. Reporting
    // utilisation without the facility would invite the reader to infer a
    // headroom that does not exist.
    const guarantorKeys = [
      ...new Set(outstanding.map((b) => `${b.guarantor}|${b.currency}`)),
    ].sort();
    const byGuarantor = guarantorKeys.map((key) => {
      const sep = key.lastIndexOf("|");
      const guarantor = key.slice(0, sep);
      const currency = key.slice(sep + 1);
      const group = outstanding.filter(
        (b) => b.guarantor === guarantor && b.currency === currency,
      );
      const exposures = group.map((b) => bondCurrentExposure(b, asOf));
      return {
        guarantor,
        currency,
        count: group.length,
        faceAmount: round2(exposures.reduce((a, e) => a + e.faceAmount, 0)),
        currentExposure: round2(exposures.reduce((a, e) => a + e.currentAmount, 0)),
        bondTypes: [...new Set(group.map((b) => b.bondType))].sort(),
      };
    });

    /* ---- claims by status, reserve versus settled ---- */
    const claimRows = await app.db
      .select()
      .from(insuranceClaims)
      .where(
        projectId
          ? and(
              eq(insuranceClaims.companyId, companyId),
              eq(insuranceClaims.projectId, projectId),
            )
          : eq(insuranceClaims.companyId, companyId),
      );
    const claimsByStatus: Record<string, number> = {};
    for (const s of INSURANCE_CLAIM_STATUSES) claimsByStatus[s] = 0;
    for (const c of claimRows) {
      claimsByStatus[c.status] = (claimsByStatus[c.status] ?? 0) + 1;
    }
    const claimCurrencies = [...new Set(claimRows.map((c) => c.currency))].sort();
    const claimTotals = claimCurrencies.map((currency) => {
      const group = claimRows.filter((c) => c.currency === currency);
      const reserved = group.filter((c) => c.reserve !== null);
      const settled = group.filter((c) => c.settledAmount !== null);
      return {
        currency,
        claims: group.length,
        reserve: reserved.length === 0 ? null : round2(reserved.reduce((a, c) => a + (c.reserve ?? 0), 0)),
        claimsWithReserve: reserved.length,
        claimsWithoutReserve: group.length - reserved.length,
        settled:
          settled.length === 0 ? null : round2(settled.reduce((a, c) => a + (c.settledAmount ?? 0), 0)),
        claimsSettled: settled.length,
      };
    });

    /* ---- live obligation and signal counts ---- */
    const oblRows = await app.db
      .select({ status: obligations.status, n: count() })
      .from(obligations)
      .where(
        projectId
          ? and(
              eq(obligations.companyId, companyId),
              eq(obligations.projectId, projectId),
              ilike(obligations.sourceClause, `${OBLIGATION_PREFIX} %`),
            )
          : and(
              eq(obligations.companyId, companyId),
              ilike(obligations.sourceClause, `${OBLIGATION_PREFIX} %`),
            ),
      )
      .groupBy(obligations.status);
    const obligationCounts: Record<string, number> = { open: 0, satisfied: 0, breached: 0 };
    for (const r of oblRows) obligationCounts[r.status] = Number(r.n);

    const signalRows = await app.db
      .select({
        detector: signals.detector,
        disposition: signals.disposition,
        n: count(),
      })
      .from(signals)
      .where(
        projectId
          ? and(
              eq(signals.companyId, companyId),
              eq(signals.projectId, projectId),
              inArray(signals.detector, [...INSURANCE_DETECTORS]),
            )
          : and(
              eq(signals.companyId, companyId),
              inArray(signals.detector, [...INSURANCE_DETECTORS]),
            ),
      )
      .groupBy(signals.detector, signals.disposition);
    const signalsByDetector: Record<string, number> = {};
    for (const d of INSURANCE_DETECTORS) signalsByDetector[d] = 0;
    let signalsOpen = 0;
    let signalsTotal = 0;
    for (const r of signalRows) {
      signalsByDetector[r.detector] = (signalsByDetector[r.detector] ?? 0) + Number(r.n);
      signalsTotal += Number(r.n);
      if (r.disposition === "new" || r.disposition === "under_review") signalsOpen += Number(r.n);
    }

    /*
     * BONDING LINES (#796). Utilisation is derived from the bonds actually
     * drawn against each facility, never stored, so it cannot drift from the
     * bonds it summarises — and headroom is refused across currencies.
     */
    const facilityRows = await app.db
      .select()
      .from(bondFacilities)
      .where(
        projectId
          ? and(
              eq(bondFacilities.companyId, companyId),
              or(eq(bondFacilities.projectId, projectId), isNull(bondFacilities.projectId)),
            )
          : eq(bondFacilities.companyId, companyId),
      );
    const allDrawn = await app.db
      .select()
      .from(bonds)
      .where(and(eq(bonds.companyId, companyId), isNotNull(bonds.facilityId)));
    const facilityLines = facilityRows.map((f) => {
      const u = facilityUtilisation(
        {
          id: f.id,
          number: f.number,
          name: f.name,
          provider: f.provider,
          projectId: f.projectId,
          limitAmount: f.limitAmount,
          currency: f.currency,
          permittedBondTypes: f.permittedBondTypes,
          status: f.status,
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo,
          reviewDate: f.reviewDate,
        },
        allDrawn,
        (b) => bondCurrentExposure(b, asOf).currentAmount,
        asOf,
      );
      return u;
    });

    const notificationsOutstanding = claimRows.filter((c) => c.notifiedAt === null).length;
    const notificationsMissed = claimRows.filter(
      (c) => c.notifiedAt !== null && isNotificationLate(c.notificationDueAt, c.notifiedAt),
    ).length;
    const notificationDeadlineUnknown = claimRows.filter(
      (c) => c.notificationDueAt === null,
    ).length;

    return {
      scope: projectId ? ("project" as const) : ("company" as const),
      companyId,
      projectId,
      asOf,
      policies: {
        total: scope.policies.length,
        inForce: scope.policies.filter((p) => derivePolicyStatus(p, asOf) === "active").length,
        companyLevel: scope.policies.filter((p) => p.projectId === null).length,
        expiringSoon: policiesExpiringWithin(scope.policies, asOf, 30).length,
      },
      certificates: {
        total: scope.certificates.length,
        inDate: scope.certificates.filter((c) => isCertificateInDate(c, asOf)).length,
        verified: scope.certificates.filter((c) => c.verifiedAt !== null).length,
        expiringSoon: certificatesExpiringWithin(scope.certificates, asOf, 30).length,
      },
      cover: {
        requirementsKnown: gapResult.requirementsKnown,
        requiredTypes: requiredTypes ?? [],
        note: gapResult.note,
        vendorsAtWork: vendorsAtWork.length,
        byType,
        gaps: gapResult.gaps,
        unverified: gapResult.unverified,
      },
      bonds: {
        total: scope.bonds.length,
        outstanding: outstanding.length,
        outstandingByType,
        byGuarantor,
        aggregateExposure: aggregateByCurrency,
        pastDemandDeadline: bondsPastDemandDeadline(scope.bonds, asOf).length,
        called: scope.bonds.filter((b) => b.status === "called").length,
        released: scope.bonds.filter((b) => b.status === "released").length,
        note:
          "Exposure is reported per currency and never summed across currencies. `currentExposure` " +
          "applies triggered milestone reductions; `faceAmount` does not.",
        facilities: facilityLines,
        headroomNote:
          facilityLines.length === 0
            ? "Bonding line headroom (#796) is not reported: no agreed facility limit is " +
              "recorded, so utilisation is shown without a denominator rather than against an " +
              "invented one. Record the facility your surety has agreed and headroom becomes a " +
              "figure rather than a hope."
            : "Headroom is derived from the live bonds drawn against each facility and is " +
              "reported per currency, never netted across two. A bond drawn against a line in " +
              "another currency is excluded and named, because no rate is held.",
      },
      claims: {
        total: claimRows.length,
        byStatus: claimsByStatus,
        totals: claimTotals,
        notificationsOutstanding,
        notificationsMissed,
        notificationDeadlineUnknown,
        note:
          notificationDeadlineUnknown > 0
            ? `${notificationDeadlineUnknown} claim(s) have no computed notification deadline because ` +
              `their policy records no notificationDays — those claims are not counted as either in ` +
              `time or late.`
            : null,
      },
      obligations: {
        ...obligationCounts,
        total: Object.values(obligationCounts).reduce((a, b) => a + b, 0),
      },
      signals: {
        total: signalsTotal,
        open: signalsOpen,
        byDetector: signalsByDetector,
      },
    };
  }

  app.get("/projects/:projectId/insurance/summary", { preHandler: readGate }, async (req) =>
    buildSummary(req.companyId!, req.projectId!),
  );

  /*
   * The company-wide programme, restricted to the projects the caller holds
   * `insurance` on. It used to run on [authenticate, requireCompany] alone,
   * so any company member — guests included — read every project's policies,
   * certificates and claim reserves through it.
   */
  app.get("/insurance/summary", { preHandler: companyScopedRead }, async (req) => {
    const scope = scopeOf(req);
    return {
      ...(await buildSummary(req.companyId!, null, scope.all ? null : scope.projectIds)),
      visibility: scope.all
        ? { all: true as const, projects: null }
        : { all: false as const, projects: scope.projectIds.length },
    };
  });

  /* ================================================================ */
  /* BONDING LINE FACILITIES (#796)                                    */
  /*                                                                   */
  /* Without this record headroom is not computable at all: you can    */
  /* list the bonds you have issued but not the ceiling they sit under,*/
  /* and the only question a contractor needs answered before          */
  /* tendering — "how much line is left?" — has no answer. Utilisation */
  /* is DERIVED from the live bonds drawn against the line, never      */
  /* stored, so it cannot drift from the bonds it summarises.          */
  /* ================================================================ */

  async function fetchFacility(facilityId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(bondFacilities)
      .where(and(eq(bondFacilities.id, facilityId), eq(bondFacilities.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Bond facility not found");
    return rows[0];
  }

  async function decorateFacility(facility: typeof bondFacilities.$inferSelect, asOf: string) {
    const drawn = await app.db
      .select()
      .from(bonds)
      .where(and(eq(bonds.companyId, facility.companyId), eq(bonds.facilityId, facility.id)));
    return {
      ...facility,
      utilisation: facilityUtilisation(
        {
          id: facility.id,
          number: facility.number,
          name: facility.name,
          provider: facility.provider,
          projectId: facility.projectId,
          limitAmount: facility.limitAmount,
          currency: facility.currency,
          permittedBondTypes: facility.permittedBondTypes,
          status: facility.status,
          effectiveFrom: facility.effectiveFrom,
          effectiveTo: facility.effectiveTo,
          reviewDate: facility.reviewDate,
        },
        drawn.map((b) => ({ ...b, facilityId: b.facilityId })),
        (b) => bondCurrentExposure(b, asOf).currentAmount,
        asOf,
      ),
      bonds: drawn.map((b) => ({
        id: b.id,
        number: b.number,
        bondType: b.bondType,
        projectId: b.projectId,
        status: b.status,
        amount: b.amount,
        currency: b.currency,
        currentAmount: bondCurrentExposure(b, asOf).currentAmount,
        expiryAt: b.expiryAt,
      })),
    };
  }

  app.get("/insurance/facilities", { preHandler: companyScopedRead }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const scope = scopeOf(req);
    const clauses = [eq(bondFacilities.companyId, req.companyId!)];
    const visible = scopeProjectsOrCompanyWide(scope, bondFacilities.projectId);
    if (visible) clauses.push(visible);
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(bondFacilities).where(where);
    const rows = await app.db
      .select()
      .from(bondFacilities)
      .where(where)
      .orderBy(asc(bondFacilities.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const asOf = todayISO();
    const items = await Promise.all(rows.map((f) => decorateFacility(f, asOf)));
    /* Headroom by currency — never a single total, because a GBP line and a
       USD line do not add up to one number anybody can act on. */
    const headroomByCurrency = new Map<string, { limit: number; drawn: number }>();
    for (const item of items) {
      if (!item.utilisation.inForce) continue;
      const b = headroomByCurrency.get(item.currency) ?? { limit: 0, drawn: 0 };
      b.limit = round2(b.limit + item.limitAmount);
      b.drawn = round2(b.drawn + item.utilisation.drawnAmount);
      headroomByCurrency.set(item.currency, b);
    }
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      headroomByCurrency: [...headroomByCurrency.entries()]
        .map(([currency, b]) => ({
          currency,
          limit: b.limit,
          drawn: b.drawn,
          headroom: round2(b.limit - b.drawn),
          utilisationPct: b.limit > 0 ? round2((b.drawn / b.limit) * 100) : null,
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      note:
        items.length === 0
          ? "No bonding facility is recorded, so bonding headroom cannot be computed. Until a " +
            "line is recorded the platform can list the bonds you have given but not the ceiling " +
            "they sit under."
          : null,
    };
  });

  app.post("/insurance/facilities", { preHandler: companyWrite }, async (req, reply) => {
    const body = facilityCreateSchema.parse(req.body);
    if (body.providerVendorId) await assertVendor(body.providerVendorId, req.companyId!);
    if (body.projectId) await assertProject(body.projectId, req.companyId!);
    if (body.effectiveFrom && body.effectiveTo && daysBetweenISO(body.effectiveFrom, body.effectiveTo) < 0) {
      throw badRequest(
        `Facility period is inverted: effectiveTo ${body.effectiveTo} falls before effectiveFrom ${body.effectiveFrom}`,
      );
    }
    const seq = await nextRecordNumber(app.db, req.companyId!, "bond_facility");
    const id = newId("bfa");
    const number = `FAC-${pad(seq)}`;
    await app.db.insert(bondFacilities).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      number,
      name: body.name,
      provider: body.provider,
      providerVendorId: body.providerVendorId ?? null,
      facilityReference: body.facilityReference ?? null,
      limitAmount: body.limitAmount,
      currency: body.currency ?? "GBP",
      permittedBondTypes: body.permittedBondTypes ?? [],
      commissionRatePct: body.commissionRatePct ?? null,
      collateralAmount: body.collateralAmount ?? null,
      collateralNote: body.collateralNote ?? null,
      effectiveFrom: body.effectiveFrom ?? null,
      effectiveTo: body.effectiveTo ?? null,
      reviewDate: body.reviewDate ?? null,
      status: "draft",
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "bond_facility",
      objectId: id,
      payload: {
        number,
        provider: body.provider,
        limitAmount: body.limitAmount,
        currency: body.currency ?? "GBP",
      },
      storePayload: true,
    });
    const created = await fetchFacility(id, req.companyId!);
    return reply.status(201).send(await decorateFacility(created, todayISO()));
  });

  app.get("/insurance/facilities/:facilityId", { preHandler: companyScopedRead }, async (req) => {
    const { facilityId } = req.params as { facilityId: string };
    const facility = await fetchFacility(facilityId, req.companyId!);
    if (!scopeAllows(scopeOf(req), facility.projectId)) throw notFound("Bond facility not found");
    return decorateFacility(facility, todayISO());
  });

  app.patch("/insurance/facilities/:facilityId", { preHandler: companyWrite }, async (req) => {
    const { facilityId } = req.params as { facilityId: string };
    const body = facilityPatchSchema.parse(req.body);
    const facility = await fetchFacility(facilityId, req.companyId!);
    if (facility.status === "closed") {
      throw conflict("A closed facility is part of the record and cannot be edited");
    }
    if (body.providerVendorId) await assertVendor(body.providerVendorId, req.companyId!);
    const from = body.effectiveFrom ?? facility.effectiveFrom;
    const to = body.effectiveTo ?? facility.effectiveTo;
    if (from && to && daysBetweenISO(from, to) < 0) {
      throw badRequest(`Facility period is inverted: effectiveTo ${to} falls before effectiveFrom ${from}`);
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
    await app.db.update(bondFacilities).set(set).where(eq(bondFacilities.id, facilityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "bond_facility",
      objectId: facilityId,
      payload: { changed: Object.keys(body), previousLimit: facility.limitAmount },
      storePayload: true,
    });
    return decorateFacility(await fetchFacility(facilityId, req.companyId!), todayISO());
  });

  const FACILITY_TRANSITIONS: Record<string, string[]> = {
    draft: ["active", "closed"],
    active: ["suspended", "expired", "closed"],
    suspended: ["active", "closed"],
    expired: ["closed"],
    closed: [],
  };

  app.post(
    "/insurance/facilities/:facilityId/status",
    { preHandler: companyWrite },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = facilityStatusSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!);
      const allowed = FACILITY_TRANSITIONS[facility.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw conflict(
          `A ${facility.status} facility cannot become ${body.status}` +
            (allowed.length === 0
              ? " — it is terminal"
              : `; permitted next states are ${allowed.join(", ")}`),
        );
      }
      if (body.status === "closed") {
        const asOf = todayISO();
        const decorated = await decorateFacility(facility, asOf);
        if (decorated.utilisation.drawnAmount > 0) {
          throw conflict(
            `${facility.currency} ${decorated.utilisation.drawnAmount} of this line is still drawn ` +
              `by ${decorated.utilisation.bondCount} live bond(s). Closing it would hide security ` +
              "that is still outstanding — release or expire the bonds first.",
          );
        }
      }
      await app.db
        .update(bondFacilities)
        .set({ status: body.status, updatedAt: new Date().toISOString() })
        .where(eq(bondFacilities.id, facilityId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "bond_facility",
        objectId: facilityId,
        payload: { from: facility.status, to: body.status, reason: body.reason ?? null },
        storePayload: true,
      });
      return decorateFacility(await fetchFacility(facilityId, req.companyId!), todayISO());
    },
  );

  /* ================================================================ */
  /* INSURANCE REQUIREMENTS — what the contract actually demands       */
  /* ================================================================ */

  async function fetchRequirement(requirementId: string, companyId: string) {
    const rows = await app.db
      .select()
      .from(insuranceRequirements)
      .where(
        and(
          eq(insuranceRequirements.id, requirementId),
          eq(insuranceRequirements.companyId, companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Insurance requirement not found");
    return rows[0];
  }

  async function insertRequirement(
    companyId: string,
    projectId: string | null,
    userId: string,
    body: z.infer<typeof requirementCreateSchema>,
  ) {
    if (body.vendorId) await assertVendor(body.vendorId, companyId);
    const id = newId("ireq");
    await app.db.insert(insuranceRequirements).values({
      id,
      companyId,
      projectId,
      contractId: body.contractId ?? null,
      vendorId: body.vendorId ?? null,
      policyType: body.policyType,
      requiredByClause: body.requiredByClause,
      minimumLimit: body.minimumLimit ?? null,
      limitBasis: body.limitBasis ?? null,
      currency: body.currency ?? "GBP",
      maximumDeductible: body.maximumDeductible ?? null,
      waiverOfSubrogation: body.waiverOfSubrogation ? 1 : 0,
      additionalInsuredRequired: body.additionalInsuredRequired ? 1 : 0,
      maintainMonthsAfterCompletion: body.maintainMonthsAfterCompletion ?? null,
      territorialLimits: body.territorialLimits ?? null,
      notes: body.notes ?? null,
      status: "required",
      createdBy: userId,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: userId,
      action: "create",
      objectType: "insurance_requirement",
      objectId: id,
      payload: {
        projectId,
        policyType: body.policyType,
        requiredByClause: body.requiredByClause,
        minimumLimit: body.minimumLimit ?? null,
        currency: body.currency ?? "GBP",
        vendorId: body.vendorId ?? null,
      },
      projectId,
      storePayload: true,
    });
    return id;
  }

  app.post(
    "/projects/:projectId/insurance/requirements",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = requirementCreateSchema.parse(req.body);
      const id = await insertRequirement(req.companyId!, req.projectId!, req.user!.id, body);
      return reply.status(201).send(await fetchRequirement(id, req.companyId!));
    },
  );

  app.get(
    "/projects/:projectId/insurance/requirements",
    { preHandler: readGate },
    async (req) => {
      const q = requirementListQuery.parse(req.query);
      const includeCompany = q.includeCompanyWide !== "false";
      const clauses = [
        eq(insuranceRequirements.companyId, req.companyId!),
        includeCompany
          ? or(
              eq(insuranceRequirements.projectId, req.projectId!),
              isNull(insuranceRequirements.projectId),
            )!
          : eq(insuranceRequirements.projectId, req.projectId!),
      ];
      if (q.policyType) clauses.push(eq(insuranceRequirements.policyType, q.policyType));
      if (q.status) clauses.push(eq(insuranceRequirements.status, q.status));
      if (q.vendorId) clauses.push(eq(insuranceRequirements.vendorId, q.vendorId));
      const where = and(...clauses);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(insuranceRequirements)
        .where(where);
      const rows = await app.db
        .select()
        .from(insuranceRequirements)
        .where(where)
        .orderBy(asc(insuranceRequirements.policyType))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return {
        ...paginate(
          rows.map((r) => ({ ...r, scope: r.projectId ? "project" : "company" })),
          Number(totalRow?.n ?? 0),
          q,
        ),
        note:
          rows.length === 0
            ? "No insurance requirement is recorded for this project. Until one is, cover gaps " +
              "cannot be asserted and no payment can be held on insurance grounds — the platform " +
              "will say 'not known', never 'compliant'."
            : null,
      };
    },
  );

  app.patch(
    "/projects/:projectId/insurance/requirements/:requirementId",
    { preHandler: standardGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = requirementPatchSchema.parse(req.body);
      const existing = await fetchRequirement(requirementId, req.companyId!);
      if (existing.projectId !== req.projectId) {
        throw badRequest(
          "This is a company-wide standard — edit it through /insurance/requirements/:id so the " +
            "company role applies. Editing it here would change every project's requirement set.",
        );
      }
      if (existing.status !== "required") {
        throw conflict(
          `A ${existing.status} requirement is part of the record. Record a new requirement rather ` +
            "than editing a waived or superseded one.",
        );
      }
      if (body.vendorId) await assertVendor(body.vendorId, req.companyId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (k === "waiverOfSubrogation" || k === "additionalInsuredRequired") set[k] = v ? 1 : 0;
        else set[k] = v;
      }
      await app.db
        .update(insuranceRequirements)
        .set(set)
        .where(eq(insuranceRequirements.id, requirementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "insurance_requirement",
        objectId: requirementId,
        payload: { changed: Object.keys(body) },
        projectId: req.projectId!,
        storePayload: true,
      });
      return fetchRequirement(requirementId, req.companyId!);
    },
  );

  /**
   * Waiving a requirement is a DECISION, not an edit, so it has its own route
   * that records who took it and why. A requirement that quietly stops
   * existing is how a cover gap becomes invisible rather than accepted.
   */
  app.post(
    "/projects/:projectId/insurance/requirements/:requirementId/waive",
    { preHandler: adminGate },
    async (req) => {
      const { requirementId } = req.params as { requirementId: string };
      const body = requirementWaiveSchema.parse(req.body);
      const existing = await fetchRequirement(requirementId, req.companyId!);
      if (existing.projectId !== req.projectId) {
        throw badRequest("A company-wide standard is waived through /insurance/requirements/:id/waive");
      }
      if (existing.status !== "required") {
        throw conflict(`This requirement is already ${existing.status}`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(insuranceRequirements)
        .set({
          status: "waived",
          waivedBy: req.user!.id,
          waivedAt: now,
          waiverReason: body.reason,
          updatedAt: now,
        })
        .where(eq(insuranceRequirements.id, requirementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "insurance_requirement",
        objectId: requirementId,
        payload: {
          from: "required",
          to: "waived",
          reason: body.reason,
          policyType: existing.policyType,
          requiredByClause: existing.requiredByClause,
        },
        projectId: req.projectId!,
        storePayload: true,
      });
      return fetchRequirement(requirementId, req.companyId!);
    },
  );

  /* ---- company-wide standards ------------------------------------- */

  app.get("/insurance/requirements", { preHandler: companyScopedRead }, async (req) => {
    const q = requirementListQuery.parse(req.query);
    const scope = scopeOf(req);
    const clauses = [eq(insuranceRequirements.companyId, req.companyId!)];
    const visible = scopeProjectsOrCompanyWide(scope, insuranceRequirements.projectId);
    if (visible) clauses.push(visible);
    if (q.policyType) clauses.push(eq(insuranceRequirements.policyType, q.policyType));
    if (q.status) clauses.push(eq(insuranceRequirements.status, q.status));
    if (q.vendorId) clauses.push(eq(insuranceRequirements.vendorId, q.vendorId));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(insuranceRequirements)
      .where(where);
    const rows = await app.db
      .select()
      .from(insuranceRequirements)
      .where(where)
      .orderBy(asc(insuranceRequirements.policyType))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, scope: r.projectId ? "project" : "company" })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/insurance/requirements", { preHandler: companyWrite }, async (req, reply) => {
    const body = requirementCreateSchema.parse(req.body);
    const id = await insertRequirement(req.companyId!, null, req.user!.id, body);
    return reply.status(201).send(await fetchRequirement(id, req.companyId!));
  });

  app.post("/insurance/requirements/:requirementId/waive", { preHandler: companyWrite }, async (req) => {
    const { requirementId } = req.params as { requirementId: string };
    const body = requirementWaiveSchema.parse(req.body);
    const existing = await fetchRequirement(requirementId, req.companyId!);
    if (existing.projectId) {
      throw badRequest(
        "This is a project requirement — waive it through the project route so the project's tool " +
          "permissions apply",
      );
    }
    if (existing.status !== "required") throw conflict(`This requirement is already ${existing.status}`);
    const now = new Date().toISOString();
    await app.db
      .update(insuranceRequirements)
      .set({
        status: "waived",
        waivedBy: req.user!.id,
        waivedAt: now,
        waiverReason: body.reason,
        updatedAt: now,
      })
      .where(eq(insuranceRequirements.id, requirementId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "insurance_requirement",
      objectId: requirementId,
      payload: { from: "required", to: "waived", reason: body.reason, scope: "company" },
      storePayload: true,
    });
    return fetchRequirement(requirementId, req.companyId!);
  });

  /* ================================================================ */
  /* WORDING COMPLIANCE — does the programme match the clause?         */
  /* ================================================================ */

  async function buildWordingChecks(companyId: string, projectId: string | null) {
    const asOf = todayISO();
    const scope = await loadScope(companyId, projectId);
    const requirements = (await loadRequirements(companyId)).filter(
      (r) =>
        r.status === "required" &&
        (projectId === null ? r.projectId === null : r.projectId === null || r.projectId === projectId),
    );
    const conditionsById = new Map<string, unknown>(
      scope.policies.map((p) => [p.id, (p as { conditions?: unknown }).conditions ?? []]),
    );
    let worksEnd: string | null = null;
    if (projectId) {
      const [project] = await app.db
        .select({ finishDate: projects.finishDate })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1);
      worksEnd = project?.finishDate ?? null;
    }
    const checks = requirements.map((r) =>
      checkRequirement(r, scope.policies, asOf, { worksEnd, conditionsById }),
    );
    const findings = checks.flatMap((c) => c.findings);
    return {
      asOf,
      projectId,
      requirements: requirements.length,
      compliant: checks.filter((c) => c.compliant).length,
      nonCompliant: checks.filter((c) => !c.compliant).length,
      checks,
      findingsBySeverity: {
        critical: findings.filter((f) => f.severity === "critical").length,
        high: findings.filter((f) => f.severity === "high").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        low: findings.filter((f) => f.severity === "low").length,
      },
      note:
        requirements.length === 0
          ? "No insurance requirement is recorded in this scope, so there is nothing to test the " +
            "wordings against. This is not a clean bill of health — record the cover the contract " +
            "demands, clause by clause, first."
          : "Structured fields and the recorded policy conditions are what this reads. An " +
            "endorsement that exists only in the PDF and was never recorded will show as missing, " +
            "which is the honest answer: the register cannot evidence it.",
    };
  }

  app.get(
    "/projects/:projectId/insurance/wording-checks",
    { preHandler: readGate },
    async (req) => buildWordingChecks(req.companyId!, req.projectId!),
  );

  app.get("/insurance/wording-checks", { preHandler: companyScopedRead }, async (req) =>
    buildWordingChecks(req.companyId!, null),
  );

  /* ================================================================ */
  /* PERIOD COVER vs THE WORKS (#777)                                  */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/insurance/period-cover",
    { preHandler: readGate },
    async (req) => {
      const [project] = await app.db
        .select({
          id: projects.id,
          name: projects.name,
          startDate: projects.startDate,
          finishDate: projects.finishDate,
        })
        .from(projects)
        .where(and(eq(projects.id, req.projectId!), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!project) throw notFound("Project not found");
      const scope = await loadScope(req.companyId!, req.projectId!);
      const requirements = (await loadRequirements(req.companyId!)).filter(
        (r) => r.projectId === null || r.projectId === req.projectId,
      );
      const out = computePeriodGaps({
        projectId: project.id,
        worksStart: project.startDate,
        worksEnd: project.finishDate,
        requirements,
        policies: scope.policies,
      });
      return {
        projectId: project.id,
        worksStart: project.startDate,
        worksEnd: project.finishDate,
        requirements: requirements.filter((r) => r.status === "required").length,
        ...out,
      };
    },
  );

  /* ================================================================ */
  /* PREMIUM AND CLAIMS EXPERIENCE (#782)                              */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/insurance/policies/:policyId/premiums",
    { preHandler: standardGate },
    async (req, reply) => {
      const { policyId } = req.params as { policyId: string };
      const body = premiumCreateSchema.parse(req.body);
      const policy = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      const id = newId("iprm");
      await app.db.insert(insurancePremiums).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        policyId,
        kind: body.kind ?? "premium",
        amount: body.amount,
        currency: body.currency ?? policy.currency,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        dueDate: body.dueDate ?? null,
        paidAt: body.paidAt ?? null,
        reference: body.reference ?? null,
        note: body.note ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "insurance_premium",
        objectId: id,
        payload: {
          policyId,
          kind: body.kind ?? "premium",
          amount: body.amount,
          currency: body.currency ?? policy.currency,
        },
        projectId: req.projectId!,
        storePayload: true,
      });
      const [created] = await app.db
        .select()
        .from(insurancePremiums)
        .where(eq(insurancePremiums.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/insurance/policies/:policyId/premiums",
    { preHandler: readGate },
    async (req) => {
      const { policyId } = req.params as { policyId: string };
      await fetchPolicyForProject(policyId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(insurancePremiums)
        .where(
          and(
            eq(insurancePremiums.companyId, req.companyId!),
            eq(insurancePremiums.policyId, policyId),
          ),
        )
        .orderBy(desc(insurancePremiums.createdAt));
      const claimRows = await app.db
        .select()
        .from(insuranceClaims)
        .where(
          and(
            eq(insuranceClaims.companyId, req.companyId!),
            eq(insuranceClaims.policyId, policyId),
          ),
        );
      return {
        items: rows,
        total: rows.length,
        experience: computeExperience({
          premiums: rows,
          claims: claimRows.map(toClaimLike),
        }),
      };
    },
  );

  app.delete(
    "/projects/:projectId/insurance/premiums/:premiumId",
    { preHandler: adminGate },
    async (req, reply) => {
      const { premiumId } = req.params as { premiumId: string };
      const [row] = await app.db
        .select()
        .from(insurancePremiums)
        .where(
          and(
            eq(insurancePremiums.id, premiumId),
            eq(insurancePremiums.companyId, req.companyId!),
            eq(insurancePremiums.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Premium record not found");
      await app.db.delete(insurancePremiums).where(eq(insurancePremiums.id, premiumId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "insurance_premium",
        objectId: premiumId,
        payload: { policyId: row.policyId, amount: row.amount, currency: row.currency },
        projectId: req.projectId!,
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  async function buildExperience(companyId: string, projectId: string | null, visibleProjectIds: readonly string[] | null) {
    const inScope = <T extends { projectId: string | null }>(rows: readonly T[]): T[] =>
      visibleProjectIds === null
        ? [...rows]
        : rows.filter((r) => r.projectId === null || visibleProjectIds.includes(r.projectId));
    const premiumRows = inScope(
      await app.db
        .select()
        .from(insurancePremiums)
        .where(
          projectId
            ? and(
                eq(insurancePremiums.companyId, companyId),
                eq(insurancePremiums.projectId, projectId),
              )
            : eq(insurancePremiums.companyId, companyId),
        ),
    );
    const claimRows = inScope(
      await app.db
        .select()
        .from(insuranceClaims)
        .where(
          projectId
            ? and(eq(insuranceClaims.companyId, companyId), eq(insuranceClaims.projectId, projectId))
            : eq(insuranceClaims.companyId, companyId),
        ),
    );
    const policyRows = await app.db
      .select({ id: insurancePolicies.id, currency: insurancePolicies.currency, policyType: insurancePolicies.policyType })
      .from(insurancePolicies)
      .where(eq(insurancePolicies.companyId, companyId));
    const experience = computeExperience({
      premiums: premiumRows,
      claims: claimRows.map(toClaimLike),
      policyCurrency: new Map(policyRows.map((p) => [p.id, p.currency] as const)),
    });
    /* By policy type as well — the renewal conversation is per class. */
    const typeById = new Map(policyRows.map((p) => [p.id, p.policyType] as const));
    const types = [...new Set([...premiumRows, ...claimRows].map((r) => typeById.get(r.policyId) ?? "unknown"))];
    const byPolicyType = types.sort().map((policyType) => ({
      policyType,
      ...computeExperience({
        premiums: premiumRows.filter((p) => (typeById.get(p.policyId) ?? "unknown") === policyType),
        claims: claimRows
          .filter((c) => (typeById.get(c.policyId) ?? "unknown") === policyType)
          .map(toClaimLike),
      }),
    }));
    return {
      asOf: todayISO(),
      projectId,
      ...experience,
      byPolicyType,
      inputs: { premiumRows: premiumRows.length, claimRows: claimRows.length },
    };
  }

  app.get("/projects/:projectId/insurance/experience", { preHandler: readGate }, async (req) =>
    buildExperience(req.companyId!, req.projectId!, null),
  );

  app.get("/insurance/experience", { preHandler: companyScopedRead }, async (req) => {
    const scope = scopeOf(req);
    return buildExperience(req.companyId!, null, scope.all ? null : scope.projectIds);
  });

  /* ================================================================ */
  /* RENEWAL PIPELINE (#775)                                           */
  /* ================================================================ */

  async function renewalRows(
    companyId: string,
    projectId: string | null,
    visibleProjectIds: readonly string[] | null,
    q: z.infer<typeof renewalQuery>,
  ) {
    const scope = await loadScope(companyId, projectId);
    const policies =
      visibleProjectIds === null
        ? scope.policies
        : scope.policies.filter(
            (p) => p.projectId === null || visibleProjectIds.includes(p.projectId),
          );
    const rows = buildRenewalPipeline({
      policies: policies.map((p) => ({
        ...p,
        renewalStatus: (p as { renewalStatus?: string }).renewalStatus ?? "not_started",
        renewalOwnerId: (p as { renewalOwnerId?: string | null }).renewalOwnerId ?? null,
        renewalTargetDate: (p as { renewalTargetDate?: string | null }).renewalTargetDate ?? null,
        renewedByPolicyId: (p as { renewedByPolicyId?: string | null }).renewedByPolicyId ?? null,
      })),
      asOf: todayISO(),
      leadTimeDays: q.leadTimeDays,
      horizonDays: q.horizonDays,
    });
    return {
      asOf: todayISO(),
      horizonDays: q.horizonDays,
      leadTimeDays: q.leadTimeDays,
      items: rows,
      total: rows.length,
      byUrgency: {
        overdue: rows.filter((r) => r.urgency === "overdue").length,
        critical: rows.filter((r) => r.urgency === "critical").length,
        warning: rows.filter((r) => r.urgency === "warning").length,
        on_track: rows.filter((r) => r.urgency === "on_track").length,
      },
      note:
        rows.length === 0
          ? `No policy expires within ${q.horizonDays} days, or every one that does is already ` +
            "bound or explicitly not being renewed."
          : null,
    };
  }

  app.get("/projects/:projectId/insurance/renewals", { preHandler: readGate }, async (req) =>
    renewalRows(req.companyId!, req.projectId!, null, renewalQuery.parse(req.query)),
  );

  app.get("/insurance/renewals", { preHandler: companyScopedRead }, async (req) => {
    const scope = scopeOf(req);
    return renewalRows(
      req.companyId!,
      null,
      scope.all ? null : scope.projectIds,
      renewalQuery.parse(req.query),
    );
  });

  /**
   * Moving a policy along the renewal pipeline. Deliberately its own route
   * rather than a field on the policy PATCH: the renewal is a workflow with
   * an owner and a target date, and it must be recordable on a policy that is
   * otherwise frozen (expired, lapsed) — which is exactly when it matters.
   */
  app.post(
    "/projects/:projectId/insurance/policies/:policyId/renewal",
    { preHandler: standardGate },
    async (req) => {
      const { policyId } = req.params as { policyId: string };
      const body = renewalPatchSchema.parse(req.body);
      const policy = await fetchProjectPolicy(policyId, req.companyId!, req.projectId!);
      if (body.renewedByPolicyId) {
        await fetchPolicyForProject(body.renewedByPolicyId, req.companyId!, req.projectId!);
        if (body.renewedByPolicyId === policyId) {
          throw badRequest("A policy cannot renew itself");
        }
      }
      if (body.renewalStatus === "bound" && !body.renewedByPolicyId && !policy.renewedByPolicyId) {
        throw badRequest(
          "A renewal marked bound must name the policy that renews this one. 'Bound' with no " +
            "successor is the state a lapse hides in — record the new policy first.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(insurancePolicies)
        .set({
          renewalStatus: body.renewalStatus,
          renewalOwnerId: body.renewalOwnerId ?? policy.renewalOwnerId,
          renewalTargetDate: body.renewalTargetDate ?? policy.renewalTargetDate,
          renewalNotes: body.renewalNotes ?? policy.renewalNotes,
          renewedByPolicyId: body.renewedByPolicyId ?? policy.renewedByPolicyId,
          updatedAt: now,
        })
        .where(eq(insurancePolicies.id, policyId));
      if (body.renewedByPolicyId) {
        await app.db
          .update(insurancePolicies)
          .set({ previousPolicyId: policyId, updatedAt: now })
          .where(eq(insurancePolicies.id, body.renewedByPolicyId));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "insurance_policy",
        objectId: policyId,
        payload: {
          renewalFrom: policy.renewalStatus,
          renewalTo: body.renewalStatus,
          renewedByPolicyId: body.renewedByPolicyId ?? policy.renewedByPolicyId,
          renewalTargetDate: body.renewalTargetDate ?? policy.renewalTargetDate,
        },
        projectId: req.projectId!,
        storePayload: true,
      });
      return decoratePolicy(
        await fetchProjectPolicy(policyId, req.companyId!, req.projectId!),
        todayISO(),
      );
    },
  );

  /* ================================================================ */
  /* THE PAYMENT HOLD HOOK — what WP-FIN2 calls before releasing money */
  /* ================================================================ */

  app.get("/insurance/hold-check", { preHandler: companyScopedRead }, async (req) => {
    const q = holdQuery.parse(req.query);
    const scope = scopeOf(req);
    if (q.projectId && !scopeAllows(scope, q.projectId)) {
      throw forbidden("You do not hold insurance on that project");
    }
    const decision = await insuranceHoldDecision(app.db, {
      companyId: req.companyId!,
      projectId: q.projectId ?? null,
      vendorId: q.vendorId,
      asOf: q.asOf ?? todayISO(),
    });
    /* Reading a hold decision is an access event worth recording: it is the
       basis on which somebody's money was or was not released. */
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "insurance_hold_check",
      objectId: q.vendorId,
      payload: {
        projectId: q.projectId ?? null,
        hold: decision.hold,
        reasons: decision.findings.map((f) => f.reason),
      },
      projectId: q.projectId ?? null,
    });
    return decision;
  });

  app.get(
    "/projects/:projectId/insurance/hold-check",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({ vendorId: z.string().min(1).max(64), asOf: isoDateSchema.optional() })
        .parse(req.query);
      return insuranceHoldDecision(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        vendorId: q.vendorId,
        asOf: q.asOf ?? todayISO(),
      });
    },
  );

  /* ================================================================ */
  /* HEALTH INPUTS — what WP-INTEL reads                               */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/insurance/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const asOf = todayISO();
      const scope = await loadScope(companyId, projectId);
      /* The same resolution every other route uses — recorded requirements
         first, the legacy policy-clause inference only as a fallback for a
         scope that has none. A different answer here would make the health
         score disagree with the register it is scored from. */
      const requiredTypes = await requiredTypesFor(companyId, projectId);
      const vendorsAtWork = await loadVendorsAtWork(companyId, projectId, scope.bonds);
      const gapResult = computeCoverGaps({
        certificates: scope.certificates,
        vendorsAtWork,
        requiredPolicyTypes: requiredTypes,
        asOf,
      });
      const claimRows = await app.db
        .select()
        .from(insuranceClaims)
        .where(
          and(eq(insuranceClaims.companyId, companyId), eq(insuranceClaims.projectId, projectId)),
        );
      const openSignals = await app.db
        .select({ n: count() })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            inArray(signals.detector, [...INSURANCE_DETECTORS]),
            eq(signals.disposition, "open"),
          ),
        );
      const expiring = certificatesExpiringWithin(scope.certificates, asOf, 30);
      const lapsed = lapsedPolicies(scope.policies, asOf);
      const notificationsMissed = claimRows.filter(
        (c) => c.notifiedAt === null && c.notificationDueAt !== null && c.notificationDueAt < asOf,
      ).length;
      const reasons: string[] = [];
      if (requiredTypes === null) {
        reasons.push(
          "No insurance requirement is recorded for this project, so coverGaps is reported as " +
            "null rather than 0 — the absence of a requirement is not the absence of a gap.",
        );
      }
      if (scope.policies.length === 0) {
        reasons.push("No policy is recorded on this project, so cover cannot be assessed.");
      }
      return {
        metrics: {
          policies: scope.policies.length,
          policiesInForce: scope.policies.filter((p) => derivePolicyStatus(p, asOf) === "active")
            .length,
          policiesLapsed: lapsed.length,
          certificates: scope.certificates.length,
          certificatesInDate: scope.certificates.filter((c) => isCertificateInDate(c, asOf)).length,
          certificatesExpiring30d: expiring.length,
          certificatesUnverified: scope.certificates.filter(
            (c) => isCertificateInDate(c, asOf) && c.verifiedAt === null,
          ).length,
          coverGaps: gapResult.requirementsKnown ? gapResult.gaps.length : null,
          vendorsAtWork: vendorsAtWork.length,
          openClaims: claimRows.filter((c) =>
            ["notified", "acknowledged", "under_assessment", "accepted"].includes(c.status),
          ).length,
          claimNotificationsMissed: notificationsMissed,
          bondsLive: scope.bonds.filter((b) => b.status === "issued" || b.status === "active")
            .length,
          openInsuranceSignals: Number(openSignals[0]?.n ?? 0),
        },
        reasons,
      };
    },
  );

  /* ================================================================ */
  /* MANUAL SWEEP + SCHEDULED JOBS                                     */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/insurance/sweep",
    { preHandler: standardGate },
    async (req) => {
      const out = await sweepInsurance(req.companyId!, req.projectId!, req.user!.id);
      return { ...out, projectId: req.projectId, ranAt: new Date().toISOString() };
    },
  );

  app.post("/insurance/sweep", { preHandler: companyWrite }, async (req) => {
    const out = await sweepInsurance(req.companyId!, null, req.user!.id);
    return { ...out, projectId: null, ranAt: new Date().toISOString() };
  });

  app.scheduler.register({
    name: "insurance.expiry",
    description:
      "Expire policies, certificates and bonds whose dates have passed; raise lapse, cover-gap, period-gap, demand-deadline, uninsured-loss and overdue-renewal signals under the system actor. This used to run only when somebody opened an insurance page, so a policy nobody looked at never lapsed in the record and the resulting ledger entries were attributed to the reader",
    everyMs: 30 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const out = await sweepInsurance(companyId, null, null);
        return out.signals;
      }),
  });

  app.scheduler.register({
    name: "insurance.claim-notification-warnings",
    description:
      "Warn before a claim's notification period expires rather than only after. The notification deadline is usually a condition precedent to liability, so the useful signal is the one raised while the notice can still be given",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => warnClaimNotifications(companyId)),
  });

  /**
   * The warning nobody was getting: `warnDaysBefore` existed on the obligation
   * but nothing emitted anything before the date passed, so the platform's
   * first word on a condition precedent was that it had already been missed.
   */
  async function warnClaimNotifications(companyId: string): Promise<number> {
    const asOf = todayISO();
    const horizon = addDaysISO(asOf, CLAIM_WARN_DAYS);
    const rows = await app.db
      .select()
      .from(insuranceClaims)
      .where(
        and(
          eq(insuranceClaims.companyId, companyId),
          isNull(insuranceClaims.notifiedAt),
          isNotNull(insuranceClaims.notificationDueAt),
        ),
      );
    const due = rows.filter(
      (c) => c.notificationDueAt !== null && c.notificationDueAt >= asOf && c.notificationDueAt <= horizon,
    );
    if (due.length === 0) return 0;
    const keys = due.map((c) => `${c.id}:warn`);
    const seen = await alreadySignalled(companyId, "insurance_notification_missed", keys);
    let raised = 0;
    for (const claim of due) {
      const key = `${claim.id}:warn`;
      if (seen.has(key)) continue;
      seen.add(key);
      const daysLeft = daysBetweenISO(asOf, claim.notificationDueAt!);
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId: claim.projectId,
        detector: "insurance_notification_missed",
        severity: daysLeft <= 3 ? "critical" : "high",
        confidence: 1,
        title: `Claim notification due in ${daysLeft} day(s) — ${claim.number}`,
        explanation:
          `Claim ${claim.number} ("${claim.title}") became known on ${claim.awareDate} and must ` +
          `be notified to the insurer by ${claim.notificationDueAt}, which is ${daysLeft} day(s) ` +
          `away. Notification within the policy period is normally a condition precedent to ` +
          `liability: a good claim notified late is usually not a claim at all. This warning is ` +
          `raised BEFORE the date, because a warning that arrives after it is only a record of ` +
          `the loss.`,
        evidenceRefs: {
          key,
          claimId: claim.id,
          reference: claim.number,
          notificationDueAt: claim.notificationDueAt,
          awareDate: claim.awareDate,
          daysLeft,
        },
      });
      await appendLedger(app.db, {
        companyId,
        actorId: null,
        action: "create",
        objectType: "signal",
        objectId: claim.id,
        payload: { detector: "insurance_notification_missed", daysLeft, warning: true },
        projectId: claim.projectId,
      });
      raised += 1;
    }
    return raised;
  }
};
