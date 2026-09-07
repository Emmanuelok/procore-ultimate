/**
 * Capital governance: business cases, stage gates, benefits and assurance
 * (spec Vol II Domain I #400-406, #410-422, Vol I §7).
 *
 * WHAT IT IS
 * The owner-side approval spine. Five-case business cases with appraisal
 * arithmetic (NPV/BCR/EIRR, a ±10/20/30% sensitivity grid, tornado and
 * switching values — appraisal.ts), stage gates whose reviews freeze a
 * Merkle-rooted evidence pack (pack.ts) so a decision stays reproducible,
 * a lessons-closure gate (lessons.ts), benefits with a dependency DAG and
 * upstream at_risk propagation (benefits.ts), assurance actions tracked as
 * owned obligations, and an uplift-challenge machine so a deviation from
 * the optimism-bias table is argued, decided and ledgered.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * The person who authors an assertion never tests it. Approval and gate
 * decisions are adminGate AND require an independent reviewer (an
 * assurance grant covering THIS project, or company owner/admin —
 * gates.ts); a criterion marked evidence-required cannot be decided
 * without an artefact; conditions of approval are obligations, not prose.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not compute programme or portfolio roll-ups (WP-PORTFOLIO reads
 * these tables), and it does not invent a benefit's realised value — a
 * benefit with no reading is "not measured", never zero.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
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
  lessons,
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
import type { Db } from "../../lib/db.js";
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
import {
  assessLessonsReadiness,
  lessonsGateApplies,
  type LessonForGate,
} from "./lessons.js";
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
  /**
   * Annual series default to empty rather than being mandatory: a capital-only
   * option genuinely has no recurring costs, and a benefits-only option
   * genuinely has no capex profile. `padToYears` pads either to the horizon,
   * so an omitted series means "nothing in these years" — which is what an
   * author omitting it actually means.
   */
  annualBenefits: z.array(z.number().finite()).max(60).default([]),
  annualCosts: z.array(z.number().finite()).max(60).default([]),
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
  /** lessons closure gate (#415): block "proceed" while lessons sit unvalidated */
  lessonsRequired: z.boolean().optional(),
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
  lessonsRequired: z.boolean().optional(),
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

  /**
   * Read the project's lessons and judge whether the stage's learning is
   * closed. Lessons are the learning module's records; this reads the four
   * fields the gate needs and nothing more, and it never writes to them —
   * a governance gate does not get to edit the evidence it is judging.
   *
   * A lesson published company-wide has its `projectId` cleared but keeps
   * `originProjectId`, so both are matched: publishing a lesson must not
   * make it vanish from the gate that was waiting for it.
   */
  async function lessonsReadinessFor(companyId: string, projectId: string, required: boolean) {
    const rows = await app.db
      .select({
        id: lessons.id,
        number: lessons.number,
        title: lessons.title,
        status: lessons.status,
        phase: lessons.phase,
        projectId: lessons.projectId,
        originProjectId: lessons.originProjectId,
      })
      .from(lessons)
      .where(
        and(
          eq(lessons.companyId, companyId),
          or(eq(lessons.projectId, projectId), eq(lessons.originProjectId, projectId)),
        ),
      )
      .orderBy(asc(lessons.number))
      .limit(500);
    const mine: LessonForGate[] = rows.map((l) => ({
      id: l.id,
      number: l.number,
      title: l.title,
      status: l.status,
      phase: l.phase,
    }));
    return assessLessonsReadiness(mine, { required });
  }

  app.get(
    "/projects/:projectId/stage-gates/:gateId/lessons-readiness",
    { preHandler: readGate },
    async (req) => {
      const { gateId } = req.params as { gateId: string };
      const gate = await fetchGate(gateId, req.companyId!, req.projectId!);
      const readiness = await lessonsReadinessFor(
        req.companyId!,
        req.projectId!,
        gate.lessonsRequired,
      );
      return { gateId: gate.id, gateNumber: gate.gateNumber, ...readiness };
    },
  );

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
        lessonsRequired: body.lessonsRequired ?? false,
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
    if (body.lessonsRequired !== undefined) set.lessonsRequired = body.lessonsRequired;
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

      // Lessons closure gate (#415): a gate that carries the requirement may
      // not be decided to PROCEED while the stage's learning is unresolved.
      // `stop` and `hold` are never blocked — refusing to let a project stop
      // until its paperwork is tidy would be the wrong incentive entirely.
      if (gate.lessonsRequired && lessonsGateApplies(body.decision)) {
        const readiness = await lessonsReadinessFor(
          req.companyId!,
          req.projectId!,
          gate.lessonsRequired,
        );
        if (!readiness.ready) {
          throw conflict(
            `This gate carries a lessons closure requirement. ${readiness.reasons.join(" ")}`,
          );
        }
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

        await appendLedger(tx as Db, {
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
        await appendLedger(tx as Db, {
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
        await appendLedger(tx as Db, {
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
   * Recompute one benefit’s realisation status (#418).
   *
   * A thin wrapper over the shared sweep in jobs.ts rather than a second
   * implementation: the read path, the write path and the scheduler must
   * agree on what "missed" means, and the only way to guarantee that is
   * for there to be one function that decides it.
   */
  async function applyBenefitStatus(
    benefit: typeof benefits.$inferSelect,
    actorId: string,
  ): Promise<string> {
    await sweepBenefitStatuses(app.db, benefit.companyId, {
      projectId: benefit.projectId,
      benefitIds: [benefit.id],
      actorId,
      today: todayISO(),
    });
    const [after] = await app.db
      .select({ status: benefits.status })
      .from(benefits)
      .where(eq(benefits.id, benefit.id))
      .limit(1);
    return after?.status ?? benefit.status;
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

  /* ---------------------------------------------------------------- */
  /* Reference class forecasting on the business case (#403-405)       */
  /* ---------------------------------------------------------------- */

  /**
   * Pick a Green Book category and a mitigation position on its range
   * instead of typing a free percent (#402-404). The route computes BOTH
   * views — the published table at that position (inside view) and the
   * empirical uplift of the company's own reference class (outside view) —
   * records which was taken, and writes the resulting percentage into the
   * appraisal so every option recomputes against it.
   *
   * Deviating from the table is still possible, but only through an uplift
   * challenge that somebody else approves (#405).
   */
  app.put(
    "/projects/:projectId/business-cases/:bcId/reference-class",
    { preHandler: standardGate },
    async (req) => {
      const { bcId } = req.params as { bcId: string };
      const body = referenceClassSchema.parse(req.body);
      const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
      if (bc.status !== "draft") {
        throw badRequest("The optimism bias position can only be set while the case is draft");
      }
      const inside = upliftFor(body.category, body.position);
      if (!inside) throw badRequest(`Unknown optimism bias category ${body.category}`);

      const refs = await app.db
        .select()
        .from(referenceProjects)
        .where(
          and(
            eq(referenceProjects.companyId, req.companyId!),
            eq(referenceProjects.category, body.category),
          ),
        );
      const outside = referenceClassForecast(
        refs.map((r) => ({
          id: r.id,
          name: r.name,
          category: r.category,
          estimatedCost: r.estimatedCost,
          outturnCost: r.outturnCost,
          estimatedDurationDays: r.estimatedDurationDays,
          outturnDurationDays: r.outturnDurationDays,
        })),
        { category: body.category, basis: "cost" },
      );

      const outsideValue =
        body.outsideConfidence === "p50"
          ? outside.p50UpliftPercent
          : body.outsideConfidence === "p90"
            ? outside.p90UpliftPercent
            : outside.p80UpliftPercent;
      if (body.useOutsideView && outsideValue === null) {
        throw badRequest(
          outside.unavailableReason ??
            "The outside view cannot be computed for this class, so it cannot be applied.",
        );
      }
      const appliedPercent = body.useOutsideView ? outsideValue! : inside.upliftPercent;
      const view = body.useOutsideView ? "outside" : "inside";

      const config = { ...asAppraisalConfig(bc.appraisal), optimismBiasPercent: appliedPercent };
      const options = (bc.options as BcOption[]).map((o) => ({
        ...o,
        computed: computeOption(o, config),
      }));
      const referenceClass = {
        category: body.category,
        position: inside.position,
        upperPercent: inside.upperPercent,
        lowerPercent: inside.lowerPercent,
        mitigations: body.mitigations ?? [],
        appliedPercent,
        view,
        outsideConfidence: body.outsideConfidence,
        inside,
        outside,
        setAt: new Date().toISOString(),
        setBy: req.user!.id,
      };
      await app.db
        .update(businessCases)
        .set({
          appraisal: config as unknown as Record<string, unknown>,
          options,
          referenceClass,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(businessCases.id, bcId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "business_case",
        objectId: bcId,
        payload: { referenceClass: { category: body.category, appliedPercent, view } },
        storePayload: true,
        projectId: req.projectId!,
      });
      return fetchBc(bcId, req.companyId!, req.projectId!);
    },
  );

  /** The published table, read-only — guidance, not tenant data (#402). */
  app.get("/governance/optimism-bias", { preHandler: companyReadGate }, async () => ({
    source:
      "HM Treasury Green Book Supplementary Guidance on optimism bias, capital expenditure uplifts.",
    bands: OPTIMISM_BIAS_TABLE,
  }));

  /* ---------------------------------------------------------------- */
  /* Uplift challenges (#405)                                          */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/business-cases/:bcId/uplift-challenges",
    { preHandler: standardGate },
    async (req, reply) => {
      const { bcId } = req.params as { bcId: string };
      const body = upliftChallengeSchema.parse(req.body);
      const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
      if (bc.status === "approved" || bc.status === "rejected") {
        throw badRequest(`A ${bc.status} business case cannot carry a new uplift challenge`);
      }
      const band = upliftFor(body.category, 0);
      if (!band) throw badRequest(`Unknown optimism bias category ${body.category}`);
      const stored = (bc.referenceClass ?? {}) as { position?: number };
      const tableAtPosition = upliftFor(body.category, stored.position ?? 0)!;
      const id = newId("uch");
      await app.db.insert(upliftChallenges).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        businessCaseId: bcId,
        category: body.category,
        tablePercent: tableAtPosition.upliftPercent,
        proposedPercent: body.proposedPercent,
        justification: body.justification,
        status: "proposed",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "uplift_challenge",
        objectId: id,
        payload: {
          businessCaseId: bcId,
          category: body.category,
          tablePercent: tableAtPosition.upliftPercent,
          proposedPercent: body.proposedPercent,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(upliftChallenges)
        .where(eq(upliftChallenges.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/business-cases/:bcId/uplift-challenges",
    { preHandler: readGate },
    async (req) => {
      const { bcId } = req.params as { bcId: string };
      await fetchBc(bcId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(upliftChallenges)
        .where(
          and(
            eq(upliftChallenges.businessCaseId, bcId),
            eq(upliftChallenges.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(upliftChallenges.createdAt));
      return { items, total: items.length };
    },
  );

  /**
   * Decide a challenge. Approving one applies the proposed percentage to the
   * case and recomputes every option — the deviation is now on the record
   * with a named approver, which is the whole point of the mechanism (#405).
   */
  for (const verb of ["approve", "reject"] as const) {
    app.post(
      `/projects/:projectId/uplift-challenges/:challengeId/${verb}`,
      { preHandler: adminGate },
      async (req) => {
        const { challengeId } = req.params as { challengeId: string };
        const body = challengeDecisionSchema.parse(req.body ?? {});
        const rows = await app.db
          .select()
          .from(upliftChallenges)
          .where(
            and(
              eq(upliftChallenges.id, challengeId),
              eq(upliftChallenges.companyId, req.companyId!),
              eq(upliftChallenges.projectId, req.projectId!),
            ),
          )
          .limit(1);
        const challenge = rows[0];
        if (!challenge) throw notFound("Uplift challenge not found");
        if (challenge.status !== "proposed") {
          throw badRequest(`A ${challenge.status} challenge cannot be ${verb}d`);
        }
        if (challenge.createdBy === req.user!.id) {
          throw forbidden(
            "Determination independence: the person proposing a departure from the published uplift cannot approve it.",
          );
        }
        const now = new Date().toISOString();
        await app.db.transaction(async (tx) => {
          await tx
            .update(upliftChallenges)
            .set({
              status: verb === "approve" ? "approved" : "rejected",
              decidedBy: req.user!.id,
              decidedAt: now,
              decisionNote: body.note ?? null,
              updatedAt: now,
            })
            .where(eq(upliftChallenges.id, challengeId));
          if (verb === "approve") {
            // Read the case through `tx`, never through `app.db`. The
            // platform's test database (and any single-connection
            // deployment) serves one statement at a time: a query issued on
            // the outer handle while this transaction is open waits for the
            // transaction, which is waiting for the query — the request
            // hangs forever rather than failing. Everything inside a
            // transaction reads and writes through its own handle.
            const bcRows = await tx
              .select()
              .from(businessCases)
              .where(
                and(
                  eq(businessCases.id, challenge.businessCaseId),
                  eq(businessCases.companyId, req.companyId!),
                  eq(businessCases.projectId, req.projectId!),
                ),
              )
              .limit(1);
            const bc = bcRows[0];
            if (!bc) throw notFound("Business case not found");
            const config = {
              ...asAppraisalConfig(bc.appraisal),
              optimismBiasPercent: challenge.proposedPercent,
            };
            const options = (bc.options as BcOption[]).map((o) => ({
              ...o,
              computed: computeOption(o, config),
            }));
            const referenceClass = {
              ...((bc.referenceClass ?? {}) as Record<string, unknown>),
              appliedPercent: challenge.proposedPercent,
              view: "challenged",
              challengeId,
              challengeApprovedBy: req.user!.id,
              challengeApprovedAt: now,
            };
            await tx
              .update(businessCases)
              .set({
                appraisal: config as unknown as Record<string, unknown>,
                options,
                referenceClass,
                updatedAt: now,
              })
              .where(eq(businessCases.id, bc.id));
          }
          await appendLedger(tx as Db, {
            companyId: req.companyId!,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "uplift_challenge",
            objectId: challengeId,
            payload: {
              from: "proposed",
              to: verb === "approve" ? "approved" : "rejected",
              tablePercent: challenge.tablePercent,
              proposedPercent: challenge.proposedPercent,
              note: body.note ?? null,
            },
            storePayload: true,
            projectId: req.projectId!,
          });
        });
        const [after] = await app.db
          .select()
          .from(upliftChallenges)
          .where(eq(upliftChallenges.id, challengeId))
          .limit(1);
        return after;
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Logic model (#418)                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Inputs → outputs → outcomes → impacts. A benefit that cannot be traced
   * back through the chain to something the project actually builds is a
   * benefit nobody should be counting.
   */
  app.put(
    "/projects/:projectId/business-cases/:bcId/logic-model",
    { preHandler: standardGate },
    async (req) => {
      const { bcId } = req.params as { bcId: string };
      const body = logicModelSchema.parse(req.body);
      const bc = await fetchBc(bcId, req.companyId!, req.projectId!);
      if (bc.status === "approved" || bc.status === "rejected") {
        throw badRequest(`A ${bc.status} business case is immutable`);
      }
      const nodes = body.nodes.map((nd) => ({
        id: nd.id ?? newId("lmn"),
        level: nd.level,
        label: nd.label,
        note: nd.note ?? null,
        benefitId: nd.benefitId ?? null,
      }));
      const nodeIds = new Set(nodes.map((nd) => nd.id));
      for (const e of body.edges) {
        if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
          throw badRequest(`Logic model edge ${e.from} → ${e.to} references an unknown node`);
        }
      }
      const benefitIds = nodes.map((nd) => nd.benefitId).filter((x): x is string => Boolean(x));
      if (benefitIds.length > 0) {
        const found = await app.db
          .select({ id: benefits.id })
          .from(benefits)
          .where(
            and(
              inArray(benefits.id, [...new Set(benefitIds)]),
              eq(benefits.companyId, req.companyId!),
              eq(benefits.projectId, req.projectId!),
            ),
          );
        if (found.length !== new Set(benefitIds).size) {
          throw badRequest("A logic model node references a benefit outside this project");
        }
      }
      const logicModel = { nodes, edges: body.edges };
      await app.db
        .update(businessCases)
        .set({ logicModel, updatedAt: new Date().toISOString() })
        .where(eq(businessCases.id, bcId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "business_case",
        objectId: bcId,
        payload: { logicModel: { nodes: nodes.length, edges: body.edges.length } },
        projectId: req.projectId!,
      });
      return fetchBc(bcId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Benefit dependency network (#418-419)                             */
  /* ---------------------------------------------------------------- */

  async function loadNetwork(companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(benefits)
      .where(and(eq(benefits.companyId, companyId), eq(benefits.projectId, projectId)))
      .orderBy(asc(benefits.number));
    const edges = await app.db
      .select()
      .from(benefitDependencies)
      .where(
        and(
          eq(benefitDependencies.companyId, companyId),
          eq(benefitDependencies.projectId, projectId),
        ),
      );
    const readings = rows.length
      ? await app.db
          .select()
          .from(benefitReadings)
          .where(
            inArray(
              benefitReadings.benefitId,
              rows.map((b) => b.id),
            ),
          )
          .orderBy(asc(benefitReadings.readingDate), asc(benefitReadings.createdAt))
      : [];
    const latestByBenefit = new Map<string, number>();
    for (const r of readings) latestByBenefit.set(r.benefitId, r.value);
    const nodes: BenefitNode[] = rows.map((b) => ({
      id: b.id,
      number: b.number,
      name: b.name,
      ownStatus: b.status as BenefitNode["ownStatus"],
      baselineValue: b.baselineValue,
      targetValue: b.targetValue,
      latestValue: latestByBenefit.get(b.id) ?? null,
      targetDate: b.targetDate,
      isDisbenefit: b.isDisbenefit === 1,
    }));
    const graphEdges: BenefitEdge[] = edges.map((e) => ({
      fromBenefitId: e.fromBenefitId,
      toBenefitId: e.toBenefitId,
      depType: e.depType as BenefitDependencyType,
    }));
    return { rows, nodes, graphEdges, edges, readings };
  }

  app.get("/projects/:projectId/benefits/network", { preHandler: readGate }, async (req) => {
    await sweepBenefitStatuses(app.db, req.companyId!, {
      projectId: req.projectId!,
      actorId: null,
      today: todayISO(),
    });
    const { nodes, graphEdges, edges } = await loadNetwork(req.companyId!, req.projectId!);
    const propagated = propagateBenefitStatus(nodes, graphEdges);
    const byId = new Map(propagated.map((p) => [p.id, p]));
    return {
      nodes: nodes.map((nd) => ({
        ...nd,
        effectiveStatus: byId.get(nd.id)?.effectiveStatus ?? nd.ownStatus,
        inherited: byId.get(nd.id)?.inherited ?? false,
        causedBy: byId.get(nd.id)?.causedBy ?? [],
        reason: byId.get(nd.id)?.reason ?? null,
      })),
      edges,
      basis:
        "An 'enables' dependency propagates its predecessor's at_risk or missed status; a " +
        "'contributes' dependency propagates at_risk only. A benefit measured as realised is never " +
        "downgraded by an upstream failure, and nothing weights or apportions value along an edge — " +
        "nobody has the data to do that honestly.",
    };
  });

  app.post("/projects/:projectId/benefits/dependencies", { preHandler: standardGate }, async (req, reply) => {
    const body = dependencySchema.parse(req.body);
    if (body.fromBenefitId === body.toBenefitId) {
      throw badRequest("A benefit cannot depend on itself");
    }
    await fetchBenefit(body.fromBenefitId, req.companyId!, req.projectId!);
    await fetchBenefit(body.toBenefitId, req.companyId!, req.projectId!);
    const { graphEdges } = await loadNetwork(req.companyId!, req.projectId!);
    if (wouldCycle(graphEdges, body.fromBenefitId, body.toBenefitId)) {
      throw badRequest(
        "That dependency would close a cycle in the benefits network — a benefit cannot end up depending on itself through a chain.",
      );
    }
    const id = newId("bdp");
    const inserted = await app.db
      .insert(benefitDependencies)
      .values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        fromBenefitId: body.fromBenefitId,
        toBenefitId: body.toBenefitId,
        depType: body.depType,
        note: body.note ?? null,
        createdBy: req.user!.id,
      })
      .onConflictDoNothing({
        target: [benefitDependencies.fromBenefitId, benefitDependencies.toBenefitId],
      })
      .returning({ id: benefitDependencies.id });
    if (inserted.length === 0) throw conflict("That dependency already exists");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "benefit_dependency",
      objectId: id,
      payload: { from: body.fromBenefitId, to: body.toBenefitId, depType: body.depType },
      storePayload: true,
      projectId: req.projectId!,
    });
    const [row] = await app.db
      .select()
      .from(benefitDependencies)
      .where(eq(benefitDependencies.id, id))
      .limit(1);
    return reply.status(201).send(row);
  });

  app.delete(
    "/projects/:projectId/benefit-dependencies/:dependencyId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { dependencyId } = req.params as { dependencyId: string };
      const rows = await app.db
        .select({ id: benefitDependencies.id })
        .from(benefitDependencies)
        .where(
          and(
            eq(benefitDependencies.id, dependencyId),
            eq(benefitDependencies.companyId, req.companyId!),
            eq(benefitDependencies.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!rows[0]) throw notFound("Benefit dependency not found");
      await app.db.delete(benefitDependencies).where(eq(benefitDependencies.id, dependencyId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "benefit_dependency",
        objectId: dependencyId,
        payload: null,
        projectId: req.projectId!,
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Realisation dashboard (#421-422)                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Planned vs realised value over time, bucketed by UNIT. "£m saved" and
   * "minutes per journey" are not commensurable and are never added; each
   * unit gets its own series, and a benefit with no reading contributes null
   * rather than zero.
   */
  app.get("/projects/:projectId/benefits/realisation", { preHandler: readGate }, async (req) => {
    await sweepBenefitStatuses(app.db, req.companyId!, {
      projectId: req.projectId!,
      actorId: null,
      today: todayISO(),
    });
    const { rows, nodes, graphEdges, readings } = await loadNetwork(req.companyId!, req.projectId!);
    const propagated = propagateBenefitStatus(nodes, graphEdges);
    const effective = new Map(propagated.map((p) => [p.id, p.effectiveStatus]));

    const dates = [
      ...new Set([
        ...readings.map((r) => r.readingDate),
        ...rows.map((b) => b.targetDate).filter((d): d is string => Boolean(d)),
      ]),
    ].sort();

    const units = [...new Set(rows.map((b) => b.unit))].sort();
    const series = units.map((unit) => {
      const unitRows = rows.filter((b) => b.unit === unit);
      const unitIds = new Set(unitRows.map((b) => b.id));
      return {
        unit,
        benefits: unitRows.length,
        points: realisationSeries(
          nodes.filter((nd) => unitIds.has(nd.id)),
          readings
            .filter((r) => unitIds.has(r.benefitId))
            .map((r) => ({ benefitId: r.benefitId, readingDate: r.readingDate, value: r.value })),
          dates,
        ),
      };
    });

    const byStatus: Record<string, number> = {};
    for (const b of rows) {
      const st = effective.get(b.id) ?? b.status;
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }
    return {
      total: rows.length,
      byStatus,
      inheritedAtRisk: propagated.filter((p) => p.inherited).length,
      series,
      dates,
      basis:
        "Planned value accumulates a benefit's target-minus-baseline once its target date has " +
        "arrived; realised value accumulates the latest reading at or before each date. Series are " +
        "grouped by unit and never summed across units. A benefit with no reading contributes " +
        "nothing rather than zero — its absence is the point.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Assurance actions (#415)                                          */
  /* ---------------------------------------------------------------- */

  async function fetchAction(actionId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(assuranceActions)
      .where(
        and(
          eq(assuranceActions.id, actionId),
          eq(assuranceActions.companyId, companyId),
          eq(assuranceActions.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Assurance action not found");
    return rows[0];
  }

  app.post(
    "/projects/:projectId/assurance-actions",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = assuranceActionCreateSchema.parse(req.body);
      if (body.gateReviewId) {
        const rows = await app.db
          .select({ id: gateReviews.id })
          .from(gateReviews)
          .where(
            and(
              eq(gateReviews.id, body.gateReviewId),
              eq(gateReviews.companyId, req.companyId!),
              eq(gateReviews.projectId, req.projectId!),
            ),
          )
          .limit(1);
        if (!rows[0]) throw badRequest("gateReviewId does not belong to this project");
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "assurance_action");
      const id = newId("asa");
      await app.db.transaction(async (tx) => {
        // An action with a due date carries an obligation, so it appears on
        // the assurance register alongside every other dated promise.
        let obligationId: string | null = null;
        if (body.dueDate) {
          obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `Assurance action #${number}`,
            trigger: body.title,
            deadline: `${body.dueDate}T23:59:59Z`,
            warnDaysBefore: 7,
            evidenceRequirement: "Evidence that the assurance action has been completed",
            status: "open",
            createdBy: req.user!.id,
          });
        }
        await tx.insert(assuranceActions).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          gateReviewId: body.gateReviewId ?? null,
          source: body.source,
          title: body.title,
          description: body.description ?? null,
          priority: body.priority,
          ownerId: body.ownerId ?? null,
          dueDate: body.dueDate ?? null,
          status: "open",
          obligationId,
          createdBy: req.user!.id,
        });
        await appendLedger(tx as Db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "assurance_action",
          objectId: id,
          payload: {
            number,
            title: body.title,
            priority: body.priority,
            ownerId: body.ownerId ?? null,
            dueDate: body.dueDate ?? null,
            obligationId,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      if (body.ownerId) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: body.ownerId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `Assurance action #${number} assigned to you`,
            body: `"${body.title}"${body.dueDate ? `, due ${body.dueDate}` : ""}.`,
            recordType: "assurance_action",
            recordId: id,
          },
        ]);
      }
      return reply.status(201).send(await fetchAction(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/assurance-actions", { preHandler: readGate }, async (req) => {
    const q = assuranceActionListQuery.parse(req.query);
    await sweepAssuranceActions(app.db, req.companyId!, todayISO());
    const clauses = [
      eq(assuranceActions.companyId, req.companyId!),
      eq(assuranceActions.projectId, req.projectId!),
    ];
    if (q.status) clauses.push(eq(assuranceActions.status, q.status));
    if (q.ownerId) clauses.push(eq(assuranceActions.ownerId, q.ownerId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(assuranceActions).where(where);
    const rows = await app.db
      .select()
      .from(assuranceActions)
      .where(where)
      .orderBy(asc(assuranceActions.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((a) => ({ ...a, daysToDue: a.dueDate ? daysUntil(a.dueDate) : null })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  /**
   * One action, with its overdue state refreshed on the read. The list route
   * sweeps; a caller looking at a single action deserves the same currency —
   * an action that went overdue an hour ago should not read as "open" just
   * because nobody has opened the register since.
   */
  app.get(
    "/projects/:projectId/assurance-actions/:actionId",
    { preHandler: readGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      await sweepAssuranceActions(app.db, req.companyId!, todayISO());
      const action = await fetchAction(actionId, req.companyId!, req.projectId!);
      return { ...action, daysToDue: action.dueDate ? daysUntil(action.dueDate) : null };
    },
  );

  app.patch(
    "/projects/:projectId/assurance-actions/:actionId",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = assuranceActionPatchSchema.parse(req.body);
      const action = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (action.status === "done") {
        throw badRequest("A completed assurance action cannot be edited — reopen it first");
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      await app.db.transaction(async (tx) => {
        await tx.update(assuranceActions).set(set).where(eq(assuranceActions.id, actionId));
        if (body.dueDate !== undefined && action.obligationId) {
          await tx
            .update(obligations)
            .set({ deadline: body.dueDate ? `${body.dueDate}T23:59:59Z` : null })
            .where(and(eq(obligations.id, action.obligationId), eq(obligations.status, "open")));
        }
        if (body.status === "cancelled" && action.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "waived" })
            .where(
              and(
                eq(obligations.id, action.obligationId),
                inArray(obligations.status, ["open", "breached"]),
              ),
            );
        }
        await appendLedger(tx as Db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "assurance_action",
          objectId: actionId,
          payload: { changed: Object.keys(body) },
          projectId: req.projectId!,
        });
      });
      return fetchAction(actionId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/assurance-actions/:actionId/close",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = assuranceActionCloseSchema.parse(req.body ?? {});
      const action = await fetchAction(actionId, req.companyId!, req.projectId!);
      if (action.status === "done") throw badRequest("This action is already closed");
      if (action.status === "cancelled") throw badRequest("A cancelled action cannot be closed");
      if (body.evidenceIds && body.evidenceIds.length > 0) {
        const unique = [...new Set(body.evidenceIds)];
        const found = await app.db
          .select({ id: evidence.id })
          .from(evidence)
          .where(
            and(
              inArray(evidence.id, unique),
              eq(evidence.companyId, req.companyId!),
              eq(evidence.projectId, req.projectId!),
            ),
          );
        if (found.length !== unique.length) {
          throw badRequest("evidenceIds must reference evidence records in this project");
        }
      }
      const now = new Date().toISOString();
      await app.db.transaction(async (tx) => {
        await tx
          .update(assuranceActions)
          .set({
            status: "done",
            closedAt: now,
            closedBy: req.user!.id,
            closeNote: body.note ?? null,
            evidenceIds: body.evidenceIds ?? [],
            updatedAt: now,
          })
          .where(eq(assuranceActions.id, actionId));
        if (action.obligationId) {
          await tx
            .update(obligations)
            .set({
              status: "satisfied",
              satisfiedEvidenceId: body.evidenceIds?.[0] ?? null,
            })
            .where(and(eq(obligations.id, action.obligationId), eq(obligations.status, "open")));
        }
        await appendLedger(tx as Db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "assurance_action",
          objectId: actionId,
          payload: {
            from: action.status,
            to: "done",
            note: body.note ?? null,
            evidenceIds: body.evidenceIds ?? [],
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return fetchAction(actionId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Reviewer workspace (#415) — company-level                          */
  /* ---------------------------------------------------------------- */

  /**
   * What an independent reviewer needs in one place: gates due across the
   * portfolio, open conditions of approval and open assurance actions.
   * Scoped to the projects the caller can actually see: memberships plus
   * whatever their live assurance grants cover — a tenant-wide grant
   * (projectId null) is read-all, a grant pinned to one project adds that
   * project only. An ordinary member sees just their projects.
   */
  app.get("/governance/reviewer-workspace", { preHandler: companyReadGate }, async (req) => {
    const scope = await visibleProjectIds(app, req, "governance");
    if (scope !== null && scope.length === 0) {
      return {
        gates: [],
        conditions: [],
        actions: [],
        projects: [],
        reason: "You do not hold governance access on any project in this company.",
      };
    }
    const projectFilter = scope === null ? undefined : scope;
    const gateClauses = [eq(stageGates.companyId, req.companyId!)];
    if (projectFilter) gateClauses.push(inArray(stageGates.projectId, projectFilter));
    const gates = await app.db
      .select()
      .from(stageGates)
      .where(and(...gateClauses))
      .orderBy(asc(stageGates.plannedDate));

    const reviewClauses = [eq(gateReviews.companyId, req.companyId!)];
    if (projectFilter) reviewClauses.push(inArray(gateReviews.projectId, projectFilter));
    const reviews = await app.db
      .select()
      .from(gateReviews)
      .where(and(...reviewClauses));

    const actionClauses = [
      eq(assuranceActions.companyId, req.companyId!),
      inArray(assuranceActions.status, ["open", "in_progress", "overdue"]),
    ];
    if (projectFilter) actionClauses.push(inArray(assuranceActions.projectId, projectFilter));
    const actions = await app.db
      .select()
      .from(assuranceActions)
      .where(and(...actionClauses))
      .orderBy(asc(assuranceActions.dueDate));

    const projectIds = [
      ...new Set([
        ...gates.map((g) => g.projectId),
        ...actions.map((a) => a.projectId),
        ...reviews.map((r) => r.projectId),
      ]),
    ];
    const projectRows = projectIds.length
      ? await app.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, req.companyId!), inArray(projects.id, projectIds)))
      : [];
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
    const gateById = new Map(gates.map((g) => [g.id, g]));

    const conditions: Array<Record<string, unknown>> = [];
    for (const review of reviews) {
      const gate = gateById.get(review.gateId);
      for (const c of review.conditions as GateCondition[]) {
        if (c.closed) continue;
        conditions.push({
          projectId: review.projectId,
          projectName: projectName.get(review.projectId) ?? null,
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
    conditions.sort((a, b) => {
      const ad = (a.dueDate as string | null) ?? "9999-12-31";
      const bd = (b.dueDate as string | null) ?? "9999-12-31";
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });

    const latestReview = new Map<string, (typeof reviews)[number]>();
    for (const r of reviews) {
      const current = latestReview.get(r.gateId);
      if (!current || r.createdAt > current.createdAt) latestReview.set(r.gateId, r);
    }

    return {
      gates: gates
        .filter((g) => g.status !== "decided")
        .map((g) => ({
          id: g.id,
          projectId: g.projectId,
          projectName: projectName.get(g.projectId) ?? null,
          gateNumber: g.gateNumber,
          name: g.name,
          status: g.status,
          plannedDate: g.plannedDate,
          daysToPlanned: g.plannedDate ? daysUntil(g.plannedDate) : null,
          criteria: (g.criteria as GateCriterion[]).length,
          evidenceRequired: (g.criteria as GateCriterion[]).filter((c) => c.evidenceRequired).length,
          latestReview: latestReview.get(g.id)
            ? {
                id: latestReview.get(g.id)!.id,
                decision: latestReview.get(g.id)!.decision,
                rag: latestReview.get(g.id)!.rag,
                reviewDate: latestReview.get(g.id)!.reviewDate,
                evidencePackRoot: latestReview.get(g.id)!.evidencePackRoot,
              }
            : null,
        })),
      conditions,
      actions: actions.map((a) => ({
        ...a,
        projectName: projectName.get(a.projectId) ?? null,
        daysToDue: a.dueDate ? daysUntil(a.dueDate) : null,
      })),
      projects: projectRows,
      scoped: scope !== null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/governance/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const today = todayISO();
      await sweepBenefitStatuses(app.db, companyId, { projectId, actorId: null, today });
      await sweepAssuranceActions(app.db, companyId, today);
      await sweepGateConditions(app.db, companyId, today);

      const reasons: string[] = [];
      const gates = await app.db
        .select()
        .from(stageGates)
        .where(and(eq(stageGates.companyId, companyId), eq(stageGates.projectId, projectId)));
      const reviews = await app.db
        .select()
        .from(gateReviews)
        .where(and(eq(gateReviews.companyId, companyId), eq(gateReviews.projectId, projectId)))
        .orderBy(asc(gateReviews.createdAt));
      const benefitRows = await app.db
        .select()
        .from(benefits)
        .where(and(eq(benefits.companyId, companyId), eq(benefits.projectId, projectId)));
      const actions = await app.db
        .select()
        .from(assuranceActions)
        .where(
          and(eq(assuranceActions.companyId, companyId), eq(assuranceActions.projectId, projectId)),
        );

      const latestByGate = new Map<string, (typeof reviews)[number]>();
      for (const r of reviews) latestByGate.set(r.gateId, r);
      const latestReview = reviews[reviews.length - 1] ?? null;
      if (!latestReview) reasons.push("No gate review has been recorded on this project.");
      if (gates.length === 0) reasons.push("No stage gates are defined on this project.");
      if (benefitRows.length === 0) reasons.push("No benefits are registered on this project.");

      const openConditions = reviews.reduce(
        (n, r) => n + (r.conditions as GateCondition[]).filter((c) => !c.closed).length,
        0,
      );
      const overdueConditions = reviews.reduce(
        (n, r) =>
          n +
          (r.conditions as GateCondition[]).filter(
            (c) => !c.closed && c.dueDate !== null && c.dueDate < today,
          ).length,
        0,
      );
      const ragScale: Record<string, number> = {
        green: 100,
        amber_green: 75,
        amber: 50,
        amber_red: 25,
        red: 0,
      };

      return {
        metrics: {
          gates: gates.length,
          gatesDecided: gates.filter((g) => g.status === "decided").length,
          gatesOverdue: gates.filter(
            (g) => g.status !== "decided" && g.plannedDate !== null && g.plannedDate < today,
          ).length,
          latestRagScore:
            latestReview === null ? null : (ragScale[latestReview.rag] ?? null),
          stopDecisions: [...latestByGate.values()].filter((r) => r.decision === "stop").length,
          openConditions,
          overdueConditions,
          openAssuranceActions: actions.filter(
            (a) => a.status === "open" || a.status === "in_progress",
          ).length,
          overdueAssuranceActions: actions.filter((a) => a.status === "overdue").length,
          benefits: benefitRows.length,
          benefitsAtRisk: benefitRows.filter((b) => b.status === "at_risk").length,
          benefitsMissed: benefitRows.filter((b) => b.status === "missed").length,
          benefitsRealised: benefitRows.filter((b) => b.status === "realised").length,
        },
        reasons,
      };
    },
  );
};
