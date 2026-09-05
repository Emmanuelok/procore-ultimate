import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  assuranceActions,
  benefitDependencies,
  benefitReadings,
  benefits,
  businessCases,
  events,
  evidence,
  files,
  gateReviews,
  obligations,
  projects,
  stageGates,
  upliftChallenges,
} from "@constructos/db";
import {
  ASSURANCE_ACTION_PRIORITIES,
  ASSURANCE_ACTION_STATUSES,
  BENEFIT_DEPENDENCY_TYPES,
  BUSINESS_CASE_STAGES,
  BUSINESS_CASE_STATUSES,
  BENEFIT_STATUSES,
  GATE_DECISIONS,
  LOGIC_MODEL_LEVELS,
  OPTIMISM_BIAS_CATEGORIES,
  RAG_RATINGS,
  type BenefitDependencyType,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { pushNotifications } from "../notifications/service.js";
import {
  appraiseOption,
  benefitProgressPercent,
  economicIrr,
  netCashflows,
  sensitivityAnalysis,
  type AppraisalConfig,
  type OptionAppraisal,
  type SensitivityAnalysis,
} from "./appraisal.js";
import {
  propagateBenefitStatus,
  realisationSeries,
  wouldCycle,
  type BenefitEdge,
  type BenefitNode,
} from "./benefits.js";
import {
  buildGateEvidencePack,
  gateStatusForDecision,
  missingEvidenceLinks,
  type EvidenceLink,
  type PackItemInput,
} from "./pack.js";
import {
  registerGovernanceJobs,
  sweepAssuranceActions,
  sweepBenefitStatuses,
  sweepGateConditions,
} from "./jobs.js";
import { companyToolGate, isIndependentReviewer, visibleProjectIds } from "./gates.js";
import { OPTIMISM_BIAS_TABLE, referenceClassForecast, upliftFor } from "../risk/optimism.js";
import { referenceProjects } from "@constructos/db";

/* ------------------------------------------------------------------ */
/* JSONB shapes                                                        */
/* ------------------------------------------------------------------ */

interface BcOption {
  id: string;
  name: string;
  /** do-nothing / do-minimum counterfactual flag (#397) */
  isCounterfactual: boolean;
  capex: number;
  annualBenefits: number[];
  annualCosts: number[];
  computed: OptionAppraisal & {
    /** economic IRR; null when the cashflow series has no sign change (#400) */
    eirr: number | null;
    /** ±10/20/30% grid, switching values and tornado ordering (#406) */
    sensitivity: SensitivityAnalysis;
  };
}

interface GateCriterion {
  id: string;
  text: string;
  evidenceRequired: boolean;
}

interface GateCondition {
  id: string;
  text: string;
  dueDate: string | null;
  /** assurance obligation materialized for this condition (#413) */
  obligationId: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const casesSchema = z.object({
  strategic: z.string().max(50000).optional(),
  economic: z.string().max(50000).optional(),
  commercial: z.string().max(50000).optional(),
  financial: z.string().max(50000).optional(),
  management: z.string().max(50000).optional(),
});

/**
 * Appraisal config (#398, #401-402). discountRatePercent defaults to 3.5 —
 * the HM Treasury Green Book social time preference rate; jurisdictions with
 * a different social discount rate override it here (#401).
 */
const appraisalSchema = z.object({
  discountRatePercent: z.number().min(0).max(100).default(3.5),
  appraisalYears: z.number().int().min(1).max(60),
  optimismBiasPercent: z.number().min(0).max(1000).default(0),
});

const bcCreateSchema = z.object({
  stage: z.enum(BUSINESS_CASE_STAGES),
  title: z.string().min(1).max(300),
  cases: casesSchema.optional(),
  appraisal: appraisalSchema,
});

/** No defaults here — a PATCH merges over the stored config, so an absent key must stay absent. */
const appraisalPatchSchema = z.object({
  discountRatePercent: z.number().min(0).max(100).optional(),
  appraisalYears: z.number().int().min(1).max(60).optional(),
  optimismBiasPercent: z.number().min(0).max(1000).optional(),
});

const bcPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  cases: casesSchema.optional(),
  stage: z.enum(BUSINESS_CASE_STAGES).optional(),
  appraisal: appraisalPatchSchema.optional(),
});

const bcListQuery = pageQuerySchema.extend({
  stage: z.enum(BUSINESS_CASE_STAGES).optional(),
  status: z.enum(BUSINESS_CASE_STATUSES).optional(),
});

const optionInputSchema = z.object({
  id: z.string().min(1).max(60).optional(),
  name: z.string().min(1).max(300),
  isCounterfactual: z.boolean().optional(),
  capex: z.number().min(0).finite(),
  annualBenefits: z.array(z.number().finite()).max(60),
  annualCosts: z.array(z.number().finite()).max(60),
});

const optionsPutSchema = z.object({
  options: z.array(optionInputSchema).min(1).max(50),
});

const gateCreateSchema = z.object({
  gateNumber: z.number().int().min(0).max(5),
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  criteria: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        evidenceRequired: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
  plannedDate: isoDateSchema.nullable().optional(),
});

const gatePatchSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  criteria: z
    .array(
      z.object({
        id: z.string().min(1).max(60).optional(),
        text: z.string().min(1).max(2000),
        evidenceRequired: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  plannedDate: isoDateSchema.nullable().optional(),
});

const reviewCreateSchema = z.object({
  reviewDate: isoDateSchema,
  rag: z.enum(RAG_RATINGS),
  decision: z.enum(GATE_DECISIONS),
  narrative: z.string().max(50000).nullable().optional(),
  findings: z
    .array(
      z.object({
        criterionId: z.string().min(1),
        met: z.boolean(),
        note: z.string().max(5000).optional(),
        /** artefacts the reviewer looked at — required where evidenceRequired (#410) */
        evidenceIds: z.array(z.string().min(1)).max(50).optional(),
        fileIds: z.array(z.string().min(1)).max(50).optional(),
      }),
    )
    .max(200),
  conditions: z
    .array(
      z.object({
        text: z.string().min(1).max(5000),
        dueDate: isoDateSchema.optional(),
      }),
    )
    .max(100)
    .optional(),
});

const conditionCloseSchema = z.object({
  note: z.string().max(5000).nullable().optional(),
});

/* ---- platform upgrade wave ---- */

const referenceClassSchema = z.object({
  category: z.enum(OPTIMISM_BIAS_CATEGORIES),
  /** 0 = nothing mitigated (upper bound), 1 = all drivers addressed (lower bound) */
  position: z.number().min(0).max(1).default(0),
  mitigations: z.array(z.string().max(1000)).max(50).optional(),
  /** apply the outside view instead of the table, when the class supports it */
  useOutsideView: z.boolean().default(false),
  outsideConfidence: z.enum(["p50", "p80", "p90"]).default("p80"),
});

const upliftChallengeSchema = z.object({
  category: z.enum(OPTIMISM_BIAS_CATEGORIES),
  proposedPercent: z.number().min(0).max(1000),
  justification: z.string().min(20).max(20000),
});

const challengeDecisionSchema = z.object({
  note: z.string().max(5000).nullable().optional(),
});

const logicModelSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(60).optional(),
        level: z.enum(LOGIC_MODEL_LEVELS),
        label: z.string().min(1).max(500),
        note: z.string().max(5000).nullable().optional(),
        benefitId: z.string().min(1).nullable().optional(),
      }),
    )
    .max(200),
  edges: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .max(400),
});

const dependencySchema = z.object({
  fromBenefitId: z.string().min(1),
  toBenefitId: z.string().min(1),
  depType: z.enum(BENEFIT_DEPENDENCY_TYPES).default("contributes"),
  note: z.string().max(2000).nullable().optional(),
});

const assuranceActionCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  source: z.enum(["gate_review", "assurance_review", "audit", "other"]).default("other"),
  gateReviewId: z.string().min(1).nullable().optional(),
  priority: z.enum(ASSURANCE_ACTION_PRIORITIES).default("recommended"),
  ownerId: z.string().min(1).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

const assuranceActionPatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  priority: z.enum(ASSURANCE_ACTION_PRIORITIES).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  status: z.enum(["open", "in_progress", "cancelled"]).optional(),
});

const assuranceActionCloseSchema = z.object({
  note: z.string().max(5000).nullable().optional(),
  evidenceIds: z.array(z.string().min(1)).max(50).optional(),
});

const assuranceActionListQuery = pageQuerySchema.extend({
  status: z.enum(ASSURANCE_ACTION_STATUSES).optional(),
  ownerId: z.string().min(1).optional(),
});

const benefitCreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  measurementMethod: z.string().max(2000).nullable().optional(),
  unit: z.string().min(1).max(50),
  baselineValue: z.number().finite(),
  targetValue: z.number().finite(),
  targetDate: isoDateSchema.nullable().optional(),
  isDisbenefit: z.boolean().optional(),
});

const benefitPatchSchema = benefitCreateSchema.partial();

const benefitListQuery = pageQuerySchema.extend({
  status: z.enum(BENEFIT_STATUSES).optional(),
});

