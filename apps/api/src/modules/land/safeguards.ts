/**
 * Resettlement depth — spec Domain J #550, #558-561, #568, #575-578, #591.
 *
 * Four registers plus the consent view, all of them answering questions a
 * lender's environmental & social supervision mission actually asks:
 *
 *  - Replacement-cost studies (#550). "Compensated at full replacement cost"
 *    and "compensated at the government schedule rate" are different facts,
 *    and the second is the single commonest adverse finding on a supervision
 *    mission. The study records the market survey, the depreciation a
 *    schedule WOULD have deducted (as the size of the gap, never as an input
 *    to the answer) and the transaction costs the household must bear, then
 *    tests what was actually offered against the total.
 *
 *  - Heritage & Indigenous Peoples plans (#575-578, IFC PS7/PS8) with their
 *    commitments tracked, plus the chance-find register — a find stops the
 *    works until the authority has spoken, and the register is what proves
 *    it did.
 *
 *  - Livelihood restoration activities (#561, PS5 paras 27-29). "Livelihood
 *    restored" is a measured claim: income after the intervention against the
 *    pre-displacement baseline, not a tick.
 *
 *  - RAP completion audits and the lender supervision pack (#558-560, #568).
 *    The pack freezes the indicator set AND the ledger sequence range it was
 *    built from, so an auditor can replay the same window and get the same
 *    numbers.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: raise signals. Every finding in this
 * area is raised by the scheduled detector (land/detectors.ts) as the system
 * actor. Reads here are pure.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import {
  affectedPersons,
  chanceFinds,
  grievances,
  heritagePlans,
  landParcels,
  ledgerEntries,
  livelihoodActivities,
  rapAudits,
  replacementCostStudies,
} from "@constructos/db";
import {
  ACQUISITION_BASES,
  CHANCE_FIND_STATUSES,
  CONSENT_STATUSES,
  HERITAGE_PLAN_KINDS,
  HERITAGE_PLAN_STATUSES,
  LIVELIHOOD_ACTIVITY_KINDS,
  LIVELIHOOD_ACTIVITY_STATUSES,
  RAP_AUDIT_CONCLUSIONS,
  REPLACEMENT_ASSET_TYPES,
  VALUATION_METHODS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { computeReplacementCost, round2, summariseReplacement } from "./replacement.js";
import { loadConsentView } from "./consent-service.js";
import { runLandDetectors } from "./detectors.js";
import { GRIEVANCE_SETTLED_STATUSES, PHYSICAL_DISPLACEMENT } from "./reference.js";
import {
  percentOf,
  validateEvidence,
  validateFiles,
  validateLocation,
  validateTasksInProject,
} from "./shared.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const studyCreateSchema = z
  .object({
    parcelId: z.string().min(1).nullable().optional(),
    papId: z.string().min(1).nullable().optional(),
    assetType: z.enum(REPLACEMENT_ASSET_TYPES),
    description: z.string().min(1).max(2000),
    method: z.enum(VALUATION_METHODS),
    marketValue: z.number().finite().nonnegative(),
    depreciationDeducted: z.number().finite().nonnegative().optional(),
    transactionCosts: z.number().finite().nonnegative().optional(),
    compensationOffered: z.number().finite().nonnegative().nullable().optional(),
    currency: z.string().length(3).optional(),
    surveyDate: isoDateSchema,
    valuerName: z.string().max(200).nullable().optional(),
    valuerIndependent: z.boolean().optional(),
    evidenceIds: z.array(z.string().min(1)).max(100).optional(),
    notes: z.string().max(20000).nullable().optional(),
  })
  .refine((b) => b.parcelId != null || b.papId != null, {
    message: "A replacement-cost study must be about a parcel or a household",
  });

const studyPatchSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  method: z.enum(VALUATION_METHODS).optional(),
  marketValue: z.number().finite().nonnegative().optional(),
  depreciationDeducted: z.number().finite().nonnegative().optional(),
  transactionCosts: z.number().finite().nonnegative().optional(),
  compensationOffered: z.number().finite().nonnegative().nullable().optional(),
  valuerName: z.string().max(200).nullable().optional(),
  valuerIndependent: z.boolean().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const commitmentInput = z.object({
  text: z.string().min(1).max(4000),
  dueDate: isoDateSchema.nullable().optional(),
  owner: z.string().max(200).nullable().optional(),
});

const planCreateSchema = z.object({
  kind: z.enum(HERITAGE_PLAN_KINDS),
  title: z.string().min(1).max(300),
  subject: z.string().max(300).nullable().optional(),
  consentStatus: z.enum(CONSENT_STATUSES).nullable().optional(),
  consentEvidenceIds: z.array(z.string().min(1)).max(100).optional(),
  commitments: z.array(commitmentInput).max(200).optional(),
  stakeholderIds: z.array(z.string().min(1)).max(200).optional(),
  disclosedAt: isoDateSchema.nullable().optional(),
  reviewDueAt: isoDateSchema.nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(100).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const planPatchSchema = planCreateSchema.partial().extend({
  status: z.enum(HERITAGE_PLAN_STATUSES).optional(),
});

const closeCommitmentSchema = z.object({
  note: z.string().max(10000).nullable().optional(),
});

const chanceFindCreateSchema = z.object({
  planId: z.string().min(1).nullable().optional(),
  discoveredAt: isoDateSchema,
  locationId: z.string().min(1).nullable().optional(),
  locationDescription: z.string().max(1000).nullable().optional(),
  description: z.string().min(1).max(20000),
  affectedTaskIds: z.array(z.string().min(1)).max(200).optional(),
  /** the works stop when the find is reported, unless it is a historic entry */
  stopWork: z.boolean().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
});

