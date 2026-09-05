import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import {
  covenantReadings,
  covenantWaivers,
  covenants,
  disbursementForecasts,
  disbursements,
  evidence,
  facilityCashflows,
  facilityConditions,
  fundingFacilities,
  ineligibleRecoveries,
  obligations,
  projects,
  scheduleTasks,
  signals,
} from "@constructos/db";
import {
  COVENANT_FORMULAS,
  COVENANT_OPERATORS,
  DAY_COUNT_CONVENTIONS,
  EXPENDITURE_ELIGIBILITY,
  FACILITY_CONDITION_KINDS,
  FACILITY_INSTRUMENTS,
  FACILITY_CASHFLOW_INPUTS,
  INELIGIBILITY_REASONS,
  INELIGIBLE_RECOVERY_STATUSES,
  type DayCountConvention,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  companyToolGate,
  isIndependentReviewer,
  visibleProjectIds,
} from "../governance/gates.js";
import {
  COVENANT_FORMULA_LIBRARY,
  computeCovenantReading,
  evaluateDrawStop,
  formulaSpec,
} from "./covenants.js";
import { buildAccrualSchedule, quarterEnds } from "./interest.js";
import {
  assessEligibility,
  bucketByCurrency,
  compareForecast,
  singleCurrencyTotal,
  type EligibilityEntry,
  type ForecastPeriod,
} from "./money.js";
import {
  covenantStanding,
  registerFinanceJobs,
  sweepDisbursementForecast,
  sweepOverdueConditions as sweepConditionsShared,
} from "./jobs.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const categoryInputSchema = z.object({
  /** present only when updating an existing category in place */
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(200),
  limit: z.number().positive(),
});

const facilityCreateSchema = z.object({
  name: z.string().min(1).max(300),
  lender: z.string().min(1).max(300),
  instrument: z.enum(FACILITY_INSTRUMENTS),
  currency: z.string().length(3).optional(),
  committedAmount: z.number().positive(),
  availabilityEndDate: isoDateSchema.nullable().optional(),
  categories: z.array(categoryInputSchema).max(100).optional(),
  baseRatePercent: z.number().min(0).max(100).nullable().optional(),
  marginPercent: z.number().min(0).max(100).nullable().optional(),
  commitmentFeePercent: z.number().min(0).max(100).nullable().optional(),
  dayCountConvention: z.enum(DAY_COUNT_CONVENTIONS).optional(),
  capitaliseInterest: z.boolean().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const facilityPatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  lender: z.string().min(1).max(300).optional(),
  availabilityEndDate: isoDateSchema.nullable().optional(),
  categories: z.array(categoryInputSchema).max(100).optional(),
  baseRatePercent: z.number().min(0).max(100).nullable().optional(),
  marginPercent: z.number().min(0).max(100).nullable().optional(),
  commitmentFeePercent: z.number().min(0).max(100).nullable().optional(),
  dayCountConvention: z.enum(DAY_COUNT_CONVENTIONS).optional(),
  capitaliseInterest: z.boolean().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const conditionCreateSchema = z.object({
  kind: z.enum(FACILITY_CONDITION_KINDS),
  reference: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(10000),
  dueDate: isoDateSchema.nullable().optional(),
});

const satisfySchema = z.object({
  /** conditions are satisfied WITH EVIDENCE — at least one item (#731) */
  evidenceIds: z.array(z.string().min(1)).min(1).max(100),
});

const waiveSchema = z.object({ reason: z.string().min(1).max(10000) });

const disbursementCreateSchema = z.object({
  amount: z.number().positive(),
  categoryId: z.string().min(1).nullable().optional(),
  purpose: z.string().min(1).max(10000),
  evidenceIds: z.array(z.string().min(1)).max(200).optional(),
});

const disburseSchema = z.object({ disbursedAt: isoTimestamp.optional() });

const certifySchema = z.object({
  note: z.string().max(10000).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
});

/** Per-item eligibility classification on a withdrawal application (#736-737). */
const eligibilityPutSchema = z.object({
  entries: z
    .array(
      z.object({
        evidenceId: z.string().min(1),
        eligibility: z.enum(EXPENDITURE_ELIGIBILITY),
        reason: z.enum(INELIGIBILITY_REASONS).nullable().optional(),
        amount: z.number().nonnegative().nullable().optional(),
        note: z.string().max(5000).nullable().optional(),
      }),
    )
    .max(200),
});

const forecastCreateSchema = z.object({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  plannedAmount: z.number().positive(),
  categoryId: z.string().min(1).nullable().optional(),
  milestoneTaskId: z.string().min(1).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
});

const cashflowPutSchema = z.object({
  periodEnd: isoDateSchema,
  inputs: z.record(z.enum(FACILITY_CASHFLOW_INPUTS), z.number().finite()),
  note: z.string().max(5000).nullable().optional(),
});

const covenantWaiveSchema = z.object({
  reason: z.string().min(1).max(10000),
  lenderReference: z.string().max(200).nullable().optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(50).optional(),
});

const recoveryCreateSchema = z.object({
  disbursementId: z.string().min(1).nullable().optional(),
  evidenceId: z.string().min(1).nullable().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  reason: z.enum(INELIGIBILITY_REASONS),
  detail: z.string().max(10000).nullable().optional(),
});

const recoveryResolveSchema = z.object({
  status: z.enum(INELIGIBLE_RECOVERY_STATUSES).exclude(["open"]),
  note: z.string().max(5000).nullable().optional(),
});

const costOfFinanceQuery = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

const rejectSchema = z.object({ reason: z.string().min(1).max(10000) });

const covenantCreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  operator: z.enum(COVENANT_OPERATORS),
  threshold: z.number().finite(),
  unit: z.string().max(50).nullable().optional(),
  /** a named ratio computed from the period cashflows, or custom for manual entry (#743) */
  formula: z.enum(COVENANT_FORMULAS).default("custom"),
  testFrequencyMonths: z.number().int().min(1).max(24).nullable().optional(),
});