const readingCreateSchema = z.object({
  readingDate: isoDateSchema,
  value: z.number().finite(),
  note: z.string().max(5000).nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The full computed block for one option: NPV/BCR/payback (#398-399), the
 * economic IRR (#400) and the sensitivity/switching-value analysis (#406).
 * One definition, used by both the options PUT and the appraisal-config
 * PATCH, so a persisted block can never drift from its config.
 */
function computeOption(
  cashflows: { capex: number; annualBenefits: number[]; annualCosts: number[] },
  config: AppraisalConfig,
): BcOption["computed"] {
  return {
    ...appraiseOption(cashflows, config),
    eirr: economicIrr(netCashflows(cashflows, config)),
    sensitivity: sensitivityAnalysis(cashflows, config),
  };
}

function asAppraisalConfig(raw: Record<string, unknown>): AppraisalConfig {
  return {
    discountRatePercent: Number(raw.discountRatePercent ?? 3.5),
    appraisalYears: Number(raw.appraisalYears ?? 1),
    optimismBiasPercent: Number(raw.optimismBiasPercent ?? 0),
  };
}

/**
 * Owner-side capital programme governance — spec Vol II Domain G / M12
 * (#394-421 subset): five-case business case lifecycle (#394-395) with
 * options appraisal to NPV/BCR under a configurable social discount rate and
 * optimism bias uplift (#396-399, #401-402), counterfactual flagging (#397),
 * determination-independent approval, OGC/IPA-style stage gates with
 * criteria findings, RAG delivery confidence and a decision register
 * (#408-414), conditions-of-approval tracked to closure as assurance
 * obligations (#413, #415), and a benefits register with baselines, targets,
 * realisation readings and disbenefit tracking (#416-418, #420).
 */
export const governanceModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("governance", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("governance", "standard"),
  ];
  /**
   * The decision gates. Approving a business case and recording a Gateway
   * review are determinations, not edits: both were on "standard", which
   * meant any project member with governance:standard — the estimator, a
   * contractor-side user — could approve the money case or stop the
   * project. They now need governance:admin, and a gate review
   * additionally needs an independence finding (see the review route).
   */
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("governance", "admin"),
  ];
  const companyReadGate = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "governance", "read"),
  ];
  registerGovernanceJobs(app);

  /* ---------------------------------------------------------------- */
  /* Business cases (#394-405)                                         */
  /* ---------------------------------------------------------------- */

  async function fetchBc(bcId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(businessCases)
      .where(
        and(
          eq(businessCases.id, bcId),
          eq(businessCases.companyId, companyId),
          eq(businessCases.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Business case not found");
    return rows[0];
  }

  app.post(
    "/projects/:projectId/business-cases",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = bcCreateSchema.parse(req.body);
      const id = newId("bc");
      await app.db.insert(businessCases).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        stage: body.stage,
        status: "draft",
        title: body.title,
        cases: (body.cases ?? {}) as Record<string, string>,
        appraisal: body.appraisal,
        options: [],
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "business_case",
        objectId: id,
        payload: { stage: body.stage, title: body.title, appraisal: body.appraisal },
        storePayload: true,
      });
      return reply.status(201).send(await fetchBc(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/business-cases", { preHandler: readGate }, async (req) => {
    const q = bcListQuery.parse(req.query);
    const clauses = [
      eq(businessCases.companyId, req.companyId!),
      eq(businessCases.projectId, req.projectId!),
    ];
    if (q.stage) clauses.push(eq(businessCases.stage, q.stage));
    if (q.status) clauses.push(eq(businessCases.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(businessCases).where(where);
    const rows = await app.db
      .select()
      .from(businessCases)
      .where(where)
      .orderBy(desc(businessCases.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/business-cases/:bcId", { preHandler: readGate }, async (req) => {
    const { bcId } = req.params as { bcId: string };
    return fetchBc(bcId, req.companyId!, req.projectId!);
  });

  /**
   * PATCH rules: an approved/rejected business case is immutable (the
   * determination stands); stage and appraisal changes are draft-only, while
   * title/cases narratives may still be refined on a submitted case. An
   * appraisal change recomputes every stored option's NPV/BCR/payback so the
   * persisted computed block never drifts from its config.
   */
  app.patch("/projects/:projectId/business-cases/:bcId", { preHandler: standardGate }, async (req) => {
    const { bcId } = req.params as { bcId: string };
    const body = bcPatchSchema.parse(req.body);
    const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
    if (bc.status === "approved" || bc.status === "rejected") {
      throw badRequest(`A ${bc.status} business case is immutable`);
    }
    if ((body.stage !== undefined || body.appraisal !== undefined) && bc.status !== "draft") {
      throw badRequest("Stage and appraisal can only be changed while the business case is draft");
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set.title = body.title;
    if (body.stage !== undefined) set.stage = body.stage;
    if (body.cases !== undefined) {
      set.cases = { ...(bc.cases as Record<string, string>), ...body.cases };
    }
    if (body.appraisal !== undefined) {
      const merged = { ...asAppraisalConfig(bc.appraisal), ...body.appraisal };
      set.appraisal = merged;
      const options = bc.options as BcOption[];
      set.options = options.map((o) => ({ ...o, computed: computeOption(o, merged) }));
    }
    await app.db.update(businessCases).set(set).where(eq(businessCases.id, bcId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "business_case",
      objectId: bcId,
      payload: { changed: Object.keys(body) },
    });
    return fetchBc(bcId, req.companyId!, req.projectId!);
  });

  /**
   * Replace the option set (#396-397). The server owns the computed block:
   * per option, capexAdjusted = capex x (1 + OB%) — optimism bias applied to
   * capex only (#402) — then NPV, BCR and simple payback under the case's
   * appraisal config (#398-399). Annual series are padded/truncated to the
   * appraisal horizon. Draft-only: the appraisal a decision was made on
   * cannot be re-shaped afterwards.
   */
  app.put("/projects/:projectId/business-cases/:bcId/options", { preHandler: standardGate }, async (req) => {
    const { bcId } = req.params as { bcId: string };
    const body = optionsPutSchema.parse(req.body);
    const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
    if (bc.status !== "draft") {
      throw badRequest("Options can only be edited while the business case is draft");
    }
    const seen = new Set<string>();
    for (const o of body.options) {
      if (o.id) {
        if (seen.has(o.id)) throw badRequest(`Duplicate option id: ${o.id}`);
        seen.add(o.id);
      }
    }
    const config = asAppraisalConfig(bc.appraisal);
    const options: BcOption[] = body.options.map((o) => {
      const cashflows = {
        capex: o.capex,
        annualBenefits: o.annualBenefits,
        annualCosts: o.annualCosts,
      };
      return {
        id: o.id ?? newId("opt"),
        name: o.name,
        isCounterfactual: o.isCounterfactual ?? false,
        ...cashflows,
        computed: computeOption(cashflows, config),
      };
    });
    const set: Record<string, unknown> = { options, updatedAt: new Date().toISOString() };
    // a previously preferred option that no longer exists is unselected
    if (bc.preferredOptionId && !options.some((o) => o.id === bc.preferredOptionId)) {
      set.preferredOptionId = null;
    }
    await app.db.update(businessCases).set(set).where(eq(businessCases.id, bcId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "business_case",
      objectId: bcId,
      payload: {
        options: options.map((o) => ({ id: o.id, name: o.name, computed: o.computed })),
      },
      storePayload: true,
    });
    return fetchBc(bcId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/business-cases/:bcId/select-option",
    { preHandler: standardGate },
    async (req) => {
      const { bcId } = req.params as { bcId: string };
      const body = z.object({ optionId: z.string().min(1) }).parse(req.body);
      const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
      if (bc.status !== "draft" && bc.status !== "submitted") {
        throw badRequest(`A preferred option cannot be selected on a ${bc.status} business case`);
      }
      const options = bc.options as BcOption[];
      if (!options.some((o) => o.id === body.optionId)) {
        throw badRequest("optionId does not match any option on this business case");
      }
      await app.db
        .update(businessCases)
        .set({ preferredOptionId: body.optionId, updatedAt: new Date().toISOString() })
        .where(eq(businessCases.id, bcId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "business_case",
        objectId: bcId,
        payload: { preferredOptionId: body.optionId },
      });
      return fetchBc(bcId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/business-cases/:bcId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { bcId } = req.params as { bcId: string };
      const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
      if (bc.status !== "draft") throw badRequest(`A ${bc.status} business case cannot be submitted`);
      await app.db
        .update(businessCases)
        .set({ status: "submitted", updatedAt: new Date().toISOString() })
        .where(eq(businessCases.id, bcId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "business_case",
        objectId: bcId,
        payload: { from: "draft", to: "submitted" },
      });
      return fetchBc(bcId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Determination independence: the person who authored a business case may
   * not decide it (403). Approval additionally requires a preferred option —
   * an approval that endorses no option is not a decision (#396, #412).
   */
  for (const verb of ["approve", "reject"] as const) {
    app.post(
      `/projects/:projectId/business-cases/:bcId/${verb}`,
      { preHandler: adminGate },
      async (req) => {
        const { bcId } = req.params as { bcId: string };
        const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
        if (bc.status !== "submitted") {
          throw badRequest(`Only a submitted business case can be ${verb}d (this one is ${bc.status})`);
        }
        if (req.user!.id === bc.createdBy) {
          throw forbidden(
            "Determination independence: the author of a business case cannot decide it",
          );
        }
        if (verb === "approve" && !bc.preferredOptionId) {
          throw badRequest("A business case cannot be approved without a preferred option selected");
        }
        const now = new Date().toISOString();
        await app.db
          .update(businessCases)
          .set(
            verb === "approve"
              ? { status: "approved", approvedBy: req.user!.id, approvedAt: now, updatedAt: now }
              : { status: "rejected", updatedAt: now },
          )
          .where(eq(businessCases.id, bcId));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "business_case",
          objectId: bcId,
          payload: {
            from: "submitted",
            to: verb === "approve" ? "approved" : "rejected",
            preferredOptionId: bc.preferredOptionId,
          },
          storePayload: true,
        });
        return fetchBc(bcId, req.companyId!, req.projectId!);
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Stage gates (#408-415)                                            */
  /* ---------------------------------------------------------------- */

  async function fetchGate(gateId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(stageGates)
      .where(
        and(
          eq(stageGates.id, gateId),
          eq(stageGates.companyId, companyId),
          eq(stageGates.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Stage gate not found");
    return rows[0];
  }

  app.post("/projects/:projectId/stage-gates", { preHandler: standardGate }, async (req, reply) => {
    const body = gateCreateSchema.parse(req.body);
    // The check-then-insert below is a race against stage_gates_uq: two
    // concurrent "Gate 2" creates both pass the lookup and the second used to
    // surface the unique violation as a 500. The lookup stays for the good
    // error message; the insert is guarded so the loser gets the 409 the
    // check would have given it.
    const existing = await app.db
      .select({ id: stageGates.id })
      .from(stageGates)
      .where(
        and(eq(stageGates.projectId, req.projectId!), eq(stageGates.gateNumber, body.gateNumber)),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict(`Gate ${body.gateNumber} is already defined for this project`);
    }
    const id = newId("gat");
    const criteria: GateCriterion[] = body.criteria.map((c) => ({
      id: newId("crt"),
      text: c.text,
      evidenceRequired: c.evidenceRequired ?? false,
    }));
    const inserted = await app.db
      .insert(stageGates)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        gateNumber: body.gateNumber,
        name: body.name,
        description: body.description ?? null,
        criteria,
        plannedDate: body.plannedDate ?? null,
        status: "pending",
      })
      .onConflictDoNothing({ target: [stageGates.projectId, stageGates.gateNumber] })
      .returning({ id: stageGates.id });
    if (inserted.length === 0) {
      throw conflict(`Gate ${body.gateNumber} is already defined for this project`);
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "stage_gate",
      objectId: id,
      payload: { gateNumber: body.gateNumber, name: body.name, criteria: criteria.length },
      storePayload: true,
    });
    return reply.status(201).send(await fetchGate(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/stage-gates", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(stageGates.companyId, req.companyId!),
      eq(stageGates.projectId, req.projectId!),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(stageGates).where(where);
    const rows = await app.db
      .select()
      .from(stageGates)
      .where(where)
      .orderBy(asc(stageGates.gateNumber))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    // attach the latest review's decision + RAG per gate (#412, #414)
    const latest = new Map<string, { decision: string; rag: string; reviewDate: string }>();
    if (rows.length > 0) {
      const reviews = await app.db
        .select()
        .from(gateReviews)
        .where(
          inArray(
            gateReviews.gateId,
            rows.map((g) => g.id),
          ),
        )
        .orderBy(asc(gateReviews.createdAt));
      for (const r of reviews) {
        latest.set(r.gateId, { decision: r.decision, rag: r.rag, reviewDate: r.reviewDate });
      }
    }
    const items = rows.map((g) => ({ ...g, latestReview: latest.get(g.id) ?? null }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/stage-gates/:gateId", { preHandler: readGate }, async (req) => {
    const { gateId } = req.params as { gateId: string };
    const gate = await fetchGate(gateId, req.companyId!, req.projectId!);
    const reviews = await app.db
      .select()
      .from(gateReviews)
      .where(eq(gateReviews.gateId, gateId))
      .orderBy(desc(gateReviews.createdAt));
    return { ...gate, reviews };
  });

  app.patch("/projects/:projectId/stage-gates/:gateId", { preHandler: standardGate }, async (req) => {
    const { gateId } = req.params as { gateId: string };
    const body = gatePatchSchema.parse(req.body);
    const gate = await fetchGate(gateId, req.companyId!, req.projectId!);
    if (gate.status === "decided") {
      throw badRequest("A decided stage gate can no longer be edited");
    }
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.plannedDate !== undefined) set.plannedDate = body.plannedDate;
    if (body.criteria !== undefined) {
      set.criteria = body.criteria.map(
        (c): GateCriterion => ({
          id: c.id ?? newId("crt"),
          text: c.text,
          evidenceRequired: c.evidenceRequired ?? false,
        }),
      );
    }
    await app.db.update(stageGates).set(set).where(eq(stageGates.id, gateId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "stage_gate",
      objectId: gateId,
      payload: { changed: Object.keys(body) },
    });
    return fetchGate(gateId, req.companyId!, req.projectId!);
  });

  /**
   * Record a gate review (#409-415).
   *
   * Three things changed here, and each of them was a real hole:
   *
   *  1. INDEPENDENCE. This route used to be `standard`. Any project member
   *     holding governance:standard — the estimator, a contractor-side user —
   *     could record a Gateway review, set a `stop` decision that lands in
   *     the project event graph, and close their own conditions. #411/#412
   *     expect an independent assurance reviewer, so the route now requires
   *     governance:admin AND an independence test: an assurance grant
   *     (integrity_reviewer / auditor) or company owner/admin. The basis of
   *     that finding is stored on the review, because "who was allowed to
   *     decide this, and why" is part of the decision.
   *
   *  2. EVIDENCE. Criteria marked `evidenceRequired` must be linked to real
   *     evidence or files; those content hashes are frozen into a
   *     Merkle-rooted pack whose root is stored on the review, so the
   *     decision is reproducible six months later.
   *
   *  3. ATOMICITY. Conditions materialise as obligations. That used to be N
   *     inserts followed by the review insert with no transaction, so a
   *     failure part-way left obligations with no owning record on the
   *     assurance register. The whole handler now runs in one transaction.
   *
   * A `hold` decision no longer marks the gate `decided` — a hold is a
   * review still running, so the gate moves to `in_review` (the status the
   * schema and the UI already modelled and no route ever set).
   */
  app.post(
    "/projects/:projectId/stage-gates/:gateId/reviews",
    { preHandler: adminGate },
    async (req, reply) => {
      const { gateId } = req.params as { gateId: string };
      const body = reviewCreateSchema.parse(req.body);
      const gate = await fetchGate(gateId, req.companyId!, req.projectId!);
      const criteria = gate.criteria as GateCriterion[];

      const independence = await isIndependentReviewer(app, req);
      if (!independence.independent) {
        throw forbidden(
          `A gate review must be recorded by an independent reviewer. ${independence.basis} ` +
            `Grant an assurance role (integrity_reviewer or auditor) to the reviewer, or have a ` +
            `company owner or admin record the decision.`,
        );
      }

      const knownIds = new Set(criteria.map((c) => c.id));
      const coveredIds = new Set(body.findings.map((f) => f.criterionId));
      const missing = criteria.filter((c) => !coveredIds.has(c.id));
      if (missing.length > 0) {
        throw badRequest("Findings must cover every gate criterion", {
          missingCriterionIds: missing.map((c) => c.id),
          missingCriteria: missing.map((c) => c.text),
        });
      }
      const unknown = body.findings.filter((f) => !knownIds.has(f.criterionId));
      if (unknown.length > 0) {
        throw badRequest("Findings reference unknown criterion ids", {
          unknownCriterionIds: unknown.map((f) => f.criterionId),
        });
      }

      // Evidence-required criteria must carry at least one artefact (#410).
      const links: EvidenceLink[] = body.findings.map((f) => ({
        criterionId: f.criterionId,
        evidenceIds: f.evidenceIds,
        fileIds: f.fileIds,
      }));
      const unevidenced = missingEvidenceLinks(criteria, links);
      if (unevidenced.length > 0) {
        throw badRequest(
          "Every criterion marked as requiring evidence must be linked to evidence or a file before the gate can be decided",
          { unevidencedCriteria: unevidenced },
        );
      }

      // Resolve the artefacts and freeze the pack.
      const wantedEvidence = [...new Set(links.flatMap((l) => l.evidenceIds ?? []))];
      const wantedFiles = [...new Set(links.flatMap((l) => l.fileIds ?? []))];
      const evidenceRows = wantedEvidence.length
        ? await app.db
            .select({ id: evidence.id, contentHash: evidence.contentHash, source: evidence.source, kind: evidence.kind })
            .from(evidence)
            .where(
              and(
                inArray(evidence.id, wantedEvidence),
                eq(evidence.companyId, req.companyId!),
                eq(evidence.projectId, req.projectId!),
              ),
            )
        : [];
      if (evidenceRows.length !== wantedEvidence.length) {
        throw badRequest("One or more evidenceIds do not belong to this project");
      }
      const fileRows = wantedFiles.length
        ? await app.db
            .select({ id: files.id, sha256: files.sha256, name: files.name, projectId: files.projectId })
            .from(files)
            .where(and(inArray(files.id, wantedFiles), eq(files.companyId, req.companyId!)))
        : [];
      if (fileRows.length !== wantedFiles.length) {
        throw badRequest("One or more fileIds do not belong to this company");
      }
      const foreignFiles = fileRows.filter((f) => f.projectId && f.projectId !== req.projectId);
      if (foreignFiles.length > 0) {
        throw badRequest(
          "A gate evidence pack may only cite files belonging to this project",
          { foreignFileIds: foreignFiles.map((f) => f.id) },
        );
      }
      const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
      const fileById = new Map(fileRows.map((f) => [f.id, f]));
      const criterionText = new Map(criteria.map((c) => [c.id, c.text]));
      const packItems: PackItemInput[] = [];
      for (const l of links) {
        for (const id of l.evidenceIds ?? []) {
          const e = evidenceById.get(id)!;
          packItems.push({
            criterionId: l.criterionId,
            criterionText: criterionText.get(l.criterionId) ?? "",
            kind: "evidence",
            id,
            sha256: e.contentHash,
            title: `${e.kind} — ${e.source}`,
          });
        }
        for (const id of l.fileIds ?? []) {
          const f = fileById.get(id)!;
          packItems.push({
            criterionId: l.criterionId,
            criterionText: criterionText.get(l.criterionId) ?? "",
            kind: "file",
            id,
            sha256: f.sha256,
            title: f.name,
          });
        }
      }
      const evidenceRequiredWithoutLink = criteria
        .filter((c) => c.evidenceRequired)
        .filter((c) => !packItems.some((i) => i.criterionId === c.id))
        .map((c) => ({ criterionId: c.id, text: c.text }));
      const pack = buildGateEvidencePack(
        packItems,
        evidenceRequiredWithoutLink,
        new Date().toISOString(),
      );

      const reviewId = newId("grv");
      const nextStatus = gateStatusForDecision(body.decision);

      await app.db.transaction(async (tx) => {
        const conditions: GateCondition[] = [];
        for (const c of body.conditions ?? []) {
          // conditions-of-approval tracked to closure as assurance obligations (#413)
          const obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `Gate ${gate.gateNumber} — ${gate.name}`,
            trigger: c.text,
            deadline: c.dueDate ? `${c.dueDate}T23:59:59Z` : null,
            warnDaysBefore: 7,
            evidenceRequirement: "Evidence that the gate condition has been discharged",
            status: "open",
            createdBy: req.user!.id,
          });
          conditions.push({
            id: newId("gcn"),
            text: c.text,
            dueDate: c.dueDate ?? null,
            obligationId,
            closed: false,
            closedAt: null,
            closedBy: null,
            closeNote: null,
          });
        }

        await tx.insert(gateReviews).values({
          id: reviewId,
          gateId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          reviewDate: body.reviewDate,
          rag: body.rag,
          decision: body.decision,
          narrative: body.narrative ?? null,
          findings: body.findings,
          conditions,
          evidencePack: pack as unknown as Record<string, unknown>,
          evidencePackRoot: pack.root,
          independence: { independent: true, basis: independence.basis },
          reviewedBy: req.user!.id,
        });
        await tx
          .update(stageGates)
          .set({ status: nextStatus, updatedAt: new Date().toISOString() })
          .where(eq(stageGates.id, gateId));

        if (body.decision === "stop") {
          // a stop decision is a project-level event, not just a register row
          await tx.insert(events).values({
            id: newId("evt"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            type: "gate_stop",
            occurredAt: new Date().toISOString(),
            detectedOrReported: "reported",
            payload: { gateId, reviewId, gateNumber: gate.gateNumber, rag: body.rag },
            createdBy: req.user!.id,
          });
        }

        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "gate_review",
          objectId: reviewId,
          payload: {
            gateId,
            decision: body.decision,
            rag: body.rag,
            evidencePackRoot: pack.root,
            evidenceItems: pack.itemCount,
            independence: independence.basis,
            conditions: conditions.map((c) => ({ id: c.id, obligationId: c.obligationId })),
          },
          storePayload: true,
          projectId: req.projectId!,
        });
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "stage_gate",
          objectId: gateId,
          payload: { from: gate.status, to: nextStatus, reviewId, decision: body.decision },
          projectId: req.projectId!,
        });
      });

      const review = (
        await app.db.select().from(gateReviews).where(eq(gateReviews.id, reviewId)).limit(1)
      )[0];
      return reply.status(201).send(review);
    },
  );

  /** Close one condition of approval: condition closed + obligation satisfied (#413). */
  app.post(
    "/projects/:projectId/gate-reviews/:reviewId/conditions/:conditionId/close",
    { preHandler: standardGate },
    async (req) => {
      const { reviewId, conditionId } = req.params as { reviewId: string; conditionId: string };
      const body = conditionCloseSchema.parse(req.body ?? {});
      const rows = await app.db
        .select()
        .from(gateReviews)
        .where(
          and(
            eq(gateReviews.id, reviewId),
            eq(gateReviews.companyId, req.companyId!),
            eq(gateReviews.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const review = rows[0];
      if (!review) throw notFound("Gate review not found");
      const conditions = review.conditions as GateCondition[];
      const condition = conditions.find((c) => c.id === conditionId);
      if (!condition) throw notFound("Condition not found on this gate review");
      if (condition.closed) throw badRequest("Condition is already closed");
      // Segregation of duties (#413): the reviewer who imposed a condition
      // cannot also declare it discharged. Somebody else has to look.
      if (review.reviewedBy === req.user!.id) {
        throw forbidden(
          "The reviewer who imposed this condition of approval cannot close it — a condition " +
            "closed by the person who set it is not an independent check.",
        );
      }
      const now = new Date().toISOString();
      const updated = conditions.map((c) =>
        c.id === conditionId
          ? { ...c, closed: true, closedAt: now, closedBy: req.user!.id, closeNote: body.note ?? null }
          : c,
      );
      await app.db.transaction(async (tx) => {
        await tx.update(gateReviews).set({ conditions: updated }).where(eq(gateReviews.id, reviewId));
        // A late closure does not rewrite the register: a breached
        // obligation stays breached, it just stops being open.
        await tx
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, condition.obligationId), eq(obligations.status, "open")));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "gate_condition",
          objectId: conditionId,
          payload: {
            reviewId,
            obligationId: condition.obligationId,
            closed: true,
            note: body.note ?? null,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      const after = (
        await app.db.select().from(gateReviews).where(eq(gateReviews.id, reviewId)).limit(1)
      )[0];
      return after;
    },
  );

  /** Open conditions across every gate review, soonest due first (#413, #415). */
  app.get("/projects/:projectId/governance/conditions", { preHandler: readGate }, async (req) => {
    const reviews = await app.db
      .select()
      .from(gateReviews)
      .where(
        and(eq(gateReviews.companyId, req.companyId!), eq(gateReviews.projectId, req.projectId!)),
      );
    const gates = await app.db
      .select()
      .from(stageGates)
      .where(
        and(eq(stageGates.companyId, req.companyId!), eq(stageGates.projectId, req.projectId!)),
      );
    const gateById = new Map(gates.map((g) => [g.id, g]));
    const items = [];
    for (const review of reviews) {
      const gate = gateById.get(review.gateId);
      for (const c of review.conditions as GateCondition[]) {
        if (c.closed) continue;
        items.push({
          reviewId: review.id,
          gateId: review.gateId,
          gateNumber: gate?.gateNumber ?? null,
          gateName: gate?.name ?? null,
          decision: review.decision,
          conditionId: c.id,
          text: c.text,
          dueDate: c.dueDate,
          obligationId: c.obligationId,
          daysToDue: c.dueDate ? daysUntil(c.dueDate) : null,
        });
      }
    }
    items.sort((a, b) => {
      if (a.dueDate === b.dueDate) return a.conditionId < b.conditionId ? -1 : 1;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });
    return { items, total: items.length };
  });

  /* ---------------------------------------------------------------- */
  /* Benefits register (#416-421)                                      */
  /* ---------------------------------------------------------------- */

  async function fetchBenefit(benefitId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(benefits)
      .where(
        and(
          eq(benefits.id, benefitId),
          eq(benefits.companyId, companyId),
          eq(benefits.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Benefit not found");
    return rows[0];
  }

  async function latestReading(benefitId: string) {
    const rows = await app.db
      .select()
      .from(benefitReadings)
      .where(eq(benefitReadings.benefitId, benefitId))
      .orderBy(desc(benefitReadings.readingDate), desc(benefitReadings.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  function progressOf(
    benefit: typeof benefits.$inferSelect,
    latestValue: number | null,
  ): number | null {
    if (latestValue === null) return null;
    return benefitProgressPercent(benefit.baselineValue, benefit.targetValue, latestValue);
  }

  /**
   * Recompute a benefit's realisation status from its latest reading (#418)
   * and persist a transition when one happened. Transitions INTO at_risk or
   * missed notify the benefit owner. Returns the effective status.
   */
  async function applyBenefitStatus(
    benefit: typeof benefits.$inferSelect,
    actorId: string,
  ): Promise<BenefitStatus> {
    const reading = await latestReading(benefit.id);
    const progress = progressOf(benefit, reading ? reading.value : null);
    const next = benefitStatusFor(progress, benefit.targetDate, todayISO());
    if (next === benefit.status) return next;
    await app.db
      .update(benefits)
      .set({ status: next, updatedAt: new Date().toISOString() })
      .where(eq(benefits.id, benefit.id));
    await appendLedger(app.db, {
      companyId: benefit.companyId,
      actorId,
      action: "state_change",
      objectType: "benefit",
      objectId: benefit.id,
      payload: { from: benefit.status, to: next, progressPercent: progress },
    });
    if ((next === "at_risk" || next === "missed") && benefit.ownerId) {
      await pushNotifications(app.db, [
        {
          companyId: benefit.companyId,
          userId: benefit.ownerId,
          projectId: benefit.projectId,
          kind: "status_change",
          title: `Benefit "${benefit.name}" is now ${next === "at_risk" ? "at risk" : "missed"}`,
          body:
            `Benefit #${benefit.number} (${benefit.name}) moved from ${benefit.status} to ${next}: ` +
            `progress ${progress ?? 0}% against a target of ${benefit.targetValue} ${benefit.unit}` +
            (benefit.targetDate ? ` by ${benefit.targetDate}.` : "."),
          recordType: "benefit",
          recordId: benefit.id,
        },
      ]);
    }
    return next;
  }

  app.post("/projects/:projectId/benefits", { preHandler: standardGate }, async (req, reply) => {
    const body = benefitCreateSchema.parse(req.body);
    const number = await nextRecordNumber(app.db, req.projectId!, "benefit");
    const id = newId("ben");
    await app.db.insert(benefits).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      name: body.name,
      description: body.description ?? null,
      ownerId: body.ownerId ?? null,
      measurementMethod: body.measurementMethod ?? null,
      unit: body.unit,
      baselineValue: body.baselineValue,
      targetValue: body.targetValue,
      targetDate: body.targetDate ?? null,
      isDisbenefit: body.isDisbenefit ? 1 : 0,
      status: "planned",
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "benefit",
      objectId: id,
      payload: {
        number,
        name: body.name,
        unit: body.unit,
        baselineValue: body.baselineValue,
        targetValue: body.targetValue,
        isDisbenefit: body.isDisbenefit ?? false,
      },
      storePayload: true,
    });
    return reply.status(201).send(await fetchBenefit(id, req.companyId!, req.projectId!));
  });

  /**
   * The status shown here is recomputed before it is read (#418).
   *
   * Before this, applyBenefitStatus ran only on a PATCH or a new reading,
   * so a benefit at 30% progress with a target date a hundred days in the
   * past stayed "tracking" indefinitely and its owner was never told. The
   * scheduler recomputes on a cycle; this read-path sweep means a page
   * opened between cycles still shows the truth. Both call the same
   * sweepBenefitStatuses, so they cannot disagree.
   */
  app.get("/projects/:projectId/benefits", { preHandler: readGate }, async (req) => {
    const q = benefitListQuery.parse(req.query);
    await sweepBenefitStatuses(app.db, req.companyId!, {
      projectId: req.projectId!,
      actorId: null,
      today: todayISO(),
    });
    const clauses = [eq(benefits.companyId, req.companyId!), eq(benefits.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(benefits.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(benefits).where(where);
    const rows = await app.db
      .select()
      .from(benefits)
      .where(where)
      .orderBy(asc(benefits.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    // latest reading per listed benefit (single query, last-wins on sorted rows)
    const latestByBenefit = new Map<string, number>();
    if (rows.length > 0) {
      const readings = await app.db
        .select()
        .from(benefitReadings)
        .where(
          inArray(
            benefitReadings.benefitId,
            rows.map((b) => b.id),
          ),
        )
        .orderBy(asc(benefitReadings.readingDate), asc(benefitReadings.createdAt));
      for (const r of readings) latestByBenefit.set(r.benefitId, r.value);
    }
    const items = rows.map((b) => {
      const latestValue = latestByBenefit.has(b.id) ? latestByBenefit.get(b.id)! : null;
      return { ...b, latestValue, progressPercent: progressOf(b, latestValue) };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/benefits/:benefitId", { preHandler: readGate }, async (req) => {
    const { benefitId } = req.params as { benefitId: string };
    await fetchBenefit(benefitId, req.companyId!, req.projectId!); // 404 before sweeping
    await sweepBenefitStatuses(app.db, req.companyId!, {
      projectId: req.projectId!,
      benefitIds: [benefitId],
      actorId: null,
      today: todayISO(),
    });
    const benefit = await fetchBenefit(benefitId, req.companyId!, req.projectId!);
    const readings = await app.db
      .select()
      .from(benefitReadings)
      .where(eq(benefitReadings.benefitId, benefitId))
      .orderBy(asc(benefitReadings.readingDate), asc(benefitReadings.createdAt));
    const latestValue = readings.length > 0 ? readings[readings.length - 1]!.value : null;
    return {
      ...benefit,
      latestValue,
      progressPercent: progressOf(benefit, latestValue),
      readings,
    };
  });

  app.patch("/projects/:projectId/benefits/:benefitId", { preHandler: standardGate }, async (req) => {
    const { benefitId } = req.params as { benefitId: string };
    const body = benefitPatchSchema.parse(req.body);
    const benefit = await fetchBenefit(benefitId, req.companyId!, req.projectId!);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      set[k] = k === "isDisbenefit" ? (v ? 1 : 0) : v;
    }
    await app.db.update(benefits).set(set).where(eq(benefits.id, benefitId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "benefit",
      objectId: benefitId,
      payload: { changed: Object.keys(body) },
    });
    // baseline/target/date changes can move the realisation status
    const updated = await fetchBenefit(benefitId, req.companyId!, req.projectId!);
    await applyBenefitStatus(updated, req.user!.id);
    return fetchBenefit(benefitId, req.companyId!, req.projectId!);
  });

  app.post(
    "/projects/:projectId/benefits/:benefitId/readings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { benefitId } = req.params as { benefitId: string };
      const body = readingCreateSchema.parse(req.body);
      const benefit = await fetchBenefit(benefitId, req.companyId!, req.projectId!);
      const id = newId("brd");
      await app.db.insert(benefitReadings).values({
        id,
        benefitId,
        companyId: req.companyId!,
        readingDate: body.readingDate,
        value: body.value,
        note: body.note ?? null,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "benefit_reading",
        objectId: id,
        payload: { benefitId, readingDate: body.readingDate, value: body.value },
        storePayload: true,
      });
      const status = await applyBenefitStatus(benefit, req.user!.id);
      const updated = await fetchBenefit(benefitId, req.companyId!, req.projectId!);
      const latest = await latestReading(benefitId);
      return reply.status(201).send({
        ...updated,
        status,
        latestValue: latest ? latest.value : null,
        progressPercent: progressOf(updated, latest ? latest.value : null),
        reading: { id, readingDate: body.readingDate, value: body.value },
      });
    },
  );
};