const chanceFindStatusSchema = z.object({
  status: z.enum(CHANCE_FIND_STATUSES),
  authority: z.string().max(300).nullable().optional(),
  assessment: z.string().max(20000).nullable().optional(),
  disposition: z.string().max(20000).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
});

const livelihoodCreateSchema = z.object({
  papId: z.string().min(1),
  kind: z.enum(LIVELIHOOD_ACTIVITY_KINDS),
  description: z.string().min(1).max(4000),
  plannedAt: isoDateSchema.nullable().optional(),
  cost: z.number().finite().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  incomeBaseline: z.number().finite().nonnegative().nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const livelihoodStatusSchema = z.object({
  status: z.enum(LIVELIHOOD_ACTIVITY_STATUSES),
  /** the measured household income at this point, for the restoration test */
  incomeCurrent: z.number().finite().nonnegative().nullable().optional(),
  incomeMeasuredAt: isoDateSchema.nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  note: z.string().max(10000).nullable().optional(),
});

const auditCreateSchema = z.object({
  kind: z.string().max(80).optional(),
  auditor: z.string().min(1).max(300),
  auditorIndependent: z.boolean().optional(),
  auditDate: isoDateSchema.optional(),
  scope: z.string().max(20000).nullable().optional(),
  findings: z
    .array(
      z.object({
        ref: z.string().max(80).nullable().optional(),
        severity: z.enum(["critical", "high", "medium", "low", "observation"]),
        finding: z.string().min(1).max(20000),
        recommendation: z.string().max(20000).nullable().optional(),
        dueDate: isoDateSchema.nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
  conclusion: z.enum(RAP_AUDIT_CONCLUSIONS).optional(),
  evidenceIds: z.array(z.string().min(1)).max(200).optional(),
  fileIds: z.array(z.string().min(1)).max(200).optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const consentQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

interface PlanCommitment {
  id: string;
  text: string;
  dueDate: string | null;
  owner: string | null;
  status: "open" | "closed";
  closedAt: string | null;
  closedBy: string | null;
  note: string | null;
}

function parseCommitments(raw: unknown): PlanCommitment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is PlanCommitment => typeof c === "object" && c !== null);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export async function registerSafeguardRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];

  async function assertParcel(companyId: string, projectId: string, parcelId: string) {
    const rows = await app.db
      .select({ id: landParcels.id, reference: landParcels.reference })
      .from(landParcels)
      .where(
        and(
          eq(landParcels.id, parcelId),
          eq(landParcels.companyId, companyId),
          eq(landParcels.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("parcelId does not belong to this project");
    return rows[0];
  }

  async function assertPap(companyId: string, projectId: string, papId: string) {
    const rows = await app.db
      .select()
      .from(affectedPersons)
      .where(
        and(
          eq(affectedPersons.id, papId),
          eq(affectedPersons.companyId, companyId),
          eq(affectedPersons.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("papId does not belong to this project");
    return rows[0];
  }

  async function fetchStudy(studyId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(replacementCostStudies)
      .where(
        and(
          eq(replacementCostStudies.id, studyId),
          eq(replacementCostStudies.companyId, companyId),
          eq(replacementCostStudies.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Replacement-cost study not found");
    return rows[0];
  }

  async function fetchPlan(planId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(heritagePlans)
      .where(
        and(
          eq(heritagePlans.id, planId),
          eq(heritagePlans.companyId, companyId),
          eq(heritagePlans.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Heritage plan not found");
    return rows[0];
  }

  async function fetchFind(findId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(chanceFinds)
      .where(
        and(
          eq(chanceFinds.id, findId),
          eq(chanceFinds.companyId, companyId),
          eq(chanceFinds.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Chance find not found");
    return rows[0];
  }

  async function fetchActivity(activityId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(livelihoodActivities)
      .where(
        and(
          eq(livelihoodActivities.id, activityId),
          eq(livelihoodActivities.companyId, companyId),
          eq(livelihoodActivities.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Livelihood activity not found");
    return rows[0];
  }

  /* ================================================================ */
  /* Replacement-cost verification (#550)                              */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/replacement-studies",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = studyCreateSchema.parse(req.body);
      if (body.parcelId) await assertParcel(req.companyId!, req.projectId!, body.parcelId);
      if (body.papId) await assertPap(req.companyId!, req.projectId!, body.papId);
      await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds ?? []);
      const computed = computeReplacementCost({
        marketValue: body.marketValue,
        depreciationDeducted: body.depreciationDeducted ?? 0,
        transactionCosts: body.transactionCosts ?? 0,
        compensationOffered: body.compensationOffered ?? null,
      });
      const id = newId("rcs");
      await app.db.insert(replacementCostStudies).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        parcelId: body.parcelId ?? null,
        papId: body.papId ?? null,
        assetType: body.assetType,
        description: body.description,
        method: body.method,
        marketValue: body.marketValue,
        depreciationDeducted: body.depreciationDeducted ?? 0,
        transactionCosts: body.transactionCosts ?? 0,
        replacementCost: computed.replacementCost,
        compensationOffered: body.compensationOffered ?? null,
        currency: body.currency ?? "USD",
        shortfall: computed.shortfall,
        verdict: computed.verdict,
        surveyDate: body.surveyDate,
        valuerName: body.valuerName ?? null,
        valuerIndependent: body.valuerIndependent ? 1 : 0,
        evidenceIds: body.evidenceIds ?? [],
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "replacement_cost_study",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          parcelId: body.parcelId ?? null,
          papId: body.papId ?? null,
          assetType: body.assetType,
          method: body.method,
          marketValue: body.marketValue,
          transactionCosts: body.transactionCosts ?? 0,
          replacementCost: computed.replacementCost,
          compensationOffered: body.compensationOffered ?? null,
          shortfall: computed.shortfall,
          verdict: computed.verdict,
          basis: computed.basis,
          citation: "IFC PS5 para 27",
        },
        storePayload: true,
      });
      const created = await fetchStudy(id, req.companyId!, req.projectId!);
      return reply.status(201).send({ ...created, ...computed });
    },
  );

  app.get("/projects/:projectId/replacement-studies", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ verdict: z.enum(["adequate", "shortfall", "unverified"]).optional() })
      .parse(req.query);
    const clauses = [
      eq(replacementCostStudies.companyId, req.companyId!),
      eq(replacementCostStudies.projectId, req.projectId!),
    ];
    if (q.verdict) clauses.push(eq(replacementCostStudies.verdict, q.verdict));
    const where = and(...clauses);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(replacementCostStudies)
      .where(where);
    const rows = await app.db
      .select()
      .from(replacementCostStudies)
      .where(where)
      .orderBy(desc(replacementCostStudies.surveyDate), desc(replacementCostStudies.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, valuerIndependentBool: r.valuerIndependent === 1 })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch(
    "/projects/:projectId/replacement-studies/:studyId",
    { preHandler: standardGate },
    async (req) => {
      const { studyId } = req.params as { studyId: string };
      const body = studyPatchSchema.parse(req.body);
      const study = await fetchStudy(studyId, req.companyId!, req.projectId!);
      if (body.evidenceIds) {
        await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      }
      const marketValue = body.marketValue ?? study.marketValue;
      const depreciation = body.depreciationDeducted ?? study.depreciationDeducted;
      const transaction = body.transactionCosts ?? study.transactionCosts;
      const offered =
        body.compensationOffered !== undefined
          ? body.compensationOffered
          : study.compensationOffered;
      const computed = computeReplacementCost({
        marketValue,
        depreciationDeducted: depreciation,
        transactionCosts: transaction,
        compensationOffered: offered,
      });
      const before = {
        marketValue: study.marketValue,
        transactionCosts: study.transactionCosts,
        compensationOffered: study.compensationOffered,
        replacementCost: study.replacementCost,
        verdict: study.verdict,
        shortfall: study.shortfall,
      };
      await app.db
        .update(replacementCostStudies)
        .set({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.method !== undefined ? { method: body.method } : {}),
          ...(body.valuerName !== undefined ? { valuerName: body.valuerName } : {}),
          ...(body.valuerIndependent !== undefined
            ? { valuerIndependent: body.valuerIndependent ? 1 : 0 }
            : {}),
          ...(body.evidenceIds !== undefined ? { evidenceIds: body.evidenceIds } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          marketValue,
          depreciationDeducted: depreciation,
          transactionCosts: transaction,
          compensationOffered: offered,
          replacementCost: computed.replacementCost,
          shortfall: computed.shortfall,
          verdict: computed.verdict,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(replacementCostStudies.id, studyId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "replacement_cost_study",
        objectId: studyId,
        projectId: req.projectId!,
        payload: {
          before,
          after: {
            marketValue,
            transactionCosts: transaction,
            compensationOffered: offered,
            replacementCost: computed.replacementCost,
            verdict: computed.verdict,
            shortfall: computed.shortfall,
          },
          basis: computed.basis,
        },
        storePayload: true,
      });
      const updated = await fetchStudy(studyId, req.companyId!, req.projectId!);
      return { ...updated, ...computed };
    },
  );

  app.get(
    "/projects/:projectId/replacement-studies/summary",
    { preHandler: readGate },
    async (req) => {
      const rows = await app.db
        .select()
        .from(replacementCostStudies)
        .where(
          and(
            eq(replacementCostStudies.companyId, req.companyId!),
            eq(replacementCostStudies.projectId, req.projectId!),
          ),
        );
      // Never sum money across currencies: bucket, then summarise each.
      const currencies = [...new Set(rows.map((r) => r.currency))].sort();
      return {
        total: rows.length,
        currencies,
        byCurrency: currencies.map((currency) => ({
          currency,
          ...summariseReplacement(rows.filter((r) => r.currency === currency)),
        })),
        byAssetType: REPLACEMENT_ASSET_TYPES.map((assetType) => ({
          assetType,
          studies: rows.filter((r) => r.assetType === assetType).length,
          shortfalls: rows.filter((r) => r.assetType === assetType && r.verdict === "shortfall")
            .length,
        })).filter((r) => r.studies > 0),
        independentValuerSharePercent:
          rows.length > 0
            ? percentOf(rows.filter((r) => r.valuerIndependent === 1).length, rows.length)
            : null,
      };
    },
  );

  /* ================================================================ */
  /* Heritage & Indigenous Peoples plans (PS7 / PS8, #575-578)         */
  /* ================================================================ */

  app.post("/projects/:projectId/heritage-plans", { preHandler: standardGate }, async (req, reply) => {
    const body = planCreateSchema.parse(req.body);
    await validateFiles(app.db, req.companyId!, req.projectId!, body.fileIds ?? []);
    await validateEvidence(
      app.db,
      req.companyId!,
      req.projectId!,
      body.consentEvidenceIds ?? [],
    );
    const commitments: PlanCommitment[] = (body.commitments ?? []).map((c) => ({
      id: newId("hpc"),
      text: c.text,
      dueDate: c.dueDate ?? null,
      owner: c.owner ?? null,
      status: "open",
      closedAt: null,
      closedBy: null,
      note: null,
    }));
    const id = newId("hpl");
    await app.db.insert(heritagePlans).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      kind: body.kind,
      title: body.title,
      subject: body.subject ?? null,
      status: "draft",
      consentStatus: body.consentStatus ?? null,
      consentEvidenceIds: body.consentEvidenceIds ?? [],
      commitments,
      stakeholderIds: body.stakeholderIds ?? [],
      disclosedAt: body.disclosedAt ?? null,
      reviewDueAt: body.reviewDueAt ?? null,
      fileIds: body.fileIds ?? [],
      notes: body.notes ?? null,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "heritage_plan",
      objectId: id,
      projectId: req.projectId!,
      payload: {
        kind: body.kind,
        title: body.title,
        subject: body.subject ?? null,
        commitments: commitments.length,
        consentStatus: body.consentStatus ?? null,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchPlan(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/heritage-plans", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        kind: z.enum(HERITAGE_PLAN_KINDS).optional(),
        status: z.enum(HERITAGE_PLAN_STATUSES).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(heritagePlans.companyId, req.companyId!),
      eq(heritagePlans.projectId, req.projectId!),
    ];
    if (q.kind) clauses.push(eq(heritagePlans.kind, q.kind));
    if (q.status) clauses.push(eq(heritagePlans.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(heritagePlans).where(where);
    const rows = await app.db
      .select()
      .from(heritagePlans)
      .where(where)
      .orderBy(asc(heritagePlans.title))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const today = todayISO();
    return paginate(
      rows.map((r) => {
        const commitments = parseCommitments(r.commitments);
        const open = commitments.filter((c) => c.status !== "closed");
        return {
          ...r,
          commitmentCount: commitments.length,
          openCommitments: open.length,
          overdueCommitments: open.filter((c) => c.dueDate != null && c.dueDate < today).length,
        };
      }),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/projects/:projectId/heritage-plans/:planId", { preHandler: readGate }, async (req) => {
    const { planId } = req.params as { planId: string };
    const plan = await fetchPlan(planId, req.companyId!, req.projectId!);
    const today = todayISO();
    const commitments = parseCommitments(plan.commitments);
    return {
      ...plan,
      commitments,
      openCommitments: commitments.filter((c) => c.status !== "closed").length,
      overdueCommitments: commitments.filter(
        (c) => c.status !== "closed" && c.dueDate != null && c.dueDate < today,
      ).length,
    };
  });

  app.patch(
    "/projects/:projectId/heritage-plans/:planId",
    { preHandler: standardGate },
    async (req) => {
      const { planId } = req.params as { planId: string };
      const body = planPatchSchema.parse(req.body);
      const plan = await fetchPlan(planId, req.companyId!, req.projectId!);
      if (body.fileIds) await validateFiles(app.db, req.companyId!, req.projectId!, body.fileIds);
      if (body.consentEvidenceIds) {
        await validateEvidence(app.db, req.companyId!, req.projectId!, body.consentEvidenceIds);
      }
      /*
       * A plan cannot be declared implemented while it still carries open
       * commitments: "implemented" is the claim a completion audit tests, and
       * a plan with unfulfilled commitments is a plan in progress.
       */
      if (body.status === "implemented" || body.status === "closed") {
        const open = parseCommitments(plan.commitments).filter((c) => c.status !== "closed");
        if (open.length > 0) {
          throw conflict(
            `"${plan.title}" still carries ${open.length} open commitment(s). Close them (each ` +
              `with its evidence) before recording the plan as ${body.status}.`,
          );
        }
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "subject",
        "status",
        "consentStatus",
        "consentEvidenceIds",
        "stakeholderIds",
        "disclosedAt",
        "reviewDueAt",
        "fileIds",
        "notes",
      ] as const) {
        if (body[key] !== undefined) {
          patch[key] = body[key];
          before[key] = (plan as Record<string, unknown>)[key];
          after[key] = body[key];
        }
      }
      await app.db.update(heritagePlans).set(patch).where(eq(heritagePlans.id, planId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: body.status !== undefined ? "state_change" : "update",
        objectType: "heritage_plan",
        objectId: planId,
        projectId: req.projectId!,
        payload: { before, after },
        storePayload: true,
      });
      return fetchPlan(planId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/heritage-plans/:planId/commitments/:commitmentId/close",
    { preHandler: standardGate },
    async (req) => {
      const { planId, commitmentId } = req.params as { planId: string; commitmentId: string };
      const body = closeCommitmentSchema.parse(req.body ?? {});
      const plan = await fetchPlan(planId, req.companyId!, req.projectId!);
      const commitments = parseCommitments(plan.commitments);
      const target = commitments.find((c) => c.id === commitmentId);
      if (!target) throw notFound("Plan commitment not found");
      if (target.status === "closed") throw badRequest("This commitment is already closed");
      const now = new Date().toISOString();
      const next = commitments.map((c) =>
        c.id === commitmentId
          ? { ...c, status: "closed" as const, closedAt: now, closedBy: req.user!.id, note: body.note ?? null }
          : c,
      );
      await app.db
        .update(heritagePlans)
        .set({ commitments: next, updatedAt: now })
        .where(eq(heritagePlans.id, planId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "heritage_plan_commitment",
        objectId: commitmentId,
        projectId: req.projectId!,
        payload: {
          planId,
          text: target.text,
          dueDate: target.dueDate,
          closedLate: target.dueDate != null && now.slice(0, 10) > target.dueDate,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      return fetchPlan(planId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Chance finds (IFC PS8 para 16)                                    */
  /* ================================================================ */

  app.post("/projects/:projectId/chance-finds", { preHandler: standardGate }, async (req, reply) => {
    const body = chanceFindCreateSchema.parse(req.body);
    if (body.planId) await fetchPlan(body.planId, req.companyId!, req.projectId!);
    if (body.locationId) {
      await validateLocation(app.db, req.companyId!, req.projectId!, body.locationId);
    }
    await validateTasksInProject(app.db, req.projectId!, body.affectedTaskIds ?? []);
    await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds ?? []);
    const now = new Date().toISOString();
    // A find stops the works by default: PS8 para 16 makes the stoppage the
    // norm, so recording a find without one has to be a deliberate choice.
    const stopWork = body.stopWork !== false;
    const id = newId("cfd");
    const number = await app.db.transaction(async (tx) => {
      const number = await nextRecordNumber(tx, req.projectId!, "chance_find");
      await tx.insert(chanceFinds).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        planId: body.planId ?? null,
        discoveredAt: body.discoveredAt,
        locationId: body.locationId ?? null,
        locationDescription: body.locationDescription ?? null,
        description: body.description,
        workStoppedAt: stopWork ? now : null,
        status: stopWork ? "work_stopped" : "reported",
        affectedTaskIds: body.affectedTaskIds ?? [],
        evidenceIds: body.evidenceIds ?? [],
        createdBy: req.user!.id,
      });
      await appendLedger(tx, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "chance_find",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          number,
          discoveredAt: body.discoveredAt,
          description: body.description,
          workStopped: stopWork,
          affectedTaskIds: body.affectedTaskIds ?? [],
          citation: "IFC PS8 para 16",
        },
        storePayload: true,
      });
      return number;
    });
    void number;
    return reply.status(201).send(await fetchFind(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/chance-finds", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(CHANCE_FIND_STATUSES).optional() })
      .parse(req.query);
    const clauses = [
      eq(chanceFinds.companyId, req.companyId!),
      eq(chanceFinds.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(chanceFinds.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(chanceFinds).where(where);
    const rows = await app.db
      .select()
      .from(chanceFinds)
      .where(where)
      .orderBy(desc(chanceFinds.discoveredAt), desc(chanceFinds.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({
        ...r,
        notified: r.authorityNotifiedAt != null,
        released: r.releasedAt != null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /**
   * The chance-find lifecycle is a legal sequence, not a status field: the
   * works stop, the authority is told, an assessment happens, and only then
   * is the area released. Skipping straight to `released` is exactly the act
   * PS8 para 16 exists to prevent, so it is refused.
   */
  const FIND_TRANSITIONS: Record<string, readonly string[]> = {
    reported: ["work_stopped", "authority_notified"],
    work_stopped: ["authority_notified"],
    authority_notified: ["assessed"],
    assessed: ["released"],
    released: [],
  };

  app.post(
    "/projects/:projectId/chance-finds/:findId/status",
    { preHandler: standardGate },
    async (req) => {
      const { findId } = req.params as { findId: string };
      const body = chanceFindStatusSchema.parse(req.body);
      const find = await fetchFind(findId, req.companyId!, req.projectId!);
      if (body.status === find.status) throw badRequest(`Chance find is already ${find.status}`);
      const allowed = FIND_TRANSITIONS[find.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw badRequest(
          `A ${find.status} chance find cannot move to ${body.status} ` +
            `(allowed: ${allowed.join(", ") || "none"}). IFC PS8 para 16 requires the works to ` +
            `stop and the competent authority to be notified before the area is released.`,
        );
      }
      if (body.status === "authority_notified" && !body.authority) {
        throw badRequest("Name the authority that was notified");
      }
      if (body.evidenceIds) {
        await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.status === "work_stopped" && !find.workStoppedAt) patch["workStoppedAt"] = now;
      if (body.status === "authority_notified") {
        patch["authorityNotifiedAt"] = now;
        patch["authority"] = body.authority ?? null;
      }
      if (body.assessment !== undefined) patch["assessment"] = body.assessment;
      if (body.disposition !== undefined) patch["disposition"] = body.disposition;
      if (body.status === "released") patch["releasedAt"] = now;
      if (body.evidenceIds) {
        patch["evidenceIds"] = [...new Set([...find.evidenceIds, ...body.evidenceIds])];
      }
      await app.db.update(chanceFinds).set(patch).where(eq(chanceFinds.id, findId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "chance_find",
        objectId: findId,
        projectId: req.projectId!,
        payload: {
          from: find.status,
          to: body.status,
          number: find.number,
          authority: body.authority ?? find.authority,
          assessment: body.assessment ?? null,
          disposition: body.disposition ?? null,
          evidenceIds: body.evidenceIds ?? [],
          citation: "IFC PS8 para 16",
        },
        storePayload: true,
      });
      return fetchFind(findId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Livelihood restoration (#561, PS5 paras 27-29)                    */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/livelihood-activities",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = livelihoodCreateSchema.parse(req.body);
      const pap = await assertPap(req.companyId!, req.projectId!, body.papId);
      const id = newId("lva");
      await app.db.insert(livelihoodActivities).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        papId: body.papId,
        kind: body.kind,
        description: body.description,
        plannedAt: body.plannedAt ?? null,
        cost: body.cost ?? null,
        currency: body.currency ?? "USD",
        // fall back to the census baseline income when the household has one
        incomeBaseline:
          body.incomeBaseline ??
          (typeof (pap.baseline as Record<string, unknown> | null)?.["monthlyIncome"] === "number"
            ? ((pap.baseline as Record<string, unknown>)["monthlyIncome"] as number)
            : null),
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "livelihood_activity",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          papId: body.papId,
          papReference: pap.reference,
          kind: body.kind,
          description: body.description,
          cost: body.cost ?? null,
        },
        storePayload: true,
      });
      return reply.status(201).send(await fetchActivity(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/livelihood-activities", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        papId: z.string().min(1).optional(),
        status: z.enum(LIVELIHOOD_ACTIVITY_STATUSES).optional(),
      })
      .parse(req.query);
    const clauses = [
      eq(livelihoodActivities.companyId, req.companyId!),
      eq(livelihoodActivities.projectId, req.projectId!),
    ];
    if (q.papId) clauses.push(eq(livelihoodActivities.papId, q.papId));
    if (q.status) clauses.push(eq(livelihoodActivities.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(livelihoodActivities).where(where);
    const rows = await app.db
      .select()
      .from(livelihoodActivities)
      .where(where)
      .orderBy(desc(livelihoodActivities.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const papIds = [...new Set(rows.map((r) => r.papId))];
    const paps = papIds.length
      ? await app.db
          .select({ id: affectedPersons.id, reference: affectedPersons.reference })
          .from(affectedPersons)
          .where(inArray(affectedPersons.id, papIds))
      : [];
    const refOf = new Map(paps.map((p) => [p.id, p.reference]));
    return paginate(
      rows.map((r) => ({
        ...r,
        papReference: refOf.get(r.papId) ?? null,
        /*
         * The restoration test: income now against the pre-displacement
         * baseline. Null when either side is missing — an unmeasured
         * household is unknown, not restored.
         */
        incomeRatioPercent:
          r.incomeBaseline != null && r.incomeBaseline > 0 && r.incomeCurrent != null
            ? round2((r.incomeCurrent / r.incomeBaseline) * 100)
            : null,
        restored:
          r.incomeBaseline != null && r.incomeCurrent != null
            ? r.incomeCurrent >= r.incomeBaseline
            : null,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post(
    "/projects/:projectId/livelihood-activities/:activityId/status",
    { preHandler: standardGate },
    async (req) => {
      const { activityId } = req.params as { activityId: string };
      const body = livelihoodStatusSchema.parse(req.body);
      const activity = await fetchActivity(activityId, req.companyId!, req.projectId!);
      if (body.evidenceIds) {
        await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds);
      }
      /*
       * `verified` is the status the RAP audit relies on, so it needs the
       * measurement behind it: a verified activity with no income figure is
       * an assertion with no evidence, which is precisely what PS5 para 29
       * monitoring exists to prevent.
       */
      const incomeCurrent = body.incomeCurrent ?? activity.incomeCurrent;
      if (body.status === "verified") {
        if (incomeCurrent == null) {
          throw badRequest(
            "Verifying a livelihood activity requires the measured household income " +
              "(incomeCurrent), which is what the restoration claim is tested against",
          );
        }
        if (activity.incomeBaseline == null) {
          throw badRequest(
            "This household carries no pre-displacement income baseline, so restoration " +
              "cannot be measured against anything. Record the baseline on the household first.",
          );
        }
        if ((body.evidenceIds ?? activity.evidenceIds).length === 0) {
          throw badRequest("Verification requires evidence of the measurement");
        }
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status: body.status, updatedAt: now };
      if (body.status === "delivered" && !activity.deliveredAt) patch["deliveredAt"] = todayISO();
      if (body.status === "verified") {
        patch["verifiedAt"] = todayISO();
        patch["verifiedBy"] = req.user!.id;
      }
      if (body.incomeCurrent !== undefined) patch["incomeCurrent"] = body.incomeCurrent;
      if (body.incomeMeasuredAt !== undefined) patch["incomeMeasuredAt"] = body.incomeMeasuredAt;
      else if (body.incomeCurrent !== undefined) patch["incomeMeasuredAt"] = todayISO();
      if (body.evidenceIds) {
        patch["evidenceIds"] = [...new Set([...activity.evidenceIds, ...body.evidenceIds])];
      }
      await app.db
        .update(livelihoodActivities)
        .set(patch)
        .where(eq(livelihoodActivities.id, activityId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "livelihood_activity",
        objectId: activityId,
        projectId: req.projectId!,
        payload: {
          from: activity.status,
          to: body.status,
          papId: activity.papId,
          incomeBaseline: activity.incomeBaseline,
          incomeCurrent: incomeCurrent ?? null,
          restored:
            activity.incomeBaseline != null && incomeCurrent != null
              ? incomeCurrent >= activity.incomeBaseline
              : null,
          evidenceIds: body.evidenceIds ?? [],
          note: body.note ?? null,
          citation: "IFC PS5 para 29",
        },
        storePayload: true,
      });
      return fetchActivity(activityId, req.companyId!, req.projectId!);
    },
  );

  /* ================================================================ */
  /* Consent to programme (#591) — unified parcels + permits           */
  /* ================================================================ */

  app.get("/projects/:projectId/land/consent", { preHandler: readGate }, async (req) => {
    const q = consentQuery.parse(req.query);
    const { view, dependencies } = await loadConsentView(
      app.db,
      req.companyId!,
      req.projectId!,
      { horizonDays: q.days, withObservations: true },
    );
    return {
      ...view,
      dependencies: dependencies.map((d) => ({
        kind: d.kind,
        id: d.id,
        reference: d.reference,
        label: d.label,
        status: d.status,
        resolved: d.resolved,
        taskCount: d.taskIds.length,
      })),
    };
  });

  /** Trigger a detector cycle for this project (operators and tests). */
  app.post(
    "/projects/:projectId/land/detectors/run",
    { preHandler: standardGate },
    async (req) => {
      const result = await runLandDetectors(app.db, req.companyId!, req.projectId!);
      return { projectId: req.projectId!, ...result };
    },
  );

  /* ================================================================ */
  /* RAP completion audit & supervision pack (#558-560, #568)          */
  /* ================================================================ */

  /**
   * Compute the indicator set a supervision mission or an independent RAP
   * monitor works from. This is the same computation the audit freezes, so
   * the "live" view and the audit are guaranteed to be the same arithmetic.
   */
  async function rapIndicators(companyId: string, projectId: string) {
    const parcels = await app.db
      .select()
      .from(landParcels)
      .where(and(eq(landParcels.companyId, companyId), eq(landParcels.projectId, projectId)));
    const paps = await app.db
      .select()
      .from(affectedPersons)
      .where(
        and(eq(affectedPersons.companyId, companyId), eq(affectedPersons.projectId, projectId)),
      );
    const grv = await app.db
      .select()
      .from(grievances)
      .where(and(eq(grievances.companyId, companyId), eq(grievances.projectId, projectId)));
    const studies = await app.db
      .select()
      .from(replacementCostStudies)
      .where(
        and(
          eq(replacementCostStudies.companyId, companyId),
          eq(replacementCostStudies.projectId, projectId),
        ),
      );
    const activities = await app.db
      .select()
      .from(livelihoodActivities)
      .where(
        and(
          eq(livelihoodActivities.companyId, companyId),
          eq(livelihoodActivities.projectId, projectId),
        ),
      );
    const plans = await app.db
      .select()
      .from(heritagePlans)
      .where(and(eq(heritagePlans.companyId, companyId), eq(heritagePlans.projectId, projectId)));
    const finds = await app.db
      .select()
      .from(chanceFinds)
      .where(and(eq(chanceFinds.companyId, companyId), eq(chanceFinds.projectId, projectId)));

    const today = todayISO();
    const physical = paps.filter((p) => PHYSICAL_DISPLACEMENT.includes(p.displacementType));
    const compensated = paps.filter((p) => p.compensationPaidAt != null);
    const restored = paps.filter(
      (p) => p.livelihoodRestoredAt != null || p.status === "livelihood_restored",
    );
    const openGrievances = grv.filter(
      (g) => !(GRIEVANCE_SETTLED_STATUSES as readonly string[]).includes(g.status),
    );
    const overdueGrievances = openGrievances.filter(
      (g) => g.resolveDueAt != null && g.resolveDueAt < today,
    );
    const verifiedClosures = grv.filter((g) => g.status === "closed_verified");
    const satisfied = grv.filter((g) => g.complainantSatisfied === 1);
    const openPlanCommitments = plans.reduce(
      (s, p) => s + parseCommitments(p.commitments).filter((c) => c.status !== "closed").length,
      0,
    );

    return {
      asOf: today,
      parcels: {
        total: parcels.length,
        acquired: parcels.filter((p) => p.status === "acquired").length,
        compensated: parcels.filter((p) => p.compensationPaidAt != null).length,
        disputed: parcels.filter((p) => p.status === "disputed").length,
        acquiredWithoutBasis: parcels.filter(
          (p) => p.status === "acquired" && p.acquisitionBasis == null,
        ).length,
        byAcquisitionBasis: Object.fromEntries(
          ACQUISITION_BASES.map((b) => [
            b,
            parcels.filter((p) => p.acquisitionBasis === b).length,
          ]),
        ),
      },
      households: {
        total: paps.length,
        physicallyDisplaced: physical.length,
        vulnerable: paps.filter((p) => p.vulnerabilities.length > 0).length,
        compensated: compensated.length,
        compensatedPercent: percentOf(compensated.length, paps.length),
        resettled: paps.filter((p) => p.status === "resettled").length,
        livelihoodRestored: restored.length,
        livelihoodRestoredPercent: percentOf(restored.length, paps.length),
        resettledWithoutPayment: paps.filter(
          (p) => p.status === "resettled" && p.compensationPaidAt == null,
        ).length,
      },
      replacementCost: {
        studies: studies.length,
        shortfalls: studies.filter((s) => s.verdict === "shortfall").length,
        unverified: studies.filter((s) => s.verdict === "unverified").length,
        independentValuations: studies.filter((s) => s.valuerIndependent === 1).length,
        // households with no study at all: the coverage gap a monitor asks about
        householdsWithoutStudy: paps.filter((p) => !studies.some((s) => s.papId === p.id)).length,
      },
      livelihood: {
        activities: activities.length,
        delivered: activities.filter((a) => a.status === "delivered" || a.status === "verified")
          .length,
        verified: activities.filter((a) => a.status === "verified").length,
        failed: activities.filter((a) => a.status === "failed").length,
        householdsWithActivity: new Set(activities.map((a) => a.papId)).size,
      },
      grievances: {
        total: grv.length,
        open: openGrievances.length,
        overdue: overdueGrievances.length,
        rejected: grv.filter((g) => g.status === "rejected").length,
        verifiedClosures: verifiedClosures.length,
        satisfactionPercent: percentOf(satisfied.length, verifiedClosures.length ),
        anonymous: grv.filter((g) => g.isAnonymous === 1).length,
        escalated: grv.filter((g) => g.escalationTier > 0).length,
      },
      heritage: {
        plans: plans.length,
        implemented: plans.filter((p) => p.status === "implemented" || p.status === "closed")
          .length,
        openCommitments: openPlanCommitments,
        chanceFinds: finds.length,
        chanceFindsUnnotified: finds.filter((f) => f.authorityNotifiedAt == null).length,
        chanceFindsReleased: finds.filter((f) => f.releasedAt != null).length,
      },
    };
  }

  app.get("/projects/:projectId/land/rap-indicators", { preHandler: readGate }, async (req) => {
    return rapIndicators(req.companyId!, req.projectId!);
  });

  app.post("/projects/:projectId/rap-audits", { preHandler: standardGate }, async (req, reply) => {
    const body = auditCreateSchema.parse(req.body);
    await validateEvidence(app.db, req.companyId!, req.projectId!, body.evidenceIds ?? []);
    await validateFiles(app.db, req.companyId!, req.projectId!, body.fileIds ?? []);
    const indicators = await rapIndicators(req.companyId!, req.projectId!);
    /*
     * Freeze the ledger window the pack was built from. An auditor who
     * replays the company's ledger up to `ledgerSeqTo` must be able to
     * reconstruct exactly these numbers — that is what makes the pack a
     * verifiable artefact rather than a screenshot.
     */
    const [seqRow] = await app.db
      .select({ seq: max(ledgerEntries.seq) })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, req.companyId!));
    const findings = (body.findings ?? []).map((f) => ({
      id: newId("raf"),
      ref: f.ref ?? null,
      severity: f.severity,
      finding: f.finding,
      recommendation: f.recommendation ?? null,
      dueDate: f.dueDate ?? null,
      status: "open" as const,
    }));
    const id = newId("rap");
    const number = await app.db.transaction(async (tx) => {
      const number = await nextRecordNumber(tx, req.projectId!, "rap_audit");
      await tx.insert(rapAudits).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        kind: body.kind ?? "completion_audit",
        auditor: body.auditor,
        auditorIndependent: body.auditorIndependent ? 1 : 0,
        auditDate: body.auditDate ?? todayISO(),
        scope: body.scope ?? null,
        indicators,
        findings,
        conclusion: body.conclusion ?? "not_assessed",
        ledgerSeqFrom: 1,
        ledgerSeqTo: seqRow?.seq ?? null,
        evidenceIds: body.evidenceIds ?? [],
        fileIds: body.fileIds ?? [],
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(tx, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "rap_report",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          number,
          auditor: body.auditor,
          auditorIndependent: Boolean(body.auditorIndependent),
          conclusion: body.conclusion ?? "not_assessed",
          findings: findings.length,
          ledgerSeqTo: seqRow?.seq ?? null,
          indicators,
        },
        storePayload: true,
      });
      return number;
    });
    void number;
    const rows = await app.db.select().from(rapAudits).where(eq(rapAudits.id, id)).limit(1);
    return reply.status(201).send(rows[0]);
  });

  app.get("/projects/:projectId/rap-audits", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(rapAudits.companyId, req.companyId!),
      eq(rapAudits.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(rapAudits).where(where);
    const rows = await app.db
      .select()
      .from(rapAudits)
      .where(where)
      .orderBy(desc(rapAudits.auditDate), desc(rapAudits.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((r) => ({ ...r, auditorIndependentBool: r.auditorIndependent === 1 })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /**
   * Supervision pack as CSV (#558-560). One row per indicator, each carrying
   * the ledger sequence the pack was frozen at, so a lender can diff two
   * missions' packs mechanically instead of by eye.
   */
  app.get(
    "/projects/:projectId/rap-audits/:auditId/pack.csv",
    { preHandler: readGate },
    async (req, reply) => {
      const { auditId } = req.params as { auditId: string };
      const rows = await app.db
        .select()
        .from(rapAudits)
        .where(
          and(
            eq(rapAudits.id, auditId),
            eq(rapAudits.companyId, req.companyId!),
            eq(rapAudits.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const audit = rows[0];
      if (!audit) throw notFound("RAP audit not found");
      const escape = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = ["section,indicator,value,ledger_seq_to"];
      const walk = (prefix: string, value: unknown): void => {
        if (value === null || typeof value !== "object") {
          lines.push(
            [prefix.split(".")[0] ?? "", prefix, value, audit.ledgerSeqTo]
              .map(escape)
              .join(","),
          );
          return;
        }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          walk(prefix ? `${prefix}.${k}` : k, v);
        }
      };
      walk("", audit.indicators);
      for (const raw of audit.findings as Record<string, unknown>[]) {
        lines.push(
          ["findings", `finding.${raw["ref"] ?? raw["id"]}`, raw["finding"], audit.ledgerSeqTo]
            .map(escape)
            .join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="rap-supervision-pack-${audit.number}.csv"`,
        )
        .send(lines.join("\n"));
    },
  );

  /** Health inputs for WP-INTEL (contract 3.5). */
  app.get("/projects/:projectId/land/health-inputs", { preHandler: readGate }, async (req) => {
    const i = await rapIndicators(req.companyId!, req.projectId!);
    const reasons: string[] = [];
    if (i.households.resettledWithoutPayment > 0) {
      reasons.push(
        `${i.households.resettledWithoutPayment} household(s) resettled with no compensation on file (IFC PS5 para 20)`,
      );
    }
    if (i.replacementCost.shortfalls > 0) {
      reasons.push(`${i.replacementCost.shortfalls} replacement-cost shortfall(s)`);
    }
    if (i.grievances.overdue > 0) {
      reasons.push(`${i.grievances.overdue} grievance(s) past their published SLA`);
    }
    if (i.heritage.chanceFindsUnnotified > 0) {
      reasons.push(`${i.heritage.chanceFindsUnnotified} chance find(s) not notified to the authority`);
    }
    const consent = await loadConsentView(app.db, req.companyId!, req.projectId!, {
      horizonDays: 90,
    });
    if (consent.view.summary.startedUnconsented > 0) {
      reasons.push(
        `${consent.view.summary.startedUnconsented} task(s) started on unresolved land or consent`,
      );
    }
    return {
      metrics: {
        parcels: i.parcels.total,
        parcelsAcquired: i.parcels.acquired,
        parcelsDisputed: i.parcels.disputed,
        households: i.households.total,
        householdsCompensatedPercent: i.households.compensatedPercent,
        livelihoodRestoredPercent: i.households.livelihoodRestoredPercent,
        resettledWithoutPayment: i.households.resettledWithoutPayment,
        replacementShortfalls: i.replacementCost.shortfalls,
        grievancesOpen: i.grievances.open,
        grievancesOverdue: i.grievances.overdue,
        grievanceSatisfactionPercent: i.grievances.satisfactionPercent,
        chanceFindsUnnotified: i.heritage.chanceFindsUnnotified,
        blockedTasks: consent.view.summary.blockedTasks,
        startedUnconsented: consent.view.summary.startedUnconsented,
        projectedSlipDays: consent.view.summary.projectedSlipDays,
      },
      reasons,
    };
  });
}