const readingCreateSchema = z.object({
  readingDate: isoDateSchema,
  value: z.number().finite(),
  note: z.string().max(10000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface FacilityCategory {
  id: string;
  name: string;
  limit: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const EPS = 1e-9;

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/** Statuses that consume facility headroom (draft/rejected do not). */
const PIPELINE_STATUSES = ["submitted", "approved", "disbursed"] as const;

/**
 * Instruments on which an independent engineer must certify before money
 * moves (#738). Loans and blended packages are the IFI case; a grant or an
 * equity injection does not carry the same requirement.
 */
const CERTIFICATION_REQUIRED_INSTRUMENTS: readonly string[] = ["loan", "blended"];

/**
 * Covenant headroom, signed toward compliance (#743): positive headroom is
 * the margin by which the reading complies, negative headroom is the depth
 * of the breach — for a `gte` covenant that is value − threshold, for a
 * `lte` covenant it is threshold − value.
 */
function covenantHeadroom(operator: string, value: number, threshold: number): number {
  return round2(operator === "gte" ? value - threshold : threshold - value);
}

function covenantCompliant(operator: string, value: number, threshold: number): boolean {
  return operator === "gte" ? value >= threshold : value <= threshold;
}

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Project finance & disbursement — spec Vol II Domain O / M14 (#729-743,
 * #769 subset): funding facility register (#729), condition precedent /
 * subsequent tracking materialized as assurance Obligations (#730-731),
 * disbursement request assembly (#732), the lender conditionality gate —
 * money does not move while a condition precedent is open (#733-734),
 * statement of expenditure (#735, #769), category/allocation limits (#739),
 * undisbursed balance and closing-date monitoring (#740-741), and covenant
 * compliance with signed headroom (#742-743).
 */
export const financeModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("finance", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("finance", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("finance", "admin")];
  const companyReadGate = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "finance", "read"),
  ];

  async function fetchFacility(facilityId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(fundingFacilities)
      .where(
        and(
          eq(fundingFacilities.id, facilityId),
          eq(fundingFacilities.companyId, companyId),
          eq(fundingFacilities.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Funding facility not found");
    return rows[0];
  }

  async function fetchCondition(conditionId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(facilityConditions)
      .where(
        and(
          eq(facilityConditions.id, conditionId),
          eq(facilityConditions.companyId, companyId),
          eq(facilityConditions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Facility condition not found");
    return rows[0];
  }

  async function fetchDisbursement(disbursementId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(disbursements)
      .where(
        and(
          eq(disbursements.id, disbursementId),
          eq(disbursements.companyId, companyId),
          eq(disbursements.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Disbursement not found");
    return rows[0];
  }

  async function fetchCovenant(covenantId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(covenants)
      .where(
        and(
          eq(covenants.id, covenantId),
          eq(covenants.companyId, companyId),
          eq(covenants.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Covenant not found");
    return rows[0];
  }

  /** Each evidence id must reference evidence captured in THIS project. */
  async function validateEvidence(
    companyId: string,
    projectId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const rows = await app.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          inArray(evidence.id, unique),
          eq(evidence.companyId, companyId),
          eq(evidence.projectId, projectId),
        ),
      );
    if (rows.length !== unique.length) {
      throw badRequest("evidenceIds must reference evidence records in this project");
    }
  }

  /**
   * Refresh overdue condition state before a read.
   *
   * This used to write signals and ledger `state_change` rows with
   * `actorId = req.user.id`, on routes gated at READ. An auditor or
   * regulator with read-only access became the recorded actor of
   * "facility condition breached" transitions they did not perform — a
   * false entry in the one record the platform sells as trustworthy. The
   * sweep now lives in jobs.ts, runs on a schedule, and attributes every
   * transition to the system principal (`actorId: null`). The read path
   * still calls it so a page opened between cycles is current, but the
   * reader is not blamed for what it finds.
   */
  async function sweepOverdueConditions(companyId: string, projectId: string): Promise<void> {
    await sweepConditionsShared(app.db, companyId, todayISO(), projectId);
  }
  function parseCategories(facility: { categories: unknown[] }): FacilityCategory[] {
    return facility.categories as FacilityCategory[];
  }

  /**
   * Aggregate view-model fields for one facility (#739-741).
   *
   * `remaining` and `undisbursed` used to count only DISBURSED requests,
   * while the submit gate counted submitted + approved + disbursed. The
   * category picker offered "Civil works — 500,000 remaining" and then
   * refused a 400,000 request because 300,000 was already approved but
   * unpaid: two contradictory numbers on the same screen. Both figures
   * are now returned — `disbursed` (money that has moved) and `pipeline`
   * (money committed to move) — plus `available`, which is what the
   * picker must show because it is what the gate enforces.
   */
  function facilityAggregates(
    facility: typeof fundingFacilities.$inferSelect,
    rows: (typeof disbursements.$inferSelect)[],
    conds: (typeof facilityConditions.$inferSelect)[],
  ) {
    const disbursed = round2(
      rows.filter((d) => d.status === "disbursed").reduce((s, d) => s + d.amount, 0),
    );
    const inPipeline = rows.filter((d) =>
      (PIPELINE_STATUSES as readonly string[]).includes(d.status),
    );
    const pipeline = round2(inPipeline.reduce((s, d) => s + d.amount, 0));
    const cats = parseCategories(facility).map((c) => {
      const catDisbursed = round2(
        rows
          .filter((d) => d.status === "disbursed" && d.categoryId === c.id)
          .reduce((s, d) => s + d.amount, 0),
      );
      const catPipeline = round2(
        inPipeline.filter((d) => d.categoryId === c.id).reduce((s, d) => s + d.amount, 0),
      );
      return {
        id: c.id,
        name: c.name,
        limit: c.limit,
        disbursed: catDisbursed,
        pipeline: catPipeline,
        /** limit less everything disbursed or in flight — what the gate allows */
        available: round2(c.limit - catPipeline),
        remaining: round2(c.limit - catDisbursed),
      };
    });
    return {
      disbursed,
      pipeline,
      available: round2(facility.committedAmount - pipeline),
      undisbursed: round2(facility.committedAmount - disbursed),
      // "open" in the lender's sense: not yet satisfied or waived — an
      // overdue (breached) condition is still outstanding.
      openConditions: conds.filter((c) => c.status === "open" || c.status === "breached").length,
      pendingRequests: rows.filter((d) => d.status === "submitted" || d.status === "approved")
        .length,
      daysToClosing: facility.availabilityEndDate ? daysUntil(facility.availabilityEndDate) : null,
      categories: cats,
    };
  }

  /**
   * The headroom invariant (#739-741): the PIPELINE — submitted, approved
   * and disbursed together — may never exceed the committed amount or a
   * category limit. Draft and rejected requests consume nothing.
   *
   * Called inside the transaction that holds the facility row lock, from
   * both submit and approve. One definition, so the two stages can never
   * enforce different arithmetic — which is exactly how 12M got paid
   * against 10M committed before.
   */
  function checkHeadroom(
    facility: typeof fundingFacilities.$inferSelect,
    siblings: (typeof disbursements.$inferSelect)[],
    request: typeof disbursements.$inferSelect,
  ): void {
    const pipeline = siblings.filter(
      (x) => x.id !== request.id && (PIPELINE_STATUSES as readonly string[]).includes(x.status),
    );
    const usedTotal = round2(pipeline.reduce((sum, x) => sum + x.amount, 0));
    const availableTotal = round2(facility.committedAmount - usedTotal);
    if (request.amount > availableTotal + EPS) {
      throw conflict(
        `Amount ${request.amount} exceeds the undisbursed balance ${availableTotal} of ${facility.name} ` +
          `(committed ${facility.committedAmount}, in pipeline or disbursed ${usedTotal})`,
      );
    }
    if (request.categoryId) {
      const cat = parseCategories(facility).find((c) => c.id === request.categoryId);
      if (!cat) throw badRequest("categoryId no longer exists on this facility");
      const usedCat = round2(
        pipeline
          .filter((x) => x.categoryId === request.categoryId)
          .reduce((sum, x) => sum + x.amount, 0),
      );
      const availableCat = round2(cat.limit - usedCat);
      if (request.amount > availableCat + EPS) {
        throw conflict(
          `Amount ${request.amount} exceeds the remaining allocation ${availableCat} of category ` +
            `"${cat.name}" (limit ${cat.limit}, in pipeline or disbursed ${usedCat})`,
        );
      }
    }
  }

  registerFinanceJobs(app);

  /* ---------------------------------------------------------------- */
  /* Facilities (#729, #739-741)                                       */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/facilities", { preHandler: standardGate }, async (req, reply) => {
    const body = facilityCreateSchema.parse(req.body);
    const categories: FacilityCategory[] = (body.categories ?? []).map((c) => ({
      id: newId("fct"), // server-assigned — client-supplied ids are ignored on create
      name: c.name,
      limit: c.limit,
    }));
    const limitSum = round2(categories.reduce((s, c) => s + c.limit, 0));
    if (limitSum > body.committedAmount + EPS) {
      throw badRequest(
        `Category limits total ${limitSum}, exceeding the committed amount ${body.committedAmount}`,
      );
    }
    const id = newId("fac");
    await app.db.insert(fundingFacilities).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      lender: body.lender,
      instrument: body.instrument,
      currency: body.currency ?? "GBP",
      committedAmount: body.committedAmount,
      availabilityEndDate: body.availabilityEndDate ?? null,
      categories,
      baseRatePercent: body.baseRatePercent ?? null,
      marginPercent: body.marginPercent ?? null,
      commitmentFeePercent: body.commitmentFeePercent ?? null,
      dayCountConvention: body.dayCountConvention ?? "actual_365",
      capitaliseInterest: body.capitaliseInterest ? 1 : 0,
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "funding_facility",
      objectId: id,
      payload: {
        name: body.name,
        lender: body.lender,
        instrument: body.instrument,
        committedAmount: body.committedAmount,
        categories,
      },
      storePayload: true,
    });
    const created = await fetchFacility(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/facilities", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    await sweepOverdueConditions(req.companyId!, req.projectId!);
    const where = and(
      eq(fundingFacilities.companyId, req.companyId!),
      eq(fundingFacilities.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(fundingFacilities).where(where);
    const rows = await app.db
      .select()
      .from(fundingFacilities)
      .where(where)
      .orderBy(desc(fundingFacilities.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const ids = rows.map((f) => f.id);
    const allDisb = ids.length
      ? await app.db.select().from(disbursements).where(inArray(disbursements.facilityId, ids))
      : [];
    const allConds = ids.length
      ? await app.db
          .select()
          .from(facilityConditions)
          .where(inArray(facilityConditions.facilityId, ids))
      : [];
    const items = rows.map((f) => ({
      ...f,
      ...facilityAggregates(
        f,
        allDisb.filter((d) => d.facilityId === f.id),
        allConds.filter((c) => c.facilityId === f.id),
      ),
    }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/facilities/:facilityId",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      await fetchFacility(facilityId, req.companyId!, req.projectId!); // 404 before sweeping
      await sweepOverdueConditions(req.companyId!, req.projectId!);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const conds = await app.db
        .select()
        .from(facilityConditions)
        .where(eq(facilityConditions.facilityId, facilityId))
        .orderBy(asc(facilityConditions.createdAt));
      const rows = await app.db
        .select()
        .from(disbursements)
        .where(eq(disbursements.facilityId, facilityId))
        .orderBy(asc(disbursements.number));
      const covs = await app.db
        .select()
        .from(covenants)
        .where(eq(covenants.facilityId, facilityId))
        .orderBy(asc(covenants.createdAt));
      const readings = covs.length
        ? await app.db
            .select()
            .from(covenantReadings)
            .where(
              inArray(
                covenantReadings.covenantId,
                covs.map((c) => c.id),
              ),
            )
            .orderBy(asc(covenantReadings.readingDate), asc(covenantReadings.createdAt))
        : [];
      const covenantItems = covs.map((c) => {
        const series = readings.filter((r) => r.covenantId === c.id);
        const latest = series[series.length - 1] ?? null;
        return {
          ...c,
          latestReading: latest,
          compliant: latest ? latest.compliant === 1 : null,
          headroom: latest ? latest.headroom : null,
        };
      });
      return {
        ...facility,
        ...facilityAggregates(facility, rows, conds),
        conditions: conds,
        disbursements: rows,
        covenants: covenantItems,
      };
    },
  );

  app.patch(
    "/projects/:projectId/facilities/:facilityId",
    { preHandler: standardGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = facilityPatchSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.name !== undefined) set["name"] = body.name;
      if (body.lender !== undefined) set["lender"] = body.lender;
      if (body.availabilityEndDate !== undefined) {
        set["availabilityEndDate"] = body.availabilityEndDate;
      }
      if (body.notes !== undefined) set["notes"] = body.notes;
      if (body.baseRatePercent !== undefined) set["baseRatePercent"] = body.baseRatePercent;
      if (body.marginPercent !== undefined) set["marginPercent"] = body.marginPercent;
      if (body.commitmentFeePercent !== undefined) {
        set["commitmentFeePercent"] = body.commitmentFeePercent;
      }
      if (body.dayCountConvention !== undefined) {
        set["dayCountConvention"] = body.dayCountConvention;
      }
      if (body.capitaliseInterest !== undefined) {
        set["capitaliseInterest"] = body.capitaliseInterest ? 1 : 0;
      }
      if (body.categories !== undefined) {
        const existing = parseCategories(facility);
        const existingIds = new Set(existing.map((c) => c.id));
        const next: FacilityCategory[] = body.categories.map((c) => {
          if (c.id && !existingIds.has(c.id)) {
            throw badRequest(`Unknown category id ${c.id} on this facility`);
          }
          return { id: c.id ?? newId("fct"), name: c.name, limit: c.limit };
        });
        const nextIds = new Set(next.map((c) => c.id));
        const limitSum = round2(next.reduce((s, c) => s + c.limit, 0));
        if (limitSum > facility.committedAmount + EPS) {
          throw badRequest(
            `Category limits total ${limitSum}, exceeding the committed amount ${facility.committedAmount}`,
          );
        }
        // A category can only be removed while nothing has been drawn or is
        // being drawn against it (#739) — rejected requests do not pin it.
        const removed = existing.filter((c) => !nextIds.has(c.id));
        if (removed.length > 0) {
          const referencing = await app.db
            .select({ categoryId: disbursements.categoryId, status: disbursements.status })
            .from(disbursements)
            .where(
              and(
                eq(disbursements.facilityId, facilityId),
                inArray(
                  disbursements.categoryId,
                  removed.map((c) => c.id),
                ),
              ),
            );
          const pinned = referencing.filter((d) => d.status !== "rejected");
          if (pinned.length > 0) {
            throw badRequest(
              "Cannot remove a category that disbursement requests are recorded against",
            );
          }
        }
        set["categories"] = next;
      }
      await app.db.update(fundingFacilities).set(set).where(eq(fundingFacilities.id, facilityId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "funding_facility",
        objectId: facilityId,
        payload: { changed: Object.keys(body) },
      });
      return fetchFacility(facilityId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Conditions precedent / subsequent (#730-731)                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/facilities/:facilityId/conditions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = conditionCreateSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      // The condition materialises as an assurance Obligation so the
      // facility clock and the obligation register see the same date.
      //
      // These used to be three separate statements: obligation, then
      // condition, then ledger. A failure after the first left an
      // obligation with no owning record on the register the platform sells
      // as trustworthy, and the caller got a 500 having partly committed.
      const obligationId = newId("obl");
      const id = newId("fcd");
      await app.db.transaction(async (tx) => {
      await tx.insert(obligations).values({
        id: obligationId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause: `${facility.name} — condition ${body.kind}`,
        trigger: body.description,
        deadline: body.dueDate ? `${body.dueDate}T23:59:59Z` : null,
        warnDaysBefore: body.dueDate ? 7 : null,
        evidenceRequirement: "Documentary evidence satisfying the facility condition",
        status: "open",
        createdBy: req.user!.id,
      });
      await tx.insert(facilityConditions).values({
        id,
        facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: body.kind,
        reference: body.reference ?? null,
        description: body.description,
        dueDate: body.dueDate ?? null,
        status: "open",
        obligationId,
      });
      await appendLedger(tx as never, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "facility_condition",
        objectId: id,
        payload: {
          facilityId: facility.id,
          kind: body.kind,
          reference: body.reference ?? null,
          dueDate: body.dueDate ?? null,
          obligationId,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      });
      const created = await fetchCondition(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/conditions",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const q = pageQuerySchema.parse(req.query);
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      await sweepOverdueConditions(req.companyId!, req.projectId!);
      const where = eq(facilityConditions.facilityId, facilityId);
      const [totalRow] = await app.db.select({ n: count() }).from(facilityConditions).where(where);
      const rows = await app.db
        .select()
        .from(facilityConditions)
        .where(where)
        .orderBy(asc(facilityConditions.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  app.post(
    "/projects/:projectId/facility-conditions/:conditionId/satisfy",
    { preHandler: standardGate },
    async (req) => {
      const { conditionId } = req.params as { conditionId: string };
      const body = satisfySchema.parse(req.body);
      const cond = await fetchCondition(conditionId, req.companyId!, req.projectId!);
      // A breached (overdue) condition can still be satisfied late — that is
      // exactly how a blocked disbursement pipeline gets unblocked.
      if (cond.status !== "open" && cond.status !== "breached") {
        throw badRequest(`A ${cond.status} condition cannot be satisfied`);
      }
      await validateEvidence(req.companyId!, req.projectId!, body.evidenceIds);
      const now = new Date().toISOString();
      await app.db
        .update(facilityConditions)
        .set({
          status: "satisfied",
          evidenceIds: body.evidenceIds,
          satisfiedAt: now,
          satisfiedBy: req.user!.id,
          updatedAt: now,
        })
        .where(eq(facilityConditions.id, conditionId));
      if (cond.obligationId) {
        // A late satisfaction does not rewrite the register: only a still-
        // open obligation flips to satisfied; a breached one stays breached.
        await app.db
          .update(obligations)
          .set({ status: "satisfied", satisfiedEvidenceId: body.evidenceIds[0] })
          .where(and(eq(obligations.id, cond.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "facility_condition",
        objectId: conditionId,
        payload: { from: cond.status, to: "satisfied", evidenceIds: body.evidenceIds },
        storePayload: true,
      });
      return fetchCondition(conditionId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/facility-conditions/:conditionId/waive",
    { preHandler: adminGate },
    async (req) => {
      const { conditionId } = req.params as { conditionId: string };
      const body = waiveSchema.parse(req.body);
      const cond = await fetchCondition(conditionId, req.companyId!, req.projectId!);
      if (cond.status !== "open" && cond.status !== "breached") {
        throw badRequest(`A ${cond.status} condition cannot be waived`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(facilityConditions)
        .set({ status: "waived", updatedAt: now })
        .where(eq(facilityConditions.id, conditionId));
      if (cond.obligationId) {
        // An explicit lender waiver supersedes the breach state.
        await app.db
          .update(obligations)
          .set({ status: "waived" })
          .where(
            and(
              eq(obligations.id, cond.obligationId),
              inArray(obligations.status, ["open", "breached"]),
            ),
          );
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "facility_condition",
        objectId: conditionId,
        payload: { from: cond.status, to: "waived", reason: body.reason },
        storePayload: true,
      });
      return fetchCondition(conditionId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Disbursements (#732-734, #740)                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/facilities/:facilityId/disbursements",
    { preHandler: standardGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = disbursementCreateSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      if (body.categoryId) {
        const cats = parseCategories(facility);
        if (!cats.some((c) => c.id === body.categoryId)) {
          throw badRequest("categoryId does not belong to this facility");
        }
      }
      await validateEvidence(req.companyId!, req.projectId!, body.evidenceIds ?? []);
      const number = await nextRecordNumber(app.db, req.projectId!, "disbursement");
      const id = newId("dsb");
      await app.db.insert(disbursements).values({
        id,
        facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        amount: body.amount,
        categoryId: body.categoryId ?? null,
        purpose: body.purpose,
        status: "draft",
        evidenceIds: body.evidenceIds ?? [],
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "disbursement",
        objectId: id,
        payload: {
          facilityId,
          number,
          amount: body.amount,
          categoryId: body.categoryId ?? null,
        },
        storePayload: true,
      });
      const created = await fetchDisbursement(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Draw-stop (#741, #747)                                            */
  /* ---------------------------------------------------------------- */

  /**
   * The lender's two absolute bars on money moving: the availability period
   * has ended, or a covenant is in breach with no recorded waiver.
   *
   * Neither was enforced. The covenant breach signal even SAID a breach
   * "may suspend further disbursements" while nothing suspended anything,
   * and a facility whose availability ended last quarter still accepted and
   * paid draws. Both are now checked at submit and at disburse — the two
   * moments a request enters and leaves the pipeline.
   */
  async function assertDrawable(
    facility: typeof fundingFacilities.$inferSelect,
    stage: "submitted" | "disbursed",
  ): Promise<void> {
    const today = todayISO();
    const standing = await covenantStanding(app.db, facility.id, today);
    const stop = evaluateDrawStop({
      availabilityEndDate: facility.availabilityEndDate,
      today,
      covenants: standing,
    });
    if (!stop.stopped) return;
    throw conflict(
      `This disbursement cannot be ${stage} against ${facility.name}: ${stop.reasons.join(" ")}` +
        (stop.breachedCovenantIds.length > 0
          ? " Record a lender waiver against the covenant if the lender has granted one."
          : ""),
    );
  }

  /**
   * The conditionality gate (#733-737, #739-741, #747) — the module's core
   * rule, now enforced atomically.
   *
   * What changed:
   *  - HEADROOM RACE. The sibling requests were loaded, the totals computed
   *    in memory and the status flipped, with no transaction and no lock.
   *    Two draft requests of 6M against a facility with 10M available both
   *    passed and both entered the pipeline; approve and disburse never
   *    re-checked, so 12M could be paid against 10M committed. The whole
   *    sequence now runs inside one transaction with the facility row locked
   *    FOR UPDATE.
   *  - ELIGIBILITY. Every attached evidence item must be classified
   *    eligible; an ineligible or unassessed item blocks submission (#736).
   *  - DRAW-STOP. Availability period and covenant standing are checked
   *    before anything moves (#741, #747).
   */
  app.post(
    "/projects/:projectId/disbursements/:disbursementId/submit",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "draft") {
        throw badRequest(`A ${d.status} disbursement cannot be submitted`);
      }
      // Refresh condition states first so an overdue CP blocks as breached.
      await sweepOverdueConditions(req.companyId!, req.projectId!);
      const facility = await fetchFacility(d.facilityId, req.companyId!, req.projectId!);
      await assertDrawable(facility, "submitted");

      // Eligibility of the attached expenditure (#736-737).
      const eligibility = assessEligibility(
        d.evidenceIds,
        (d.evidenceEligibility ?? []) as EligibilityEntry[],
      );
      if (!eligibility.submittable) {
        return reply.status(409).send({
          statusCode: 409,
          error: "ConflictError",
          message:
            "This withdrawal application cannot be submitted until every attached item is classified eligible: " +
            eligibility.reasons.join(" "),
          eligibility,
        });
      }

      const verifiedAt = new Date().toISOString();
      const blocking = await app.db
        .select()
        .from(facilityConditions)
        .where(
          and(
            eq(facilityConditions.facilityId, d.facilityId),
            eq(facilityConditions.kind, "precedent"),
            inArray(facilityConditions.status, ["open", "breached"]),
          ),
        )
        .orderBy(asc(facilityConditions.createdAt));
      const conditionality = {
        verifiedAt,
        openConditions: blocking.map((c) => ({
          id: c.id,
          reference: c.reference,
          description: c.description,
          status: c.status,
          dueDate: c.dueDate,
        })),
        eligibility: {
          total: eligibility.total,
          eligible: eligibility.eligible,
          ineligible: eligibility.ineligible,
          unassessed: eligibility.unassessed,
        },
      };
      // Persist the verification snapshot whether or not it passed.
      await app.db
        .update(disbursements)
        .set({ conditionality, updatedAt: verifiedAt })
        .where(eq(disbursements.id, disbursementId));
      if (blocking.length > 0) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "disbursement",
          objectId: disbursementId,
          payload: {
            event: "submit_blocked_by_conditionality",
            verifiedAt,
            openConditionIds: blocking.map((c) => c.id),
          },
          storePayload: true,
          projectId: req.projectId!,
        });
        return reply.status(409).send({
          statusCode: 409,
          error: "ConflictError",
          message:
            `Disbursement request cannot be submitted: ${blocking.length} condition(s) precedent ` +
            `on ${facility.name} remain unsatisfied`,
          openConditions: conditionality.openConditions,
        });
      }

      await app.db.transaction(async (tx) => {
        // Lock the facility: headroom is read, compared and consumed under
        // one lock, so two concurrent submits serialise instead of both
        // passing a stale check.
        const locked = (
          await tx
            .select()
            .from(fundingFacilities)
            .where(eq(fundingFacilities.id, d.facilityId))
            .for("update")
        )[0];
        if (!locked) throw notFound("Funding facility not found");
        const fresh = (
          await tx.select().from(disbursements).where(eq(disbursements.id, disbursementId)).limit(1)
        )[0];
        if (!fresh || fresh.status !== "draft") {
          throw conflict("This disbursement has already been submitted");
        }
        const siblings = await tx
          .select()
          .from(disbursements)
          .where(eq(disbursements.facilityId, d.facilityId));
        checkHeadroom(locked, siblings, fresh);
        await tx
          .update(disbursements)
          .set({ status: "submitted", submittedAt: verifiedAt, submittedBy: req.user!.id })
          .where(and(eq(disbursements.id, disbursementId), eq(disbursements.status, "draft")));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "disbursement",
          objectId: disbursementId,
          payload: {
            from: "draft",
            to: "submitted",
            verifiedAt,
            openConditions: 0,
            eligibleItems: eligibility.eligible,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/disbursements/:disbursementId/approve",
    { preHandler: adminGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "submitted") {
        throw badRequest(`A ${d.status} disbursement cannot be approved`);
      }
      // Separation of duties: neither the requester NOR the submitter may
      // approve. The old check looked at createdBy alone, so a request
      // created by A and submitted by B could be approved by B — two roles
      // collapsed into one person.
      if (d.createdBy === req.user!.id || d.submittedBy === req.user!.id) {
        throw forbidden(
          "Separation of duties: a disbursement request cannot be approved by the person who created or submitted it",
        );
      }
      const now = new Date().toISOString();
      await app.db.transaction(async (tx) => {
        const locked = (
          await tx
            .select()
            .from(fundingFacilities)
            .where(eq(fundingFacilities.id, d.facilityId))
            .for("update")
        )[0];
        if (!locked) throw notFound("Funding facility not found");
        const fresh = (
          await tx.select().from(disbursements).where(eq(disbursements.id, disbursementId)).limit(1)
        )[0];
        if (!fresh || fresh.status !== "submitted") {
          throw conflict("This disbursement is no longer awaiting approval");
        }
        // Re-check headroom at approval: conditions and other requests may
        // have moved since the request was submitted.
        const siblings = await tx
          .select()
          .from(disbursements)
          .where(eq(disbursements.facilityId, d.facilityId));
        checkHeadroom(locked, siblings, fresh);
        await tx
          .update(disbursements)
          .set({ status: "approved", approvedAt: now, approvedBy: req.user!.id, updatedAt: now })
          .where(and(eq(disbursements.id, disbursementId), eq(disbursements.status, "submitted")));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "disbursement",
          objectId: disbursementId,
          payload: { from: "submitted", to: "approved", headroomRechecked: true },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Independent certification (#738). On an IFI-financed project the
   * lender's technical adviser (LTA) or independent engineer certifies that
   * the expenditure was actually incurred on eligible works before the
   * money moves. It is a distinct role from the approver — that is the
   * whole point — so it needs the assurance grant, and it is refused to
   * anyone already in the chain.
   */
  app.post(
    "/projects/:projectId/disbursements/:disbursementId/certify",
    { preHandler: standardGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const body = certifySchema.parse(req.body ?? {});
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "approved") {
        throw badRequest(`Only an approved disbursement can be certified (this one is ${d.status})`);
      }
      if (d.certifiedAt) throw badRequest("This disbursement has already been certified");
      const independence = await isIndependentReviewer(app, req);
      if (!independence.independent) {
        throw forbidden(
          `Certification is the independent engineer's step. ${independence.basis} Grant the ` +
            `certifier an assurance role (integrity_reviewer or auditor), or have a company owner ` +
            `or admin certify.`,
        );
      }
      if (
        d.createdBy === req.user!.id ||
        d.submittedBy === req.user!.id ||
        d.approvedBy === req.user!.id
      ) {
        throw forbidden(
          "Separation of duties: the certifier cannot be the person who created, submitted or approved the request",
        );
      }
      if (body.evidenceIds && body.evidenceIds.length > 0) {
        await validateEvidence(req.companyId!, req.projectId!, body.evidenceIds);
      }
      const now = new Date().toISOString();
      await app.db
        .update(disbursements)
        .set({
          certifiedAt: now,
          certifiedBy: req.user!.id,
          certificationNote: body.note ?? null,
          certificationEvidenceIds: body.evidenceIds ?? [],
          updatedAt: now,
        })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: {
          event: "certified",
          basis: independence.basis,
          note: body.note ?? null,
          evidenceIds: body.evidenceIds ?? [],
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Pay it. This was `standard` with no separation-of-duties check at all,
   * so the requester could pay their own draw. It now needs finance:admin
   * and refuses anyone already in the chain, and it re-tests the draw-stop:
   * a covenant can breach between approval and payment.
   */
  app.post(
    "/projects/:projectId/disbursements/:disbursementId/disburse",
    { preHandler: adminGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const body = disburseSchema.parse(req.body ?? {});
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "approved") {
        throw badRequest(`Only an approved disbursement can be disbursed (this one is ${d.status})`);
      }
      if (
        d.createdBy === req.user!.id ||
        d.submittedBy === req.user!.id ||
        d.approvedBy === req.user!.id
      ) {
        throw forbidden(
          "Separation of duties: the person who created, submitted or approved a request cannot also pay it",
        );
      }
      const facility = await fetchFacility(d.facilityId, req.companyId!, req.projectId!);
      await assertDrawable(facility, "disbursed");
      // Loan and blended facilities are the DFI case: independent
      // certification is a precondition of payment. Grants, equity and
      // guarantees do not carry the same requirement, so certification is
      // recorded where it happens but not demanded.
      if (CERTIFICATION_REQUIRED_INSTRUMENTS.includes(facility.instrument) && !d.certifiedAt) {
        throw conflict(
          `A ${facility.instrument} facility requires independent certification before payment. ` +
            "Have the lender's technical adviser or independent engineer certify the request first.",
        );
      }
      const disbursedAt = body.disbursedAt
        ? new Date(body.disbursedAt).toISOString()
        : new Date().toISOString();
      await app.db.transaction(async (tx) => {
        const locked = (
          await tx
            .select()
            .from(fundingFacilities)
            .where(eq(fundingFacilities.id, d.facilityId))
            .for("update")
        )[0];
        if (!locked) throw notFound("Funding facility not found");
        const fresh = (
          await tx.select().from(disbursements).where(eq(disbursements.id, disbursementId)).limit(1)
        )[0];
        if (!fresh || fresh.status !== "approved") {
          throw conflict("This disbursement is no longer approved");
        }
        await tx
          .update(disbursements)
          .set({ status: "disbursed", disbursedAt, updatedAt: new Date().toISOString() })
          .where(and(eq(disbursements.id, disbursementId), eq(disbursements.status, "approved")));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "disbursement",
          objectId: disbursementId,
          payload: {
            from: "approved",
            to: "disbursed",
            disbursedAt,
            amount: d.amount,
            currency: locked.currency,
            certifiedBy: d.certifiedBy,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/disbursements/:disbursementId/reject",
    { preHandler: adminGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const body = rejectSchema.parse(req.body);
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "submitted" && d.status !== "approved") {
        throw badRequest(`A ${d.status} disbursement cannot be rejected`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(disbursements)
        .set({ status: "rejected", rejectionReason: body.reason, updatedAt: now })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: { from: d.status, to: "rejected", reason: body.reason },
        storePayload: true,
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/disbursements",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const q = pageQuerySchema.parse(req.query);
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const where = eq(disbursements.facilityId, facilityId);
      const [totalRow] = await app.db.select({ n: count() }).from(disbursements).where(where);
      const rows = await app.db
        .select()
        .from(disbursements)
        .where(where)
        .orderBy(asc(disbursements.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(rows, Number(totalRow?.n ?? 0), q);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Project finance summary (#739-742)                                */
  /* ---------------------------------------------------------------- */

  /**
   * The headline figures — per currency.
   *
   * This route used to add every facility's committed amount together and
   * the page labelled the total with the FIRST facility's currency. A
   * project with a USD 100m loan and a EUR 50m grant reported
   * "GBP 150,000,000 committed" on its dashboard: a wrong money figure in
   * the most prominent place on the screen. There is no exchange rate on
   * this platform, so the numbers are bucketed by currency and the single
   * total is returned only when every facility shares one. Otherwise the
   * total is an Unknowable — a null with the reason — and the buckets are
   * what the page must render.
   */
  app.get("/projects/:projectId/finance/summary", { preHandler: readGate }, async (req) => {
    await sweepOverdueConditions(req.companyId!, req.projectId!);
    const where = and(
      eq(fundingFacilities.companyId, req.companyId!),
      eq(fundingFacilities.projectId, req.projectId!),
    );
    const facs = await app.db
      .select()
      .from(fundingFacilities)
      .where(where)
      .orderBy(asc(fundingFacilities.createdAt));
    const allDisb = await app.db
      .select()
      .from(disbursements)
      .where(
        and(
          eq(disbursements.companyId, req.companyId!),
          eq(disbursements.projectId, req.projectId!),
        ),
      );
    const allConds = await app.db
      .select()
      .from(facilityConditions)
      .where(
        and(
          eq(facilityConditions.companyId, req.companyId!),
          eq(facilityConditions.projectId, req.projectId!),
        ),
      );

    const currencyOf = new Map(facs.map((f) => [f.id, f.currency]));
    const committedByCurrency = bucketByCurrency(
      facs.map((f) => ({ amount: f.committedAmount, currency: f.currency })),
    );
    const disbursedByCurrency = bucketByCurrency(
      allDisb
        .filter((d) => d.status === "disbursed")
        .map((d) => ({ amount: d.amount, currency: currencyOf.get(d.facilityId) ?? null })),
    );
    const pipelineByCurrency = bucketByCurrency(
      allDisb
        .filter((d) => (PIPELINE_STATUSES as readonly string[]).includes(d.status))
        .map((d) => ({ amount: d.amount, currency: currencyOf.get(d.facilityId) ?? null })),
    );
    const disbursedLookup = new Map(disbursedByCurrency.map((b) => [b.currency, b.amount]));
    const pipelineLookup = new Map(pipelineByCurrency.map((b) => [b.currency, b.amount]));
    const undisbursedByCurrency = committedByCurrency.map((b) => ({
      currency: b.currency,
      amount: round2(b.amount - (disbursedLookup.get(b.currency) ?? 0)),
      recordCount: b.recordCount,
    }));
    const availableByCurrency = committedByCurrency.map((b) => ({
      currency: b.currency,
      amount: round2(b.amount - (pipelineLookup.get(b.currency) ?? 0)),
      recordCount: b.recordCount,
    }));

    const byCategory = facs.flatMap((f) => {
      const rows = allDisb.filter((d) => d.facilityId === f.id);
      const inPipeline = rows.filter((d) =>
        (PIPELINE_STATUSES as readonly string[]).includes(d.status),
      );
      return parseCategories(f).map((c) => {
        const catDisbursed = round2(
          rows
            .filter((d) => d.status === "disbursed" && d.categoryId === c.id)
            .reduce((sum, d) => sum + d.amount, 0),
        );
        const catPipeline = round2(
          inPipeline.filter((d) => d.categoryId === c.id).reduce((sum, d) => sum + d.amount, 0),
        );
        return {
          facilityId: f.id,
          facilityName: f.name,
          currency: f.currency,
          id: c.id,
          name: c.name,
          limit: c.limit,
          disbursed: catDisbursed,
          pipeline: catPipeline,
          available: round2(c.limit - catPipeline),
          remaining: round2(c.limit - catDisbursed),
        };
      });
    });

    // Covenant status = worst of the LATEST reading per covenant:
    // breached > unknown (a covenant with no readings yet) > compliant;
    // null when the project has no covenants at all (#742). A breach with a
    // lender waiver in force is reported as `waived`, not `breached` — it is
    // not a draw-stop.
    const covs = await app.db
      .select()
      .from(covenants)
      .where(
        and(eq(covenants.companyId, req.companyId!), eq(covenants.projectId, req.projectId!)),
      );
    let covenantStatus: "breached" | "waived" | "unknown" | "compliant" | null = null;
    if (covs.length > 0) {
      const today = todayISO();
      const standings = (
        await Promise.all(facs.map((f) => covenantStanding(app.db, f.id, today)))
      ).flat();
      const anyBreached = standings.some((c) => c.compliant === false && c.waivedBy === null);
      const anyWaived = standings.some((c) => c.compliant === false && c.waivedBy !== null);
      const anyUnread = standings.some((c) => c.compliant === null);
      covenantStatus = anyBreached
        ? "breached"
        : anyWaived
          ? "waived"
          : anyUnread
            ? "unknown"
            : "compliant";
    }

    return {
      facilities: facs.length,
      committedByCurrency,
      disbursedByCurrency,
      pipelineByCurrency,
      undisbursedByCurrency,
      availableByCurrency,
      /** a single figure only when every facility shares one currency */
      committedTotal: singleCurrencyTotal(committedByCurrency, "committed funding"),
      disbursedTotal: singleCurrencyTotal(disbursedByCurrency, "disbursed funding"),
      undisbursedTotal: singleCurrencyTotal(undisbursedByCurrency, "undisbursed funding"),
      pendingRequests: allDisb.filter((d) => d.status === "submitted" || d.status === "approved")
        .length,
      awaitingCertification: allDisb.filter((d) => d.status === "approved" && !d.certifiedAt)
        .length,
      openConditions: allConds.filter((c) => c.status === "open" || c.status === "breached")
        .length,
      byCategory,
      covenantStatus,
      currencies: committedByCurrency.map((b) => b.currency),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Statement of expenditure (#735, #769)                             */
  /* ---------------------------------------------------------------- */

  async function buildStatement(facilityId: string, companyId: string, projectId: string) {
    const facility = await fetchFacility(facilityId, companyId, projectId);
    const rows = await app.db
      .select()
      .from(disbursements)
      .where(eq(disbursements.facilityId, facilityId))
      .orderBy(asc(disbursements.number));
    const catName = new Map(parseCategories(facility).map((c) => [c.id, c.name]));
    const items = rows.map((d) => ({
      number: d.number,
      date: new Date(d.disbursedAt ?? d.submittedAt ?? d.createdAt)
        .toISOString()
        .slice(0, 10),
      amount: d.amount,
      category: d.categoryId ? (catName.get(d.categoryId) ?? "") : "",
      purpose: d.purpose,
      status: d.status,
    }));
    const disbursed = round2(
      rows.filter((d) => d.status === "disbursed").reduce((s, d) => s + d.amount, 0),
    );
    const totals = {
      requested: round2(rows.reduce((s, d) => s + d.amount, 0)),
      disbursed,
      undisbursed: round2(facility.committedAmount - disbursed),
      rows: rows.length,
    };
    return { facility, items, totals };
  }

  app.get(
    "/projects/:projectId/facilities/:facilityId/statement",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const { facility, items, totals } = await buildStatement(
        facilityId,
        req.companyId!,
        req.projectId!,
      );
      return {
        facility: {
          id: facility.id,
          name: facility.name,
          lender: facility.lender,
          instrument: facility.instrument,
          currency: facility.currency,
          committedAmount: facility.committedAmount,
        },
        rows: items,
        totals,
      };
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/statement.csv",
    { preHandler: readGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const { facility, items, totals } = await buildStatement(
        facilityId,
        req.companyId!,
        req.projectId!,
      );
      const lines = [
        "number,date,amount,category,purpose,status",
        ...items.map((r) =>
          [r.number, r.date, r.amount, r.category, r.purpose, r.status].map(csvEscape).join(","),
        ),
        `TOTAL REQUESTED,,${totals.requested},,,`,
        `TOTAL DISBURSED,,${totals.disbursed},,,`,
        `UNDISBURSED,,${totals.undisbursed},,,`,
      ];
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="statement-${facility.id}.csv"`,
        )
        .send(lines.join("\n") + "\n");
    },
  );

  /* ---------------------------------------------------------------- */
  /* Covenants (#742-743)                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/facilities/:facilityId/covenants",
    { preHandler: standardGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = covenantCreateSchema.parse(req.body);
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const id = newId("cov");
      await app.db.insert(covenants).values({
        id,
        facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        description: body.description ?? null,
        operator: body.operator,
        threshold: body.threshold,
        unit: body.unit ?? null,
        formula: body.formula,
        testFrequencyMonths: body.testFrequencyMonths ?? null,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "covenant",
        objectId: id,
        payload: {
          facilityId,
          name: body.name,
          operator: body.operator,
          threshold: body.threshold,
        },
        storePayload: true,
      });
      const created = await fetchCovenant(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/covenants",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const covs = await app.db
        .select()
        .from(covenants)
        .where(eq(covenants.facilityId, facilityId))
        .orderBy(asc(covenants.createdAt));
      const readings = covs.length
        ? await app.db
            .select()
            .from(covenantReadings)
            .where(
              inArray(
                covenantReadings.covenantId,
                covs.map((c) => c.id),
              ),
            )
            .orderBy(asc(covenantReadings.readingDate), asc(covenantReadings.createdAt))
        : [];
      const items = covs.map((c) => {
        const series = readings.filter((r) => r.covenantId === c.id);
        const latest = series[series.length - 1] ?? null;
        return {
          ...c,
          latestReading: latest,
          compliant: latest ? latest.compliant === 1 : null,
          headroom: latest ? latest.headroom : null,
          readingsCount: series.length,
        };
      });
      return { items, total: items.length };
    },
  );

  app.post(
    "/projects/:projectId/covenants/:covenantId/readings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { covenantId } = req.params as { covenantId: string };
      const body = readingCreateSchema.parse(req.body);
      const covenant = await fetchCovenant(covenantId, req.companyId!, req.projectId!);
      const compliant = covenantCompliant(covenant.operator, body.value, covenant.threshold);
      const headroom = covenantHeadroom(covenant.operator, body.value, covenant.threshold);
      const id = newId("cvr");
      await app.db.insert(covenantReadings).values({
        id,
        covenantId,
        companyId: req.companyId!,
        readingDate: body.readingDate,
        value: body.value,
        compliant: compliant ? 1 : 0,
        headroom,
        note: body.note ?? null,
        recordedBy: req.user!.id,
      });
      if (!compliant) {
        // A covenant breach is a lender event of default risk — critical
        // signal, no obligation (the covenant is continuous, not dated).
        const opText = covenant.operator === "gte" ? "≥" : "≤";
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId: req.companyId!,
          projectId: req.projectId!,
          detector: "covenant_breach",
          severity: "critical",
          confidence: 1,
          title:
            `Covenant breach — ${covenant.name}: ${body.value} vs required ${opText} ` +
            `${covenant.threshold}${covenant.unit ? ` ${covenant.unit}` : ""}`,
          explanation:
            `The ${body.readingDate} reading of covenant "${covenant.name}" is ${body.value}` +
            `${covenant.unit ? ` ${covenant.unit}` : ""}, against a required level of ${opText} ` +
            `${covenant.threshold}. Headroom is ${headroom} (negative = depth of breach). ` +
            `A financial covenant breach typically constitutes a default or draw-stop event ` +
            `under the facility agreement and may suspend further disbursements.`,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "covenant_reading",
        objectId: id,
        payload: {
          covenantId,
          readingDate: body.readingDate,
          value: body.value,
          compliant,
          headroom,
        },
        storePayload: true,
      });
      const created = (
        await app.db.select().from(covenantReadings).where(eq(covenantReadings.id, id)).limit(1)
      )[0];
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/covenants/:covenantId/readings",
    { preHandler: readGate },
    async (req) => {
      const { covenantId } = req.params as { covenantId: string };
      const covenant = await fetchCovenant(covenantId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(covenantReadings)
        .where(eq(covenantReadings.covenantId, covenantId))
        .orderBy(asc(covenantReadings.readingDate), asc(covenantReadings.createdAt));
      return { covenant, items: rows, total: rows.length };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Expenditure eligibility (#736-737)                                */
  /* ---------------------------------------------------------------- */

  /**
   * Classify each attached item as eligible or ineligible for financing.
   * A withdrawal application carrying an ineligible or unassessed item
   * cannot be submitted — the whole point of the classification is that
   * "we didn't look" is not an answer a financier accepts.
   */
  app.put(
    "/projects/:projectId/disbursements/:disbursementId/eligibility",
    { preHandler: standardGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const body = eligibilityPutSchema.parse(req.body);
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "draft" && d.status !== "rejected") {
        throw badRequest(
          `Eligibility can only be classified while the request is draft or rejected (this one is ${d.status})`,
        );
      }
      const known = new Set(d.evidenceIds);
      const unknown = body.entries.filter((e) => !known.has(e.evidenceId));
      if (unknown.length > 0) {
        throw badRequest("Eligibility entries must reference evidence attached to this request", {
          unknownEvidenceIds: unknown.map((e) => e.evidenceId),
        });
      }
      for (const e of body.entries) {
        if (e.eligibility === "ineligible" && !e.reason) {
          throw badRequest(
            `Evidence ${e.evidenceId} is classified ineligible without a reason — an ineligibility finding must say why`,
          );
        }
      }
      const entries: EligibilityEntry[] = body.entries.map((e) => ({
        evidenceId: e.evidenceId,
        eligibility: e.eligibility,
        reason: e.reason ?? null,
        amount: e.amount ?? null,
        note: e.note ?? null,
      }));
      await app.db
        .update(disbursements)
        .set({ evidenceEligibility: entries, updatedAt: new Date().toISOString() })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: { eligibility: entries },
        storePayload: true,
        projectId: req.projectId!,
      });
      const assessment = assessEligibility(d.evidenceIds, entries);
      return { ...(await fetchDisbursement(disbursementId, req.companyId!, req.projectId!)), assessment };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Ineligible expenditure recoveries (#744)                          */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/facilities/:facilityId/recoveries",
    { preHandler: adminGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = recoveryCreateSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      if (body.disbursementId) {
        const d = await fetchDisbursement(body.disbursementId, req.companyId!, req.projectId!);
        if (d.facilityId !== facilityId) {
          throw badRequest("disbursementId belongs to a different facility");
        }
      }
      if (body.evidenceId) {
        await validateEvidence(req.companyId!, req.projectId!, [body.evidenceId]);
      }
      const id = newId("irc");
      await app.db.insert(ineligibleRecoveries).values({
        id,
        facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        disbursementId: body.disbursementId ?? null,
        evidenceId: body.evidenceId ?? null,
        amount: body.amount,
        currency: body.currency ?? facility.currency,
        reason: body.reason,
        detail: body.detail ?? null,
        status: "open",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "ineligible_recovery",
        objectId: id,
        payload: {
          facilityId,
          amount: body.amount,
          currency: body.currency ?? facility.currency,
          reason: body.reason,
          disbursementId: body.disbursementId ?? null,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(ineligibleRecoveries)
        .where(eq(ineligibleRecoveries.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/recoveries",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(ineligibleRecoveries)
        .where(
          and(
            eq(ineligibleRecoveries.facilityId, facilityId),
            eq(ineligibleRecoveries.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(ineligibleRecoveries.createdAt));
      return {
        items,
        total: items.length,
        openByCurrency: bucketByCurrency(
          items.filter((r) => r.status === "open").map((r) => ({ amount: r.amount, currency: r.currency })),
        ),
      };
    },
  );

  app.post(
    "/projects/:projectId/recoveries/:recoveryId/resolve",
    { preHandler: adminGate },
    async (req) => {
      const { recoveryId } = req.params as { recoveryId: string };
      const body = recoveryResolveSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(ineligibleRecoveries)
        .where(
          and(
            eq(ineligibleRecoveries.id, recoveryId),
            eq(ineligibleRecoveries.companyId, req.companyId!),
            eq(ineligibleRecoveries.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const recovery = rows[0];
      if (!recovery) throw notFound("Recovery not found");
      if (recovery.status !== "open") {
        throw badRequest(`A ${recovery.status} recovery cannot be resolved again`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(ineligibleRecoveries)
        .set({
          status: body.status,
          resolvedAt: now,
          resolvedBy: req.user!.id,
          resolutionNote: body.note ?? null,
          updatedAt: now,
        })
        .where(eq(ineligibleRecoveries.id, recoveryId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "ineligible_recovery",
        objectId: recoveryId,
        payload: { from: "open", to: body.status, amount: recovery.amount, note: body.note ?? null },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [after] = await app.db
        .select()
        .from(ineligibleRecoveries)
        .where(eq(ineligibleRecoveries.id, recoveryId))
        .limit(1);
      return after;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Drawdown forecast (#745-746)                                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/facilities/:facilityId/forecasts",
    { preHandler: standardGate },
    async (req, reply) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = forecastCreateSchema.parse(req.body);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      if (body.periodEnd <= body.periodStart) {
        throw badRequest("periodEnd must fall after periodStart");
      }
      if (body.categoryId && !parseCategories(facility).some((c) => c.id === body.categoryId)) {
        throw badRequest("categoryId does not belong to this facility");
      }
      if (body.milestoneTaskId) {
        const rows = await app.db
          .select({ id: scheduleTasks.id })
          .from(scheduleTasks)
          .where(
            and(
              eq(scheduleTasks.id, body.milestoneTaskId),
              eq(scheduleTasks.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!rows[0]) {
          throw badRequest("milestoneTaskId does not belong to a schedule on this project");
        }
      }
      const id = newId("dfc");
      await app.db.insert(disbursementForecasts).values({
        id,
        facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        plannedAmount: body.plannedAmount,
        categoryId: body.categoryId ?? null,
        milestoneTaskId: body.milestoneTaskId ?? null,
        note: body.note ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "disbursement_forecast",
        objectId: id,
        payload: {
          facilityId,
          periodEnd: body.periodEnd,
          plannedAmount: body.plannedAmount,
          milestoneTaskId: body.milestoneTaskId ?? null,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(disbursementForecasts)
        .where(eq(disbursementForecasts.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.delete(
    "/projects/:projectId/disbursement-forecasts/:forecastId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { forecastId } = req.params as { forecastId: string };
      const rows = await app.db
        .select({ id: disbursementForecasts.id })
        .from(disbursementForecasts)
        .where(
          and(
            eq(disbursementForecasts.id, forecastId),
            eq(disbursementForecasts.companyId, req.companyId!),
            eq(disbursementForecasts.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Forecast period not found");
      await app.db.delete(disbursementForecasts).where(eq(disbursementForecasts.id, forecastId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "disbursement_forecast",
        objectId: forecastId,
        payload: null,
        projectId: req.projectId!,
      });
      return reply.status(204).send();
    },
  );

  /** Planned vs actual drawdown, with the milestone test (#745-746). */
  app.get(
    "/projects/:projectId/facilities/:facilityId/forecast",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(disbursementForecasts)
        .where(eq(disbursementForecasts.facilityId, facilityId))
        .orderBy(asc(disbursementForecasts.periodEnd));
      const draws = await app.db
        .select()
        .from(disbursements)
        .where(eq(disbursements.facilityId, facilityId));
      const milestoneIds = [
        ...new Set(rows.map((r) => r.milestoneTaskId).filter((x): x is string => Boolean(x))),
      ];
      const tasks = milestoneIds.length
        ? await app.db
            .select({
              id: scheduleTasks.id,
              name: scheduleTasks.name,
              actualFinish: scheduleTasks.actualFinish,
            })
            .from(scheduleTasks)
            .where(inArray(scheduleTasks.id, milestoneIds))
        : [];
      const finished = new Map(tasks.map((t) => [t.id, t.actualFinish !== null]));
      const periods: ForecastPeriod[] = rows.map((r) => ({
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        plannedAmount: r.plannedAmount,
        milestoneTaskId: r.milestoneTaskId,
        milestoneComplete: r.milestoneTaskId ? (finished.get(r.milestoneTaskId) ?? false) : null,
      }));
      const comparison = compareForecast(
        periods,
        draws
          .filter((d) => d.status === "disbursed" && d.disbursedAt)
          .map((d) => ({ date: d.disbursedAt!.slice(0, 10), amount: d.amount })),
        todayISO(),
      );
      return {
        facilityId,
        currency: facility.currency,
        forecasts: rows,
        milestones: tasks,
        ...comparison,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Computed covenants and lender waivers (#743, #747)                */
  /* ---------------------------------------------------------------- */

  /** The formula library, read-only: named ratios anyone can check. */
  app.get("/finance/covenant-formulas", { preHandler: companyReadGate }, async () => ({
    formulas: COVENANT_FORMULA_LIBRARY,
    inputs: FACILITY_CASHFLOW_INPUTS,
  }));

  app.put(
    "/projects/:projectId/facilities/:facilityId/cashflows",
    { preHandler: standardGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const body = cashflowPutSchema.parse(req.body);
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const existing = await app.db
        .select()
        .from(facilityCashflows)
        .where(
          and(
            eq(facilityCashflows.facilityId, facilityId),
            eq(facilityCashflows.periodEnd, body.periodEnd),
          ),
        )
        .limit(1);
      const id = existing[0]?.id ?? newId("fcf");
      const inputs = body.inputs as Record<string, number>;
      if (existing[0]) {
        await app.db
          .update(facilityCashflows)
          .set({ inputs, note: body.note ?? null, updatedAt: new Date().toISOString() })
          .where(eq(facilityCashflows.id, id));
      } else {
        await app.db.insert(facilityCashflows).values({
          id,
          facilityId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          periodEnd: body.periodEnd,
          inputs,
          note: body.note ?? null,
          recordedBy: req.user!.id,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: existing[0] ? "update" : "create",
        objectType: "facility_cashflow",
        objectId: id,
        payload: { facilityId, periodEnd: body.periodEnd, inputs },
        storePayload: true,
        projectId: req.projectId!,
      });
      // Recompute every formula-driven covenant on this facility now, so the
      // reading appears with the period rather than at the next sweep.
      const covs = await app.db
        .select()
        .from(covenants)
        .where(eq(covenants.facilityId, facilityId));
      const computed: Array<Record<string, unknown>> = [];
      for (const cov of covs) {
        if (cov.formula === "custom") continue;
        const result = computeCovenantReading(cov.formula, inputs);
        computed.push({
          covenantId: cov.id,
          name: cov.name,
          formula: cov.formula,
          value: result.value,
          basis: result.basis,
          unavailableReason: result.unavailableReason,
        });
        if (result.value === null) continue;
        const compliant = covenantCompliant(cov.operator, result.value, cov.threshold);
        const headroom = covenantHeadroom(cov.operator, result.value, cov.threshold);
        const already = await app.db
          .select({ id: covenantReadings.id })
          .from(covenantReadings)
          .where(
            and(
              eq(covenantReadings.covenantId, cov.id),
              eq(covenantReadings.readingDate, body.periodEnd),
            ),
          )
          .limit(1);
        if (already[0]) {
          await app.db
            .update(covenantReadings)
            .set({
              value: result.value,
              compliant: compliant ? 1 : 0,
              headroom,
              basis: cov.formula,
              computedFrom: { inputs: result.used, basis: result.basis, cashflowId: id },
            })
            .where(eq(covenantReadings.id, already[0].id));
        } else {
          await app.db.insert(covenantReadings).values({
            id: newId("cvr"),
            covenantId: cov.id,
            companyId: req.companyId!,
            readingDate: body.periodEnd,
            value: result.value,
            compliant: compliant ? 1 : 0,
            headroom,
            note: null,
            basis: cov.formula,
            computedFrom: { inputs: result.used, basis: result.basis, cashflowId: id },
            recordedBy: req.user!.id,
          });
        }
      }
      const [row] = await app.db
        .select()
        .from(facilityCashflows)
        .where(eq(facilityCashflows.id, id))
        .limit(1);
      return { ...row, computed };
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/cashflows",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(facilityCashflows)
        .where(eq(facilityCashflows.facilityId, facilityId))
        .orderBy(asc(facilityCashflows.periodEnd));
      return { items, total: items.length, inputs: FACILITY_CASHFLOW_INPUTS };
    },
  );

  /**
   * Record a lender waiver of a covenant breach (#747). Without one, a
   * facility in breach is under a draw-stop; with one, money may move again
   * for as long as the waiver runs. Admin-only, because it lifts the bar
   * the module exists to hold.
   */
  app.post(
    "/projects/:projectId/covenants/:covenantId/waive",
    { preHandler: adminGate },
    async (req, reply) => {
      const { covenantId } = req.params as { covenantId: string };
      const body = covenantWaiveSchema.parse(req.body);
      const covenant = await fetchCovenant(covenantId, req.companyId!, req.projectId!);
      if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) {
        throw badRequest("effectiveTo cannot fall before effectiveFrom");
      }
      if (body.evidenceIds && body.evidenceIds.length > 0) {
        await validateEvidence(req.companyId!, req.projectId!, body.evidenceIds);
      }
      const id = newId("cwv");
      await app.db.insert(covenantWaivers).values({
        id,
        covenantId,
        facilityId: covenant.facilityId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        reason: body.reason,
        lenderReference: body.lenderReference ?? null,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        evidenceIds: body.evidenceIds ?? [],
        grantedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "covenant_waiver",
        objectId: id,
        payload: {
          covenantId,
          facilityId: covenant.facilityId,
          reason: body.reason,
          lenderReference: body.lenderReference ?? null,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(covenantWaivers)
        .where(eq(covenantWaivers.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/facilities/:facilityId/draw-stop",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const today = todayISO();
      const standing = await covenantStanding(app.db, facilityId, today);
      return {
        facilityId,
        ...evaluateDrawStop({
          availabilityEndDate: facility.availabilityEndDate,
          today,
          covenants: standing,
        }),
        covenants: standing,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cost of finance (#748-751)                                        */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/facilities/:facilityId/cost-of-finance",
    { preHandler: readGate },
    async (req) => {
      const { facilityId } = req.params as { facilityId: string };
      const q = costOfFinanceQuery.parse(req.query);
      const facility = await fetchFacility(facilityId, req.companyId!, req.projectId!);
      const draws = await app.db
        .select()
        .from(disbursements)
        .where(eq(disbursements.facilityId, facilityId));
      const paid = draws
        .filter((d) => d.status === "disbursed" && d.disbursedAt)
        .map((d) => ({ date: d.disbursedAt!.slice(0, 10), amount: d.amount }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const from = q.from ?? paid[0]?.date ?? facility.createdAt.slice(0, 10);
      const to = q.to ?? facility.availabilityEndDate ?? todayISO();
      if (to <= from) {
        return {
          facilityId,
          currency: facility.currency,
          periods: [],
          totalInterest: 0,
          totalCommitmentFees: 0,
          totalCostOfFinance: 0,
          basis: "",
          unavailableReason:
            `The accrual window ends on or before it begins (${from} → ${to}); nothing can be accrued. ` +
            `Set an availability end date on the facility or pass explicit from/to dates.`,
        };
      }
      const schedule = buildAccrualSchedule({
        committedAmount: facility.committedAmount,
        currency: facility.currency,
        baseRatePercent: facility.baseRatePercent,
        marginPercent: facility.marginPercent,
        commitmentFeePercent: facility.commitmentFeePercent,
        convention: (facility.dayCountConvention as DayCountConvention) ?? "actual_365",
        capitalise: facility.capitaliseInterest === 1,
        periodStart: from,
        periodEnds: quarterEnds(from, to),
        draws: paid,
      });
      return { facilityId, ...schedule };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Withdrawal application (#732, #735)                               */
  /* ---------------------------------------------------------------- */

  /**
   * The withdrawal application in the layout an IFI expects: a summary
   * page, a statement of expenditure schedule and the certification block.
   * Assembled from recorded fields only — every line is traceable to a row,
   * and anything missing is stated rather than filled in.
   */
  app.get(
    "/projects/:projectId/disbursements/:disbursementId/application",
    { preHandler: readGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      const facility = await fetchFacility(d.facilityId, req.companyId!, req.projectId!);
      const projectRow = (
        await app.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, req.projectId!))
          .limit(1)
      )[0];
      const evidenceRows = d.evidenceIds.length
        ? await app.db
            .select()
            .from(evidence)
            .where(
              and(
                inArray(evidence.id, d.evidenceIds),
                eq(evidence.companyId, req.companyId!),
                eq(evidence.projectId, req.projectId!),
              ),
            )
        : [];
      const eligibility = assessEligibility(
        d.evidenceIds,
        (d.evidenceEligibility ?? []) as EligibilityEntry[],
      );
      const category = d.categoryId
        ? (parseCategories(facility).find((c) => c.id === d.categoryId) ?? null)
        : null;
      const warnings: string[] = [];
      if (!d.certifiedAt) {
        warnings.push(
          CERTIFICATION_REQUIRED_INSTRUMENTS.includes(facility.instrument)
            ? "This application has NOT been certified by the independent engineer, and this facility requires certification before payment."
            : "This application has not been certified; certification is optional for this instrument.",
        );
      }
      if (eligibility.unassessed > 0) {
        warnings.push(`${eligibility.unassessed} attached item(s) have not been classified for eligibility.`);
      }
      if (evidenceRows.length !== d.evidenceIds.length) {
        warnings.push(
          `${d.evidenceIds.length - evidenceRows.length} attached evidence id(s) no longer resolve in this project.`,
        );
      }
      return {
        header: {
          applicationNumber: d.number,
          project: projectRow?.name ?? null,
          borrowerReference: facility.name,
          lender: facility.lender,
          instrument: facility.instrument,
          currency: facility.currency,
          committedAmount: facility.committedAmount,
          availabilityEndDate: facility.availabilityEndDate,
          category: category ? { id: category.id, name: category.name, limit: category.limit } : null,
        },
        application: {
          amount: d.amount,
          purpose: d.purpose,
          status: d.status,
          submittedAt: d.submittedAt,
          approvedAt: d.approvedAt,
          disbursedAt: d.disbursedAt,
        },
        statementOfExpenditure: evidenceRows.map((e) => {
          const entry = ((d.evidenceEligibility ?? []) as EligibilityEntry[]).find(
            (x) => x.evidenceId === e.id,
          );
          return {
            evidenceId: e.id,
            kind: e.kind,
            source: e.source,
            capturedAt: e.capturedAt,
            contentHash: e.contentHash,
            eligibility: entry?.eligibility ?? "unassessed",
            reason: entry?.reason ?? null,
            amount: entry?.amount ?? null,
          };
        }),
        eligibility,
        certification: {
          certified: Boolean(d.certifiedAt),
          certifiedAt: d.certifiedAt,
          certifiedBy: d.certifiedBy,
          note: d.certificationNote,
          evidenceIds: d.certificationEvidenceIds,
          requiredForInstrument: CERTIFICATION_REQUIRED_INSTRUMENTS.includes(facility.instrument),
        },
        conditionality: d.conditionality ?? null,
        warnings,
        basis:
          "Assembled from the disbursement record, the facility agreement terms held on the " +
          "platform and the evidence attached to the application. Nothing on this form is " +
          "computed from anything the platform does not hold; anything missing is named in warnings.",
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/finance/health-inputs", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const today = todayISO();
    await sweepOverdueConditions(companyId, projectId);
    const reasons: string[] = [];
    const facs = await app.db
      .select()
      .from(fundingFacilities)
      .where(
        and(eq(fundingFacilities.companyId, companyId), eq(fundingFacilities.projectId, projectId)),
      );
    if (facs.length === 0) {
      reasons.push("No funding facility is recorded on this project.");
      return {
        metrics: {
          facilities: 0,
          openConditions: null,
          breachedConditions: null,
          covenantBreaches: null,
          drawStopped: null,
          disbursedPercent: null,
          daysToClosing: null,
          awaitingCertification: null,
          openRecoveries: null,
        },
        reasons,
      };
    }
    const conds = await app.db
      .select()
      .from(facilityConditions)
      .where(
        and(
          eq(facilityConditions.companyId, companyId),
          eq(facilityConditions.projectId, projectId),
        ),
      );
    const draws = await app.db
      .select()
      .from(disbursements)
      .where(and(eq(disbursements.companyId, companyId), eq(disbursements.projectId, projectId)));
    const recoveries = await app.db
      .select()
      .from(ineligibleRecoveries)
      .where(
        and(
          eq(ineligibleRecoveries.companyId, companyId),
          eq(ineligibleRecoveries.projectId, projectId),
        ),
      );

    const standings = (
      await Promise.all(facs.map((f) => covenantStanding(app.db, f.id, today)))
    ).flat();
    if (standings.length === 0) reasons.push("No covenants are defined on this project's facilities.");
    const stops = facs.map((f) =>
      evaluateDrawStop({
        availabilityEndDate: f.availabilityEndDate,
        today,
        covenants: standings.filter(() => true),
      }),
    );

    // Disbursed percentage is only meaningful inside one currency.
    const currencies = new Set(facs.map((f) => f.currency));
    let disbursedPercent: number | null = null;
    if (currencies.size > 1) {
      reasons.push(
        `Facilities span ${[...currencies].join(", ")}; a single disbursed percentage would require an exchange rate this platform does not hold.`,
      );
    } else {
      const committed = facs.reduce((sum, f) => sum + f.committedAmount, 0);
      const disbursed = draws
        .filter((d) => d.status === "disbursed")
        .reduce((sum, d) => sum + d.amount, 0);
      disbursedPercent = committed > 0 ? round2((disbursed / committed) * 100) : null;
      if (disbursedPercent === null) {
        reasons.push("Committed funding is zero, so a disbursed percentage is undefined.");
      }
    }

    const closingDates = facs
      .map((f) => f.availabilityEndDate)
      .filter((d): d is string => Boolean(d))
      .sort();
    if (closingDates.length === 0) {
      reasons.push("No facility carries an availability end date, so closing pressure is unknown.");
    }

    return {
      metrics: {
        facilities: facs.length,
        openConditions: conds.filter((c) => c.status === "open").length,
        breachedConditions: conds.filter((c) => c.status === "breached").length,
        covenantBreaches:
          standings.length === 0
            ? null
            : standings.filter((c) => c.compliant === false && c.waivedBy === null).length,
        drawStopped: stops.filter((s) => s.stopped).length,
        disbursedPercent,
        daysToClosing: closingDates[0] ? daysUntil(closingDates[0]) : null,
        awaitingCertification: draws.filter((d) => d.status === "approved" && !d.certifiedAt).length,
        openRecoveries: recoveries.filter((r) => r.status === "open").length,
      },
      reasons,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Company-level portfolio view                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Every facility the caller can see, per currency. Company-level, so it
   * is gated by the same tool the project routes are and scoped to the
   * projects the caller actually holds finance access on.
   */
  app.get("/finance/portfolio", { preHandler: companyReadGate }, async (req) => {
    const scope = await visibleProjectIds(app, req, "finance");
    if (scope !== null && scope.length === 0) {
      return {
        facilities: [],
        committedByCurrency: [],
        disbursedByCurrency: [],
        reason: "You do not hold finance access on any project in this company.",
      };
    }
    const clauses = [eq(fundingFacilities.companyId, req.companyId!)];
    if (scope !== null) clauses.push(inArray(fundingFacilities.projectId, scope));
    const facs = await app.db
      .select()
      .from(fundingFacilities)
      .where(and(...clauses))
      .orderBy(desc(fundingFacilities.createdAt));
    if (facs.length === 0) {
      return {
        facilities: [],
        committedByCurrency: [],
        disbursedByCurrency: [],
        reason: "No funding facilities are recorded on the projects you can see.",
      };
    }
    const ids = facs.map((f) => f.id);
    const draws = await app.db
      .select()
      .from(disbursements)
      .where(inArray(disbursements.facilityId, ids));
    const projectRows = await app.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.companyId, req.companyId!),
          inArray(projects.id, [...new Set(facs.map((f) => f.projectId))]),
        ),
      );
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
    const currencyOf = new Map(facs.map((f) => [f.id, f.currency]));
    return {
      facilities: facs.map((f) => {
        const rows = draws.filter((d) => d.facilityId === f.id);
        return {
          id: f.id,
          projectId: f.projectId,
          projectName: projectName.get(f.projectId) ?? null,
          name: f.name,
          lender: f.lender,
          instrument: f.instrument,
          currency: f.currency,
          committedAmount: f.committedAmount,
          disbursed: round2(
            rows.filter((d) => d.status === "disbursed").reduce((sum, d) => sum + d.amount, 0),
          ),
          pipeline: round2(
            rows
              .filter((d) => (PIPELINE_STATUSES as readonly string[]).includes(d.status))
              .reduce((sum, d) => sum + d.amount, 0),
          ),
          daysToClosing: f.availabilityEndDate ? daysUntil(f.availabilityEndDate) : null,
        };
      }),
      committedByCurrency: bucketByCurrency(
        facs.map((f) => ({ amount: f.committedAmount, currency: f.currency })),
      ),
      disbursedByCurrency: bucketByCurrency(
        draws
          .filter((d) => d.status === "disbursed")
          .map((d) => ({ amount: d.amount, currency: currencyOf.get(d.facilityId) ?? null })),
      ),
      scoped: scope !== null,
    };
  });
};
