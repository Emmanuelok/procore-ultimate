import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  boqItems,
  companies,
  durationLibraryEntries,
  insuranceCertificates,
  lessonApplications,
  lessonEdges,
  lessonPushes,
  lessonTriggers,
  lessons,
  meetingActionItems,
  nonConformanceReports,
  obligations,
  postProjectReviews,
  projectMemberships,
  projects,
  rateLibraryEntries,
  recordLinks,
  riskRealisations,
  risks,
  scheduleTasks,
  users,
  valuationLines,
  valuations,
  vendors,
} from "@constructos/db";
import {
  LESSON_CATEGORIES,
  LESSON_STATUSES,
  LESSON_OUTCOMES,
  LESSON_PUSH_STATUSES,
  LESSON_TRIGGER_KINDS,
  LIBRARY_ENTRY_STATUSES,
  REVIEW_STATUSES,
  TOOLS,
  type ReviewStatus,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import {
  companyScopeOf,
  companyToolGate,
  scopeAllows,
  scopeProjects,
} from "../meetings/scope.js";
import {
  aiEnabled,
  escapeLike,
  renderSnippets,
  runAgent,
  type InputRef,
  type SearchCandidate,
} from "../ai/service.js";
import { computeReviewMetrics } from "./metrics.js";
import {
  buildTfIdfIndex,
  keywordSearch,
  rankLessons,
  semanticMatches,
  similarLessons,
  toolAffinity,
  type RankableLesson,
  type SearchableLesson,
  type TfIdfIndex,
} from "./relevance.js";
import {
  desiredEdges,
  diffEdges,
  selectOnboardingPack,
  type GraphApplication,
  type PackProject,
} from "./graph.js";
import {
  accuracyMetric,
  buildDurationProposals,
  buildRateProposals,
  centralImpact,
  inclusiveDays,
  realisationStats,
  verdictFor,
  type DurationSample,
  type RateSample,
} from "./libraries.js";
import { knownTargetTypes, resolveTarget, targetEntryFor } from "./targets.js";

/**
 * The library sweep never loads a table unbounded: it reads at most this many
 * rows per source per company. A company whose valuations exceed it gets a
 * library built from the rows it did see, which is the same statistical
 * position as any sample — and better than an out-of-memory error.
 */
const LIBRARY_SCAN_LIMIT = 20_000;

/**
 * How many lessons the nightly graph projection re-derives per company. The
 * projection is idempotent and ordered by last change, so a busy register
 * catches up over consecutive runs rather than loading itself into memory.
 */
const GRAPH_PROJECTION_BATCH = 200;
import { scoreSuppliers } from "./suppliers.js";
import {
  describeTriggerRules,
  dueDaysFor,
  resolveVariationThreshold,
  scanTriggers,
  selectNewCandidates,
  triggerKey,
  type TriggerSourceRef,
} from "./triggers.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)");

const evidenceRefSchema = z.object({
  tool: z.string().min(1).max(64),
  recordId: z.string().min(1).max(64),
  label: z.string().max(300).optional(),
});

const lessonCreateSchema = z.object({
  title: z.string().min(1).max(300),
  category: z.enum(LESSON_CATEGORIES),
  /** free text: whatever the organisation calls its phases, matched exactly on retrieval */
  phase: z.string().min(1).max(60).nullable().optional(),
  context: z.string().max(20_000).nullable().optional(),
  whatHappened: z.string().min(1).max(50_000),
  rootCause: z.string().max(20_000).nullable().optional(),
  recommendation: z.string().min(1).max(20_000),
  impactValue: z.number().finite().nullable().optional(),
  impactCurrency: z.string().min(3).max(8).nullable().optional(),
  impactDays: z.number().int().min(-10_000).max(10_000).nullable().optional(),
  tags: z.array(z.string().min(1).max(60)).max(30).optional(),
  evidenceRefs: z.array(evidenceRefSchema).max(50).optional(),
  /** capture-from-trigger: discharges the trigger's obligation on creation */
  triggerId: z.string().min(1).max(64).nullable().optional(),
});

