import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  prequalificationFinancials,
  prequalificationQuestionnaires,
  prequalificationQuestions,
  prequalificationResponses,
  prequalificationSubmissions,
  projects,
} from "@constructos/db";
import {
  CHECKLIST_ITEM_TYPES,
  FINANCIAL_DATA_SOURCES,
  PREQUAL_CATEGORIES,
  PREQUAL_OUTCOMES,
  PREQUAL_SUBMISSION_STATUSES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  isBooleanItemType,
  isChoiceItemType,
  isNumericItemType,
  isStructuralItemType,
  validateAnswer,
  type ChecklistAnswer,
  type ChecklistItemSpec,
} from "../quality/checklistItems.js";
import {
  assertSegregation,
  assertVendor,
  currencySchema,
  detailSchema,
  fetchPrequalSubmission,
  fetchQuestionnaire,
  isoDateSchema,
  known,
  ledger,
  moneySchema,
  nonNegativeMoneySchema,
  prequalReference,
  questionnaireReference,
  reasonSchema,
  round2,
  todayIso,
  unknowable,
  type PrequalSubmissionRow,
  type Unknowable,
} from "./shared.js";
import {
  checkContractAgainstLimit,
  contractToTurnoverRatio,
  DEFAULT_FINANCIAL_LIMIT_RULE,
  deriveRatios,
  recommendSingleProjectLimit,
  type FinancialFigures,
} from "./financial-limits.js";
import {
  effectiveLimit,
  latestScreening,
  RENEWAL_WINDOW_DAYS,
  sweepPrequalification,
  vendorPrequalStatus,
} from "./prequal-status.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const questionnaireCreateSchema = z.object({
  name: z.string().trim().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  /** null = company-wide, the normal case */
  projectId: z.string().min(1).max(64).nullable().optional(),
  tradeScope: z.array(z.string().min(1).max(60)).max(200).optional(),
  categories: z.array(z.enum(PREQUAL_CATEGORIES)).max(PREQUAL_CATEGORIES.length).optional(),
  passThreshold: z.number().finite().min(0).max(100).nullable().optional(),
  validityMonths: z.number().int().min(1).max(120).nullable().optional(),
  requiresAnnualRefresh: z.boolean().optional(),
  financialThresholds: detailSchema.optional(),
  approvalAuthority: z.string().max(300).nullable().optional(),
  supersedesId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const questionSchema = z.object({
  section: z.string().max(200).nullable().optional(),
  position: z.number().int().min(0).max(10000).optional(),
  questionCode: z.string().max(60).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  category: z.enum(PREQUAL_CATEGORIES).default("technical_capability"),
  /** the SHARED typed-item vocabulary — one renderer, one validator */
  itemType: z.enum(CHECKLIST_ITEM_TYPES).default("text"),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(200)).max(100).optional(),
  minValue: z.number().finite().nullable().optional(),
  maxValue: z.number().finite().nullable().optional(),
  unit: z.string().max(30).nullable().optional(),
  weight: z.number().finite().min(0).max(100).default(1),
  maxScore: z.number().finite().min(0).max(1000).nullable().optional(),
  scoringGuidance: z.string().max(8000).nullable().optional(),
  /** a wrong answer disqualifies outright, regardless of score */
  isKnockout: z.boolean().default(false),
  knockoutValue: z.string().max(200).nullable().optional(),
  evidenceRequired: z.boolean().optional(),
  evidenceKinds: z.array(z.string().min(1).max(60)).max(50).optional(),
  guidance: z.string().max(8000).nullable().optional(),
  detail: detailSchema.optional(),
});

const questionsCreateSchema = z.union([
  questionSchema,
  z.object({ questions: z.array(questionSchema).min(1).max(500) }),
]);

