import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import {
  covenantReadings,
  covenants,
  disbursements,
  evidence,
  facilityConditions,
  fundingFacilities,
  obligations,
  signals,
} from "@constructos/db";
import {
  COVENANT_OPERATORS,
  FACILITY_CONDITION_KINDS,
  FACILITY_INSTRUMENTS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";

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
  notes: z.string().max(20000).nullable().optional(),
});

const facilityPatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  lender: z.string().min(1).max(300).optional(),
  availabilityEndDate: isoDateSchema.nullable().optional(),
  categories: z.array(categoryInputSchema).max(100).optional(),
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

const rejectSchema = z.object({ reason: z.string().min(1).max(10000) });

const covenantCreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  operator: z.enum(COVENANT_OPERATORS),
  threshold: z.number().finite(),
  unit: z.string().max(50).nullable().optional(),
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
   * Lazy overdue-condition sweep (#730-731, same pattern as the payments
   * deemed-liability sweep): an OPEN condition whose due date has passed
   * flips to `breached`, its backing obligation is breached and a high
   * signal is raised — exactly once, guarded on the status flip itself (a
   * breached condition never re-enters the sweep). Runs on facility reads
   * and before every conditionality verification.
   */
  async function sweepOverdueConditions(
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const today = todayISO();
    const overdue = await app.db
      .select()
      .from(facilityConditions)
      .where(
        and(
          eq(facilityConditions.companyId, companyId),
          eq(facilityConditions.projectId, projectId),
          eq(facilityConditions.status, "open"),
          isNotNull(facilityConditions.dueDate),
          lt(facilityConditions.dueDate, today),
        ),
      );
    if (overdue.length === 0) return;
    const facilityIds = [...new Set(overdue.map((c) => c.facilityId))];
    const facs = await app.db
      .select({ id: fundingFacilities.id, name: fundingFacilities.name })
      .from(fundingFacilities)
      .where(inArray(fundingFacilities.id, facilityIds));
    const facilityName = new Map(facs.map((f) => [f.id, f.name]));
    for (const cond of overdue) {
      await app.db
        .update(facilityConditions)
        .set({ status: "breached", updatedAt: new Date().toISOString() })
        .where(and(eq(facilityConditions.id, cond.id), eq(facilityConditions.status, "open")));
      if (cond.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, cond.obligationId), eq(obligations.status, "open")));
      }
      const fname = facilityName.get(cond.facilityId) ?? "funding facility";
      await app.db.insert(signals).values({
        id: newId("sig"),
        companyId,
        projectId,
        detector: "facility_condition_overdue",
        severity: "high",
        confidence: 1,
        title: `Facility condition overdue — ${fname}${cond.reference ? ` (${cond.reference})` : ""}`,
        explanation:
          `Condition ${cond.kind} on facility "${fname}" fell due on ${cond.dueDate} and remains ` +
          `unsatisfied: ${cond.description}. ` +
          (cond.kind === "precedent"
            ? "While it stands, disbursement requests against this facility cannot be submitted."
            : "An unsatisfied condition subsequent is an event of default risk under the facility agreement."),
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "state_change",
        objectType: "facility_condition",
        objectId: cond.id,
        payload: { from: "open", to: "breached", dueDate: cond.dueDate },
      });
    }
  }

  function parseCategories(facility: { categories: unknown[] }): FacilityCategory[] {
    return facility.categories as FacilityCategory[];
  }

  /** Aggregate view-model fields for one facility (#739-741). */
  function facilityAggregates(
    facility: typeof fundingFacilities.$inferSelect,
    rows: (typeof disbursements.$inferSelect)[],
    conds: (typeof facilityConditions.$inferSelect)[],
  ) {
    const disbursed = round2(
      rows.filter((d) => d.status === "disbursed").reduce((s, d) => s + d.amount, 0),
    );
    const cats = parseCategories(facility).map((c) => {
      const catDisbursed = round2(
        rows
          .filter((d) => d.status === "disbursed" && d.categoryId === c.id)
          .reduce((s, d) => s + d.amount, 0),
      );
      return {
        id: c.id,
        name: c.name,
        limit: c.limit,
        disbursed: catDisbursed,
        remaining: round2(c.limit - catDisbursed),
      };
    });
    return {
      disbursed,
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
    await sweepOverdueConditions(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepOverdueConditions(req.companyId!, req.projectId!, req.user!.id);
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
      // The condition materializes as an assurance Obligation so the
      // facility clock and the obligation register see the same date.
      const obligationId = newId("obl");
      await app.db.insert(obligations).values({
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
      const id = newId("fcd");
      await app.db.insert(facilityConditions).values({
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
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "facility_condition",
        objectId: id,
        payload: {
          facilityId,
          kind: body.kind,
          reference: body.reference ?? null,
          dueDate: body.dueDate ?? null,
          obligationId,
        },
        storePayload: true,
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
      await sweepOverdueConditions(req.companyId!, req.projectId!, req.user!.id);
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

  /**
   * The conditionality gate (#733-734) — the module's core rule: a
   * disbursement request cannot be submitted while any condition precedent
   * on the facility is unsatisfied. The verification is snapshotted onto
   * the request either way, so the record shows what was checked and when.
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
      await sweepOverdueConditions(req.companyId!, req.projectId!, req.user!.id);
      const facility = await fetchFacility(d.facilityId, req.companyId!, req.projectId!);
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
      const verifiedAt = new Date().toISOString();
      const conditionality = {
        verifiedAt,
        openConditions: blocking.map((c) => ({
          id: c.id,
          reference: c.reference,
          description: c.description,
          status: c.status,
          dueDate: c.dueDate,
        })),
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
      // Headroom checks (#739-741): the pipeline (submitted + approved +
      // disbursed) may never exceed the committed amount or a category
      // limit — draft and rejected requests consume nothing.
      const siblings = await app.db
        .select()
        .from(disbursements)
        .where(eq(disbursements.facilityId, d.facilityId));
      const pipeline = siblings.filter(
        (s) => s.id !== d.id && (PIPELINE_STATUSES as readonly string[]).includes(s.status),
      );
      const usedTotal = round2(pipeline.reduce((s, x) => s + x.amount, 0));
      const availableTotal = round2(facility.committedAmount - usedTotal);
      if (d.amount > availableTotal + EPS) {
        throw conflict(
          `Amount ${d.amount} exceeds the undisbursed balance ${availableTotal} of ${facility.name} ` +
            `(committed ${facility.committedAmount}, in pipeline or disbursed ${usedTotal})`,
        );
      }
      if (d.categoryId) {
        const cat = parseCategories(facility).find((c) => c.id === d.categoryId);
        if (!cat) throw badRequest("categoryId no longer exists on this facility");
        const usedCat = round2(
          pipeline.filter((x) => x.categoryId === d.categoryId).reduce((s, x) => s + x.amount, 0),
        );
        const availableCat = round2(cat.limit - usedCat);
        if (d.amount > availableCat + EPS) {
          throw conflict(
            `Amount ${d.amount} exceeds the remaining allocation ${availableCat} of category ` +
              `"${cat.name}" (limit ${cat.limit}, in pipeline or disbursed ${usedCat})`,
          );
        }
      }
      await app.db
        .update(disbursements)
        .set({ status: "submitted", submittedAt: verifiedAt, submittedBy: req.user!.id })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: { from: "draft", to: "submitted", verifiedAt, openConditions: 0 },
        storePayload: true,
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
      // Separation of duties: the requester never approves their own draw.
      if (d.createdBy === req.user!.id) {
        throw forbidden(
          "Separation of duties: a disbursement request cannot be approved by its creator",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(disbursements)
        .set({ status: "approved", approvedAt: now, approvedBy: req.user!.id, updatedAt: now })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: { from: "submitted", to: "approved" },
        storePayload: true,
      });
      return fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/disbursements/:disbursementId/disburse",
    { preHandler: standardGate },
    async (req) => {
      const { disbursementId } = req.params as { disbursementId: string };
      const body = disburseSchema.parse(req.body ?? {});
      const d = await fetchDisbursement(disbursementId, req.companyId!, req.projectId!);
      if (d.status !== "approved") {
        throw badRequest(`Only an approved disbursement can be disbursed (this one is ${d.status})`);
      }
      const disbursedAt = body.disbursedAt
        ? new Date(body.disbursedAt).toISOString()
        : new Date().toISOString();
      await app.db
        .update(disbursements)
        .set({ status: "disbursed", disbursedAt, updatedAt: new Date().toISOString() })
        .where(eq(disbursements.id, disbursementId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "disbursement",
        objectId: disbursementId,
        payload: { from: "approved", to: "disbursed", disbursedAt, amount: d.amount },
        storePayload: true,
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

  app.get("/projects/:projectId/finance/summary", { preHandler: readGate }, async (req) => {
    await sweepOverdueConditions(req.companyId!, req.projectId!, req.user!.id);
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
    const committed = round2(facs.reduce((s, f) => s + f.committedAmount, 0));
    const disbursed = round2(
      allDisb.filter((d) => d.status === "disbursed").reduce((s, d) => s + d.amount, 0),
    );
    const byCategory = facs.flatMap((f) => {
      const rows = allDisb.filter((d) => d.facilityId === f.id);
      return parseCategories(f).map((c) => {
        const catDisbursed = round2(
          rows
            .filter((d) => d.status === "disbursed" && d.categoryId === c.id)
            .reduce((s, d) => s + d.amount, 0),
        );
        return {
          facilityId: f.id,
          facilityName: f.name,
          id: c.id,
          name: c.name,
          limit: c.limit,
          disbursed: catDisbursed,
          remaining: round2(c.limit - catDisbursed),
        };
      });
    });
    // Covenant status = worst of the LATEST reading per covenant:
    // breached > unknown (a covenant with no readings yet) > compliant;
    // null when the project has no covenants at all (#742).
    const covs = await app.db
      .select()
      .from(covenants)
      .where(
        and(eq(covenants.companyId, req.companyId!), eq(covenants.projectId, req.projectId!)),
      );
    let covenantStatus: "breached" | "unknown" | "compliant" | null = null;
    if (covs.length > 0) {
      const readings = await app.db
        .select()
        .from(covenantReadings)
        .where(
          inArray(
            covenantReadings.covenantId,
            covs.map((c) => c.id),
          ),
        )
        .orderBy(asc(covenantReadings.readingDate), asc(covenantReadings.createdAt));
      let anyBreached = false;
      let anyUnread = false;
      for (const c of covs) {
        const series = readings.filter((r) => r.covenantId === c.id);
        const latest = series[series.length - 1];
        if (!latest) anyUnread = true;
        else if (latest.compliant !== 1) anyBreached = true;
      }
      covenantStatus = anyBreached ? "breached" : anyUnread ? "unknown" : "compliant";
    }
    return {
      facilities: facs.length,
      committed,
      disbursed,
      undisbursed: round2(committed - disbursed),
      pendingRequests: allDisb.filter((d) => d.status === "submitted" || d.status === "approved")
        .length,
      openConditions: allConds.filter((c) => c.status === "open" || c.status === "breached")
        .length,
      byCategory,
      covenantStatus,
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
      date: (d.disbursedAt ?? d.submittedAt ?? d.createdAt).slice(0, 10),
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
};