const lessonPatchSchema = lessonCreateSchema
  .omit({ triggerId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

const rejectSchema = z.object({ reason: z.string().min(10).max(2000) });

const supersedeSchema = z.object({ supersededById: z.string().min(1).max(64) });

const dismissSchema = z.object({
  /** a dismissal without a reason is an unrecorded decision; 10 chars is the floor */
  reason: z.string().min(10).max(2000),
});

const applySchema = z.object({
  appliedTo: z.object({
    tool: z.string().min(1).max(64),
    recordId: z.string().min(1).max(64),
    label: z.string().max(300).optional(),
  }),
  action: z.string().min(1).max(2000),
  outcomeNote: z.string().max(5000).nullable().optional(),
});

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const registerQuery = pageQuerySchema.extend({
  category: z.enum(LESSON_CATEGORIES).optional(),
  status: z.enum(LESSON_STATUSES).optional(),
  phase: z.string().max(60).optional(),
  tags: z.string().max(400).optional(),
  originProject: z.string().max(64).optional(),
  impactMin: z.coerce.number().finite().optional(),
  impactMax: z.coerce.number().finite().optional(),
  q: z.string().max(200).optional(),
});

const projectLessonsQuery = pageQuerySchema.extend({
  category: z.enum(LESSON_CATEGORIES).optional(),
  status: z.enum(LESSON_STATUSES).optional(),
});

const relevantQuery = z.object({
  tool: z.enum(TOOLS).optional(),
  category: z.enum(LESSON_CATEGORIES).optional(),
  phase: z.string().max(60).optional(),
  tags: z.string().max(400).optional(),
  /*
   * The words of the record being created — an RFI's subject, a variation's
   * description, a risk's title. Structured filters only find lessons whose
   * metadata somebody remembered to set; this finds the lesson that describes
   * exactly this problem and was filed under something else (#993).
   */
  text: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const searchSchema = z.object({
  query: z.string().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

const triggersQuery = pageQuerySchema.extend({
  status: z.enum(["open", "captured", "dismissed"]).optional(),
  kind: z.enum(LESSON_TRIGGER_KINDS).optional(),
});

const participantSchema = z.object({
  userId: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(200),
  role: z.string().max(120).nullable().optional(),
});

const findingSchema = z.object({
  id: z.string().max(60).optional(),
  text: z.string().min(1).max(5000),
  category: z.enum(LESSON_CATEGORIES).optional(),
  lessonId: z.string().max(64).nullable().optional(),
});

const reviewCreateSchema = z.object({
  title: z.string().min(1).max(300),
  scheduledFor: isoDate.nullable().optional(),
  facilitator: z.string().max(200).nullable().optional(),
  participants: z.array(participantSchema).max(100).optional(),
});

const reviewPatchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    scheduledFor: isoDate.nullable().optional(),
    heldAt: isoDate.nullable().optional(),
    facilitator: z.string().max(200).nullable().optional(),
    participants: z.array(participantSchema).max(100).optional(),
    findings: z.array(findingSchema).max(200).optional(),
    whatWentWell: z.string().max(20_000).nullable().optional(),
    whatDidNot: z.string().max(20_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

const reviewTransitionSchema = z.object({
  to: z.enum(REVIEW_STATUSES),
  heldAt: isoDate.optional(),
  note: z.string().max(2000).optional(),
});

const reviewListQuery = pageQuerySchema.extend({
  status: z.enum(REVIEW_STATUSES).optional(),
});

/** AI search output. Tolerant: a malformed citation must not kill a usable answer. */
const aiSearchSchema = z.object({
  answer: z.string().nullable(),
  citations: z
    .array(
      z.object({
        ref: z.number().int().optional(),
        type: z.string().optional(),
        id: z.string(),
        excerpt: z.string().max(2000).optional(),
      }),
    )
    .default([])
    .catch([]),
  confidence: z.number().min(0).max(1).optional().catch(undefined),
});

/* ------------------------------------------------------------------ */
/* Review state machine                                                */
/* ------------------------------------------------------------------ */

/**
 * Sign-off is deliberately NOT a transition here: it is its own route,
 * because it records who signed and when, and can only follow `completed`.
 */
const REVIEW_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: ["in_progress"],
  signed_off: [],
  cancelled: ["scheduled"],
};

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

type LessonRow = typeof lessons.$inferSelect;
type TriggerRow = typeof lessonTriggers.$inferSelect;
type ReviewRow = typeof postProjectReviews.$inferSelect;

/** 503 with the platform-wide `AiDisabled` name, so clients degrade uniformly. */
function aiUnavailable(message: string): AppError {
  const err = new AppError(503, message);
  err.name = "AiDisabled";
  return err;
}

const MS_PER_DAY = 86_400_000;

const normalizeTags = (tags: string[] | undefined): string[] =>
  tags === undefined
    ? []
    : [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort();

/**
 * Domain W — organisational learning & knowledge capture (spec #976-994).
 *
 * Lessons registers fail everywhere for one reason: capture is voluntary and
 * retrieval is nobody's job. This module inverts both halves.
 *
 *  1. CAPTURE IS MANDATORY (#976-977). `triggers.ts` holds rules over records
 *     other modules already write — a dispute closing, a claim settling, a
 *     delay event closing, a variation crossing a configurable threshold, a
 *     signal confirmed by the assurance layer, a stage-gate review, project
 *     closeout. A qualifying event materializes a lesson_trigger AND an
 *     assurance Obligation that ONLY a lesson discharges. The sweep is
 *     idempotent (one trigger per source record, forever) and runs lazily on
 *     read, the same pattern as the disputes, finance and ESG sweeps.
 *
 *  2. RETRIEVAL IS BOUND TO THE MOMENT (#978, #983-987). `/learning/relevant`
 *     ranks the published register against what the user is doing right now
 *     and returns, for every hit, the reason it surfaced. The ranking is
 *     integer arithmetic over supplied inputs — deterministic and arguable.
 *     Natural-language search enriches this through the AI layer with
 *     citations back to lesson ids, and degrades to the deterministic
 *     keyword floor (saying so) when no ANTHROPIC_API_KEY is configured.
 *
 *  3. THE LOOP IS CLOSED (#979). A lesson_application binds a published
 *     lesson to a later record on another project; the impact report is the
 *     only evidence the platform can offer that learning crossed a project
 *     boundary. A published lesson with zero applications is reported as
 *     exactly that, not hidden.
 *
 * Validation is a second pair of eyes: the author may not validate their own
 * lesson (the same rule as certification independence in commercial and
 * determination independence in governance — ADR 0004, ADR 0008).
 */
export const learningModule: FastifyPluginAsync = async (app) => {
  const projectRead = [app.authenticate, app.requireCompany, app.requireTool("learning", "read")];
  const projectStandard = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("learning", "standard"),
  ];
  const projectAdmin = [app.authenticate, app.requireCompany, app.requireTool("learning", "admin")];
  const companyRead = [app.authenticate, app.requireCompany];
  /*
   * COMPANY-LEVEL ROUTES ARE NOT UNGATED ROUTES.
   *
   * `/learning/lessons` has no `:projectId`, so `requireTool` cannot resolve
   * a permission — and the route ran on [authenticate, requireCompany] alone,
   * where COMPANY_ROLES includes `guest`. Every project's DRAFT and REJECTED
   * lessons (an unvalidated account of what went wrong, naming people) were
   * readable by any member of the tenant. The gate below resolves which
   * projects the caller actually holds `learning` on; PUBLISHED lessons stay
   * company-wide, because a published lesson is a tenant asset and hiding it
   * would defeat the entire module.
   */
  const companyScopedRead = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "learning", "read"),
  ];
  const companyWrite = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetch helpers                                                     */
  /* ---------------------------------------------------------------- */

  async function fetchLesson(lessonId: string, companyId: string): Promise<LessonRow> {
    const rows = await app.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.id, lessonId), eq(lessons.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw notFound("Lesson not found");
    return rows[0];
  }

  /**
   * Project-scoped lookup keyed on originProjectId, not projectId: publishing
   * a lesson clears projectId (it belongs to the company from then on) but the
   * project it was learned on keeps its lifecycle routes working.
   */
  async function fetchProjectLesson(
    lessonId: string,
    companyId: string,
    projectId: string,
  ): Promise<LessonRow> {
    const rows = await app.db
      .select()
      .from(lessons)
      .where(
        and(
          eq(lessons.id, lessonId),
          eq(lessons.companyId, companyId),
          eq(lessons.originProjectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Lesson not found on this project");
    return rows[0];
  }

  async function fetchTrigger(
    triggerId: string,
    companyId: string,
    projectId: string,
  ): Promise<TriggerRow> {
    const rows = await app.db
      .select()
      .from(lessonTriggers)
      .where(
        and(
          eq(lessonTriggers.id, triggerId),
          eq(lessonTriggers.companyId, companyId),
          eq(lessonTriggers.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Lesson trigger not found");
    return rows[0];
  }

  async function fetchReview(
    reviewId: string,
    companyId: string,
    projectId: string,
  ): Promise<ReviewRow> {
    const rows = await app.db
      .select()
      .from(postProjectReviews)
      .where(
        and(
          eq(postProjectReviews.id, reviewId),
          eq(postProjectReviews.companyId, companyId),
          eq(postProjectReviews.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Post-project review not found");
    return rows[0];
  }

  /** Application counts per lesson across the company (one query, not N). */
  async function applicationCounts(companyId: string): Promise<Map<string, number>> {
    const rows = await app.db
      .select({ lessonId: lessonApplications.lessonId, n: count() })
      .from(lessonApplications)
      .where(eq(lessonApplications.companyId, companyId))
      .groupBy(lessonApplications.lessonId);
    return new Map(rows.map((r) => [r.lessonId, Number(r.n)]));
  }

  async function publishedRegister(companyId: string): Promise<{
    rows: LessonRow[];
    counts: Map<string, number>;
  }> {
    const rows = await app.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.companyId, companyId), eq(lessons.status, "published")));
    return { rows, counts: await applicationCounts(companyId) };
  }

  const toRankable = (l: LessonRow, counts: Map<string, number>): RankableLesson => ({
    id: l.id,
    number: l.number,
    title: l.title,
    category: l.category,
    phase: l.phase,
    tags: l.tags,
    impactValue: l.impactValue,
    impactCurrency: l.impactCurrency,
    impactDays: l.impactDays,
    publishedAt: l.publishedAt,
    originProjectId: l.originProjectId,
    applicationCount: counts.get(l.id) ?? 0,
  });

  const toSearchable = (l: LessonRow, counts: Map<string, number>): SearchableLesson => ({
    ...toRankable(l, counts),
    context: l.context,
    whatHappened: l.whatHappened,
    rootCause: l.rootCause,
    recommendation: l.recommendation,
  });

  /* ---------------------------------------------------------------- */
  /* Mandatory-capture sweep (#976-977)                                */
  /* ---------------------------------------------------------------- */

  interface SweepResult {
    scanned: number;
    created: number;
    alreadyOpen: number;
    /** candidates another writer inserted first — proof the DB guard bit */
    racedWithAnotherWriter: number;
    createdTriggerIds: string[];
    threshold: { value: number; source: string };
  }

  /**
   * Scan the project for qualifying events and materialize a trigger plus an
   * obligation for each new one. Idempotent by (kind, source record): running
   * it twice over an unchanged project creates nothing and writes nothing to
   * the ledger, which is what makes it safe to run lazily on every read.
   */
  async function sweepProjectTriggers(
    companyId: string,
    projectId: string,
    actorId: string | null,
  ): Promise<SweepResult> {
    const [project] = await app.db
      .select({ currency: projects.currency, settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!project) throw notFound("Project not found");
    const [company] = await app.db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    const threshold = resolveVariationThreshold(project.settings, company?.settings);
    const candidates = await scanTriggers(app.db, {
      companyId,
      projectId,
      variationThreshold: threshold.value,
      currency: project.currency,
    });

    const existing = await app.db
      .select({ kind: lessonTriggers.kind, sourceRef: lessonTriggers.sourceRef })
      .from(lessonTriggers)
      .where(
        and(eq(lessonTriggers.companyId, companyId), eq(lessonTriggers.projectId, projectId)),
      );
    const existingKeys = new Set(
      existing.map((t) => triggerKey(t.kind, String((t.sourceRef as TriggerSourceRef).recordId))),
    );

    const fresh = selectNewCandidates(candidates, existingKeys);
    const createdTriggerIds: string[] = [];
    const today = todayISO();
    let raced = 0;

    for (const candidate of fresh) {
      const dueAt = addDaysISO(today, dueDaysFor(candidate.kind));
      /*
       * IDEMPOTENCE THAT SURVIVES CONCURRENCY.
       *
       * The in-memory `existingKeys` set was the only guard, so two users
       * opening the Triggers tab at the same moment both saw "no trigger for
       * dispute D" and both inserted one: two obligations, two triggers, and a
       * capture-rate denominator quietly doubled with no way to tell which row
       * was real. The trigger is now written FIRST against a unique index on
       * (project_id, kind, source_key); the obligation follows only if that
       * insert actually won the race. An obligation with no trigger is an
       * un-dischargeable duty, so the order matters.
       */
      const sourceKey = String(candidate.sourceRef.recordId);
      const triggerId = newId("ltr");
      const inserted = await app.db
        .insert(lessonTriggers)
        .values({
          id: triggerId,
          companyId,
          projectId,
          kind: candidate.kind,
          sourceRef: candidate.sourceRef,
          sourceKey,
          rationale: candidate.rationale,
          dueAt,
          status: "open",
        })
        .onConflictDoNothing()
        .returning({ id: lessonTriggers.id });
      if (!inserted[0]) {
        raced += 1;
        continue;
      }
      const obligationId = newId("obl");
      await app.db.insert(obligations).values({
        id: obligationId,
        companyId,
        projectId,
        sourceClause: `Organisational learning — mandatory capture (${candidate.kind})`,
        trigger: candidate.rationale,
        deadline: `${dueAt}T23:59:59Z`,
        warnDaysBefore: 7,
        evidenceRequirement:
          "A lesson-learned record capturing what happened, the root cause and the " +
          "recommendation, validated by someone other than its author",
        status: "open",
        createdBy: actorId ?? "system",
      });
      await app.db
        .update(lessonTriggers)
        .set({ obligationId })
        .where(eq(lessonTriggers.id, triggerId));
      createdTriggerIds.push(triggerId);
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "lesson_trigger",
        objectId: triggerId,
        payload: {
          projectId,
          kind: candidate.kind,
          sourceRef: candidate.sourceRef,
          rationale: candidate.rationale,
          obligationId,
          dueAt,
        },
        storePayload: true,
      });
    }

    return {
      scanned: candidates.length,
      created: createdTriggerIds.length,
      alreadyOpen: candidates.length - createdTriggerIds.length,
      racedWithAnotherWriter: raced,
      createdTriggerIds,
      threshold: { value: threshold.value, source: threshold.source },
    };
  }

  /** A lesson discharges a trigger: obligation satisfied, trigger closed. */
  async function dischargeTrigger(
    trigger: TriggerRow,
    lessonId: string,
    actorId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await app.db
      .update(lessonTriggers)
      .set({ status: "captured", lessonId, closedAt: now })
      .where(eq(lessonTriggers.id, trigger.id));
    if (trigger.obligationId) {
      await app.db
        .update(obligations)
        .set({ status: "satisfied" })
        .where(and(eq(obligations.id, trigger.obligationId), eq(obligations.status, "open")));
    }
    await appendLedger(app.db, {
      companyId: trigger.companyId,
      actorId,
      action: "state_change",
      objectType: "lesson_trigger",
      objectId: trigger.id,
      payload: {
        from: trigger.status,
        to: "captured",
        lessonId,
        obligationId: trigger.obligationId,
        obligation: trigger.obligationId ? "satisfied" : null,
      },
      storePayload: true,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lessons — lifecycle (#976, #979)                                  */
  /* ---------------------------------------------------------------- */

  async function createLesson(
    companyId: string,
    projectId: string,
    actorId: string,
    body: z.infer<typeof lessonCreateSchema>,
    trigger: TriggerRow | null,
  ): Promise<LessonRow> {
    /*
     * COMPANY-SCOPED, because the number is used as a COMPANY-WIDE identifier.
     * Allocating per project produced LL-0001 on every job at once: the
     * published register showed two different lessons under one number, the
     * supersede picker could not tell them apart, and the AI layer's citation
     * ("ref is the lesson number") was ambiguous by construction. The counter
     * is keyed on the company id — the same thing insurance does for CPOL.
     */
    const seq = await nextRecordNumber(app.db, companyId, "lesson");
    const id = newId("lsn");
    const number = `LL-${String(seq).padStart(4, "0")}`;
    await app.db.insert(lessons).values({
      id,
      companyId,
      projectId,
      originProjectId: projectId,
      number,
      title: body.title,
      category: body.category,
      phase: body.phase ?? null,
      context: body.context ?? null,
      whatHappened: body.whatHappened,
      rootCause: body.rootCause ?? null,
      recommendation: body.recommendation,
      impactValue: body.impactValue ?? null,
      impactCurrency: body.impactCurrency ?? null,
      impactDays: body.impactDays ?? null,
      tags: normalizeTags(body.tags),
      evidenceRefs: (body.evidenceRefs ?? []) as unknown[],
      status: "draft",
      createdBy: actorId,
    });
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "lesson",
      objectId: id,
      payload: {
        projectId,
        number,
        title: body.title,
        category: body.category,
        phase: body.phase ?? null,
        impactValue: body.impactValue ?? null,
        impactDays: body.impactDays ?? null,
        triggerId: trigger?.id ?? null,
      },
      storePayload: true,
    });
    if (trigger) await dischargeTrigger(trigger, id, actorId);
    return fetchLesson(id, companyId);
  }

  app.post(
    "/projects/:projectId/learning/lessons",
    { preHandler: projectStandard },
    async (req, reply) => {
      const body = lessonCreateSchema.parse(req.body);
      let trigger: TriggerRow | null = null;
      if (body.triggerId) {
        trigger = await fetchTrigger(body.triggerId, req.companyId!, req.projectId!);
        if (trigger.status !== "open") {
          throw conflict(`Trigger is already ${trigger.status} — it cannot be captured again`);
        }
      }
      const lesson = await createLesson(
        req.companyId!,
        req.projectId!,
        req.user!.id,
        body,
        trigger,
      );
      return reply.status(201).send(lesson);
    },
  );

  app.get("/projects/:projectId/learning/lessons", { preHandler: projectRead }, async (req) => {
    const q = projectLessonsQuery.parse(req.query);
    const where = and(
      eq(lessons.companyId, req.companyId!),
      eq(lessons.originProjectId, req.projectId!),
      ...(q.category ? [eq(lessons.category, q.category)] : []),
      ...(q.status ? [eq(lessons.status, q.status)] : []),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(lessons).where(where);
    const rows = await app.db
      .select()
      .from(lessons)
      .where(where)
      .orderBy(desc(lessons.createdAt), desc(lessons.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.patch(
    "/projects/:projectId/learning/lessons/:lessonId",
    { preHandler: projectStandard },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const body = lessonPatchSchema.parse(req.body);
      const lesson = await fetchProjectLesson(lessonId, req.companyId!, req.projectId!);
      if (lesson.status !== "draft" && lesson.status !== "rejected") {
        throw conflict(
          `A ${lesson.status} lesson can no longer be edited — supersede it with a new lesson instead`,
        );
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "category",
        "phase",
        "context",
        "whatHappened",
        "rootCause",
        "recommendation",
        "impactValue",
        "impactCurrency",
        "impactDays",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      if (body.tags !== undefined) set["tags"] = normalizeTags(body.tags);
      if (body.evidenceRefs !== undefined) set["evidenceRefs"] = body.evidenceRefs;
      await app.db.update(lessons).set(set).where(eq(lessons.id, lessonId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "lesson",
        objectId: lessonId,
        payload: { changed: Object.keys(body) },
      });
      return fetchLesson(lessonId, req.companyId!);
    },
  );

  app.post(
    "/projects/:projectId/learning/lessons/:lessonId/submit",
    { preHandler: projectStandard },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const lesson = await fetchProjectLesson(lessonId, req.companyId!, req.projectId!);
      if (lesson.status !== "draft" && lesson.status !== "rejected") {
        throw conflict(`Only a draft or rejected lesson can be submitted (this one is ${lesson.status})`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessons)
        .set({
          status: "submitted",
          submittedBy: req.user!.id,
          submittedAt: now,
          rejectionReason: null,
          updatedAt: now,
        })
        .where(eq(lessons.id, lessonId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson",
        objectId: lessonId,
        payload: { from: lesson.status, to: "submitted", submittedBy: req.user!.id },
      });
      return fetchLesson(lessonId, req.companyId!);
    },
  );

  /**
   * Validation is a SECOND PAIR OF EYES. The author of a lesson may not
   * validate it, and neither may whoever submitted it — the same independence
   * rule as certifier-not-submitter in commercial (ADR 0008) and
   * determination independence in governance. A lessons register self-signed
   * by its authors is a filing cabinet.
   */
  app.post(
    "/projects/:projectId/learning/lessons/:lessonId/validate",
    { preHandler: projectStandard },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const lesson = await fetchProjectLesson(lessonId, req.companyId!, req.projectId!);
      if (lesson.status !== "submitted") {
        throw conflict(`Only a submitted lesson can be validated (this one is ${lesson.status})`);
      }
      if (req.user!.id === lesson.createdBy) {
        throw forbidden(
          "Validation is a second pair of eyes: the author of a lesson cannot validate it",
        );
      }
      if (lesson.submittedBy && req.user!.id === lesson.submittedBy) {
        throw forbidden(
          "Validation is a second pair of eyes: the person who submitted a lesson cannot validate it",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessons)
        .set({ status: "validated", validatedBy: req.user!.id, validatedAt: now, updatedAt: now })
        .where(eq(lessons.id, lessonId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson",
        objectId: lessonId,
        payload: {
          from: "submitted",
          to: "validated",
          validatedBy: req.user!.id,
          author: lesson.createdBy,
          submittedBy: lesson.submittedBy,
        },
        storePayload: true,
      });
      return fetchLesson(lessonId, req.companyId!);
    },
  );

  app.post(
    "/projects/:projectId/learning/lessons/:lessonId/reject",
    { preHandler: projectStandard },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const body = rejectSchema.parse(req.body);
      const lesson = await fetchProjectLesson(lessonId, req.companyId!, req.projectId!);
      if (lesson.status !== "submitted") {
        throw conflict(`Only a submitted lesson can be rejected (this one is ${lesson.status})`);
      }
      if (req.user!.id === lesson.createdBy) {
        throw forbidden("The author of a lesson cannot decide it — that is not a review");
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessons)
        .set({ status: "rejected", rejectionReason: body.reason, updatedAt: now })
        .where(eq(lessons.id, lessonId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson",
        objectId: lessonId,
        payload: { from: "submitted", to: "rejected", reason: body.reason },
        storePayload: true,
      });
      return fetchLesson(lessonId, req.companyId!);
    },
  );

  /**
   * Publish company-wide: the lesson leaves the project (projectId cleared,
   * originProjectId retained) and becomes visible to every project in the
   * tenant. Only published lessons can be retrieved by the relevance engine
   * or applied — a draft is not organisational memory.
   */
  app.post(
    "/projects/:projectId/learning/lessons/:lessonId/publish",
    { preHandler: projectAdmin },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const lesson = await fetchProjectLesson(lessonId, req.companyId!, req.projectId!);
      if (lesson.status !== "validated") {
        throw conflict(
          `Only a validated lesson can be published company-wide (this one is ${lesson.status})`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessons)
        .set({ status: "published", projectId: null, publishedAt: now, updatedAt: now })
        .where(eq(lessons.id, lessonId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson",
        objectId: lessonId,
        payload: {
          from: "validated",
          to: "published",
          originProjectId: lesson.originProjectId,
          publishedAt: now,
        },
        storePayload: true,
      });
      const published = await fetchLesson(lessonId, req.companyId!);
      /* Publishing IS the push. A lesson that sits in a register waiting to be
         searched for has not been learned by anybody but its author. */
      const push = await pushLessonToProjects(req.companyId!, published, req.user!.id, 10);
      /* Publication is also when the lesson's evidence becomes checkable: the
         edges are derived and each target verified, so an unresolvable
         reference is a finding on the lesson rather than a dead string. */
      const graph = await projectLessonEdges(req.companyId!, lessonId, req.user!.id);
      return { ...published, push, graph };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Applications — the loop nobody closes (#979)                      */
  /* ---------------------------------------------------------------- */

  /**
   * Record that a published lesson was actually applied to a specific later
   * record. `crossedProjectBoundary` is computed, not asserted: an
   * application on the lesson's own origin project is still worth recording,
   * but it is not evidence that knowledge travelled.
   */
  app.post(
    "/projects/:projectId/learning/lessons/:lessonId/apply",
    { preHandler: projectStandard },
    async (req, reply) => {
      const { lessonId } = req.params as { lessonId: string };
      const body = applySchema.parse(req.body);
      const lesson = await fetchLesson(lessonId, req.companyId!);
      if (lesson.status !== "published") {
        throw conflict(
          `Only a published lesson can be applied (this one is ${lesson.status}) — publish it first`,
        );
      }
      const id = newId("lap");
      await app.db.insert(lessonApplications).values({
        id,
        companyId: req.companyId!,
        lessonId,
        projectId: req.projectId!,
        appliedTo: body.appliedTo,
        action: body.action,
        outcomeNote: body.outcomeNote ?? null,
        appliedBy: req.user!.id,
      });
      const crossedProjectBoundary = lesson.originProjectId !== req.projectId!;
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "lesson_application",
        objectId: id,
        payload: {
          lessonId,
          lessonNumber: lesson.number,
          projectId: req.projectId!,
          originProjectId: lesson.originProjectId,
          crossedProjectBoundary,
          appliedTo: body.appliedTo,
          action: body.action,
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(lessonApplications)
        .where(eq(lessonApplications.id, id))
        .limit(1);
      /* An application is a new edge: the lesson now points at the record it
         was applied to, and that record can answer "what was applied here?". */
      const graph = await projectLessonEdges(req.companyId!, lessonId, req.user!.id);
      return reply.status(201).send({ application: row, crossedProjectBoundary, graph });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Retrieval bound to the moment (#978, #983-987)                    */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/learning/relevant", { preHandler: projectRead }, async (req) => {
    const q = relevantQuery.parse(req.query);
    const tags = q.tags ? csv(q.tags).map((t) => t.toLowerCase()) : [];
    const { rows, counts } = await publishedRegister(req.companyId!);
    const now = new Date().toISOString();
    const semantic = new Map<string, number>();
    let semanticTerms: string[] = [];
    if (q.text && q.text.trim().length >= 3) {
      const index = buildTfIdfIndex(rows.map((l) => toSearchable(l, counts)));
      const matches = semanticMatches(index, q.text);
      for (const m of matches) semantic.set(m.lessonId, m.similarity);
      semanticTerms = matches[0]?.terms ?? [];
    }
    const ranked = rankLessons(
      rows.map((l) => toRankable(l, counts)),
      {
        tool: q.tool ?? null,
        category: q.category ?? null,
        phase: q.phase ?? null,
        tags,
        semantic,
        now,
      },
    );
    const byId = new Map(rows.map((l) => [l.id, l]));
    return {
      query: {
        tool: q.tool ?? null,
        category: q.category ?? null,
        phase: q.phase ?? null,
        tags,
        text: q.text ?? null,
        toolImpliesCategories: toolAffinity(q.tool ?? null),
        semanticMatches: semantic.size,
        semanticTerms,
      },
      registerSize: rows.length,
      matched: ranked.length,
      items: ranked.slice(0, q.limit).map((r) => ({
        lesson: byId.get(r.lesson.id)!,
        applicationCount: r.lesson.applicationCount,
        score: r.score,
        reasons: r.reasons,
        similarity: semantic.get(r.lesson.id) ?? null,
      })),
      ranking:
        "Deterministic: category and phase match, tool affinity, tag overlap, recorded impact " +
        "magnitude, recency of publication, whether the lesson has already been applied, and — " +
        "when the record's own words are supplied — tf-idf cosine similarity between those " +
        "words and the lesson's. Every hit carries the reasons it scored. No model is involved.",
    };
  });

  /**
   * Natural-language search over the published register. The deterministic
   * keyword search ALWAYS runs and always forms the result set; the AI layer
   * only ever adds a synthesised answer with citations back to lesson ids.
   * With no ANTHROPIC_API_KEY — or when the model call fails — the endpoint
   * returns the deterministic results and says which mode it is in. It never
   * errors on account of AI being unavailable.
   */
  app.post("/learning/search", { preHandler: companyScopedRead }, async (req) => {
    const body = searchSchema.parse(req.body);
    const { rows, counts } = await publishedRegister(req.companyId!);
    const hits = keywordSearch(
      rows.map((l) => toSearchable(l, counts)),
      body.query,
    ).slice(0, body.limit);
    const byId = new Map(rows.map((l) => [l.id, l]));
    const results = hits.map((h) => ({
      lesson: byId.get(h.lesson.id)!,
      score: h.score,
      matchedTerms: h.matchedTerms,
      matchedFields: h.matchedFields,
      why:
        h.matchedTerms.length > 0
          ? `Matched ${h.matchedTerms.join(", ")} in ${h.matchedFields.join(", ")}.`
          : "Matched the published register.",
    }));

    const deterministic = (note: string) => ({
      mode: "deterministic" as const,
      aiAvailable: aiEnabled(app),
      note,
      runId: null,
      answer: null,
      confidence: null,
      citations: [] as { lessonId: string; number: string; title: string; excerpt?: string }[],
      results,
      registerSize: rows.length,
    });

    if (hits.length === 0) {
      return deterministic(
        "No published lesson matched those terms. Deterministic keyword search over the " +
          "published register; the AI layer was not called because there was nothing to cite.",
      );
    }
    if (!aiEnabled(app)) {
      return deterministic(
        "ANTHROPIC_API_KEY is not configured, so no natural-language answer was generated. " +
          "These results come from deterministic keyword search over the published register — " +
          "ranked by term matches, weighted by field, with prior applications breaking ties.",
      );
    }

    const candidates: SearchCandidate[] = hits.map((h) => ({
      type: "lesson",
      id: h.lesson.id,
      label: `${h.lesson.number} — ${h.lesson.title} (${h.lesson.category})`,
      snippet: [
        `What happened: ${h.lesson.whatHappened}`,
        h.lesson.rootCause ? `Root cause: ${h.lesson.rootCause}` : "",
        `Recommendation: ${h.lesson.recommendation}`,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1200),
    }));
    const system = [
      "You are the ConstructOS organisational-memory agent for a construction owner.",
      "Answer the user's question STRICTLY from the numbered lessons provided — never from outside knowledge.",
      'If the lessons do not answer it, set "answer" to null and return an empty citations list.',
      'Return ONLY a JSON object: {"answer": string|null, "citations": [{"ref": number, "type": "lesson", "id": string, "excerpt": string}], "confidence": number}.',
      "Each citation's ref is the lesson number it came from; copy id exactly from that lesson's header. confidence is 0-1.",
    ].join("\n");
    try {
      const result = await runAgent({
        app,
        req,
        agentKind: "document_search",
        projectId: null,
        system,
        user: `Question: ${body.query}\n\nLessons:\n\n${renderSnippets(candidates)}`,
        inputRefs: candidates.map((c): InputRef => ({ type: c.type, id: c.id })),
        schema: aiSearchSchema,
      });
      const known = new Set(hits.map((h) => h.lesson.id));
      // A citation to a lesson that was not in the prompt is dropped, not shown.
      const citations = (result.json?.citations ?? [])
        .filter((c) => known.has(c.id))
        .map((c) => {
          const lesson = byId.get(c.id)!;
          return {
            lessonId: lesson.id,
            number: lesson.number,
            title: lesson.title,
            ...(c.excerpt ? { excerpt: c.excerpt } : {}),
          };
        });
      return {
        mode: "ai" as const,
        aiAvailable: true,
        note:
          "The answer is synthesised by the AI layer strictly from the cited lessons; the " +
          "result list underneath it is the deterministic keyword search and is unaffected.",
        runId: result.runId,
        answer: result.json?.answer ?? null,
        confidence: result.json?.confidence ?? null,
        citations,
        results,
        registerSize: rows.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return deterministic(
        "The AI layer was configured but the call did not succeed, so no natural-language " +
          `answer was generated: ${message.slice(0, 300)}. These results come from ` +
          "deterministic keyword search over the published register.",
      );
    }
  });

  /* ---------------------------------------------------------------- */
  /* Triggers (#976-977)                                               */
  /* ---------------------------------------------------------------- */

  app.get("/learning/triggers/rules", { preHandler: companyRead }, async () => ({
    rules: describeTriggerRules(),
    note:
      "Every rule reads records another module already writes. Nothing here depends on a " +
      "human remembering to tell the learning module that something happened.",
  }));

  app.get("/projects/:projectId/learning/triggers", { preHandler: projectRead }, async (req) => {
    const q = triggersQuery.parse(req.query);
    /*
     * THIS READ WRITES NOTHING.
     *
     * It used to run the sweep, so a read-only member — or an assurance
     * grantee with no write permission at all — created obligations, lesson
     * triggers and hash-chained ledger entries simply by opening the tab, all
     * attributed to them. The test asserting that a reader gets 403 on
     * POST /triggers/sweep was therefore cosmetic: the identical sweep ran on
     * the GET beside it. The sweep is now the scheduled job
     * `learning.capture-triggers`, running under a null (system) actor.
     */
    const where = and(
      eq(lessonTriggers.companyId, req.companyId!),
      eq(lessonTriggers.projectId, req.projectId!),
      ...(q.status ? [eq(lessonTriggers.status, q.status)] : []),
      ...(q.kind ? [eq(lessonTriggers.kind, q.kind)] : []),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(lessonTriggers).where(where);
    const rows = await app.db
      .select()
      .from(lessonTriggers)
      .where(where)
      .orderBy(desc(lessonTriggers.raisedAt), desc(lessonTriggers.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const now = Date.now();
    const items = rows.map((t) => ({
      ...t,
      ageDays: Math.max(0, Math.floor((now - Date.parse(t.raisedAt)) / MS_PER_DAY)),
      overdue: t.status === "open" && t.dueAt != null && t.dueAt < todayISO(),
    }));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      sweptBy:
        "scheduler job learning.capture-triggers (system actor) — this read performs no writes",
    };
  });

  app.post(
    "/projects/:projectId/learning/triggers/sweep",
    { preHandler: projectStandard },
    async (req) => {
      const sweep = await sweepProjectTriggers(req.companyId!, req.projectId!, req.user!.id);
      return {
        ...sweep,
        rules: describeTriggerRules(),
        note:
          "Idempotent: one trigger per (kind, source record) per project, forever. Re-running " +
          "the sweep over an unchanged project creates nothing and writes nothing to the ledger.",
      };
    },
  );

  /**
   * Dismissal is the only way out of a trigger other than a lesson, and it is
   * deliberately expensive: a named dismisser and a reason of substance, both
   * recorded on the trigger and in the ledger. The obligation is waived, not
   * satisfied — the distinction survives in the assurance register.
   */
  app.post(
    "/projects/:projectId/learning/triggers/:triggerId/dismiss",
    { preHandler: projectStandard },
    async (req) => {
      const { triggerId } = req.params as { triggerId: string };
      const body = dismissSchema.parse(req.body);
      const trigger = await fetchTrigger(triggerId, req.companyId!, req.projectId!);
      if (trigger.status !== "open") {
        throw conflict(`Trigger is already ${trigger.status}`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessonTriggers)
        .set({
          status: "dismissed",
          dismissedBy: req.user!.id,
          dismissedReason: body.reason,
          closedAt: now,
        })
        .where(eq(lessonTriggers.id, triggerId));
      if (trigger.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "waived" })
          .where(and(eq(obligations.id, trigger.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson_trigger",
        objectId: triggerId,
        payload: {
          from: "open",
          to: "dismissed",
          dismissedBy: req.user!.id,
          reason: body.reason,
          obligationId: trigger.obligationId,
          obligation: trigger.obligationId ? "waived" : null,
        },
        storePayload: true,
      });
      return fetchTrigger(triggerId, req.companyId!, req.projectId!);
    },
  );

  /** Capture from a trigger: the lesson is created AND the trigger discharged. */
  app.post(
    "/projects/:projectId/learning/triggers/:triggerId/capture",
    { preHandler: projectStandard },
    async (req, reply) => {
      const { triggerId } = req.params as { triggerId: string };
      const body = lessonCreateSchema.omit({ triggerId: true }).parse(req.body);
      const trigger = await fetchTrigger(triggerId, req.companyId!, req.projectId!);
      if (trigger.status !== "open") {
        throw conflict(`Trigger is already ${trigger.status} — it cannot be captured again`);
      }
      const sourceRef = trigger.sourceRef as TriggerSourceRef;
      // The triggering record is evidence for the lesson by construction.
      const evidenceRefs = [
        { tool: sourceRef.tool, recordId: sourceRef.recordId, label: sourceRef.label },
        ...(body.evidenceRefs ?? []),
      ];
      const lesson = await createLesson(
        req.companyId!,
        req.projectId!,
        req.user!.id,
        { ...body, evidenceRefs },
        trigger,
      );
      return reply.status(201).send({
        lesson,
        trigger: await fetchTrigger(triggerId, req.companyId!, req.projectId!),
      });
    },
  );

  /**
   * DRAFT A LESSON FROM THE RECORD THAT OBLIGED IT (#978, AI-assisted).
   *
   * The commonest reason a mandatory capture is never captured is not that
   * nobody agreed it mattered — it is the blank page. This reads the trigger
   * and its source record and proposes the four fields a lesson needs, every
   * one of them cited back to the record it came from.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: create anything. It returns a PROPOSAL.
   * The trigger stays open, no lesson row exists, and the capture route is
   * still the only way one comes into being — because a lesson nobody chose
   * to write is a lesson nobody stands behind, and the validation step that
   * follows would then be checking a machine's work against nothing.
   *
   * With no ANTHROPIC_API_KEY the route answers 503 and the whole non-AI
   * capture path is untouched.
   */
  const draftSchema = z.object({
    title: z.string().nullable(),
    whatHappened: z.string().nullable(),
    rootCause: z.string().nullable(),
    recommendation: z.string().nullable(),
    category: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    confidence: z.number().nullable(),
    citations: z.array(
      z.object({ recordId: z.string(), excerpt: z.string().nullable() }),
    ),
  });

  app.post(
    "/projects/:projectId/learning/triggers/:triggerId/draft",
    { preHandler: projectStandard },
    async (req) => {
      const { triggerId } = req.params as { triggerId: string };
      const trigger = await fetchTrigger(triggerId, req.companyId!, req.projectId!);
      if (trigger.status !== "open") {
        throw conflict(
          `This trigger is already ${trigger.status}. A draft is only useful while the capture ` +
            "is still owed.",
        );
      }
      if (!aiEnabled(app)) {
        throw aiUnavailable(
          "ANTHROPIC_API_KEY is not configured, so no draft can be generated. Capture the " +
            "lesson directly — the trigger, its rationale and the source record are all on this " +
            "page, and nothing about the mandatory-capture workflow depends on the AI layer.",
        );
      }
      const sourceRef = trigger.sourceRef as TriggerSourceRef;
      const context = [
        `Trigger kind: ${trigger.kind}`,
        `Why it fired: ${trigger.rationale}`,
        `Source record: ${sourceRef.tool} ${sourceRef.recordId} — ${sourceRef.label}`,
        ...Object.entries(sourceRef)
          .filter(([k]) => !["tool", "recordId", "label"].includes(k))
          .map(([k, v]) => `${k}: ${String(v).slice(0, 400)}`),
      ].join("\n");
      const system = [
        "You are the ConstructOS organisational-learning agent for a construction owner.",
        "You are given ONE record that has obliged a lesson to be captured, and nothing else.",
        "Propose a lesson STRICTLY from that record. Never invent a cause, a cost or a party.",
        "Where the record does not say something, return null for that field rather than guessing.",
        'Return ONLY JSON: {"title","whatHappened","rootCause","recommendation","category","tags","confidence","citations":[{"recordId","excerpt"}]}.',
        "Every citation's recordId must be the source record's id, copied exactly.",
        "The recommendation must be an action a future project could actually take, not a platitude.",
      ].join("\n");
      try {
        const result = await runAgent({
          app,
          req,
          agentKind: "lesson_drafter",
          projectId: req.projectId!,
          system,
          user: context,
          inputRefs: [{ type: sourceRef.tool, id: sourceRef.recordId }],
          schema: draftSchema,
        });
        const draft = result.json;
        return {
          triggerId,
          runId: result.runId,
          aiAvailable: true,
          /*
           * A PROPOSAL. Nothing is written: the trigger is still open and no
           * lesson exists until a person captures one.
           */
          created: false,
          proposal: draft
            ? {
                title: draft.title,
                whatHappened: draft.whatHappened,
                rootCause: draft.rootCause,
                recommendation: draft.recommendation,
                category: draft.category,
                tags: draft.tags ?? [],
              }
            : null,
          confidence: draft?.confidence ?? null,
          citations: (draft?.citations ?? []).filter((c) => c.recordId === sourceRef.recordId),
          evidenceRefs: [
            { tool: sourceRef.tool, recordId: sourceRef.recordId, label: sourceRef.label },
          ],
          note:
            "A proposal, not a lesson. Nothing has been written: the trigger is still open and " +
            "no lesson exists until somebody captures one. Read the source record before " +
            "accepting a word of this — the validation step that follows is a check on what a " +
            "human wrote, and it is worth nothing if the human wrote nothing.",
        };
      } catch (err) {
        if (err instanceof AppError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw aiUnavailable(
          `The AI layer was configured but the draft call did not succeed: ${message.slice(0, 300)}. ` +
            "Capture the lesson directly.",
        );
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* Company-wide register (#977, #992-993)                            */
  /* ---------------------------------------------------------------- */

  /** Lesson states that are a TENANT asset rather than one project's data. */
  const COMPANY_WIDE_LESSON_STATES = ["published", "superseded"] as const;

  /**
   * Restrict the register to what the caller may actually see: published
   * lessons (company-wide by design) plus unpublished ones belonging to a
   * project they hold `learning` on. Owners, admins and tenant-wide assurance
   * grants see everything.
   */
  function visibleLessons(req: FastifyRequest) {
    const scope = companyScopeOf(req, "learning");
    if (scope.all) return undefined;
    const published = inArray(lessons.status, [...COMPANY_WIDE_LESSON_STATES]);
    if (scope.projectIds.length === 0) return published;
    return or(published, inArray(lessons.originProjectId, scope.projectIds));
  }

  /** The id-addressed form of the same rule: 404, not 403 — see scope.ts. */
  function assertLessonVisible(req: FastifyRequest, lesson: LessonRow): void {
    const scope = companyScopeOf(req, "learning");
    if (scope.all) return;
    if (COMPANY_WIDE_LESSON_STATES.includes(lesson.status as (typeof COMPANY_WIDE_LESSON_STATES)[number])) {
      return;
    }
    if (lesson.originProjectId && scopeAllows(scope, lesson.originProjectId)) return;
    throw notFound(
      "Lesson not found. An unpublished lesson belongs to the project that raised it, and is " +
        "readable only by people who hold learning on that project.",
    );
  }

  app.get("/learning/lessons", { preHandler: companyScopedRead }, async (req) => {
    const q = registerQuery.parse(req.query);
    const clauses = [eq(lessons.companyId, req.companyId!)];
    const visible = visibleLessons(req);
    if (visible) clauses.push(visible);
    if (q.category) clauses.push(eq(lessons.category, q.category));
    if (q.status) clauses.push(eq(lessons.status, q.status));
    if (q.phase) clauses.push(eq(lessons.phase, q.phase));
    if (q.originProject) clauses.push(eq(lessons.originProjectId, q.originProject));
    if (q.impactMin !== undefined) clauses.push(gte(lessons.impactValue, q.impactMin));
    if (q.impactMax !== undefined) clauses.push(lte(lessons.impactValue, q.impactMax));
    if (q.tags) {
      const wanted = csv(q.tags).map((t) => t.toLowerCase());
      if (wanted.length > 0) {
        clauses.push(
          or(...wanted.map((t) => sql`${lessons.tags} @> ${JSON.stringify([t])}::jsonb`))!,
        );
      }
    }
    if (q.q) {
      const pattern = `%${escapeLike(q.q)}%`;
      clauses.push(
        or(
          ilike(lessons.title, pattern),
          ilike(lessons.whatHappened, pattern),
          ilike(lessons.recommendation, pattern),
          ilike(lessons.rootCause, pattern),
          ilike(lessons.context, pattern),
        )!,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(lessons).where(where);
    const rows = await app.db
      .select()
      .from(lessons)
      .where(where)
      .orderBy(desc(lessons.publishedAt), desc(lessons.createdAt), desc(lessons.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const counts = await applicationCounts(req.companyId!);
    return paginate(
      rows.map((l) => ({ ...l, applicationCount: counts.get(l.id) ?? 0 })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.get("/learning/lessons/:lessonId", { preHandler: companyScopedRead }, async (req) => {
    const { lessonId } = req.params as { lessonId: string };
    const lesson = await fetchLesson(lessonId, req.companyId!);
    assertLessonVisible(req, lesson);
    const applications = await app.db
      .select()
      .from(lessonApplications)
      .where(
        and(
          eq(lessonApplications.companyId, req.companyId!),
          eq(lessonApplications.lessonId, lessonId),
        ),
      )
      .orderBy(desc(lessonApplications.appliedAt));
    const [trigger] = await app.db
      .select()
      .from(lessonTriggers)
      .where(
        and(eq(lessonTriggers.companyId, req.companyId!), eq(lessonTriggers.lessonId, lessonId)),
      )
      .limit(1);
    const supersededBy = lesson.supersededById
      ? (
          await app.db
            .select({ id: lessons.id, number: lessons.number, title: lessons.title })
            .from(lessons)
            .where(eq(lessons.id, lesson.supersededById))
            .limit(1)
        )[0] ?? null
      : null;
    return {
      ...lesson,
      applicationCount: applications.length,
      applications,
      trigger: trigger ?? null,
      supersededBy,
    };
  });

  /**
   * Impact (#979): the only evidence the platform can offer that learning
   * crossed a project boundary. A published lesson with no applications is
   * reported as exactly that — the register does not hide its own failures.
   */
  app.get("/learning/lessons/:lessonId/impact", { preHandler: companyScopedRead }, async (req) => {
    const { lessonId } = req.params as { lessonId: string };
    const lesson = await fetchLesson(lessonId, req.companyId!);
    assertLessonVisible(req, lesson);
    const rows = await app.db
      .select()
      .from(lessonApplications)
      .where(
        and(
          eq(lessonApplications.companyId, req.companyId!),
          eq(lessonApplications.lessonId, lessonId),
        ),
      )
      .orderBy(desc(lessonApplications.appliedAt));

    const projectIds = [...new Set(rows.map((r) => r.projectId))];
    const projectRows =
      projectIds.length > 0
        ? await app.db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(
              and(eq(projects.companyId, req.companyId!), inArray(projects.id, projectIds)),
            )
        : [];
    const nameById = new Map(projectRows.map((p) => [p.id, p.name]));

    const byProject = projectIds.map((pid) => {
      const forProject = rows.filter((r) => r.projectId === pid);
      const times = forProject.map((r) => r.appliedAt).sort();
      return {
        projectId: pid,
        projectName: nameById.get(pid) ?? null,
        isOriginProject: pid === lesson.originProjectId,
        applications: forProject.length,
        firstAppliedAt: times[0] ?? null,
        lastAppliedAt: times[times.length - 1] ?? null,
      };
    });
    byProject.sort((a, b) => b.applications - a.applications || a.projectId.localeCompare(b.projectId));

    const crossProject = rows.filter((r) => r.projectId !== lesson.originProjectId);
    return {
      lesson: {
        id: lesson.id,
        number: lesson.number,
        title: lesson.title,
        status: lesson.status,
        category: lesson.category,
        phase: lesson.phase,
        originProjectId: lesson.originProjectId,
        publishedAt: lesson.publishedAt,
        impactValue: lesson.impactValue,
        impactCurrency: lesson.impactCurrency,
        impactDays: lesson.impactDays,
      },
      applicationCount: rows.length,
      crossProjectApplicationCount: crossProject.length,
      crossedProjectBoundary: crossProject.length > 0,
      projectsReached: byProject.length,
      projects: byProject,
      outcomesRecorded: rows.filter((r) => (r.outcomeNote ?? "").trim().length > 0).length,
      applications: rows.map((r) => ({
        ...r,
        projectName: nameById.get(r.projectId) ?? null,
        crossedProjectBoundary: r.projectId !== lesson.originProjectId,
      })),
      note:
        rows.length === 0
          ? lesson.status === "published"
            ? "This lesson has never been applied. A published lesson with no applications is a " +
              "document, not a change in practice."
            : `This lesson is ${lesson.status}; only published lessons can be applied.`
          : crossProject.length === 0
            ? "Every application so far is on the lesson's own origin project — the knowledge has " +
              "not yet crossed a project boundary."
            : `Applied on ${byProject.length} project(s), ${crossProject.length} of them away ` +
              "from where the lesson was learned.",
    };
  });

  /**
   * Supersede a published lesson with a later one. Company-level because a
   * published lesson no longer belongs to a project, and restricted to
   * company owners/admins because it rewrites what the organisation believes.
   */
  app.post("/learning/lessons/:lessonId/supersede", { preHandler: companyWrite }, async (req) => {
    const { lessonId } = req.params as { lessonId: string };
    const body = supersedeSchema.parse(req.body);
    if (body.supersededById === lessonId) throw badRequest("A lesson cannot supersede itself");
    const lesson = await fetchLesson(lessonId, req.companyId!);
    if (lesson.status !== "published") {
      throw conflict(`Only a published lesson can be superseded (this one is ${lesson.status})`);
    }
    const replacement = await fetchLesson(body.supersededById, req.companyId!);
    if (replacement.status !== "published") {
      throw badRequest(
        `The superseding lesson must itself be published (${replacement.number} is ${replacement.status})`,
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(lessons)
      .set({ status: "superseded", supersededById: replacement.id, updatedAt: now })
      .where(eq(lessons.id, lessonId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "lesson",
      objectId: lessonId,
      payload: {
        from: "published",
        to: "superseded",
        supersededById: replacement.id,
        supersededByNumber: replacement.number,
      },
      storePayload: true,
    });
    return fetchLesson(lessonId, req.companyId!);
  });

  /* ---------------------------------------------------------------- */
  /* Company learning health (#976-979)                                */
  /* ---------------------------------------------------------------- */

  /**
   * The backlog that shames. Open triggers by age is the headline: a company
   * with fifty open triggers older than ninety days does not have a learning
   * culture, whatever its lesson count says.
   */
  app.get("/learning/summary", { preHandler: companyScopedRead }, async (req) => {
    const companyId = req.companyId!;
    const triggerRows = await app.db
      .select()
      .from(lessonTriggers)
      .where(eq(lessonTriggers.companyId, companyId));
    const lessonRows = await app.db
      .select({
        id: lessons.id,
        number: lessons.number,
        title: lessons.title,
        status: lessons.status,
        category: lessons.category,
        impactValue: lessons.impactValue,
        impactCurrency: lessons.impactCurrency,
        impactDays: lessons.impactDays,
        publishedAt: lessons.publishedAt,
        originProjectId: lessons.originProjectId,
      })
      .from(lessons)
      .where(eq(lessons.companyId, companyId));
    const applicationRows = await app.db
      .select({
        lessonId: lessonApplications.lessonId,
        projectId: lessonApplications.projectId,
      })
      .from(lessonApplications)
      .where(eq(lessonApplications.companyId, companyId));

    const now = Date.now();
    const openTriggers = triggerRows.filter((t) => t.status === "open");
    const buckets = { "0-7": 0, "8-30": 0, "31-90": 0, "90+": 0 };
    let oldestOpenDays: number | null = null;
    for (const t of openTriggers) {
      const days = Math.max(0, Math.floor((now - Date.parse(t.raisedAt)) / MS_PER_DAY));
      if (oldestOpenDays == null || days > oldestOpenDays) oldestOpenDays = days;
      if (days <= 7) buckets["0-7"] += 1;
      else if (days <= 30) buckets["8-30"] += 1;
      else if (days <= 90) buckets["31-90"] += 1;
      else buckets["90+"] += 1;
    }
    const byKind: Record<string, number> = {};
    for (const t of triggerRows) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;

    const lessonsByStatus: Record<string, number> = {};
    for (const s of LESSON_STATUSES) lessonsByStatus[s] = 0;
    for (const l of lessonRows) lessonsByStatus[l.status] = (lessonsByStatus[l.status] ?? 0) + 1;

    const appsByLesson = new Map<string, { count: number; projects: Set<string> }>();
    for (const a of applicationRows) {
      const entry = appsByLesson.get(a.lessonId) ?? { count: 0, projects: new Set<string>() };
      entry.count += 1;
      entry.projects.add(a.projectId);
      appsByLesson.set(a.lessonId, entry);
    }

    const published = lessonRows.filter((l) => l.status === "published");
    const neverApplied = published
      .filter((l) => !appsByLesson.has(l.id))
      .sort(
        (a, b) =>
          (b.impactValue ?? 0) - (a.impactValue ?? 0) ||
          (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
      );
    const mostApplied = published
      .map((l) => {
        const entry = appsByLesson.get(l.id);
        return {
          lessonId: l.id,
          number: l.number,
          title: l.title,
          category: l.category,
          applications: entry?.count ?? 0,
          projects: entry?.projects.size ?? 0,
        };
      })
      .filter((l) => l.applications > 0)
      .sort((a, b) => b.applications - a.applications || a.number.localeCompare(b.number))
      .slice(0, 10);

    const raised = triggerRows.length;
    const captured = triggerRows.filter((t) => t.status === "captured").length;
    const dismissed = triggerRows.filter((t) => t.status === "dismissed").length;
    const crossProjectApplications = applicationRows.filter((a) => {
      const lesson = lessonRows.find((l) => l.id === a.lessonId);
      return lesson != null && lesson.originProjectId !== a.projectId;
    }).length;

    return {
      triggers: {
        raised,
        open: openTriggers.length,
        captured,
        dismissed,
        openByAge: buckets,
        oldestOpenDays,
        byKind,
        oldestOpen: [...openTriggers]
          .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            projectId: t.projectId,
            kind: t.kind,
            rationale: t.rationale,
            dueAt: t.dueAt,
            ageDays: Math.max(0, Math.floor((now - Date.parse(t.raisedAt)) / MS_PER_DAY)),
          })),
      },
      captureRate: {
        raised,
        discharged: captured,
        dismissed,
        open: openTriggers.length,
        percent: raised === 0 ? null : Math.round((captured / raised) * 1000) / 10,
        note:
          raised === 0
            ? "No mandatory-capture trigger has been raised yet — run the trigger sweep on a project."
            : "Capture rate is triggers discharged by a lesson over triggers raised. Dismissals " +
              "are excluded from the numerator deliberately: a dismissal is a decision not to learn.",
      },
      lessons: {
        total: lessonRows.length,
        byStatus: lessonsByStatus,
        published: published.length,
      },
      publishedNeverApplied: {
        count: neverApplied.length,
        percentOfPublished:
          published.length === 0
            ? null
            : Math.round((neverApplied.length / published.length) * 1000) / 10,
        lessons: neverApplied.slice(0, 10).map((l) => ({
          lessonId: l.id,
          number: l.number,
          title: l.title,
          category: l.category,
          impactValue: l.impactValue,
          impactCurrency: l.impactCurrency,
          publishedAt: l.publishedAt,
        })),
      },
      mostApplied,
      applications: {
        total: applicationRows.length,
        crossProject: crossProjectApplications,
      },
    };
  });

  /* ---------------------------------------------------------------- */
  /* CROSS-PROJECT SUPPLIER PERFORMANCE (#987-989)                     */
  /*                                                                   */
  /* A vendor's record on one job is an anecdote; the same record       */
  /* across eleven is knowledge, and knowledge that crosses a project   */
  /* boundary is what this module holds. Deterministic, sourced from    */
  /* acts the platform already recorded, and scoped to the projects the */
  /* caller may actually see — a scorecard assembled from projects      */
  /* somebody cannot open is a disclosure, not a report.                */
  /* ---------------------------------------------------------------- */

  app.get("/learning/supplier-performance", { preHandler: companyScopedRead }, async (req) => {
    const q = z
      .object({
        vendorId: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});
    const companyId = req.companyId!;
    const scope = companyScopeOf(req, "learning");
    const asOf = todayISO();

    /* The project restriction, expressed once. `null` project (a company-wide
       certificate) is a tenant asset and stays visible; a project record is
       visible only where the caller holds the tool. */
    const visible = scope.all ? null : scope.projectIds;
    if (visible !== null && visible.length === 0) {
      return {
        asOf,
        items: [],
        total: 0,
        scope: "restricted" as const,
        note:
          "You hold learning on no project, so no supplier record can be assembled. This is not " +
          "the same as there being nothing to report.",
      };
    }

    const vendorRows = await app.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(
        and(
          eq(vendors.companyId, companyId),
          q.vendorId ? eq(vendors.id, q.vendorId) : undefined,
        ),
      )
      .orderBy(vendors.name)
      .limit(q.limit);
    if (vendorRows.length === 0) {
      return {
        asOf,
        items: [],
        total: 0,
        scope: visible === null ? ("company" as const) : ("restricted" as const),
        note: "No vendor is recorded in this company's directory.",
      };
    }
    const vendorIds = vendorRows.map((v) => v.id);

    const certRows = await app.db
      .select({
        vendorId: insuranceCertificates.vendorId,
        validTo: insuranceCertificates.validTo,
        verifiedAt: insuranceCertificates.verifiedAt,
        status: insuranceCertificates.status,
      })
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.companyId, companyId),
          inArray(insuranceCertificates.vendorId, vendorIds),
          visible === null
            ? undefined
            : or(
                isNull(insuranceCertificates.projectId),
                inArray(insuranceCertificates.projectId, visible),
              ),
        ),
      );

    const actionRows = await app.db
      .select({
        ownerVendorId: meetingActionItems.ownerVendorId,
        status: meetingActionItems.status,
        dueDate: meetingActionItems.dueDate,
        completedAt: meetingActionItems.completedAt,
        carryCount: meetingActionItems.carryCount,
      })
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.companyId, companyId),
          inArray(meetingActionItems.ownerVendorId, vendorIds),
          visible === null ? undefined : inArray(meetingActionItems.projectId, visible),
        ),
      );

    const ncrRows = await app.db
      .select({
        raisedAgainstVendorId: nonConformanceReports.raisedAgainstVendorId,
        status: nonConformanceReports.status,
        severity: nonConformanceReports.severity,
      })
      .from(nonConformanceReports)
      .where(
        and(
          eq(nonConformanceReports.companyId, companyId),
          inArray(nonConformanceReports.raisedAgainstVendorId, vendorIds),
          visible === null ? undefined : inArray(nonConformanceReports.projectId, visible),
        ),
      );

    const items = scoreSuppliers({
      asOf,
      vendors: vendorRows,
      certificates: certRows.flatMap((c) =>
        c.vendorId ? [{ ...c, vendorId: c.vendorId }] : [],
      ),
      actions: actionRows.flatMap((a) =>
        a.ownerVendorId ? [{ ...a, ownerVendorId: a.ownerVendorId }] : [],
      ),
      ncrs: ncrRows.flatMap((n) =>
        n.raisedAgainstVendorId
          ? [{ ...n, raisedAgainstVendorId: n.raisedAgainstVendorId }]
          : [],
      ),
    });

    return {
      asOf,
      items,
      total: items.length,
      scope: visible === null ? ("company" as const) : ("restricted" as const),
      sources: [
        "insurance certificates (in date, and independently verified)",
        "meeting action items owned by the vendor (overdue, closed late, carried)",
        "non-conformance reports raised against the vendor (count, severity, still open)",
      ],
      note:
        "Every figure names the records it came from and a dimension with no records scores " +
        "null rather than zero. Nothing here is a recommendation: it reports what happened, " +
        "and whether that disqualifies a supplier is a human judgement they may answer.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Post-project reviews (#991)                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/learning/reviews",
    { preHandler: projectStandard },
    async (req, reply) => {
      const body = reviewCreateSchema.parse(req.body);
      const id = newId("ppr");
      await app.db.insert(postProjectReviews).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        title: body.title,
        status: "scheduled",
        scheduledFor: body.scheduledFor ?? null,
        facilitator: body.facilitator ?? null,
        participants: (body.participants ?? []) as unknown[],
        metrics: {},
        findings: [],
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "post_project_review",
        objectId: id,
        payload: { projectId: req.projectId!, title: body.title, scheduledFor: body.scheduledFor ?? null },
        storePayload: true,
      });
      return reply.status(201).send(await fetchReview(id, req.companyId!, req.projectId!));
    },
  );

  app.get("/projects/:projectId/learning/reviews", { preHandler: projectRead }, async (req) => {
    const q = reviewListQuery.parse(req.query);
    const where = and(
      eq(postProjectReviews.companyId, req.companyId!),
      eq(postProjectReviews.projectId, req.projectId!),
      ...(q.status ? [eq(postProjectReviews.status, q.status)] : []),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(postProjectReviews).where(where);
    const rows = await app.db
      .select()
      .from(postProjectReviews)
      .where(where)
      .orderBy(desc(postProjectReviews.createdAt), desc(postProjectReviews.id))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/learning/reviews/:reviewId",
    { preHandler: projectRead },
    async (req) => {
      const { reviewId } = req.params as { reviewId: string };
      return fetchReview(reviewId, req.companyId!, req.projectId!);
    },
  );

  app.patch(
    "/projects/:projectId/learning/reviews/:reviewId",
    { preHandler: projectStandard },
    async (req) => {
      const { reviewId } = req.params as { reviewId: string };
      const body = reviewPatchSchema.parse(req.body);
      const review = await fetchReview(reviewId, req.companyId!, req.projectId!);
      if (review.status === "signed_off") {
        throw conflict("A signed-off review is frozen — reopen it before editing");
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "title",
        "scheduledFor",
        "heldAt",
        "facilitator",
        "whatWentWell",
        "whatDidNot",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      if (body.participants !== undefined) set["participants"] = body.participants;
      if (body.findings !== undefined) {
        set["findings"] = body.findings.map((f) => ({
          id: f.id ?? newId("fnd"),
          text: f.text,
          category: f.category ?? null,
          lessonId: f.lessonId ?? null,
        }));
      }
      await app.db
        .update(postProjectReviews)
        .set(set)
        .where(eq(postProjectReviews.id, reviewId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "post_project_review",
        objectId: reviewId,
        payload: { changed: Object.keys(body) },
      });
      return fetchReview(reviewId, req.companyId!, req.projectId!);
    },
  );

  app.post(
    "/projects/:projectId/learning/reviews/:reviewId/transition",
    { preHandler: projectStandard },
    async (req) => {
      const { reviewId } = req.params as { reviewId: string };
      const body = reviewTransitionSchema.parse(req.body);
      const review = await fetchReview(reviewId, req.companyId!, req.projectId!);
      const from = review.status as ReviewStatus;
      const allowed = REVIEW_TRANSITIONS[from] ?? [];
      if (!allowed.includes(body.to)) {
        throw conflict(
          `A ${from} review cannot become ${body.to}` +
            (allowed.length > 0 ? ` — allowed: ${allowed.join(", ")}` : " — it is terminal"),
        );
      }
      const heldAt = body.heldAt ?? review.heldAt;
      if (body.to === "completed" && !heldAt) {
        throw badRequest(
          "A review cannot be completed without the date it was held — set heldAt first",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(postProjectReviews)
        .set({ status: body.to, heldAt: heldAt ?? null, updatedAt: now })
        .where(eq(postProjectReviews.id, reviewId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "post_project_review",
        objectId: reviewId,
        payload: { from, to: body.to, heldAt: heldAt ?? null, note: body.note ?? null },
        storePayload: true,
      });
      return fetchReview(reviewId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Build the metrics object FROM PLATFORM RECORDS rather than from recall
   * (#991). Every figure the platform cannot compute comes back null with the
   * reason — the same honesty contract as `modules/benchmarks/metrics.ts`.
   */
  app.post(
    "/projects/:projectId/learning/reviews/:reviewId/compute-metrics",
    { preHandler: projectStandard },
    async (req) => {
      const { reviewId } = req.params as { reviewId: string };
      const review = await fetchReview(reviewId, req.companyId!, req.projectId!);
      if (review.status === "signed_off") {
        throw conflict(
          "A signed-off review is frozen — its metrics are the figures that were signed for",
        );
      }
      const metrics = await computeReviewMetrics(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
      });
      await app.db
        .update(postProjectReviews)
        .set({ metrics: metrics as unknown as Record<string, unknown>, updatedAt: metrics.computedAt })
        .where(eq(postProjectReviews.id, reviewId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "post_project_review",
        objectId: reviewId,
        payload: {
          phase: "compute_metrics",
          computedAt: metrics.computedAt,
          computed: metrics.metrics
            .filter((m) => m.value != null)
            .map((m) => ({ key: m.key, value: m.value, unit: m.unit })),
          unavailable: metrics.unavailable,
        },
        storePayload: true,
      });
      return metrics;
    },
  );

  /** Sign-off: only a completed review, and it records who signed and when. */
  app.post(
    "/projects/:projectId/learning/reviews/:reviewId/sign-off",
    { preHandler: projectAdmin },
    async (req) => {
      const { reviewId } = req.params as { reviewId: string };
      const review = await fetchReview(reviewId, req.companyId!, req.projectId!);
      if (review.status !== "completed") {
        throw conflict(
          `Only a completed review can be signed off (this one is ${review.status})`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(postProjectReviews)
        .set({
          status: "signed_off",
          signedOffBy: req.user!.id,
          signedOffAt: now,
          updatedAt: now,
        })
        .where(eq(postProjectReviews.id, reviewId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "post_project_review",
        objectId: reviewId,
        payload: { from: "completed", to: "signed_off", signedOffBy: req.user!.id, signedOffAt: now },
        storePayload: true,
      });
      return fetchReview(reviewId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/learning/reviews/:reviewId",
    { preHandler: projectAdmin },
    async (req, reply) => {
      const { reviewId } = req.params as { reviewId: string };
      const review = await fetchReview(reviewId, req.companyId!, req.projectId!);
      if (review.status !== "scheduled" && review.status !== "cancelled") {
        throw conflict(
          `A ${review.status} review holds findings and metrics — cancel it instead of deleting it`,
        );
      }
      await app.db.delete(postProjectReviews).where(eq(postProjectReviews.id, reviewId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "post_project_review",
        objectId: reviewId,
        payload: { projectId: req.projectId!, title: review.title, status: review.status },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ================================================================ */
  /* APPLIED-LESSON OUTCOME MEASUREMENT (#984)                         */
  /*                                                                   */
  /* An application whose outcome nobody measured is `unknown`, and it  */
  /* stays `unknown`. Counting it as a success is exactly how a lessons */
  /* register comes to report impact it never had — and the measurement */
  /* is a separate act, by a different person, carrying its own date.   */
  /* ================================================================ */

  const outcomeSchema = z.object({
    outcome: z.enum(LESSON_OUTCOMES),
    outcomeNote: z.string().max(5000).nullable().optional(),
    /** money the application is claimed to have saved (or cost, if negative) */
    outcomeValue: z.number().finite().nullable().optional(),
    outcomeCurrency: z.string().min(3).max(8).nullable().optional(),
    outcomeDays: z.number().int().min(-10_000).max(10_000).nullable().optional(),
  });

  app.post(
    "/projects/:projectId/learning/applications/:applicationId/outcome",
    { preHandler: projectStandard },
    async (req) => {
      const { applicationId } = req.params as { applicationId: string };
      const body = outcomeSchema.parse(req.body);
      const [row] = await app.db
        .select()
        .from(lessonApplications)
        .where(
          and(
            eq(lessonApplications.id, applicationId),
            eq(lessonApplications.companyId, req.companyId!),
            eq(lessonApplications.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Lesson application not found on this project");
      if (row.appliedBy === req.user!.id) {
        throw forbidden(
          "The person who applied the lesson may not also certify that it worked. A measured " +
            "outcome is the second pair of eyes this whole module is built on — ask the person " +
            "who felt the effect, or the project's reviewer.",
        );
      }
      if (body.outcomeValue != null && !body.outcomeCurrency && !row.outcomeCurrency) {
        throw badRequest(
          "A money outcome needs its currency. A bare number would be summed against other " +
            "currencies somewhere downstream, and this platform never does that.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessonApplications)
        .set({
          outcome: body.outcome,
          outcomeNote: body.outcomeNote ?? row.outcomeNote,
          outcomeValue: body.outcomeValue ?? row.outcomeValue,
          outcomeCurrency: body.outcomeCurrency ?? row.outcomeCurrency,
          outcomeDays: body.outcomeDays ?? row.outcomeDays,
          measuredAt: now,
          measuredBy: req.user!.id,
        })
        .where(eq(lessonApplications.id, applicationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson_application",
        objectId: applicationId,
        payload: {
          from: row.outcome,
          to: body.outcome,
          lessonId: row.lessonId,
          appliedBy: row.appliedBy,
          measuredBy: req.user!.id,
          outcomeValue: body.outcomeValue ?? null,
          outcomeCurrency: body.outcomeCurrency ?? row.outcomeCurrency,
          outcomeDays: body.outcomeDays ?? null,
        },
        projectId: req.projectId!,
        storePayload: true,
      });
      const [after] = await app.db
        .select()
        .from(lessonApplications)
        .where(eq(lessonApplications.id, applicationId))
        .limit(1);
      return after ?? row;
    },
  );

  /**
   * OUTCOME REPORT for one lesson: what actually happened where it was
   * applied, bucketed by currency and never summed across them, with the
   * unmeasured share stated rather than assumed away.
   */
  app.get(
    "/learning/lessons/:lessonId/outcomes",
    { preHandler: companyScopedRead },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const lesson = await fetchLesson(lessonId, req.companyId!);
      assertLessonVisible(req, lesson);
      const rows = await app.db
        .select()
        .from(lessonApplications)
        .where(
          and(
            eq(lessonApplications.companyId, req.companyId!),
            eq(lessonApplications.lessonId, lessonId),
          ),
        )
        .orderBy(desc(lessonApplications.appliedAt));
      const byOutcome: Record<string, number> = {};
      for (const o of LESSON_OUTCOMES) byOutcome[o] = 0;
      const byCurrency = new Map<string, { value: number; applications: number }>();
      let days = 0;
      let daysMeasured = 0;
      for (const r of rows) {
        byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
        if (r.outcomeValue != null && r.outcomeCurrency) {
          const bucket = byCurrency.get(r.outcomeCurrency) ?? { value: 0, applications: 0 };
          bucket.value += r.outcomeValue;
          bucket.applications += 1;
          byCurrency.set(r.outcomeCurrency, bucket);
        }
        if (r.outcomeDays != null) {
          days += r.outcomeDays;
          daysMeasured += 1;
        }
      }
      const measured = rows.length - (byOutcome["unknown"] ?? 0);
      const reasons: string[] = [];
      if (rows.length === 0) {
        reasons.push(
          "This lesson has never been applied. That is a fact about the register, not a zero: " +
            "no rate is computed.",
        );
      } else if (measured === 0) {
        reasons.push(
          `All ${rows.length} application(s) of this lesson are unmeasured. No effectiveness ` +
            "rate is computed, because an unmeasured application is not a successful one.",
        );
      }
      return {
        lessonId,
        number: lesson.number,
        applications: rows.length,
        measured,
        unmeasured: byOutcome["unknown"] ?? 0,
        byOutcome,
        /* An effectiveness rate over the MEASURED applications only, with the
           denominator stated so nobody mistakes it for a rate over all. */
        effectiveness:
          measured === 0
            ? { value: null, denominator: 0, reasons }
            : {
                value:
                  Math.round(
                    (((byOutcome["avoided"] ?? 0) + 0.5 * (byOutcome["partially_avoided"] ?? 0)) /
                      measured) *
                      1000,
                  ) / 1000,
                denominator: measured,
                reasons: [
                  "Computed over measured applications only; a partially avoided outcome counts " +
                    "as half.",
                ],
              },
        valueByCurrency: [...byCurrency.entries()].map(([currency, v]) => ({
          currency,
          value: Math.round(v.value * 100) / 100,
          applications: v.applications,
        })),
        daysAvoided: daysMeasured === 0 ? null : days,
        daysMeasuredOn: daysMeasured,
        reasons,
        items: rows,
      };
    },
  );

  /* ================================================================ */
  /* CROSS-PROJECT RELEVANCE PUSH (#985–986)                           */
  /*                                                                   */
  /* Retrieval that waits to be searched for is retrieval that does not */
  /* happen. When a lesson is published, the projects it plausibly      */
  /* applies to are computed from the deterministic ranker and the      */
  /* lesson is PUSHED to their teams. The push is itself a record, so   */
  /* "we told them" is checkable and the rate at which pushes become    */
  /* applications is measurable.                                        */
  /* ================================================================ */

  /** The minimum ranker score worth interrupting a team for. */
  const PUSH_SCORE_FLOOR = 20;

  async function pushLessonToProjects(
    companyId: string,
    lesson: LessonRow,
    actorId: string | null,
    limit = 10,
  ): Promise<{ pushed: number; considered: number; skipped: number; items: unknown[] }> {
    if (lesson.status !== "published") return { pushed: 0, considered: 0, skipped: 0, items: [] };
    const liveProjects = await app.db
      .select({ id: projects.id, name: projects.name, stage: projects.stage })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
    const counts = await applicationCounts(companyId);
    const rankable = toRankable(lesson, counts);
    const now = new Date().toISOString();
    const existing = await app.db
      .select({ projectId: lessonPushes.projectId })
      .from(lessonPushes)
      .where(eq(lessonPushes.lessonId, lesson.id));
    const already = new Set(existing.map((e) => e.projectId));

    const scored = liveProjects
      .filter((p) => p.id !== lesson.originProjectId && !already.has(p.id))
      .map((p) => {
        const ranked = rankLessons([rankable], {
          tool: null,
          category: lesson.category,
          phase: p.stage ?? null,
          tags: lesson.tags,
          now,
        })[0];
        return { project: p, score: ranked?.score ?? 0, reasons: ranked?.reasons ?? [] };
      })
      .filter((r) => r.score >= PUSH_SCORE_FLOOR)
      .sort((a, b) => b.score - a.score || a.project.id.localeCompare(b.project.id))
      .slice(0, limit);

    const items: unknown[] = [];
    let pushed = 0;
    for (const candidate of scored) {
      const members = await app.db
        .select({ userId: projectMemberships.userId })
        .from(projectMemberships)
        .where(eq(projectMemberships.projectId, candidate.project.id));
      const userIds = [...new Set(members.map((m) => m.userId))];
      const id = newId("lpu");
      const inserted = await app.db
        .insert(lessonPushes)
        .values({
          id,
          companyId,
          lessonId: lesson.id,
          projectId: candidate.project.id,
          score: candidate.score,
          reasons: candidate.reasons as unknown[],
          status: "pushed",
          notifiedUserIds: userIds,
        })
        .onConflictDoNothing()
        .returning({ id: lessonPushes.id });
      if (!inserted[0]) continue;
      pushed += 1;
      items.push({
        pushId: id,
        projectId: candidate.project.id,
        projectName: candidate.project.name,
        score: candidate.score,
        reasons: candidate.reasons,
        notified: userIds.length,
      });
      await pushNotifications(
        app.db,
        userIds.map((userId) => ({
          companyId,
          userId,
          projectId: candidate.project.id,
          kind: "system" as const,
          title: `Lesson ${lesson.number} may apply here: ${lesson.title}`,
          body: lesson.recommendation.slice(0, 400),
          recordType: "lesson",
          recordId: lesson.id,
        })),
      );
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "lesson_push",
        objectId: id,
        payload: {
          lessonId: lesson.id,
          lessonNumber: lesson.number,
          projectId: candidate.project.id,
          score: candidate.score,
          notified: userIds.length,
        },
        projectId: candidate.project.id,
        storePayload: true,
      });
    }
    return {
      pushed,
      considered: liveProjects.length,
      skipped: liveProjects.length - scored.length,
      items,
    };
  }

  app.post("/learning/lessons/:lessonId/push", { preHandler: companyWrite }, async (req) => {
    const { lessonId } = req.params as { lessonId: string };
    const body = z
      .object({ limit: z.number().int().min(1).max(50).default(10) })
      .parse(req.body ?? {});
    const lesson = await fetchLesson(lessonId, req.companyId!);
    if (lesson.status !== "published") {
      throw conflict(
        `Only a published lesson can be pushed (this one is ${lesson.status}). Pushing an ` +
          "unvalidated account of what went wrong to other teams is how a rumour becomes policy.",
      );
    }
    const result = await pushLessonToProjects(req.companyId!, lesson, req.user!.id, body.limit);
    return {
      ...result,
      floor: PUSH_SCORE_FLOOR,
      note:
        "Projects already pushed to are never pushed to twice — the record, not a timestamp, is " +
        "what makes that true.",
    };
  });

  app.get("/projects/:projectId/learning/pushes", { preHandler: projectRead }, async (req) => {
    const q = pageQuerySchema
      .extend({ status: z.enum(LESSON_PUSH_STATUSES).optional() })
      .parse(req.query);
    const where = and(
      eq(lessonPushes.companyId, req.companyId!),
      eq(lessonPushes.projectId, req.projectId!),
      q.status ? eq(lessonPushes.status, q.status) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(lessonPushes).where(where);
    const rows = await app.db
      .select()
      .from(lessonPushes)
      .where(where)
      .orderBy(desc(lessonPushes.score), desc(lessonPushes.pushedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const lessonIds = [...new Set(rows.map((r) => r.lessonId))];
    const lessonRows = lessonIds.length
      ? await app.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.companyId, req.companyId!), inArray(lessons.id, lessonIds)))
      : [];
    const byId = new Map(lessonRows.map((l) => [l.id, l]));
    return paginate(
      rows.map((r) => {
        const l = byId.get(r.lessonId);
        return {
          ...r,
          lesson: l
            ? {
                id: l.id,
                number: l.number,
                title: l.title,
                category: l.category,
                recommendation: l.recommendation,
                impactValue: l.impactValue,
                impactCurrency: l.impactCurrency,
              }
            : null,
        };
      }),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post(
    "/projects/:projectId/learning/pushes/:pushId/respond",
    { preHandler: projectStandard },
    async (req) => {
      const { pushId } = req.params as { pushId: string };
      const body = z
        .object({
          status: z.enum(["acknowledged", "dismissed", "applied"]),
          reason: z.string().max(2000).nullable().optional(),
          applicationId: z.string().max(64).nullable().optional(),
        })
        .parse(req.body);
      const [row] = await app.db
        .select()
        .from(lessonPushes)
        .where(
          and(
            eq(lessonPushes.id, pushId),
            eq(lessonPushes.companyId, req.companyId!),
            eq(lessonPushes.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Lesson push not found on this project");
      if (body.status === "dismissed" && !body.reason) {
        throw badRequest(
          "A dismissal without a reason is an unrecorded decision. Say why the lesson does not " +
            "apply here — that answer is itself worth keeping.",
        );
      }
      if (body.status === "applied" && !body.applicationId) {
        throw badRequest(
          "Mark a push applied by naming the lesson application it produced, so the claim is " +
            "backed by a record rather than a checkbox.",
        );
      }
      if (body.applicationId) {
        const [app_] = await app.db
          .select({ id: lessonApplications.id })
          .from(lessonApplications)
          .where(
            and(
              eq(lessonApplications.id, body.applicationId),
              eq(lessonApplications.companyId, req.companyId!),
              eq(lessonApplications.lessonId, row.lessonId),
            ),
          )
          .limit(1);
        if (!app_) throw badRequest("applicationId is not an application of this lesson");
      }
      const now = new Date().toISOString();
      await app.db
        .update(lessonPushes)
        .set({
          status: body.status,
          acknowledgedBy: req.user!.id,
          acknowledgedAt: now,
          dismissedReason: body.status === "dismissed" ? (body.reason ?? null) : row.dismissedReason,
          applicationId: body.applicationId ?? row.applicationId,
        })
        .where(eq(lessonPushes.id, pushId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "lesson_push",
        objectId: pushId,
        payload: { from: row.status, to: body.status, reason: body.reason ?? null },
        projectId: req.projectId!,
        storePayload: true,
      });
      const [after] = await app.db
        .select()
        .from(lessonPushes)
        .where(eq(lessonPushes.id, pushId))
        .limit(1);
      return after ?? row;
    },
  );

  /* ================================================================ */
  /* HEALTH INPUTS — what WP-INTEL reads                               */
  /* ================================================================ */

  /**
   * Organisational learning as a health dimension.
   *
   * The honest metric here is CAPTURE RATE — how many of the events that
   * oblige a lesson actually produced one — and it is refused rather than
   * reported as 100% when nothing has ever triggered. A project with no
   * disputes, claims or delay events has not learned well; it has not been
   * asked to learn at all, and those are different facts.
   */
  app.get(
    "/projects/:projectId/learning/health-inputs",
    { preHandler: projectRead },
    async (req) => {
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const triggerRows = await app.db
        .select()
        .from(lessonTriggers)
        .where(
          and(eq(lessonTriggers.companyId, companyId), eq(lessonTriggers.projectId, projectId)),
        );
      const lessonRows = await app.db
        .select({ id: lessons.id, status: lessons.status, publishedAt: lessons.publishedAt })
        .from(lessons)
        .where(and(eq(lessons.companyId, companyId), eq(lessons.originProjectId, projectId)));
      const applicationRows = await app.db
        .select({ id: lessonApplications.id, outcome: lessonApplications.outcome })
        .from(lessonApplications)
        .where(
          and(
            eq(lessonApplications.companyId, companyId),
            eq(lessonApplications.projectId, projectId),
          ),
        );
      const pushRows = await app.db
        .select({ id: lessonPushes.id, status: lessonPushes.status })
        .from(lessonPushes)
        .where(
          and(eq(lessonPushes.companyId, companyId), eq(lessonPushes.projectId, projectId)),
        );

      const today = todayISO();
      const open = triggerRows.filter((t) => t.status === "open");
      const captured = triggerRows.filter((t) => t.status === "captured");
      const overdue = open.filter((t) => t.dueAt !== null && t.dueAt < today);
      const now = Date.now();
      const oldestOpenDays = open.reduce<number | null>((max, t) => {
        const days = Math.max(0, Math.floor((now - Date.parse(t.raisedAt)) / MS_PER_DAY));
        return max === null || days > max ? days : max;
      }, null);
      const settled = triggerRows.filter(
        (t) => t.status === "captured" || t.status === "dismissed",
      ).length;

      const reasons: string[] = [];
      if (triggerRows.length === 0) {
        reasons.push(
          "No event on this project has yet obliged a lesson, so captureRate is null rather " +
            "than 100%. A project that has never been asked to learn has not learned well.",
        );
      }
      if (applicationRows.length === 0) {
        reasons.push(
          "No lesson has been applied on this project, so appliedLessonsMeasured is 0 and no " +
            "outcome can be reported. An application whose outcome nobody measured must not be " +
            "counted as a success.",
        );
      }
      return {
        metrics: {
          triggersRaised: triggerRows.length,
          triggersOpen: open.length,
          triggersOverdue: overdue.length,
          triggersCaptured: captured.length,
          captureRate:
            settled === 0 ? null : Math.round((captured.length / settled) * 1000) / 10,
          oldestOpenTriggerDays: oldestOpenDays,
          lessonsAuthored: lessonRows.length,
          lessonsPublished: lessonRows.filter((l) => l.status === "published").length,
          lessonsInDraft: lessonRows.filter((l) => l.status === "draft").length,
          lessonsApplied: applicationRows.length,
          appliedLessonsMeasured: applicationRows.filter(
            (a) => a.outcome !== null && a.outcome !== "unknown",
          ).length,
          pushesReceived: pushRows.length,
          pushesUnacknowledged: pushRows.filter((p) => p.status === "pushed").length,
        },
        reasons,
      };
    },
  );

  /* ================================================================ */
  /* KNOWLEDGE GRAPH (#992)                                            */
  /* ================================================================ */

  /**
   * Two lessons are only "see also" when they genuinely overlap. 0.18 is high
   * enough that the pair share subject matter rather than a house style, and
   * three is as many as anybody follows.
   */
  const SEE_ALSO_FLOOR = 0.18;
  const SEE_ALSO_LIMIT = 3;

  async function registerIndex(companyId: string) {
    const { rows, counts } = await publishedRegister(companyId);
    return { rows, counts, index: buildTfIdfIndex(rows.map((l) => toSearchable(l, counts))) };
  }

  async function graphApplications(
    companyId: string,
    lessonId: string,
  ): Promise<GraphApplication[]> {
    const rows = await app.db
      .select()
      .from(lessonApplications)
      .where(
        and(
          eq(lessonApplications.companyId, companyId),
          eq(lessonApplications.lessonId, lessonId),
        ),
      );
    return rows.flatMap((r) => {
      const to = r.appliedTo as Record<string, unknown>;
      const tool = typeof to["tool"] === "string" ? to["tool"] : null;
      const recordId = typeof to["recordId"] === "string" ? to["recordId"] : null;
      if (!tool || !recordId) return [];
      return [
        {
          id: r.id,
          projectId: r.projectId,
          tool,
          recordId,
          label: typeof to["label"] === "string" ? to["label"] : null,
          appliedBy: r.appliedBy,
        },
      ];
    });
  }

  /**
   * Rebuild one lesson's edges from its own fields and store the difference.
   *
   * Every `record` edge is looked up in the table that owns it before it is
   * written: an edge to a dispute that does not exist in this company is
   * stored `verified: 0` with the reason, never silently as a link. Verified
   * project-scoped edges are ALSO mirrored into `record_links`, which is what
   * the rest of the platform reads — so "which lessons came out of this
   * dispute?" is answerable from the dispute's own related-records panel
   * without anything knowing that the learning module exists.
   *
   * Idempotent: running it twice writes nothing the second time.
   */
  async function projectLessonEdges(
    companyId: string,
    lessonId: string,
    actorId: string | null,
    /*
     * The tf-idf index over the published register, when the caller already
     * has one. The nightly projection walks up to 200 lessons per company and
     * rebuilding the index for each of them would be quadratic in the size of
     * the register for no gain — the register does not change mid-sweep.
     */
    preparedIndex?: TfIdfIndex,
  ): Promise<{
    inserted: number;
    deleted: number;
    unchanged: number;
    unverified: Array<{ targetType: string; targetId: string; reason: string }>;
  }> {
    const lesson = await fetchLesson(lessonId, companyId);
    const applications = await graphApplications(companyId, lessonId);

    /* "See also" only makes sense between published lessons: a draft is one
       person's account, not something to send a reader to. */
    let seeAlso: Array<{ lessonId: string; similarity: number }> = [];
    if (lesson.status === "published") {
      const index = preparedIndex ?? (await registerIndex(companyId)).index;
      seeAlso = similarLessons(index, lessonId, {
        floor: SEE_ALSO_FLOOR,
        limit: SEE_ALSO_LIMIT,
      }).map((m) => ({ lessonId: m.lessonId, similarity: m.similarity }));
    }

    const desired = desiredEdges(
      {
        id: lesson.id,
        number: lesson.number,
        title: lesson.title,
        tags: lesson.tags,
        originProjectId: lesson.originProjectId,
        createdBy: lesson.createdBy,
        submittedBy: lesson.submittedBy,
        validatedBy: lesson.validatedBy,
        supersededById: lesson.supersededById,
        evidenceRefs: lesson.evidenceRefs,
      },
      applications,
      seeAlso,
      /* Canonicalise BEFORE the diff — see the note in desiredEdges. */
      { normaliseType: (t) => targetEntryFor(t)?.recordType ?? t },
    );

    const stored = await app.db
      .select()
      .from(lessonEdges)
      .where(and(eq(lessonEdges.companyId, companyId), eq(lessonEdges.lessonId, lessonId)));
    const diff = diffEdges(desired, stored);

    const unverified: Array<{ targetType: string; targetId: string; reason: string }> = [];
    for (const edge of diff.toInsert) {
      let verified = 0;
      let label = edge.targetLabel;
      let targetType = edge.targetType;
      let targetProjectId = edge.targetProjectId;
      let recordLinkId: string | null = null;

      if (edge.edgeKind === "record") {
        const resolved = await resolveTarget(app.db, companyId, edge.targetType, edge.targetId);
        if (resolved) {
          verified = 1;
          targetType = resolved.recordType;
          targetProjectId = resolved.projectId ?? edge.targetProjectId;
          label = resolved.label ?? label;
        } else {
          unverified.push({
            targetType: edge.targetType,
            targetId: edge.targetId,
            reason: targetEntryFor(edge.targetType)
              ? "No record with that id exists in this company"
              : `"${edge.targetType}" is not a record type the graph can resolve`,
          });
        }
      } else if (edge.edgeKind === "person") {
        const [user] = await app.db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, edge.targetId))
          .limit(1);
        if (user) {
          verified = 1;
          label = user.name ?? label;
        }
      } else if (edge.edgeKind === "lesson") {
        const [other] = await app.db
          .select({ id: lessons.id, number: lessons.number, title: lessons.title })
          .from(lessons)
          .where(and(eq(lessons.id, edge.targetId), eq(lessons.companyId, companyId)))
          .limit(1);
        if (other) {
          verified = 1;
          label = label ?? `${other.number} ${other.title}`;
        }
      } else {
        /* A tag is vocabulary: it is verified by construction. */
        verified = 1;
      }

      if (edge.edgeKind === "record" && verified === 1 && targetProjectId) {
        recordLinkId = await mirrorRecordLink(
          companyId,
          targetProjectId,
          lessonId,
          targetType,
          edge.targetId,
          edge.role,
          actorId,
        );
      }

      await app.db.insert(lessonEdges).values({
        id: newId("ledge"),
        companyId,
        lessonId,
        edgeKind: edge.edgeKind,
        targetType,
        targetId: edge.targetId,
        targetLabel: label,
        targetProjectId,
        role: edge.role,
        verified,
        recordLinkId,
        createdBy: actorId,
      });
    }

    if (diff.toDeleteIds.length > 0) {
      const doomed = stored.filter((s) => diff.toDeleteIds.includes(s.id));
      for (const row of doomed) {
        if (row.recordLinkId) {
          await app.db.delete(recordLinks).where(eq(recordLinks.id, row.recordLinkId));
        }
      }
      await app.db.delete(lessonEdges).where(inArray(lessonEdges.id, diff.toDeleteIds));
    }

    return {
      inserted: diff.toInsert.length,
      deleted: diff.toDeleteIds.length,
      unchanged: diff.unchanged,
      unverified,
    };
  }

  /** Mirror a verified edge into record_links, without duplicating one. */
  async function mirrorRecordLink(
    companyId: string,
    projectId: string,
    lessonId: string,
    toType: string,
    toId: string,
    linkKind: string,
    actorId: string | null,
  ): Promise<string | null> {
    const [existing] = await app.db
      .select({ id: recordLinks.id })
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, companyId),
          eq(recordLinks.fromType, "lesson"),
          eq(recordLinks.fromId, lessonId),
          eq(recordLinks.toType, toType),
          eq(recordLinks.toId, toId),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const id = newId("rlink");
    await app.db.insert(recordLinks).values({
      id,
      companyId,
      projectId,
      fromType: "lesson",
      fromId: lessonId,
      toType,
      toId,
      linkKind,
      createdBy: actorId ?? "system:learning",
    });
    return id;
  }

  /**
   * The lesson's graph, as nodes and edges. Grouped by kind because the four
   * kinds answer four different questions and a flat edge list answers none
   * of them well.
   */
  app.get("/learning/lessons/:lessonId/graph", { preHandler: companyScopedRead }, async (req) => {
    const { lessonId } = req.params as { lessonId: string };
    const lesson = await fetchLesson(lessonId, req.companyId!);
    const scope = companyScopeOf(req, "learning");
    /*
     * A PUBLISHED lesson is a tenant asset — the register shows it to anyone
     * who holds the tool anywhere, and hiding its provenance from the same
     * people would make the citation unverifiable while leaving the claim
     * visible. An UNPUBLISHED one is still one project's unvalidated account
     * of what went wrong, naming people, and stays inside that project.
     */
    const owningProject =
      lesson.status === "published" ? null : (lesson.projectId ?? lesson.originProjectId);
    if (!scopeAllows(scope, owningProject)) {
      throw forbidden("This lesson belongs to a project you do not hold the learning tool on");
    }
    const edges = await app.db
      .select()
      .from(lessonEdges)
      .where(and(eq(lessonEdges.companyId, req.companyId!), eq(lessonEdges.lessonId, lessonId)))
      .orderBy(asc(lessonEdges.edgeKind), asc(lessonEdges.role), asc(lessonEdges.targetId));
    const byKind = {
      record: edges.filter((e) => e.edgeKind === "record"),
      person: edges.filter((e) => e.edgeKind === "person"),
      tag: edges.filter((e) => e.edgeKind === "tag"),
      lesson: edges.filter((e) => e.edgeKind === "lesson"),
    };
    const unverified = edges.filter((e) => e.verified === 0);
    return {
      lesson: { id: lesson.id, number: lesson.number, title: lesson.title, status: lesson.status },
      edges,
      byKind,
      counts: {
        total: edges.length,
        record: byKind.record.length,
        person: byKind.person.length,
        tag: byKind.tag.length,
        lesson: byKind.lesson.length,
        unverified: unverified.length,
      },
      resolvableTypes: knownTargetTypes(),
      reason:
        edges.length === 0
          ? "No edges have been projected for this lesson yet. Edges are written when the lesson is published, when it is applied, and by the nightly projection."
          : unverified.length === 0
            ? "Every edge was checked against a real record in this company at the moment it was written."
            : `${unverified.length} edge(s) could not be resolved to a record and are marked unverified — they are shown, not hidden, because a broken pointer is a finding.`,
    };
  });

  /** Re-derive one lesson's edges on demand. Idempotent. */
  app.post(
    "/learning/lessons/:lessonId/graph/rebuild",
    { preHandler: companyWrite },
    async (req) => {
      const { lessonId } = req.params as { lessonId: string };
      const lesson = await fetchLesson(lessonId, req.companyId!);
      const result = await projectLessonEdges(req.companyId!, lessonId, req.user!.id);
      if (result.inserted > 0 || result.deleted > 0) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "lesson",
          objectId: lessonId,
          payload: { graph: result, lessonNumber: lesson.number },
          storePayload: true,
        });
      }
      return result;
    },
  );

  /**
   * THE REVERSE QUESTION (#992).
   *
   * "What did we learn from this?" asked of a record, not of the register.
   * This is the endpoint a dispute, variation or NCR page calls to show the
   * lessons that cite it — the direction nobody builds, and the only one a
   * person standing in front of the record can actually use.
   */
  app.get("/projects/:projectId/learning/for-record", { preHandler: projectRead }, async (req) => {
    const q = z
      .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(64) })
      .parse(req.query);
    const entry = targetEntryFor(q.type);
    const edges = await app.db
      .select()
      .from(lessonEdges)
      .where(
        and(
          eq(lessonEdges.companyId, req.companyId!),
          eq(lessonEdges.edgeKind, "record"),
          eq(lessonEdges.targetType, entry?.recordType ?? q.type),
          eq(lessonEdges.targetId, q.id),
        ),
      );
    const ids = [...new Set(edges.map((e) => e.lessonId))];
    const rows = ids.length
      ? await app.db
          .select()
          .from(lessons)
          .where(and(eq(lessons.companyId, req.companyId!), inArray(lessons.id, ids)))
      : [];
    const byId = new Map(rows.map((l) => [l.id, l]));
    return {
      record: { type: entry?.recordType ?? q.type, id: q.id, resolvable: entry !== null },
      items: edges
        .map((e) => ({ edge: e, lesson: byId.get(e.lessonId) ?? null }))
        .filter((i) => i.lesson !== null),
      total: ids.length,
      reason:
        ids.length === 0
          ? "No lesson cites this record. That is a fact about the register, not about the record."
          : `${ids.length} lesson(s) cite this record as their origin, evidence, or the place they were applied.`,
    };
  });

  /* ================================================================ */
  /* ONBOARDING PACKS (#994)                                           */
  /* ================================================================ */

  async function buildOnboardingPack(companyId: string, projectId: string, limit: number) {
    const [target] = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!target) throw notFound("Project not found");

    const { rows, counts, index } = await registerIndex(companyId);
    const describeTarget = [target.name, target.type ?? "", target.description ?? ""]
      .filter(Boolean)
      .join(". ");
    const similarity = new Map<string, number>();
    if (describeTarget.trim().length > 0) {
      for (const m of semanticMatches(index, describeTarget)) similarity.set(m.lessonId, m.similarity);
    }

    const originIds = [
      ...new Set(rows.map((l) => l.originProjectId).filter((v): v is string => Boolean(v))),
    ];
    const originRows = originIds.length
      ? await app.db
          .select()
          .from(projects)
          .where(and(eq(projects.companyId, companyId), inArray(projects.id, originIds)))
      : [];
    const origins = new Map<string, PackProject>(
      originRows.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.name,
          projectType: p.type,
          stage: p.stage,
          contractValue: p.value,
          currency: p.currency,
        },
      ]),
    );

    const selections = selectOnboardingPack(
      {
        id: target.id,
        name: target.name,
        projectType: target.type,
        stage: target.stage,
        contractValue: target.value,
        currency: target.currency,
      },
      origins,
      rows.map((l) => ({
        lessonId: l.id,
        originProjectId: l.originProjectId,
        category: l.category,
        phase: l.phase,
        impactValue: l.impactValue,
        impactCurrency: l.impactCurrency,
        applicationCount: counts.get(l.id) ?? 0,
        similarity: similarity.get(l.id) ?? null,
      })),
      { limit },
    );

    const byId = new Map(rows.map((l) => [l.id, l]));
    return {
      project: {
        id: target.id,
        name: target.name,
        type: target.type,
        stage: target.stage,
        value: target.value,
        currency: target.currency,
      },
      registerSize: rows.length,
      items: selections.map((s) => ({
        lesson: byId.get(s.lessonId)!,
        score: s.score,
        reasons: s.reasons,
      })),
      selection:
        "Deterministic: same project type, same order of contract value in the same currency, " +
        "same phase, tf-idf similarity to this project's own description, how often the lesson " +
        "has already been applied, and its recorded impact. Every pick carries its reasons.",
      reason:
        rows.length === 0
          ? "The published register is empty, so there is nothing to hand a new team. That is a gap in capture, not an absence of lessons."
          : selections.length === 0
            ? "No published lesson matched this project on type, value band, phase or description. Widening the pack would mean handing a new team a reading list with no reason attached."
            : null,
    };
  }

  /** The deterministic pack. Pure read — no AI, no writes. */
  app.get(
    "/projects/:projectId/learning/onboarding-pack",
    { preHandler: projectRead },
    async (req) => {
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(40).default(12) })
        .parse(req.query);
      return buildOnboardingPack(req.companyId!, req.projectId!, q.limit);
    },
  );

  /**
   * The same pack, narrated. The selection is ALWAYS the deterministic one:
   * the model is asked to introduce lessons it was handed, with citations to
   * their numbers, and never to choose them. With no key configured the
   * endpoint returns the pack and says the narrative is unavailable — it does
   * not fail, because a reading list does not need a model to be useful.
   */
  app.post(
    "/projects/:projectId/learning/onboarding-pack",
    { preHandler: projectStandard },
    async (req) => {
      const body = z
        .object({
          limit: z.coerce.number().int().min(1).max(40).default(12),
          audience: z.string().max(200).nullable().optional(),
        })
        .parse(req.body ?? {});
      const pack = await buildOnboardingPack(req.companyId!, req.projectId!, body.limit);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "project",
        objectId: req.projectId!,
        payload: { onboardingPack: pack.items.map((i) => i.lesson.number), audience: body.audience ?? null },
        projectId: req.projectId!,
      });
      if (pack.items.length === 0) {
        return { ...pack, narrative: null, runId: null, narrativeReason: pack.reason };
      }
      if (!aiEnabled(app)) {
        return {
          ...pack,
          narrative: null,
          runId: null,
          narrativeReason:
            "AI is not configured, so the pack is the deterministic selection with its reasons. Nothing is missing from the list itself.",
        };
      }
      const inputRefs: InputRef[] = pack.items.map((i) => ({ type: "lesson", id: i.lesson.id }));
      try {
        const run = await runAgent({
          app,
          req,
          agentKind: "learning_onboarding_pack",
          projectId: req.projectId!,
          system:
            "You introduce a lessons-learned pack to a team starting a project. Write two to " +
            "four short paragraphs. Use ONLY the numbered lessons supplied; cite each by its " +
            "number in the prose and by {\"type\":\"lesson\",\"id\":\"…\"} in a `citations` array. " +
            "Never invent a lesson, a number or a figure. If the lessons do not cover an obvious " +
            "risk, say that they do not rather than filling the gap.",
          user: [
            `Project: ${pack.project.name} (${pack.project.type ?? "type not recorded"}, stage ${pack.project.stage}).`,
            body.audience ? `Audience: ${body.audience}.` : "",
            "",
            ...pack.items.map(
              (i) =>
                `${i.lesson.number} (type=lesson id=${i.lesson.id}) — ${i.lesson.title}\nWhy selected: ${i.reasons.join(" ")}\nRecommendation: ${i.lesson.recommendation}`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
          inputRefs,
          maxTokens: 1200,
          dataCategories: ["lessons"],
        });
        return {
          ...pack,
          narrative: run.text,
          runId: run.runId,
          citations: run.grounding.citations,
          narrativeReason: null,
        };
      } catch (err) {
        return {
          ...pack,
          narrative: null,
          runId: null,
          narrativeReason: `The narrative could not be produced (${err instanceof Error ? err.message : "unknown error"}). The pack itself is unaffected.`,
        };
      }
    },
  );

  /* ================================================================ */
  /* FEEDBACK INTO THE LIBRARIES (#981-984)                            */
  /* ================================================================ */

  /**
   * Collect measured rates from the CERTIFIED valuations of every live
   * project in the company. A draft valuation is a proposal; only what was
   * certified or paid is outturn. One observation per BQ item — the latest
   * valuation that certified it — so a monthly application does not count the
   * same element eight times and call it a sample of eight.
   */
  async function collectRateSamples(companyId: string): Promise<RateSample[]> {
    const rows = await app.db
      .select({
        lineId: valuationLines.id,
        boqItemId: valuationLines.boqItemId,
        qtyToDate: valuationLines.qtyToDate,
        amountToDate: valuationLines.amountToDate,
        valuationNumber: valuations.number,
        valuationDate: valuations.valuationDate,
        projectId: valuations.projectId,
        currency: valuations.currency,
        code: boqItems.code,
        description: boqItems.description,
        unit: boqItems.unit,
        rate: boqItems.rate,
        itemType: boqItems.itemType,
      })
      .from(valuationLines)
      .innerJoin(valuations, eq(valuations.id, valuationLines.valuationId))
      .innerJoin(boqItems, eq(boqItems.id, valuationLines.boqItemId))
      .where(
        and(
          eq(valuations.companyId, companyId),
          inArray(valuations.status, ["certified", "paid"]),
        ),
      )
      /* Newest first: when the cap bites, the sample it keeps is the recent
         work, not an arbitrary slice of the company's history. */
      .orderBy(desc(valuations.valuationDate))
      .limit(LIBRARY_SCAN_LIMIT);

    const latestByItem = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const seen = latestByItem.get(row.boqItemId);
      if (!seen || row.valuationNumber > seen.valuationNumber) latestByItem.set(row.boqItemId, row);
    }
    const samples: RateSample[] = [];
    for (const row of latestByItem.values()) {
      if (row.itemType !== "measured") continue;
      if (row.qtyToDate === null || row.amountToDate === null) continue;
      samples.push({
        projectId: row.projectId,
        recordId: row.lineId,
        elementCode: row.code,
        description: row.description,
        unit: row.unit,
        currency: row.currency,
        quantity: row.qtyToDate,
        amount: row.amountToDate,
        estimatedRate: row.rate,
        observedAt: row.valuationDate,
      });
    }
    return samples;
  }

  /**
   * Collect achieved durations from completed schedule activities. An
   * activity is only a sample once it has BOTH an actual start and an actual
   * finish: a task in progress has no duration yet, and treating today's date
   * as its finish would teach the library that everything finishes early.
   */
  async function collectDurationSamples(companyId: string): Promise<DurationSample[]> {
    const live = await app.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
    const ids = live.map((p) => p.id);
    if (ids.length === 0) return [];
    const rows = await app.db
      .select({
        id: scheduleTasks.id,
        projectId: scheduleTasks.projectId,
        name: scheduleTasks.name,
        wbsCode: scheduleTasks.wbsCode,
        durationDays: scheduleTasks.durationDays,
        actualStart: scheduleTasks.actualStart,
        actualFinish: scheduleTasks.actualFinish,
        taskType: scheduleTasks.taskType,
      })
      .from(scheduleTasks)
      .where(
        and(
          inArray(scheduleTasks.projectId, ids),
          isNotNull(scheduleTasks.actualStart),
          isNotNull(scheduleTasks.actualFinish),
        ),
      )
      .orderBy(desc(scheduleTasks.actualFinish))
      .limit(LIBRARY_SCAN_LIMIT);
    const samples: DurationSample[] = [];
    for (const row of rows) {
      /* Milestones have no duration and level-of-effort tasks borrow theirs
         from whatever they span; neither is evidence about how long work takes. */
      if (row.taskType !== "task") continue;
      const actualDays = inclusiveDays(row.actualStart, row.actualFinish);
      if (actualDays === null) continue;
      const activityCode = (row.wbsCode ?? "").trim() || normaliseActivityName(row.name);
      if (!activityCode) continue;
      samples.push({
        projectId: row.projectId,
        taskId: row.id,
        activityCode,
        name: row.name,
        plannedDays: row.durationDays,
        actualDays,
        actualStart: row.actualStart,
        actualFinish: row.actualFinish,
      });
    }
    return samples;
  }

  /**
   * Activities without a WBS code are grouped by their normalised name. That
   * is a weaker key than a code and it is stated as such in the entry, but the
   * alternative — ignoring every schedule that was not imported from P6 —
   * would mean most companies never see a duration library at all.
   */
  function normaliseActivityName(name: string): string {
    return name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
  }

  interface LibraryRebuildResult {
    rates: { proposals: number; inserted: number; superseded: number; skipped: number };
    durations: { proposals: number; inserted: number; superseded: number; skipped: number };
    reasons: string[];
  }

  async function rebuildLibraries(
    companyId: string,
    actorId: string | null,
  ): Promise<LibraryRebuildResult> {
    const reasons: string[] = [];
    const now = new Date().toISOString();

    const rateSamples = await collectRateSamples(companyId);
    const rateProposals = buildRateProposals(rateSamples);
    if (rateSamples.length === 0) {
      reasons.push(
        "No certified valuation lines were found, so no rate can be measured. Rates come from " +
          "what was certified, not from what was priced.",
      );
    }
    const rateStats = { proposals: rateProposals.length, inserted: 0, superseded: 0, skipped: 0 };
    for (const proposal of rateProposals) {
      const [existing] = await app.db
        .select()
        .from(rateLibraryEntries)
        .where(
          and(
            eq(rateLibraryEntries.companyId, companyId),
            eq(rateLibraryEntries.elementCode, proposal.elementCode),
            eq(rateLibraryEntries.unit, proposal.unit),
            eq(rateLibraryEntries.currency, proposal.currency),
            inArray(rateLibraryEntries.status, ["proposed", "accepted", "rejected"]),
          ),
        )
        .orderBy(desc(rateLibraryEntries.computedAt))
        .limit(1);
      const verdict = verdictFor(proposal, existing
        ? {
            id: existing.id,
            sampleSize: existing.sampleSize,
            median: existing.medianRate,
            status: existing.status,
          }
        : null);
      if (verdict.action === "skip") {
        rateStats.skipped += 1;
        continue;
      }
      const id = newId("ratelib");
      await app.db.insert(rateLibraryEntries).values({
        id,
        companyId,
        elementCode: proposal.elementCode,
        description: proposal.description,
        unit: proposal.unit,
        currency: proposal.currency,
        sampleSize: proposal.distribution.n,
        medianRate: proposal.distribution.median,
        p80Rate: proposal.distribution.p80,
        meanRate: proposal.distribution.mean,
        minRate: proposal.distribution.min,
        maxRate: proposal.distribution.max,
        estimatedRate: proposal.estimatedRate,
        accuracyRatio: proposal.accuracyRatio,
        sourceProjectIds: proposal.sourceProjectIds,
        samples: proposal.samples,
        status: "proposed",
        note: [proposal.note, ...verdict.reasons].join(" "),
        supersedesId: existing?.id ?? null,
        computedAt: now,
      });
      /*
       * AN ACCEPTED ENTRY STAYS ACCEPTED UNTIL THE REPLACEMENT IS ACCEPTED.
       *
       * Retiring it the moment a fresher sample arrives would empty the
       * library between the sweep and somebody looking at it — the company
       * would be pricing against nothing, silently. Only an unaccepted
       * proposal is replaced outright, because nobody ever agreed to it.
       */
      if (existing && existing.status === "proposed") {
        await app.db
          .update(rateLibraryEntries)
          .set({ status: "superseded", updatedAt: now })
          .where(eq(rateLibraryEntries.id, existing.id));
        rateStats.superseded += 1;
      } else {
        rateStats.inserted += 1;
      }
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "rate_library_entry",
        objectId: id,
        payload: {
          elementCode: proposal.elementCode,
          unit: proposal.unit,
          currency: proposal.currency,
          sampleSize: proposal.distribution.n,
          median: proposal.distribution.median,
          supersedes: existing?.id ?? null,
        },
        storePayload: true,
      });
    }

    const durationSamples = await collectDurationSamples(companyId);
    const durationProposals = buildDurationProposals(durationSamples);
    if (durationSamples.length === 0) {
      reasons.push(
        "No schedule activity has both an actual start and an actual finish, so no duration can " +
          "be measured. A task in progress has not taken any time yet.",
      );
    }
    const durationStats = {
      proposals: durationProposals.length,
      inserted: 0,
      superseded: 0,
      skipped: 0,
    };
    for (const proposal of durationProposals) {
      const [existing] = await app.db
        .select()
        .from(durationLibraryEntries)
        .where(
          and(
            eq(durationLibraryEntries.companyId, companyId),
            eq(durationLibraryEntries.activityCode, proposal.activityCode),
            inArray(durationLibraryEntries.status, ["proposed", "accepted", "rejected"]),
          ),
        )
        .orderBy(desc(durationLibraryEntries.computedAt))
        .limit(1);
      const verdict = verdictFor(proposal, existing
        ? {
            id: existing.id,
            sampleSize: existing.sampleSize,
            median: existing.medianDays,
            status: existing.status,
          }
        : null);
      if (verdict.action === "skip") {
        durationStats.skipped += 1;
        continue;
      }
      const id = newId("durlib");
      await app.db.insert(durationLibraryEntries).values({
        id,
        companyId,
        activityCode: proposal.activityCode,
        description: proposal.description,
        unit: "days",
        sampleSize: proposal.distribution.n,
        medianDays: proposal.distribution.median,
        p80Days: proposal.distribution.p80,
        meanDays: proposal.distribution.mean,
        minDays: proposal.distribution.min,
        maxDays: proposal.distribution.max,
        plannedDays: proposal.plannedDays,
        accuracyRatio: proposal.accuracyRatio,
        sourceProjectIds: proposal.sourceProjectIds,
        samples: proposal.samples,
        status: "proposed",
        note: [proposal.note, ...verdict.reasons].join(" "),
        supersedesId: existing?.id ?? null,
        computedAt: now,
      });
      /* Same rule as rates: an accepted entry is what the company plans
         against and it stands until its replacement is accepted. */
      if (existing && existing.status === "proposed") {
        await app.db
          .update(durationLibraryEntries)
          .set({ status: "superseded", updatedAt: now })
          .where(eq(durationLibraryEntries.id, existing.id));
        durationStats.superseded += 1;
      } else {
        durationStats.inserted += 1;
      }
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "duration_library_entry",
        objectId: id,
        payload: {
          activityCode: proposal.activityCode,
          sampleSize: proposal.distribution.n,
          median: proposal.distribution.median,
          supersedes: existing?.id ?? null,
        },
        storePayload: true,
      });
    }

    return { rates: rateStats, durations: durationStats, reasons };
  }

  const libraryQuery = pageQuerySchema.extend({
    status: z.enum(LIBRARY_ENTRY_STATUSES).optional(),
    code: z.string().max(80).optional(),
  });

  app.get("/learning/libraries/rates", { preHandler: companyScopedRead }, async (req) => {
    const q = libraryQuery.parse(req.query);
    const where = and(
      eq(rateLibraryEntries.companyId, req.companyId!),
      q.status ? eq(rateLibraryEntries.status, q.status) : undefined,
      q.code ? ilike(rateLibraryEntries.elementCode, `%${escapeLike(q.code)}%`) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(rateLibraryEntries).where(where);
    const items = await app.db
      .select()
      .from(rateLibraryEntries)
      .where(where)
      .orderBy(asc(rateLibraryEntries.elementCode), desc(rateLibraryEntries.computedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/learning/libraries/durations", { preHandler: companyScopedRead }, async (req) => {
    const q = libraryQuery.parse(req.query);
    const where = and(
      eq(durationLibraryEntries.companyId, req.companyId!),
      q.status ? eq(durationLibraryEntries.status, q.status) : undefined,
      q.code ? ilike(durationLibraryEntries.activityCode, `%${escapeLike(q.code)}%`) : undefined,
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(durationLibraryEntries)
      .where(where);
    const items = await app.db
      .select()
      .from(durationLibraryEntries)
      .where(where)
      .orderBy(asc(durationLibraryEntries.activityCode), desc(durationLibraryEntries.computedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.post("/learning/libraries/rebuild", { preHandler: companyWrite }, async (req) => {
    const result = await rebuildLibraries(req.companyId!, req.user!.id);
    return result;
  });

  const decisionSchema = z.object({ note: z.string().max(2000).nullable().optional() });

  /**
   * ACCEPTANCE IS THE POINT.
   *
   * The sweep proposes; a person with the authority decides. An accepted entry
   * is what the company will price and plan against, so accepting it is a
   * ledgered act with a name against it — and an entry whose sample the
   * accepter never looked at is exactly what this workflow exists to prevent
   * being invisible.
   */
  app.post(
    "/learning/libraries/rates/:entryId/:decision",
    { preHandler: companyWrite },
    async (req) => {
      const { entryId, decision } = req.params as { entryId: string; decision: string };
      if (decision !== "accept" && decision !== "reject") {
        throw badRequest("Decision must be accept or reject");
      }
      const body = decisionSchema.parse(req.body ?? {});
      const [entry] = await app.db
        .select()
        .from(rateLibraryEntries)
        .where(
          and(
            eq(rateLibraryEntries.id, entryId),
            eq(rateLibraryEntries.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!entry) throw notFound("Rate library entry not found");
      if (entry.status === "superseded") {
        throw conflict("A superseded entry cannot be decided — decide the entry that replaced it");
      }
      if (entry.status !== "proposed") {
        throw conflict(`This entry is already ${entry.status}`);
      }
      const now = new Date().toISOString();
      const status = decision === "accept" ? "accepted" : "rejected";
      await app.db
        .update(rateLibraryEntries)
        .set({
          status,
          acceptedBy: decision === "accept" ? req.user!.id : null,
          acceptedAt: decision === "accept" ? now : null,
          note: body.note ? `${entry.note ?? ""} ${body.note}`.trim() : entry.note,
          updatedAt: now,
        })
        .where(eq(rateLibraryEntries.id, entryId));
      /* The entry this one replaces is retired HERE — at acceptance — so the
         library never has a gap between the sweep and the decision. */
      if (decision === "accept" && entry.supersedesId) {
        await app.db
          .update(rateLibraryEntries)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(rateLibraryEntries.id, entry.supersedesId),
              eq(rateLibraryEntries.companyId, req.companyId!),
            ),
          );
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "rate_library_entry",
        objectId: entryId,
        payload: {
          from: entry.status,
          to: status,
          elementCode: entry.elementCode,
          sampleSize: entry.sampleSize,
          median: entry.medianRate,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const [updated] = await app.db
        .select()
        .from(rateLibraryEntries)
        .where(eq(rateLibraryEntries.id, entryId))
        .limit(1);
      return updated;
    },
  );

  app.post(
    "/learning/libraries/durations/:entryId/:decision",
    { preHandler: companyWrite },
    async (req) => {
      const { entryId, decision } = req.params as { entryId: string; decision: string };
      if (decision !== "accept" && decision !== "reject") {
        throw badRequest("Decision must be accept or reject");
      }
      const body = decisionSchema.parse(req.body ?? {});
      const [entry] = await app.db
        .select()
        .from(durationLibraryEntries)
        .where(
          and(
            eq(durationLibraryEntries.id, entryId),
            eq(durationLibraryEntries.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!entry) throw notFound("Duration library entry not found");
      if (entry.status === "superseded") {
        throw conflict("A superseded entry cannot be decided — decide the entry that replaced it");
      }
      if (entry.status !== "proposed") {
        throw conflict(`This entry is already ${entry.status}`);
      }
      const now = new Date().toISOString();
      const status = decision === "accept" ? "accepted" : "rejected";
      await app.db
        .update(durationLibraryEntries)
        .set({
          status,
          acceptedBy: decision === "accept" ? req.user!.id : null,
          acceptedAt: decision === "accept" ? now : null,
          note: body.note ? `${entry.note ?? ""} ${body.note}`.trim() : entry.note,
          updatedAt: now,
        })
        .where(eq(durationLibraryEntries.id, entryId));
      if (decision === "accept" && entry.supersedesId) {
        await app.db
          .update(durationLibraryEntries)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(durationLibraryEntries.id, entry.supersedesId),
              eq(durationLibraryEntries.companyId, req.companyId!),
            ),
          );
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "duration_library_entry",
        objectId: entryId,
        payload: {
          from: entry.status,
          to: status,
          activityCode: entry.activityCode,
          sampleSize: entry.sampleSize,
          median: entry.medianDays,
          note: body.note ?? null,
        },
        storePayload: true,
      });
      const [updated] = await app.db
        .select()
        .from(durationLibraryEntries)
        .where(eq(durationLibraryEntries.id, entryId))
        .limit(1);
      return updated;
    },
  );

  /**
   * ESTIMATE ACCURACY, PUBLISHED (#983).
   *
   * The company's own optimism bias, measured from its own outturn. Entries
   * with no recorded estimate are counted separately and never treated as
   * accurate — "we cannot tell" is the honest answer, and it is the one most
   * companies deserve at first.
   */
  app.get("/learning/libraries/accuracy", { preHandler: companyScopedRead }, async (req) => {
    const rateRows = await app.db
      .select({ accuracyRatio: rateLibraryEntries.accuracyRatio })
      .from(rateLibraryEntries)
      .where(
        and(
          eq(rateLibraryEntries.companyId, req.companyId!),
          inArray(rateLibraryEntries.status, ["proposed", "accepted"]),
        ),
      );
    const durationRows = await app.db
      .select({ accuracyRatio: durationLibraryEntries.accuracyRatio })
      .from(durationLibraryEntries)
      .where(
        and(
          eq(durationLibraryEntries.companyId, req.companyId!),
          inArray(durationLibraryEntries.status, ["proposed", "accepted"]),
        ),
      );
    const realisations = await app.db
      .select()
      .from(riskRealisations)
      .where(eq(riskRealisations.companyId, req.companyId!))
      .limit(1000);
    return {
      rates: accuracyMetric(
        "rates",
        rateRows.map((r) => r.accuracyRatio),
      ),
      durations: accuracyMetric(
        "durations",
        durationRows.map((r) => r.accuracyRatio),
      ),
      riskRealisation: realisationStats(
        realisations.map((r) => ({
          category: r.category,
          predictedProbability: r.predictedProbability,
          predictedImpact: r.predictedImpact,
          predictedCurrency: r.predictedCurrency,
          realisedImpact: r.realisedImpact,
          realisedCurrency: r.realisedCurrency,
        })),
      ),
      basis:
        "Accuracy is median outturn ÷ recorded estimate − 1 per library entry. Positive means " +
        "the estimate was optimistic. Superseded and rejected entries are excluded.",
    };
  });

  /* ---------------------------------------------------------------- */
  /* Risk realisation (#984)                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Record what a realised risk actually cost. The prediction is copied from
   * the register AT THE MOMENT OF REALISATION rather than read back later,
   * because a register that gets edited after the event cannot be used to
   * measure how well it predicted it.
   */
  const realisationSchema = z.object({
    riskId: z.string().min(1).max(64),
    realisedAt: isoDate.nullable().optional(),
    realisedImpact: z.number().finite().nullable().optional(),
    realisedCurrency: z.string().min(3).max(8).nullable().optional(),
    realisedDays: z.number().int().min(-10_000).max(10_000).nullable().optional(),
    sourceType: z.string().max(60).nullable().optional(),
    sourceId: z.string().max(64).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  });

  app.post(
    "/projects/:projectId/learning/risk-realisations",
    { preHandler: projectStandard },
    async (req, reply) => {
      const body = realisationSchema.parse(req.body);
      const [risk] = await app.db
        .select()
        .from(risks)
        .where(
          and(
            eq(risks.id, body.riskId),
            eq(risks.companyId, req.companyId!),
            eq(risks.projectId, req.projectId!),
          ),
        )
        .limit(1);
      if (!risk) throw notFound("Risk not found on this project");
      const [project] = await app.db
        .select({ currency: projects.currency })
        .from(projects)
        .where(eq(projects.id, req.projectId!))
        .limit(1);
      const sourceType = body.sourceType ?? "manual";
      const sourceId = body.sourceId ?? risk.id;
      const [existing] = await app.db
        .select({ id: riskRealisations.id })
        .from(riskRealisations)
        .where(
          and(
            eq(riskRealisations.riskId, risk.id),
            eq(riskRealisations.sourceType, sourceType),
            eq(riskRealisations.sourceId, sourceId),
          ),
        )
        .limit(1);
      if (existing) {
        throw conflict(
          "This risk has already been recorded as realised against that source. Realisation is " +
            "a fact about one event; a second event is a second source.",
        );
      }
      const id = newId("rreal");
      await app.db.insert(riskRealisations).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        riskId: risk.id,
        riskReference: `R-${risk.number}`,
        category: risk.category,
        title: risk.title,
        predictedProbability:
          risk.occurrenceProbability ?? (risk.probabilityScore ? risk.probabilityScore / 5 : null),
        predictedImpact: centralImpact(risk.costImpact),
        predictedCurrency: project?.currency ?? null,
        realisedAt: body.realisedAt ?? todayISO(),
        realisedImpact: body.realisedImpact ?? null,
        realisedCurrency: body.realisedCurrency ?? project?.currency ?? null,
        realisedDays: body.realisedDays ?? null,
        sourceType,
        sourceId,
        note: body.note ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "risk_realisation",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          riskId: risk.id,
          category: risk.category,
          realisedImpact: body.realisedImpact ?? null,
          sourceType,
          sourceId,
        },
        storePayload: true,
      });
      const [row] = await app.db
        .select()
        .from(riskRealisations)
        .where(eq(riskRealisations.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get("/learning/risk-realisations", { preHandler: companyScopedRead }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const scope = companyScopeOf(req, "learning");
    const where = and(
      eq(riskRealisations.companyId, req.companyId!),
      scopeProjects(scope, riskRealisations.projectId),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(riskRealisations).where(where);
    const items = await app.db
      .select()
      .from(riskRealisations)
      .where(where)
      .orderBy(desc(riskRealisations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      stats: realisationStats(
        items.map((r) => ({
          category: r.category,
          predictedProbability: r.predictedProbability,
          predictedImpact: r.predictedImpact,
          predictedCurrency: r.predictedCurrency,
          realisedImpact: r.realisedImpact,
          realisedCurrency: r.realisedCurrency,
        })),
      ),
    };
  });

  /**
   * Sweep risks the register itself says have been realised, so the feedback
   * loop does not depend on somebody remembering to press a button. The
   * prediction is captured as it stands now; the realised impact stays null
   * until a person records it, and null is reported as null.
   */
  async function sweepRiskRealisations(companyId: string, actorId: string | null) {
    const rows = await app.db
      .select({
        risk: risks,
        currency: projects.currency,
      })
      .from(risks)
      .innerJoin(projects, eq(projects.id, risks.projectId))
      .where(
        and(
          eq(risks.companyId, companyId),
          eq(risks.status, "realised"),
          isNull(projects.deletedAt),
        ),
      )
      .limit(500);
    let created = 0;
    for (const { risk, currency } of rows) {
      const [existing] = await app.db
        .select({ id: riskRealisations.id })
        .from(riskRealisations)
        .where(
          and(
            eq(riskRealisations.riskId, risk.id),
            eq(riskRealisations.sourceType, "risk_status"),
            eq(riskRealisations.sourceId, risk.id),
          ),
        )
        .limit(1);
      if (existing) continue;
      const id = newId("rreal");
      await app.db.insert(riskRealisations).values({
        id,
        companyId,
        projectId: risk.projectId,
        riskId: risk.id,
        riskReference: `R-${risk.number}`,
        category: risk.category,
        title: risk.title,
        predictedProbability:
          risk.occurrenceProbability ?? (risk.probabilityScore ? risk.probabilityScore / 5 : null),
        predictedImpact: centralImpact(risk.costImpact),
        predictedCurrency: currency,
        realisedAt: todayISO(),
        realisedImpact: null,
        realisedCurrency: currency,
        realisedDays: null,
        sourceType: "risk_status",
        sourceId: risk.id,
        note: "Captured automatically when the register marked the risk realised. The realised impact has not been recorded.",
        createdBy: actorId,
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "risk_realisation",
        objectId: id,
        projectId: risk.projectId,
        payload: { riskId: risk.id, category: risk.category, source: "risk_status" },
        storePayload: true,
      });
      created += 1;
    }
    return { scanned: rows.length, created };
  }

  /* ================================================================ */
  /* SCHEDULED JOBS                                                    */
  /* ================================================================ */

  app.scheduler.register({
    name: "learning.capture-triggers",
    description:
      "Scan every live project for events that make lesson capture mandatory (disputes, claims, delay events, threshold variations, confirmed signals, gate reviews, closeout) and raise the trigger and its obligation — the sweep that used to run only when somebody opened the Triggers tab, under whichever reader's name",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const live = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
        let created = 0;
        let scanned = 0;
        for (const project of live) {
          const result = await sweepProjectTriggers(companyId, project.id, null);
          created += result.created;
          scanned += result.scanned;
        }
        return { projects: live.length, scanned, created };
      }),
  });

  app.scheduler.register({
    name: "learning.relevance-push",
    description:
      "Push newly published lessons to the projects the deterministic ranker says they apply to, so retrieval does not wait to be searched for",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const published = await db
          .select()
          .from(lessons)
          .where(and(eq(lessons.companyId, companyId), eq(lessons.status, "published")))
          .orderBy(desc(lessons.publishedAt))
          .limit(50);
        let pushed = 0;
        for (const lesson of published) {
          const result = await pushLessonToProjects(companyId, lesson, null, 10);
          pushed += result.pushed;
        }
        return { lessons: published.length, pushed };
      }),
  });

  app.scheduler.register({
    name: "learning.knowledge-graph",
    description:
      "Re-derive the edges of recently changed lessons: verify every evidence reference against the record it names, mirror the verified ones into record_links so a dispute can show what was learned from it, and remove edges whose target has gone",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const recent = await db
          .select({ id: lessons.id })
          .from(lessons)
          .where(eq(lessons.companyId, companyId))
          .orderBy(desc(lessons.updatedAt))
          .limit(GRAPH_PROJECTION_BATCH);
        let inserted = 0;
        let deleted = 0;
        let unverified = 0;
        /* One index for the whole batch: the register is not moving while the
           sweep runs, and rebuilding it per lesson would be quadratic. */
        const { index } = await registerIndex(companyId);
        for (const row of recent) {
          const result = await projectLessonEdges(companyId, row.id, null, index);
          inserted += result.inserted;
          deleted += result.deleted;
          unverified += result.unverified.length;
        }
        return { lessons: recent.length, inserted, deleted, unverified };
      }),
  });

  app.scheduler.register({
    name: "learning.libraries",
    description:
      "Rebuild the rate and duration libraries from certified valuations and completed schedule activities, and capture risks the register has marked realised — the feedback loop that turns finished work into the next estimate instead of leaving it in the projects that produced it",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) =>
      forEachCompany(db, async (companyId) => {
        const realisations = await sweepRiskRealisations(companyId, null);
        const libraries = await rebuildLibraries(companyId, null);
        return {
          rateProposals: libraries.rates.proposals,
          durationProposals: libraries.durations.proposals,
          realisationsCaptured: realisations.created,
        };
      }),
  });

};