const prequalSubmissionCreateSchema = z.object({
  questionnaireId: z.string().min(1).max(64),
  vendorId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64).nullable().optional(),
  submittedByName: z.string().max(200).nullable().optional(),
  submittedByContactId: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const responseSchema = z.object({
  questionId: z.string().min(1).max(64),
  response: z.string().max(20000).nullable().optional(),
  numericValue: z.number().finite().nullable().optional(),
  selectedOptions: z.array(z.string().min(1).max(200)).max(100).optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

const responsesSchema = z.object({
  responses: z.array(responseSchema).min(1).max(500),
});

const assessSchema = z.object({
  scores: z
    .array(
      z.object({
        questionId: z.string().min(1).max(64),
        score: z.number().finite().min(0).nullable(),
        maxScore: z.number().finite().min(0).max(1000).nullable().optional(),
        note: z.string().max(8000).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
  reviewNote: z.string().max(20000).nullable().optional(),
});

const decideSchema = z.object({
  outcome: z.enum(PREQUAL_OUTCOMES).refine((o) => o !== "pending", "Decide a real outcome"),
  conditions: z.string().max(20000).nullable().optional(),
  rejectedReason: z.string().max(20000).nullable().optional(),
  singleProjectLimit: nonNegativeMoneySchema.nullable().optional(),
  aggregateLimit: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  tradeScopeApproved: z.array(z.string().min(1).max(60)).max(200).optional(),
  validFrom: isoDateSchema.optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  approvalAuthority: z.string().max(300).nullable().optional(),
});

const financialCreateSchema = z.object({
  vendorId: z.string().min(1).max(64),
  submissionId: z.string().min(1).max(64).nullable().optional(),
  financialYearEnd: isoDateSchema,
  periodLabel: z.string().max(120).nullable().optional(),
  periodMonths: z.number().int().min(1).max(36).nullable().optional(),
  source: z.enum(FINANCIAL_DATA_SOURCES),
  currency: currencySchema.optional(),
  turnover: moneySchema.nullable().optional(),
  grossProfit: moneySchema.nullable().optional(),
  operatingProfit: moneySchema.nullable().optional(),
  profitBeforeTax: moneySchema.nullable().optional(),
  netAssets: moneySchema.nullable().optional(),
  currentAssets: moneySchema.nullable().optional(),
  currentLiabilities: moneySchema.nullable().optional(),
  cashAtBank: moneySchema.nullable().optional(),
  totalDebt: moneySchema.nullable().optional(),
  /** stock / WIP — needed for the acid test, which is otherwise refused */
  inventory: moneySchema.nullable().optional(),
  largestContractValue: moneySchema.nullable().optional(),
  orderBookValue: moneySchema.nullable().optional(),
  employeeCount: z.number().int().min(0).max(1_000_000).nullable().optional(),
  creditAgency: z.string().max(120).nullable().optional(),
  creditScore: z.number().finite().nullable().optional(),
  creditLimit: moneySchema.nullable().optional(),
  creditRating: z.string().max(60).nullable().optional(),
  dunsNumber: z.string().max(60).nullable().optional(),
  isGoingConcernQualified: z.boolean().optional(),
  auditorQualification: z.string().max(8000).nullable().optional(),
  ccjCount: z.number().int().min(0).max(10000).nullable().optional(),
  insolvencyEvents: z
    .array(
      z.object({
        kind: z.string().min(1).max(120),
        date: isoDateSchema.nullable().optional(),
        note: z.string().max(4000).nullable().optional(),
      }),
    )
    .max(50)
    .optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  detail: detailSchema.optional(),
});

/* ------------------------------------------------------------------ */
/* Knockout — the field that does the real work                        */
/* ------------------------------------------------------------------ */

export interface KnockoutQuestionSpec {
  id: string;
  questionCode: string | null;
  text: string;
  itemType: string;
  required: boolean;
  isKnockout: boolean;
  knockoutValue: string | null;
  minValue: number | null;
  maxValue: number | null;
  unit: string | null;
}

export interface KnockoutAnswer {
  response?: string | null;
  numericValue?: number | null;
  selectedOptions?: string[] | null;
}

export interface KnockoutCheck {
  failed: boolean;
  questionId: string | null;
  questionCode: string | null;
  /** ALWAYS names the question when it failed — that is the whole point */
  reason: string | null;
}

const label = (q: KnockoutQuestionSpec): string =>
  q.questionCode ? `${q.questionCode} ("${q.text}")` : `"${q.text}"`;

/**
 * A knockout question disqualifies a bidder outright, regardless of score.
 *
 * A prequalification that says "failed, 62%" tells the vendor nothing they
 * can fix and tells an auditor nothing they can check, so the reason returned
 * here ALWAYS names the question, quotes the answer given, and says what the
 * disqualifying answer was. Silence is a failure too: you cannot pass a
 * knockout question by not answering it.
 */
export function evaluateKnockout(
  question: KnockoutQuestionSpec,
  answer: KnockoutAnswer | null,
): KnockoutCheck {
  const clear: KnockoutCheck = {
    failed: false,
    questionId: question.id,
    questionCode: question.questionCode,
    reason: null,
  };
  if (!question.isKnockout || isStructuralItemType(question.itemType)) return clear;

  const given = (answer?.response ?? "").trim();
  const chosen = answer?.selectedOptions ?? [];
  const numeric = answer?.numericValue ?? null;
  const answered = given !== "" || chosen.length > 0 || numeric !== null;

  if (!answered) {
    if (!question.required) return clear;
    return {
      ...clear,
      failed: true,
      reason:
        `Knockout question ${label(question)} was not answered. A knockout question cannot be ` +
        "passed by silence — it is the question the supply chain is screened on.",
    };
  }

  if (question.knockoutValue !== null && question.knockoutValue !== "") {
    const target = question.knockoutValue.trim().toLowerCase();
    if (isNumericItemType(question.itemType)) {
      const targetNumber = Number(question.knockoutValue);
      if (Number.isFinite(targetNumber) && numeric === targetNumber) {
        return {
          ...clear,
          failed: true,
          reason:
            `Knockout question ${label(question)} was answered "${numeric}", which is the ` +
            "disqualifying answer declared on the questionnaire.",
        };
      }
    } else if (
      given.toLowerCase() === target ||
      chosen.some((o) => o.trim().toLowerCase() === target)
    ) {
      return {
        ...clear,
        failed: true,
        reason:
          `Knockout question ${label(question)} was answered "${given || chosen.join(", ")}", ` +
          `which is the disqualifying answer ("${question.knockoutValue}") declared on the ` +
          "questionnaire. This fails the submission outright, whatever it scored elsewhere.",
      };
    }
  }

  if (isNumericItemType(question.itemType) && numeric !== null) {
    if (question.minValue !== null && numeric < question.minValue) {
      return {
        ...clear,
        failed: true,
        reason:
          `Knockout question ${label(question)} requires at least ${question.minValue}` +
          `${question.unit ? ` ${question.unit}` : ""}; the answer given was ${numeric}.`,
      };
    }
    if (question.maxValue !== null && numeric > question.maxValue) {
      return {
        ...clear,
        failed: true,
        reason:
          `Knockout question ${label(question)} permits at most ${question.maxValue}` +
          `${question.unit ? ` ${question.unit}` : ""}; the answer given was ${numeric}.`,
      };
    }
  }

  if (isBooleanItemType(question.itemType) && question.knockoutValue === null) {
    // A knockout yes/no with no declared disqualifying answer defaults to
    // "no" failing — stated here rather than assumed silently.
    const token = given.toLowerCase();
    if (token === "no" || token === "fail") {
      return {
        ...clear,
        failed: true,
        reason:
          `Knockout question ${label(question)} was answered "${given}". No disqualifying answer ` +
          'was declared on the questionnaire, so the default applies: "no"/"fail" fails a ' +
          "knockout question.",
      };
    }
  }

  return clear;
}

/* ------------------------------------------------------------------ */
/* Scoring an assessment                                               */
/* ------------------------------------------------------------------ */

export interface AssessmentInput {
  questionId: string;
  category: string | null;
  weight: number;
  required: boolean;
  itemType: string;
  score: number | null;
  maxScore: number | null;
  questionLabel: string;
}

export interface AssessmentResult {
  overallScore: Unknowable;
  maxScore: Unknowable;
  scorePercent: Unknowable;
  categoryScores: { category: string; score: number | null; maxScore: number; percent: number | null }[];
  unscored: { questionId: string; label: string }[];
}

/**
 * Score an assessment. The same discipline as bid scoring: a REQUIRED
 * question the assessor did not score leaves the overall score NULL with the
 * question named, rather than counting the gap as zero. A supply-chain
 * approval refused on a question nobody assessed is exactly as wrong as an
 * award decided that way.
 */
export function scoreAssessment(inputs: readonly AssessmentInput[]): AssessmentResult {
  const scoreable = inputs.filter((i) => !isStructuralItemType(i.itemType));
  const unscored = scoreable
    .filter((i) => i.required && (i.score === null || i.maxScore === null || i.maxScore <= 0))
    .map((i) => ({ questionId: i.questionId, label: i.questionLabel }));

  const contributing = scoreable.filter(
    (i) => i.score !== null && i.maxScore !== null && i.maxScore > 0,
  );
  const weightedScore = contributing.reduce((s, i) => s + i.score! * i.weight, 0);
  const weightedMax = contributing.reduce((s, i) => s + i.maxScore! * i.weight, 0);

  const byCategory = new Map<string, { score: number; max: number }>();
  for (const i of contributing) {
    const key = i.category ?? "uncategorised";
    const bucket = byCategory.get(key) ?? { score: 0, max: 0 };
    bucket.score += i.score! * i.weight;
    bucket.max += i.maxScore! * i.weight;
    byCategory.set(key, bucket);
  }

  if (scoreable.length === 0) {
    const why = "This questionnaire carries no scoreable questions.";
    return {
      overallScore: unknowable(why),
      maxScore: unknowable(why),
      scorePercent: unknowable(why),
      categoryScores: [],
      unscored: [],
    };
  }
  if (unscored.length > 0) {
    const reasons = unscored.map(
      (u) =>
        `Required question ${u.label} has not been scored. An unscored question counted as zero ` +
        "would reject a vendor on evidence nobody looked at.",
    );
    return {
      overallScore: unknowable(...reasons),
      maxScore: weightedMax > 0 ? known(round2(weightedMax)) : unknowable(...reasons),
      scorePercent: unknowable(...reasons),
      categoryScores: [...byCategory.entries()].map(([category, b]) => ({
        category,
        score: round2(b.score),
        maxScore: round2(b.max),
        percent: b.max > 0 ? round2((b.score / b.max) * 100) : null,
      })),
      unscored,
    };
  }
  if (weightedMax <= 0) {
    const why =
      "Every scored question carries a maximum of zero, so no percentage can be formed from them.";
    return {
      overallScore: known(round2(weightedScore)),
      maxScore: known(0),
      scorePercent: unknowable(why),
      categoryScores: [],
      unscored: [],
    };
  }

  return {
    overallScore: known(round2(weightedScore)),
    maxScore: known(round2(weightedMax)),
    scorePercent: known(round2((weightedScore / weightedMax) * 100)),
    categoryScores: [...byCategory.entries()].map(([category, b]) => ({
      category,
      score: round2(b.score),
      maxScore: round2(b.max),
      percent: b.max > 0 ? round2((b.score / b.max) * 100) : null,
    })),
    unscored: [],
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * PREQUALIFICATION IS COMPANY-LEVEL.
 *
 * A questionnaire, its responses and a bidder's financial screening are
 * properties of the SUPPLY CHAIN, not of one project — so these routes hang
 * off `/companies/current`, gated by company membership rather than by a
 * project tool level, with mutations restricted to company owners and admins.
 * `projectId` is genuinely nullable throughout; a project-scoped
 * questionnaire is the exception, not the rule.
 */
export const prequalificationRoutes: FastifyPluginAsync = async (app) => {
  const memberGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const BASE = "/companies/current/prequalification";

  async function assertProject(projectId: string, companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("projectId does not reference a project in this company");
  }

  async function questionsOf(db: Db, questionnaireId: string) {
    return db
      .select()
      .from(prequalificationQuestions)
      .where(eq(prequalificationQuestions.questionnaireId, questionnaireId))
      .orderBy(asc(prequalificationQuestions.position));
  }

  async function responsesOf(db: Db, submissionId: string) {
    return db
      .select()
      .from(prequalificationResponses)
      .where(eq(prequalificationResponses.submissionId, submissionId));
  }

  function questionSpec(q: typeof prequalificationQuestions.$inferSelect): ChecklistItemSpec {
    return {
      id: q.id,
      itemNumber: q.questionCode,
      text: q.text,
      itemType: q.itemType,
      required: q.required === 1,
      options: (q.options as string[]) ?? [],
      targetValue: null,
      minValue: q.minValue,
      maxValue: q.maxValue,
      tolerancePlus: null,
      toleranceMinus: null,
      unit: q.unit,
      weight: q.weight,
      isCritical: q.isKnockout === 1,
      photoRequired: false,
      raisesNcrOnFail: false,
    };
  }

  function knockoutSpec(
    q: typeof prequalificationQuestions.$inferSelect,
  ): KnockoutQuestionSpec {
    return {
      id: q.id,
      questionCode: q.questionCode,
      text: q.text,
      itemType: q.itemType,
      required: q.required === 1,
      isKnockout: q.isKnockout === 1,
      knockoutValue: q.knockoutValue,
      minValue: q.minValue,
      maxValue: q.maxValue,
      unit: q.unit,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Questionnaires                                                    */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/questionnaires`, { preHandler: adminGate }, async (req, reply) => {
    const body = questionnaireCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.projectId) await assertProject(body.projectId, companyId);
    const [maxRow] = await app.db
      .select({ n: count() })
      .from(prequalificationQuestionnaires)
      .where(eq(prequalificationQuestionnaires.companyId, companyId));
    const number = Number(maxRow?.n ?? 0) + 1;
    const id = newId("pqq");
    await app.db.insert(prequalificationQuestionnaires).values({
      id,
      companyId,
      projectId: body.projectId ?? null,
      number,
      reference: questionnaireReference(number),
      name: body.name,
      description: body.description ?? null,
      status: "draft",
      tradeScope: body.tradeScope ?? [],
      categories: body.categories ?? [],
      passThreshold: body.passThreshold ?? null,
      validityMonths: body.validityMonths ?? null,
      requiresAnnualRefresh: body.requiresAnnualRefresh ? 1 : 0,
      financialThresholds: body.financialThresholds ?? {},
      approvalAuthority: body.approvalAuthority ?? null,
      supersedesId: body.supersedesId ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_questionnaire", id, {
      reference: questionnaireReference(number),
      name: body.name,
      projectId: body.projectId ?? null,
      validityMonths: body.validityMonths ?? null,
      passThreshold: body.passThreshold ?? null,
    }, body.projectId ?? null, true);
    return reply.status(201).send(await fetchQuestionnaire(app.db, id, companyId));
  });

  app.get(`${BASE}/questionnaires`, { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(["draft", "active", "retired"]).optional(),
        projectId: z.string().min(1).max(64).optional(),
      })
      .parse(req.query);
    const filters = [eq(prequalificationQuestionnaires.companyId, req.companyId!)];
    if (q.status) filters.push(eq(prequalificationQuestionnaires.status, q.status));
    if (q.projectId) filters.push(eq(prequalificationQuestionnaires.projectId, q.projectId));
    const where = and(...filters);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(prequalificationQuestionnaires)
      .where(where);
    const items = await app.db
      .select()
      .from(prequalificationQuestionnaires)
      .where(where)
      .orderBy(asc(prequalificationQuestionnaires.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(`${BASE}/questionnaires/:questionnaireId`, { preHandler: memberGate }, async (req) => {
    const { questionnaireId } = req.params as { questionnaireId: string };
    const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
    const questions = await questionsOf(app.db, questionnaireId);
    return {
      ...questionnaire,
      questions: questions.map((q) => ({
        ...q,
        required: q.required === 1,
        isKnockout: q.isKnockout === 1,
        evidenceRequired: q.evidenceRequired === 1,
      })),
      knockoutQuestions: questions
        .filter((q) => q.isKnockout === 1)
        .map((q) => ({
          id: q.id,
          questionCode: q.questionCode,
          text: q.text,
          knockoutValue: q.knockoutValue,
        })),
    };
  });

  app.patch(`${BASE}/questionnaires/:questionnaireId`, { preHandler: adminGate }, async (req) => {
    const { questionnaireId } = req.params as { questionnaireId: string };
    const body = questionnaireCreateSchema.partial().parse(req.body);
    const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
    if (questionnaire.status !== "draft") {
      throw conflict(
        `An ${questionnaire.status} questionnaire cannot be edited. Vendors have been assessed ` +
          "against it, and changing the questions would silently change what those assessments " +
          "mean. Create a new version instead (supersedesId).",
      );
    }
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const key of [
      "name",
      "description",
      "tradeScope",
      "categories",
      "passThreshold",
      "validityMonths",
      "financialThresholds",
      "approvalAuthority",
      "supersedesId",
      "detail",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key] ?? null;
    }
    if (body.requiresAnnualRefresh !== undefined) {
      patch["requiresAnnualRefresh"] = body.requiresAnnualRefresh ? 1 : 0;
    }
    await app.db
      .update(prequalificationQuestionnaires)
      .set(patch)
      .where(eq(prequalificationQuestionnaires.id, questionnaireId));
    await ledger(app.db, req, "update", "prequalification_questionnaire", questionnaireId, {
      changed: Object.keys(body),
    }, questionnaire.projectId);
    return fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
  });

  app.post(
    `${BASE}/questionnaires/:questionnaireId/questions`,
    { preHandler: adminGate },
    async (req, reply) => {
      const { questionnaireId } = req.params as { questionnaireId: string };
      const parsed = questionsCreateSchema.parse(req.body);
      const wanted = "questions" in parsed ? parsed.questions : [parsed];
      const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
      if (questionnaire.status !== "draft") {
        throw conflict(`Questions cannot be added to an ${questionnaire.status} questionnaire.`);
      }
      const existing = await questionsOf(app.db, questionnaireId);
      let nextPosition = existing.reduce((max, q) => Math.max(max, q.position + 1), 0);
      const codes = new Set(existing.map((q) => q.questionCode).filter(Boolean) as string[]);

      const created: string[] = [];
      for (const q of wanted) {
        if (q.questionCode && codes.has(q.questionCode)) {
          throw conflict(`Question code "${q.questionCode}" already exists on this questionnaire.`);
        }
        if (q.questionCode) codes.add(q.questionCode);
        if (isChoiceItemType(q.itemType) && (q.options ?? []).length === 0) {
          throw badRequest(
            `"${q.text}" is a ${q.itemType} question with no declared options. A select with no ` +
              "options cannot be answered and cannot be scored.",
          );
        }
        if (q.isKnockout && q.knockoutValue && isChoiceItemType(q.itemType)) {
          if (!(q.options ?? []).some((o) => o.toLowerCase() === q.knockoutValue!.toLowerCase())) {
            throw badRequest(
              `The knockout answer "${q.knockoutValue}" is not one of the declared options for ` +
                `"${q.text}". A disqualifying answer nobody can give disqualifies nobody.`,
            );
          }
        }
        const id = newId("pqn");
        await app.db.insert(prequalificationQuestions).values({
          id,
          companyId: req.companyId!,
          projectId: questionnaire.projectId,
          questionnaireId,
          section: q.section ?? null,
          position: q.position ?? nextPosition,
          questionCode: q.questionCode ?? null,
          text: q.text,
          category: q.category,
          itemType: q.itemType,
          required: q.required ? 1 : 0,
          options: q.options ?? [],
          minValue: q.minValue ?? null,
          maxValue: q.maxValue ?? null,
          unit: q.unit ?? null,
          weight: q.weight,
          maxScore: q.maxScore ?? null,
          scoringGuidance: q.scoringGuidance ?? null,
          isKnockout: q.isKnockout ? 1 : 0,
          knockoutValue: q.knockoutValue ?? null,
          evidenceRequired: q.evidenceRequired ? 1 : 0,
          evidenceKinds: q.evidenceKinds ?? [],
          guidance: q.guidance ?? null,
          detail: q.detail ?? {},
        });
        nextPosition = Math.max(nextPosition, q.position ?? nextPosition) + 1;
        created.push(id);
      }

      const all = await questionsOf(app.db, questionnaireId);
      await app.db
        .update(prequalificationQuestionnaires)
        .set({
          questionCount: all.length,
          maxScore: round2(
            all.reduce((s, q) => s + (q.maxScore ?? 0) * q.weight, 0),
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(prequalificationQuestionnaires.id, questionnaireId));
      await ledger(app.db, req, "create", "prequalification_question", created[0] ?? questionnaireId, {
        questionnaireId,
        created: created.length,
        knockouts: wanted.filter((q) => q.isKnockout).length,
      }, questionnaire.projectId);
      const rows = await app.db
        .select()
        .from(prequalificationQuestions)
        .where(inArray(prequalificationQuestions.id, created))
        .orderBy(asc(prequalificationQuestions.position));
      return reply.status(201).send({ items: rows, total: rows.length });
    },
  );

  app.get(
    `${BASE}/questionnaires/:questionnaireId/questions`,
    { preHandler: memberGate },
    async (req) => {
      const { questionnaireId } = req.params as { questionnaireId: string };
      await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
      const items = await questionsOf(app.db, questionnaireId);
      return { items, total: items.length };
    },
  );

  app.delete(
    `${BASE}/questions/:questionId`,
    { preHandler: adminGate },
    async (req, reply) => {
      const { questionId } = req.params as { questionId: string };
      const rows = await app.db
        .select()
        .from(prequalificationQuestions)
        .where(
          and(
            eq(prequalificationQuestions.id, questionId),
            eq(prequalificationQuestions.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const question = rows[0];
      if (!question) throw notFound("Prequalification question not found");
      const questionnaire = await fetchQuestionnaire(
        app.db,
        question.questionnaireId,
        req.companyId!,
      );
      if (questionnaire.status !== "draft") {
        throw conflict(`Questions cannot be removed from an ${questionnaire.status} questionnaire.`);
      }
      await app.db
        .delete(prequalificationQuestions)
        .where(eq(prequalificationQuestions.id, questionId));
      const all = await questionsOf(app.db, question.questionnaireId);
      await app.db
        .update(prequalificationQuestionnaires)
        .set({ questionCount: all.length, updatedAt: new Date().toISOString() })
        .where(eq(prequalificationQuestionnaires.id, question.questionnaireId));
      await ledger(app.db, req, "delete", "prequalification_question", questionId, {
        questionnaireId: question.questionnaireId,
        text: question.text,
      }, questionnaire.projectId);
      return reply.status(204).send();
    },
  );

  /**
   * Activation IS the questionnaire's approval, and it is never the author's
   * to give. A question set that decides who may work for this company is
   * reviewed by somebody else before it is put to the supply chain.
   */
  app.post(
    `${BASE}/questionnaires/:questionnaireId/activate`,
    { preHandler: adminGate },
    async (req) => {
      const { questionnaireId } = req.params as { questionnaireId: string };
      const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
      if (questionnaire.status !== "draft") {
        throw conflict(`This questionnaire is already ${questionnaire.status}.`);
      }
      assertSegregation(
        req.user!.id,
        { createdBy: questionnaire.createdBy },
        "prequalification questionnaire",
      );
      const questions = await questionsOf(app.db, questionnaireId);
      if (questions.length === 0) {
        throw conflict("A questionnaire with no questions cannot be issued to the supply chain.");
      }
      if (questionnaire.validityMonths === null) {
        throw badRequest(
          "Set validityMonths before activating. A prequalification that never expires is a " +
            "check that was done once and then relied on forever — which is the failure this " +
            "whole register exists to prevent.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(prequalificationQuestionnaires)
        .set({
          status: "active",
          approvedBy: req.user!.id,
          approvedAt: now,
          questionCount: questions.length,
          maxScore: round2(questions.reduce((s, q) => s + (q.maxScore ?? 0) * q.weight, 0)),
          updatedAt: now,
        })
        .where(eq(prequalificationQuestionnaires.id, questionnaireId));
      await ledger(app.db, req, "state_change", "prequalification_questionnaire", questionnaireId, {
        to: "active",
        approvedBy: req.user!.id,
        createdBy: questionnaire.createdBy,
        questionCount: questions.length,
        knockoutCount: questions.filter((q) => q.isKnockout === 1).length,
        validityMonths: questionnaire.validityMonths,
      }, questionnaire.projectId, true);
      return fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
    },
  );

  app.post(
    `${BASE}/questionnaires/:questionnaireId/retire`,
    { preHandler: adminGate },
    async (req) => {
      const { questionnaireId } = req.params as { questionnaireId: string };
      const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
      await app.db
        .update(prequalificationQuestionnaires)
        .set({ status: "retired", updatedAt: new Date().toISOString() })
        .where(eq(prequalificationQuestionnaires.id, questionnaireId));
      await ledger(app.db, req, "state_change", "prequalification_questionnaire", questionnaireId, {
        to: "retired",
      }, questionnaire.projectId);
      return fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Submissions                                                       */
  /* ---------------------------------------------------------------- */

  async function prequalDetail(db: Db, submission: PrequalSubmissionRow) {
    const questionnaire = await fetchQuestionnaire(
      db,
      submission.questionnaireId,
      submission.companyId,
    );
    const questions = await questionsOf(db, submission.questionnaireId);
    const responses = await responsesOf(db, submission.id);
    const byQuestion = new Map(responses.map((r) => [r.questionId, r] as const));
    const financials = await db
      .select()
      .from(prequalificationFinancials)
      .where(
        and(
          eq(prequalificationFinancials.companyId, submission.companyId),
          eq(prequalificationFinancials.vendorId, submission.vendorId),
        ),
      )
      .orderBy(desc(prequalificationFinancials.financialYearEnd));
    const screening = await latestScreening(db, submission.companyId, submission.vendorId);
    const status = await vendorPrequalStatus(db, submission.companyId, submission.vendorId);

    return {
      ...submission,
      knockoutFailed: submission.knockoutFailed === 1,
      questionnaire: {
        id: questionnaire.id,
        reference: questionnaire.reference,
        name: questionnaire.name,
        passThreshold: questionnaire.passThreshold,
        validityMonths: questionnaire.validityMonths,
        questionCount: questionnaire.questionCount,
      },
      questions: questions.map((q) => ({
        ...q,
        required: q.required === 1,
        isKnockout: q.isKnockout === 1,
        response: byQuestion.get(q.id) ?? null,
      })),
      responses,
      financials,
      screening,
      standing: {
        state: status.state,
        daysToExpiry: status.daysToExpiry,
        note: status.note,
        renewalWindowDays: RENEWAL_WINDOW_DAYS,
      },
    };
  }

  app.post(`${BASE}/submissions`, { preHandler: adminGate }, async (req, reply) => {
    const body = prequalSubmissionCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    const questionnaire = await fetchQuestionnaire(app.db, body.questionnaireId, companyId);
    if (questionnaire.status !== "active") {
      throw conflict(
        `Questionnaire ${questionnaire.reference} is ${questionnaire.status}. Only an active, ` +
          "approved questionnaire may be issued to a vendor.",
      );
    }
    const vendor = await assertVendor(app.db, body.vendorId, companyId);
    if (body.projectId) await assertProject(body.projectId, companyId);

    const [maxRow] = await app.db
      .select({ n: count() })
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.companyId, companyId));
    const number = Number(maxRow?.n ?? 0) + 1;
    const id = newId("pqs");
    const now = new Date().toISOString();
    await app.db.insert(prequalificationSubmissions).values({
      id,
      companyId,
      projectId: body.projectId ?? questionnaire.projectId ?? null,
      questionnaireId: body.questionnaireId,
      vendorId: body.vendorId,
      number,
      reference: prequalReference(number),
      status: "invited",
      invitedAt: now,
      submittedByContactId: body.submittedByContactId ?? null,
      submittedByName: body.submittedByName ?? null,
      outcome: "pending",
      currency: (questionnaire.financialThresholds as Record<string, unknown>)["currency"] as string ?? "USD",
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_submission", id, {
      reference: prequalReference(number),
      questionnaireId: body.questionnaireId,
      vendorId: body.vendorId,
      vendorName: vendor.name,
      projectId: body.projectId ?? questionnaire.projectId ?? null,
    }, body.projectId ?? questionnaire.projectId ?? null, true);
    return reply.status(201).send(
      await prequalDetail(app.db, await fetchPrequalSubmission(app.db, id, companyId)),
    );
  });

  app.get(`${BASE}/submissions`, { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(PREQUAL_SUBMISSION_STATUSES).optional(),
        outcome: z.enum(PREQUAL_OUTCOMES).optional(),
        vendorId: z.string().min(1).max(64).optional(),
        questionnaireId: z.string().min(1).max(64).optional(),
      })
      .parse(req.query);
    // The lazy sweep: expiries are settled at the moment the register is read.
    const sweep = await sweepPrequalification(app.db, req.companyId!, req.user!.id);
    const filters = [eq(prequalificationSubmissions.companyId, req.companyId!)];
    if (q.status) filters.push(eq(prequalificationSubmissions.status, q.status));
    if (q.outcome) filters.push(eq(prequalificationSubmissions.outcome, q.outcome));
    if (q.vendorId) filters.push(eq(prequalificationSubmissions.vendorId, q.vendorId));
    if (q.questionnaireId) {
      filters.push(eq(prequalificationSubmissions.questionnaireId, q.questionnaireId));
    }
    const where = and(...filters);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(prequalificationSubmissions)
      .where(where);
    const items = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(where)
      .orderBy(desc(prequalificationSubmissions.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return {
      ...paginate(
        items.map((s) => ({ ...s, knockoutFailed: s.knockoutFailed === 1 })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      sweep,
    };
  });

  app.get(`${BASE}/submissions/:submissionId`, { preHandler: memberGate }, async (req) => {
    const { submissionId } = req.params as { submissionId: string };
    await sweepPrequalification(app.db, req.companyId!, req.user!.id);
    return prequalDetail(
      app.db,
      await fetchPrequalSubmission(app.db, submissionId, req.companyId!),
    );
  });

  app.post(
    `${BASE}/submissions/:submissionId/responses`,
    { preHandler: memberGate },
    async (req) => {
      const { submissionId } = req.params as { submissionId: string };
      const body = responsesSchema.parse(req.body);
      const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
      if (["assessed", "expired", "withdrawn", "suspended"].includes(submission.status)) {
        throw conflict(`A ${submission.status} prequalification cannot take new answers.`);
      }
      const questions = await questionsOf(app.db, submission.questionnaireId);
      const byId = new Map(questions.map((q) => [q.id, q] as const));
      const errors: string[] = [];
      for (const r of body.responses) {
        const question = byId.get(r.questionId);
        if (!question) {
          throw badRequest(`Question ${r.questionId} is not on this questionnaire.`);
        }
        const answer: ChecklistAnswer = {
          response: r.response ?? null,
          numericValue: r.numericValue ?? null,
          selectedOptions: r.selectedOptions ?? [],
          fileIds: r.fileIds ?? [],
        };
        const validation = validateAnswer(questionSpec(question), answer);
        if (!validation.ok) errors.push(...validation.errors);
        if (question.evidenceRequired === 1 && (r.fileIds ?? []).length === 0) {
          errors.push(
            `${question.questionCode ?? question.text} requires supporting evidence ` +
              `(${((question.evidenceKinds as string[]) ?? []).join(", ") || "documents"}) and none was attached.`,
          );
        }
      }
      if (errors.length > 0) {
        throw badRequest(
          `${errors.length} answer(s) do not match the question they answer.`,
          { errors },
        );
      }

      const now = new Date().toISOString();
      for (const r of body.responses) {
        const question = byId.get(r.questionId)!;
        const [existing] = await app.db
          .select({ id: prequalificationResponses.id })
          .from(prequalificationResponses)
          .where(
            and(
              eq(prequalificationResponses.submissionId, submissionId),
              eq(prequalificationResponses.questionId, r.questionId),
            ),
          )
          .limit(1);
        const values = {
          companyId: req.companyId!,
          projectId: submission.projectId,
          submissionId,
          questionnaireId: submission.questionnaireId,
          questionId: r.questionId,
          questionCode: question.questionCode,
          // snapshot: the assessment must stay readable after a revision
          questionText: question.text,
          category: question.category,
          itemType: question.itemType,
          response: r.response ?? null,
          numericValue: r.numericValue ?? null,
          selectedOptions: r.selectedOptions ?? [],
          fileIds: r.fileIds ?? [],
          maxScore: question.maxScore,
          updatedAt: now,
        };
        if (existing) {
          await app.db
            .update(prequalificationResponses)
            .set(values)
            .where(eq(prequalificationResponses.id, existing.id));
        } else {
          await app.db
            .insert(prequalificationResponses)
            .values({ id: newId("pqr"), ...values });
        }
      }
      if (submission.status === "invited") {
        await app.db
          .update(prequalificationSubmissions)
          .set({ status: "in_progress", updatedAt: now })
          .where(eq(prequalificationSubmissions.id, submissionId));
      }
      await ledger(app.db, req, "update", "prequalification_response", submissionId, {
        submissionId,
        answered: body.responses.length,
      }, submission.projectId);
      return prequalDetail(
        app.db,
        await fetchPrequalSubmission(app.db, submissionId, req.companyId!),
      );
    },
  );

  app.post(`${BASE}/submissions/:submissionId/submit`, { preHandler: memberGate }, async (req) => {
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    if (submission.status !== "invited" && submission.status !== "in_progress") {
      throw conflict(`A ${submission.status} prequalification cannot be submitted again.`);
    }
    const questions = await questionsOf(app.db, submission.questionnaireId);
    const responses = await responsesOf(app.db, submissionId);
    const answered = new Set(responses.map((r) => r.questionId));
    const missing = questions.filter(
      (q) => q.required === 1 && !isStructuralItemType(q.itemType) && !answered.has(q.id),
    );
    if (missing.length > 0) {
      throw badRequest(
        `${missing.length} required question(s) are unanswered: ` +
          missing.map((q) => q.questionCode ?? q.text).join(", "),
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationSubmissions)
      .set({ status: "submitted", submittedAt: now, updatedAt: now })
      .where(eq(prequalificationSubmissions.id, submissionId));
    await ledger(app.db, req, "state_change", "prequalification_submission", submissionId, {
      to: "submitted",
      responses: responses.length,
    }, submission.projectId, true);
    return prequalDetail(
      app.db,
      await fetchPrequalSubmission(app.db, submissionId, req.companyId!),
    );
  });

  /**
   * The assessment. Two independent things happen and they are kept apart:
   * the SCORE (weighted, per category, null where a required question was not
   * scored) and the KNOCKOUT (binary, and fatal regardless of score). A
   * bidder can score 92% and still fail, and when they do, the reason names
   * the question.
   */
  app.post(`${BASE}/submissions/:submissionId/assess`, { preHandler: adminGate }, async (req) => {
    const body = assessSchema.parse(req.body ?? {});
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    if (submission.status === "invited" || submission.status === "in_progress") {
      throw conflict(
        "This prequalification has not been submitted yet. Assessing a half-finished " +
          "questionnaire assesses the gaps, not the vendor.",
      );
    }
    const questions = await questionsOf(app.db, submission.questionnaireId);
    const responses = await responsesOf(app.db, submissionId);
    const responseByQuestion = new Map(responses.map((r) => [r.questionId, r] as const));
    const now = new Date().toISOString();

    /* record the assessor's scores */
    for (const s of body.scores ?? []) {
      const question = questions.find((q) => q.id === s.questionId);
      if (!question) throw badRequest(`Question ${s.questionId} is not on this questionnaire.`);
      const response = responseByQuestion.get(s.questionId);
      if (!response) {
        throw badRequest(
          `${question.questionCode ?? question.text} has no answer, so it cannot be scored.`,
        );
      }
      const maxScore = s.maxScore ?? question.maxScore ?? 100;
      if (s.score !== null && s.score > maxScore) {
        throw badRequest(
          `Score ${s.score} for ${question.questionCode ?? question.text} exceeds its maximum of ${maxScore}.`,
        );
      }
      await app.db
        .update(prequalificationResponses)
        .set({
          score: s.score,
          maxScore,
          assessorNote: s.note ?? null,
          assessedBy: req.user!.id,
          assessedAt: now,
          updatedAt: now,
        })
        .where(eq(prequalificationResponses.id, response.id));
    }

    const scored = await responsesOf(app.db, submissionId);
    const scoredByQuestion = new Map(scored.map((r) => [r.questionId, r] as const));

    /* the knockout pass — fatal, and it names its question */
    let knockout: KnockoutCheck | null = null;
    for (const question of questions) {
      if (question.isKnockout !== 1) continue;
      const response = scoredByQuestion.get(question.id) ?? null;
      const check = evaluateKnockout(
        knockoutSpec(question),
        response
          ? {
              response: response.response,
              numericValue: response.numericValue,
              selectedOptions: (response.selectedOptions as string[]) ?? [],
            }
          : null,
      );
      await app.db
        .update(prequalificationResponses)
        .set({ isKnockoutFail: check.failed ? 1 : 0, updatedAt: now })
        .where(
          and(
            eq(prequalificationResponses.submissionId, submissionId),
            eq(prequalificationResponses.questionId, question.id),
          ),
        );
      if (check.failed && !knockout) knockout = check;
    }

    /* the score */
    const assessment = scoreAssessment(
      questions
        .filter((q) => !isStructuralItemType(q.itemType))
        .map((q) => {
          const r = scoredByQuestion.get(q.id);
          return {
            questionId: q.id,
            category: q.category,
            weight: q.weight,
            required: q.required === 1,
            itemType: q.itemType,
            score: r?.score ?? null,
            maxScore: r?.maxScore ?? q.maxScore ?? null,
            questionLabel: q.questionCode ? `${q.questionCode} ("${q.text}")` : `"${q.text}"`,
          };
        }),
    );

    await app.db
      .update(prequalificationSubmissions)
      .set({
        status: "assessed",
        overallScore: assessment.overallScore.value,
        maxScore: assessment.maxScore.value,
        scorePercent: assessment.scorePercent.value,
        categoryScores: assessment.categoryScores,
        knockoutFailed: knockout ? 1 : 0,
        knockoutReason: knockout?.reason ?? null,
        reviewedBy: req.user!.id,
        reviewedAt: now,
        reviewNote: body.reviewNote ?? submission.reviewNote,
        updatedAt: now,
      })
      .where(eq(prequalificationSubmissions.id, submissionId));

    await ledger(app.db, req, "state_change", "prequalification_submission", submissionId, {
      to: "assessed",
      reviewedBy: req.user!.id,
      overallScore: assessment.overallScore.value,
      scorePercent: assessment.scorePercent.value,
      unscored: assessment.unscored,
      knockoutFailed: Boolean(knockout),
      knockoutReason: knockout?.reason ?? null,
      knockoutQuestionId: knockout?.questionId ?? null,
    }, submission.projectId, true);

    const fresh = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    return {
      ...(await prequalDetail(app.db, fresh)),
      assessment: {
        overallScore: assessment.overallScore,
        maxScore: assessment.maxScore,
        scorePercent: assessment.scorePercent,
        categoryScores: assessment.categoryScores,
        unscored: assessment.unscored,
      },
      knockout: knockout ?? { failed: false, questionId: null, questionCode: null, reason: null },
    };
  });

  /**
   * The decision to admit a vendor to the supply chain — never by the person
   * who assessed them, and never over a knockout failure. Most approvals are
   * capped rather than binary: the single-project limit is the number the
   * financial screening exists to set.
   */
  app.post(`${BASE}/submissions/:submissionId/decide`, { preHandler: adminGate }, async (req) => {
    const body = decideSchema.parse(req.body);
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    if (submission.status !== "assessed") {
      throw conflict(
        `This prequalification is at status "${submission.status}". It must be assessed before ` +
          "it can be decided.",
      );
    }
    if (submission.approvedBy) {
      throw conflict(`This prequalification was already decided by ${submission.approvedBy}.`);
    }
    assertSegregation(
      req.user!.id,
      { createdBy: submission.createdBy, reviewedBy: submission.reviewedBy },
      "prequalification",
    );

    const approving = body.outcome !== "rejected";
    if (approving && submission.knockoutFailed === 1) {
      throw conflict(
        `This submission failed a knockout question and cannot be approved. ${submission.knockoutReason} ` +
          "A knockout failure is not a low score to be weighed against the rest — it is the " +
          "answer that ends the assessment.",
      );
    }
    const questionnaire = await fetchQuestionnaire(
      app.db,
      submission.questionnaireId,
      req.companyId!,
    );
    if (approving && questionnaire.passThreshold !== null) {
      if (submission.scorePercent === null) {
        throw conflict(
          `Questionnaire ${questionnaire.reference} carries a pass threshold of ` +
            `${questionnaire.passThreshold}%, but this submission has no score — a required ` +
            "question was not assessed. Score it before deciding; approving against an unknown " +
            "score approves against nothing.",
        );
      }
      if (submission.scorePercent < questionnaire.passThreshold) {
        throw conflict(
          `This submission scored ${submission.scorePercent}%, below the ${questionnaire.passThreshold}% ` +
            "pass threshold declared on the questionnaire. Reject it, or record a new " +
            "questionnaire with the threshold you actually intend to apply.",
        );
      }
    }
    if (body.outcome === "approved_with_conditions" && !body.conditions) {
      throw badRequest("An approval with conditions must state the conditions.");
    }
    if (body.outcome === "approved_with_limit" && body.singleProjectLimit === undefined) {
      throw badRequest(
        "An approval with a limit must state the limit. The cap is the whole content of the " +
          "decision.",
      );
    }
    if (body.outcome === "rejected" && !body.rejectedReason) {
      throw badRequest("A rejection must say why — the vendor is entitled to know what to fix.");
    }

    const validFrom = body.validFrom ?? todayIso();
    let expiresAt = body.expiresAt ?? null;
    if (approving && expiresAt === null && questionnaire.validityMonths !== null) {
      const d = new Date(`${validFrom}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + questionnaire.validityMonths);
      expiresAt = d.toISOString().slice(0, 10);
    }
    if (approving && expiresAt === null) {
      throw badRequest(
        "An approval needs an expiry. A prequalification that never expires is a check done " +
          "once and relied on forever.",
      );
    }

    const screening = await latestScreening(app.db, req.companyId!, submission.vendorId);
    /*
     * The cap and the currency it is stated in are chosen as a PAIR. An
     * approver's figure is in the currency they gave (or the questionnaire's);
     * a figure inherited from the screening is in the currency the accounts
     * were filed in. Mixing the two produces a limit nothing can be compared
     * against.
     */
    const cap =
      body.singleProjectLimit !== undefined
        ? {
            limit: body.singleProjectLimit,
            currency: body.currency ?? submission.currency,
            basis: "Cap set by the approver at the point of admission.",
          }
        : screening && screening.value !== null
          ? { limit: screening.value, currency: screening.currency, basis: screening.basis }
          : {
              limit: null,
              currency: body.currency ?? submission.currency,
              basis:
                screening?.basis ??
                "No financial screening is on record for this vendor, so no single-project " +
                  "limit was derived. The approval is uncapped until one is.",
            };
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationSubmissions)
      .set({
        outcome: body.outcome,
        conditions: body.conditions ?? null,
        rejectedReason: body.rejectedReason ?? null,
        singleProjectLimit: cap.limit,
        aggregateLimit: body.aggregateLimit ?? null,
        currency: cap.currency,
        tradeScopeApproved: body.tradeScopeApproved ?? [],
        validFrom: approving ? validFrom : null,
        expiresAt: approving ? expiresAt : null,
        renewalDueAt: approving ? expiresAt : null,
        approvedBy: req.user!.id,
        approvedAt: now,
        detail: {
          ...(submission.detail as Record<string, unknown>),
          approvalAuthority: body.approvalAuthority ?? questionnaire.approvalAuthority ?? null,
          limitBasis: cap.basis,
        },
        updatedAt: now,
      })
      .where(eq(prequalificationSubmissions.id, submissionId));

    await ledger(app.db, req, "state_change", "prequalification_submission", submissionId, {
      outcome: body.outcome,
      approvedBy: req.user!.id,
      reviewedBy: submission.reviewedBy,
      createdBy: submission.createdBy,
      vendorId: submission.vendorId,
      scorePercent: submission.scorePercent,
      knockoutFailed: submission.knockoutFailed === 1,
      singleProjectLimit: cap.limit,
      limitCurrency: cap.currency,
      limitBasis: cap.basis,
      validFrom: approving ? validFrom : null,
      expiresAt: approving ? expiresAt : null,
      conditions: body.conditions ?? null,
      rejectedReason: body.rejectedReason ?? null,
    }, submission.projectId, true);

    // Raise the renewal obligation immediately where the approval already
    // sits inside its renewal window (a short validity period, or a
    // backdated validFrom).
    await sweepPrequalification(app.db, req.companyId!, req.user!.id);

    return prequalDetail(
      app.db,
      await fetchPrequalSubmission(app.db, submissionId, req.companyId!),
    );
  });

  app.post(`${BASE}/submissions/:submissionId/suspend`, { preHandler: adminGate }, async (req) => {
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
    const { submissionId } = req.params as { submissionId: string };
    const submission = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    const now = new Date().toISOString();
    await app.db
      .update(prequalificationSubmissions)
      .set({ status: "suspended", suspendedAt: now, suspendedReason: reason, updatedAt: now })
      .where(eq(prequalificationSubmissions.id, submissionId));
    await ledger(app.db, req, "state_change", "prequalification_submission", submissionId, {
      to: "suspended",
      reason,
      vendorId: submission.vendorId,
    }, submission.projectId, true);
    return prequalDetail(
      app.db,
      await fetchPrequalSubmission(app.db, submissionId, req.companyId!),
    );
  });

  /**
   * Renewal: a NEW submission that supersedes the old one, never an edit of
   * it. The expired assessment stays exactly as it was, because "what did we
   * know about them in 2024" is a question somebody will ask.
   */
  app.post(`${BASE}/submissions/:submissionId/renew`, { preHandler: adminGate }, async (req) => {
    const { submissionId } = req.params as { submissionId: string };
    const body = z
      .object({ questionnaireId: z.string().min(1).max(64).optional() })
      .parse(req.body ?? {});
    const previous = await fetchPrequalSubmission(app.db, submissionId, req.companyId!);
    const questionnaireId = body.questionnaireId ?? previous.questionnaireId;
    const questionnaire = await fetchQuestionnaire(app.db, questionnaireId, req.companyId!);
    if (questionnaire.status !== "active") {
      throw conflict(`Questionnaire ${questionnaire.reference} is ${questionnaire.status}.`);
    }
    const [maxRow] = await app.db
      .select({ n: count() })
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.companyId, req.companyId!));
    const number = Number(maxRow?.n ?? 0) + 1;
    const id = newId("pqs");
    const now = new Date().toISOString();
    await app.db.insert(prequalificationSubmissions).values({
      id,
      companyId: req.companyId!,
      projectId: previous.projectId,
      questionnaireId,
      vendorId: previous.vendorId,
      number,
      reference: prequalReference(number),
      status: "invited",
      invitedAt: now,
      outcome: "pending",
      currency: previous.currency,
      supersedesId: previous.id,
      detail: { renewalOf: previous.reference },
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "prequalification_submission", id, {
      event: "renewal",
      supersedes: previous.id,
      supersedesReference: previous.reference,
      vendorId: previous.vendorId,
      questionnaireId,
    }, previous.projectId, true);
    return prequalDetail(
      app.db,
      await fetchPrequalSubmission(app.db, id, req.companyId!),
    );
  });

  /* ---------------------------------------------------------------- */
  /* Financial screening                                               */
  /* ---------------------------------------------------------------- */

  app.post(`${BASE}/financials`, { preHandler: adminGate }, async (req, reply) => {
    const body = financialCreateSchema.parse(req.body);
    const companyId = req.companyId!;
    await assertVendor(app.db, body.vendorId, companyId);
    const currency = body.currency ?? "USD";

    const [existing] = await app.db
      .select({ id: prequalificationFinancials.id })
      .from(prequalificationFinancials)
      .where(
        and(
          eq(prequalificationFinancials.vendorId, body.vendorId),
          eq(prequalificationFinancials.financialYearEnd, body.financialYearEnd),
          eq(prequalificationFinancials.source, body.source),
        ),
      )
      .limit(1);
    if (existing) {
      throw conflict(
        `Figures for ${body.financialYearEnd} from "${body.source}" are already on record for ` +
          "this vendor. Two versions of the same period from the same source is how a screening " +
          "decision stops being reproducible.",
      );
    }

    const figures: FinancialFigures = {
      currency,
      source: body.source,
      financialYearEnd: body.financialYearEnd,
      turnover: body.turnover ?? null,
      grossProfit: body.grossProfit ?? null,
      operatingProfit: body.operatingProfit ?? null,
      profitBeforeTax: body.profitBeforeTax ?? null,
      netAssets: body.netAssets ?? null,
      currentAssets: body.currentAssets ?? null,
      currentLiabilities: body.currentLiabilities ?? null,
      cashAtBank: body.cashAtBank ?? null,
      totalDebt: body.totalDebt ?? null,
      inventory: body.inventory ?? null,
      largestContractValue: body.largestContractValue ?? null,
      orderBookValue: body.orderBookValue ?? null,
      isGoingConcernQualified: body.isGoingConcernQualified === true,
      insolvencyEventCount: (body.insolvencyEvents ?? []).length,
      ccjCount: body.ccjCount ?? null,
    };
    const ratios = deriveRatios(figures);
    const limit = recommendSingleProjectLimit(figures, ratios);

    const id = newId("pqf");
    await app.db.insert(prequalificationFinancials).values({
      id,
      companyId,
      vendorId: body.vendorId,
      submissionId: body.submissionId ?? null,
      financialYearEnd: body.financialYearEnd,
      periodLabel: body.periodLabel ?? null,
      periodMonths: body.periodMonths ?? null,
      source: body.source,
      currency,
      turnover: body.turnover ?? null,
      grossProfit: body.grossProfit ?? null,
      operatingProfit: body.operatingProfit ?? null,
      profitBeforeTax: body.profitBeforeTax ?? null,
      netAssets: body.netAssets ?? null,
      currentAssets: body.currentAssets ?? null,
      currentLiabilities: body.currentLiabilities ?? null,
      cashAtBank: body.cashAtBank ?? null,
      totalDebt: body.totalDebt ?? null,
      workingCapital: ratios.workingCapital.value,
      currentRatio: ratios.currentRatio.value,
      acidTestRatio: ratios.acidTestRatio.value,
      gearingPercent: ratios.gearingPercent.value,
      profitMarginPercent: ratios.profitMarginPercent.value,
      returnOnCapitalPercent: ratios.returnOnCapitalPercent.value,
      largestContractValue: body.largestContractValue ?? null,
      orderBookValue: body.orderBookValue ?? null,
      recommendedSingleProjectLimit: limit.value,
      contractToTurnoverRatio: null,
      employeeCount: body.employeeCount ?? null,
      creditAgency: body.creditAgency ?? null,
      creditScore: body.creditScore ?? null,
      creditLimit: body.creditLimit ?? null,
      creditRating: body.creditRating ?? null,
      dunsNumber: body.dunsNumber ?? null,
      isGoingConcernQualified: body.isGoingConcernQualified ? 1 : 0,
      auditorQualification: body.auditorQualification ?? null,
      ccjCount: body.ccjCount ?? null,
      insolvencyEvents: body.insolvencyEvents ?? [],
      fileIds: body.fileIds ?? [],
      detail: { ...(body.detail ?? {}), inventory: body.inventory ?? null, limitBasis: limit.basis },
      createdBy: req.user!.id,
    });

    await ledger(app.db, req, "create", "prequalification_financial", id, {
      vendorId: body.vendorId,
      financialYearEnd: body.financialYearEnd,
      source: body.source,
      currency,
      turnover: body.turnover ?? null,
      netAssets: body.netAssets ?? null,
      recommendedSingleProjectLimit: limit.value,
      limitBasis: limit.basis,
      bindingTest: limit.bindingTest,
      goingConcernQualified: body.isGoingConcernQualified === true,
    }, null, true);

    const [created] = await app.db
      .select()
      .from(prequalificationFinancials)
      .where(eq(prequalificationFinancials.id, id))
      .limit(1);
    return reply.status(201).send({
      ...created!,
      ratios,
      recommendedLimit: limit,
    });
  });

  app.get(`${BASE}/financials`, { preHandler: memberGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ vendorId: z.string().min(1).max(64).optional() })
      .parse(req.query);
    const filters = [eq(prequalificationFinancials.companyId, req.companyId!)];
    if (q.vendorId) filters.push(eq(prequalificationFinancials.vendorId, q.vendorId));
    const where = and(...filters);
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(prequalificationFinancials)
      .where(where);
    const rows = await app.db
      .select()
      .from(prequalificationFinancials)
      .where(where)
      .orderBy(desc(prequalificationFinancials.financialYearEnd))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((row) => {
      const figures: FinancialFigures = {
        currency: row.currency,
        source: row.source as FinancialFigures["source"],
        financialYearEnd: row.financialYearEnd,
        turnover: row.turnover,
        operatingProfit: row.operatingProfit,
        profitBeforeTax: row.profitBeforeTax,
        netAssets: row.netAssets,
        currentAssets: row.currentAssets,
        currentLiabilities: row.currentLiabilities,
        cashAtBank: row.cashAtBank,
        totalDebt: row.totalDebt,
        inventory: (row.detail as Record<string, unknown>)["inventory"] as number | null,
        largestContractValue: row.largestContractValue,
        orderBookValue: row.orderBookValue,
        isGoingConcernQualified: row.isGoingConcernQualified === 1,
        insolvencyEventCount: ((row.insolvencyEvents as unknown[]) ?? []).length,
      };
      const ratios = deriveRatios(figures);
      return {
        ...row,
        isGoingConcernQualified: row.isGoingConcernQualified === 1,
        ratios,
        recommendedLimit: recommendSingleProjectLimit(figures, ratios),
      };
    });
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      rule: DEFAULT_FINANCIAL_LIMIT_RULE,
    };
  });

  app.post(
    `${BASE}/financials/:financialId/verify`,
    { preHandler: adminGate },
    async (req) => {
      const { financialId } = req.params as { financialId: string };
      const rows = await app.db
        .select()
        .from(prequalificationFinancials)
        .where(
          and(
            eq(prequalificationFinancials.id, financialId),
            eq(prequalificationFinancials.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Financial record not found");
      assertSegregation(req.user!.id, { createdBy: row.createdBy }, "financial record");
      const now = new Date().toISOString();
      await app.db
        .update(prequalificationFinancials)
        .set({ verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
        .where(eq(prequalificationFinancials.id, financialId));
      await ledger(app.db, req, "state_change", "prequalification_financial", financialId, {
        event: "figures_verified",
        verifiedBy: req.user!.id,
        createdBy: row.createdBy,
        vendorId: row.vendorId,
        financialYearEnd: row.financialYearEnd,
        source: row.source,
      }, null, true);
      const [fresh] = await app.db
        .select()
        .from(prequalificationFinancials)
        .where(eq(prequalificationFinancials.id, financialId))
        .limit(1);
      return fresh!;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Vendor standing — the answer every other module asks for          */
  /* ---------------------------------------------------------------- */

  app.get(`${BASE}/vendors/:vendorId`, { preHandler: memberGate }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    await assertVendor(app.db, vendorId, req.companyId!);
    await sweepPrequalification(app.db, req.companyId!, req.user!.id);
    const status = await vendorPrequalStatus(app.db, req.companyId!, vendorId);
    const submissions = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(
        and(
          eq(prequalificationSubmissions.companyId, req.companyId!),
          eq(prequalificationSubmissions.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationSubmissions.createdAt));
    const financials = await app.db
      .select()
      .from(prequalificationFinancials)
      .where(
        and(
          eq(prequalificationFinancials.companyId, req.companyId!),
          eq(prequalificationFinancials.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationFinancials.financialYearEnd));
    return {
      ...status,
      history: submissions.map((s) => ({ ...s, knockoutFailed: s.knockoutFailed === 1 })),
      financials,
      rule: DEFAULT_FINANCIAL_LIMIT_RULE,
    };
  });

  /**
   * Test a proposed contract value against this vendor's approved capacity.
   * Called by any screen that is about to put work their way — that is the
   * moment to notice a job three times the size of anything they have done.
   */
  app.get(`${BASE}/vendors/:vendorId/capacity`, { preHandler: memberGate }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const q = z
      .object({
        contractValue: z.coerce.number().finite(),
        currency: z.string().min(3).max(8).optional(),
      })
      .parse(req.query);
    await assertVendor(app.db, vendorId, req.companyId!);
    const status = await vendorPrequalStatus(app.db, req.companyId!, vendorId);
    const currency = (q.currency ?? status.currency ?? "USD").toUpperCase();
    const [latest] = await app.db
      .select({ turnover: prequalificationFinancials.turnover })
      .from(prequalificationFinancials)
      .where(
        and(
          eq(prequalificationFinancials.companyId, req.companyId!),
          eq(prequalificationFinancials.vendorId, vendorId),
        ),
      )
      .orderBy(desc(prequalificationFinancials.financialYearEnd))
      .limit(1);
    const cap = effectiveLimit(status);
    return {
      prequalification: status,
      limitInUse: cap,
      capacity: checkContractAgainstLimit({
        contractValue: q.contractValue,
        contractCurrency: currency,
        limit: cap.limit,
        limitCurrency: cap.currency,
        vendorName: status.vendorName ?? vendorId,
        basis: cap.basis,
      }),
      contractToTurnover: contractToTurnoverRatio(q.contractValue, latest?.turnover ?? null),
    };
  });
};
