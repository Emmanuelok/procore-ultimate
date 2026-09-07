/**
 * modules/ai — the AI agent fleet, its governance and its audit trail.
 *
 * Spec: Vol I §6.4 #759–#775; Vol II Domain X #995–#1027.
 *
 * WHAT IS HERE
 *   · the seven original agents, each on its own route (search, RFI
 *     evaluation, submittal review, daily-log draft, sheet naming, photo
 *     intelligence, assistant);
 *   · the fleet: eighteen declarative agents run through one governed runner
 *     (registry.ts → runner.ts → agents/*);
 *   · the human-in-the-loop review queue, now ATOMIC, state-machine-respecting
 *     and REVERSIBLE (actions.ts);
 *   · per-kind authorisation limits and a daily cost ceiling (policy.ts);
 *   · schedules with a platform scheduler job (schedules.ts);
 *   · the transparency surface: run detail with full provenance, model
 *     inventory, usage, and the adversarial / bias / validation reports
 *     (reports.ts).
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   · the daily briefing (modules/intelligence owns it and calls runAgent);
 *   · automation rules (modules/automation);
 *   · detector implementations (modules/assurance) — the integrity agents
 *     read what the detectors produced, they do not re-detect.
 *
 * AUTHORISATION NOTE. Two rules, applied everywhere:
 *
 *  1. Company-wide lists (/ai/runs, /ai/review, /agents/*) are filtered to
 *     the projects the caller can actually read (visibility.ts) and never
 *     return prompts, model output, proposals or before/after images in a
 *     list. Content comes only from a detail route. A company-scoped row
 *     belongs to a run only an owner/admin could have started, so it is
 *     listed and shown only to an owner/admin (or, for a run, its requester).
 *
 *  2. `ai:standard` is never a gate on OTHER modules' data. Every agent
 *     declares the tools that own the tables it reads (`requiredTools`), and
 *     they are enforced at "read" on the run's project before it gathers;
 *     a legacy single-shot route that reads several modules gates on its
 *     primary record's tool and DROPS a secondary source the caller may not
 *     read, reporting the omission instead of quietly including it. Reading a
 *     run back is gated by the tools its recorded inputRefs belong to, and a
 *     queue proposal by the tool that owns the data its body quotes.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, gte, ilike, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  agentActions,
  agentReports,
  agentSchedules,
  aiReviewQueue,
  aiRuns,
  dailyLogs,
  drawingPins,
  drawingRevisions,
  drawingSheets,
  files,
  photos,
  projects,
  punchItems,
  recordLinks,
  rfis,
  signals,
  specSectionRevisions,
  specSections,
  submittals,
} from "@constructos/db";
import {
  AGENT_AUTHORISATIONS,
  AGENT_REPORT_KINDS,
  COMPANY_ROLES,
  DRAWING_DISCIPLINES,
  SIGNAL_SEVERITIES,
  SUBMITTAL_RESPONSES,
  type PermissionLevel,
  type ToolKey,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import {
  claimReviewItem,
  recordAgentAction,
  revertAction,
  type ActionRow,
  type ReviewRow,
} from "./actions.js";
import { effectiveConfidence } from "./evidence.js";
import {
  budgetVerdict,
  loadEffectivePolicies,
  loadEffectivePolicy,
  readUsage,
  savePolicy,
  usageDate,
} from "./policy.js";
import {
  AGENT_INVENTORY,
  getAgentDefinition,
  isKnownAgentKind,
  KNOWN_AGENT_KINDS,
} from "./registry.js";
import { buildBiasReport, buildValidationReport, runAdversarialSuite } from "./reports.js";
import { applyReviewItem, createProposal, executeAgent } from "./runner.js";
import { loadRunMeta, loadRunMetaMany } from "./run-meta.js";
import {
  createSchedule,
  listSchedules,
  registerAgentJobs,
  runDueSchedules,
  runSchedule,
  staleCutoff,
  STALE_REVIEW_DAYS,
} from "./schedules.js";
import {
  aiDisabledError,
  aiEnabled,
  escapeLike,
  renderSnippets,
  runAgent,
  snippetAround,
  streamToBuffer,
  type InputRef,
  type SearchCandidate,
} from "./service.js";
import { targetTool, toolsForRefs } from "./tools.js";
import { canSeeProject, visibleProjectIds } from "./visibility.js";

/* ------------------------------------------------------------------ */
/* Request schemas                                                     */
/* ------------------------------------------------------------------ */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const searchBodySchema = z.object({ query: z.string().min(2).max(500) });
const dailyLogBodySchema = z.object({ date: isoDate });
const rfiEvalBodySchema = z.object({ rfiId: z.string().min(1).max(64) });
const submittalBodySchema = z.object({ submittalId: z.string().min(1).max(64) });
const sheetNameBodySchema = z.object({ revisionId: z.string().min(1).max(64) });
const photoIntelBodySchema = z.object({ photoId: z.string().min(1).max(64) });
const assistBodySchema = z.object({ message: z.string().min(1).max(4000) });
const rejectBodySchema = z.object({ reason: z.string().max(2000).optional() });
const revertBodySchema = z.object({ reason: z.string().max(2000).optional() });

const reviewStatus = z.enum(["pending", "approved", "rejected", "superseded", "reverted"]);

const reviewListQuerySchema = pageQuerySchema.extend({
  status: reviewStatus.optional(),
  targetType: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  /** ?stale=1 lists the pending items past the staleness window */
  stale: z.enum(["0", "1"]).optional(),
});

const agentKindQuery = z
  .string()
  .max(64)
  .refine((k) => isKnownAgentKind(k), { message: "Unknown agent kind" });

const runsQuerySchema = pageQuerySchema.extend({
  projectId: z.string().max(64).optional(),
  agentKind: agentKindQuery.optional(),
  status: z.enum(["succeeded", "failed", "refused"]).optional(),
});

const actionsQuerySchema = pageQuerySchema.extend({
  projectId: z.string().max(64).optional(),
  agentKind: agentKindQuery.optional(),
  status: z.enum(["applied", "rolled_back", "failed", "not_reversible"]).optional(),
});

const runAgentBodySchema = z.object({
  projectId: z.string().min(1).max(64).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

const projectRunAgentBodySchema = z.object({
  params: z.record(z.string(), z.unknown()).default({}),
});

const policyBodySchema = z.object({
  enabled: z.boolean().optional(),
  authorisation: z.enum(AGENT_AUTHORISATIONS).optional(),
  autoApplyMinConfidence: z.number().min(0).max(1).nullable().optional(),
  minConfidence: z.number().min(0).max(1).nullable().optional(),
  allowedTargetTypes: z.array(z.string().max(64)).max(40).optional(),
  // A real company role, not free text: a policy naming a role that cannot
  // exist would silently lock every caller out of the agent.
  allowedRoles: z.array(z.enum(COMPANY_ROLES)).max(COMPANY_ROLES.length).optional(),
  maxRunsPerDay: z.number().int().min(0).max(100_000).nullable().optional(),
  maxInputTokensPerDay: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  maxOutputTokensPerDay: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const scheduleBodySchema = z.object({
  agentKind: agentKindQuery,
  projectId: z.string().min(1).max(64).nullable().optional(),
  name: z.string().max(200).optional(),
  everyMinutes: z.coerce.number().int().min(15).max(60 * 24 * 30).default(1440),
  params: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

const schedulePatchSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  everyMinutes: z.coerce.number().int().min(15).max(60 * 24 * 30).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const reportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const usageQuerySchema = z.object({
  date: isoDate.optional(),
});

/* ------------------------------------------------------------------ */
/* Agent output schemas (legacy seven)                                 */
/* ------------------------------------------------------------------ */

/**
 * `confidence` stays optional on the seven legacy agents so existing clients
 * and existing queue rows keep working; the fleet requires it (see
 * agents/schemas.ts). Where it is absent the platform records "not stated"
 * rather than assuming certainty.
 */
const confidence = z.number().min(0).max(1).optional().catch(undefined);

const citationList = z
  .array(
    z.object({
      ref: z.number().int().optional(),
      type: z.string(),
      id: z.string(),
      excerpt: z.string().max(2000).optional(),
    }),
  )
  .default([])
  .catch([]);

const searchResultSchema = z.object({
  answer: z.string().nullable(),
  citations: citationList,
  confidence,
});

const dailyLogDraftSchema = z.object({
  summary: z.string().min(1).max(1000),
  sections: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(10_000).optional(),
  weather: z.record(z.string(), z.unknown()).optional(),
  confidence,
});

const impact = z.enum(["yes", "no", "tbd"]).catch("tbd");

const rfiEvaluationSchema = z.object({
  suggestedResponse: z.string().min(1).max(20_000),
  costImpact: impact,
  scheduleImpact: impact,
  scheduleImpactDays: z.number().int().min(0).max(10_000).optional().catch(undefined),
  reasoning: z.string().max(10_000).optional(),
  citations: citationList,
  confidence,
});

const submittalReviewSchema = z.object({
  recommendation: z.enum(SUBMITTAL_RESPONSES),
  findings: z
    .array(
      z.object({
        item: z.string().min(1).max(500),
        severity: z.string().max(40),
        clauseRef: z.string().max(120).optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .default([])
    .catch([]),
  deviations: z.array(z.string().max(500)).max(30).default([]).catch([]),
  missingItems: z.array(z.string().max(500)).max(30).default([]).catch([]),
  reasoning: z.string().max(10_000).optional(),
  citations: citationList,
  confidence,
});

const sheetNameSchema = z.object({
  number: z.string().min(1).max(50),
  title: z.string().min(1).max(300),
  discipline: z.enum(DRAWING_DISCIPLINES).catch("other"),
  confidence,
});

const photoIntelSchema = z.object({
  tags: z.array(z.string().min(1).max(60)).max(40).default([]).catch([]),
  progressSummary: z.string().max(5000).optional(),
  safetySignals: z
    .array(
      z.object({
        issue: z.string().min(1).max(500),
        severity: z.enum(SIGNAL_SEVERITIES).catch("medium"),
      }),
    )
    .default([])
    .catch([]),
  confidence,
});

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Largest attachment passed to the model as a document block. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 3;

/**
 * The UTC offset an IANA zone is on at a given instant, or null when the zone
 * is unknown. Uses Intl, which Node ships with full tz data — no dependency.
 */
export function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(at);
    const get = (type: string): number => {
      const raw = parts.find((p) => p.type === type)?.value;
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    };
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    if (!Number.isFinite(asUtc)) return null;
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/**
 * The UTC window covering one PROJECT-LOCAL calendar day.
 *
 * This used to be hard-coded to UTC, which put a UTC+10 project's afternoon
 * activity in the next day's draft and a UTC-7 project's morning in the
 * previous one. The offset comes from the project's recorded timezone; with
 * none recorded the behaviour is the old one, stated rather than assumed.
 */
export function dayRange(date: string, offsetMinutes = 0): { start: string; end: string } {
  const localMidnightUtcMs = Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000;
  return {
    start: new Date(localMidnightUtcMs).toISOString(),
    end: new Date(localMidnightUtcMs + 86_400_000 - 1).toISOString(),
  };
}

/** Round-robin so a saturated type cannot starve the others (#candidate cap). */
export function interleave<T>(groups: T[][], limit: number): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < longest && out.length < limit; i += 1) {
    for (const group of groups) {
      if (out.length >= limit) break;
      const item = group[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** Re-exported so the module's public surface is unchanged. */
export { refTool, targetTool, toolsForRefs } from "./tools.js";

/** List projections: a list never carries prompts, outputs or proposals. */
function runListView(row: typeof aiRuns.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    agentKind: row.agentKind,
    model: row.model,
    requestedBy: row.requestedBy,
    status: row.status,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    error: row.error ? row.error.slice(0, 300) : null,
    inputRefCount: (row.inputRefs ?? []).length,
    citationCount: (row.citations ?? []).length,
    createdAt: row.createdAt,
  };
}

/**
 * Action projections: an action's before/after image IS the operational
 * record content it moved — an RFI's official response, a daily log's
 * sections, a photo's tags, a budget-quoting comment. A list gated at
 * `ai:read` must not carry it; the detail route below re-resolves the tool
 * that owns the target and only then hands the images over.
 */
function actionListView(row: ActionRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    agentKind: row.agentKind,
    runId: row.runId,
    reviewId: row.reviewId,
    actionType: row.actionType,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status,
    reversible: row.reversible,
    irreversibleReason: row.irreversibleReason,
    authorisation: row.authorisation,
    policyId: row.policyId,
    confidence: row.confidence,
    summary: row.summary,
    appliedBy: row.appliedBy,
    appliedAt: row.appliedAt,
    rolledBackBy: row.rolledBackBy,
    rolledBackAt: row.rolledBackAt,
    rollbackReason: row.rollbackReason,
    hasBeforeImage: row.beforeImage !== null && row.beforeImage !== undefined,
    hasAfterImage: row.afterImage !== null && row.afterImage !== undefined,
    createdAt: row.createdAt,
  };
}

function reviewListView(row: ReviewRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    runId: row.runId,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    confidence: row.confidence,
    status: row.status,
    reviewerId: row.reviewerId,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const aiModule: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];
  const aiStandard = [...companyGate, app.requireTool("ai", "standard")];
  const aiRead = [...companyGate, app.requireTool("ai", "read")];

  function requireAi(): void {
    if (!aiEnabled(app)) throw aiDisabledError();
  }

  /** Enforce a tool level on a project that is NOT in the route params. */
  async function requireProjectTool(
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    tool: ToolKey,
    level: PermissionLevel,
  ): Promise<void> {
    (req.params as Record<string, string>).projectId = projectId;
    await app.requireTool(tool, level)(req, reply);
  }

  /**
   * Non-throwing form of the same check.
   *
   * A grounded agent reads SEVERAL tables. Refusing the whole run because the
   * caller lacks one of them would be worse than useless (a superintendent
   * with no `punch` access would lose the daily-log drafter entirely), and
   * quietly putting the rows in the prompt anyway is the leak this wave
   * closed everywhere else. So the secondary sources are dropped per source
   * and the omission is REPORTED — the reader is told what the agent was not
   * allowed to look at, rather than being handed a confident answer over a
   * silently narrower evidence base.
   */
  async function holdsProjectTool(
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    tool: ToolKey,
    level: PermissionLevel = "read",
  ): Promise<boolean> {
    try {
      await requireProjectTool(req, reply, projectId, tool, level);
      return true;
    } catch {
      return false;
    }
  }

  async function heldTools(
    req: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    tools: ToolKey[],
  ): Promise<Set<ToolKey>> {
    const held = new Set<ToolKey>();
    for (const tool of tools) {
      if (await holdsProjectTool(req, reply, projectId, tool)) held.add(tool);
    }
    return held;
  }

  /** Guests never act on AI proposals, whatever the target. */
  function refuseGuest(req: FastifyRequest): void {
    if (req.companyRole === "guest") throw forbidden("Guests cannot act on AI proposals");
  }

  async function projectOffset(companyId: string, projectId: string): Promise<number> {
    const [row] = await app.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    const tz = settings["timezone"];
    if (typeof tz === "string" && tz) {
      const offset = tzOffsetMinutes(tz, new Date());
      if (offset !== null) return offset;
    }
    const raw = settings["utcOffsetMinutes"];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  }

  /**
   * Queue one proposal from a legacy agent through the same governed path the
   * fleet uses: supersede stale siblings, damp the confidence by the evidence
   * actually supplied, ledger it, and auto-apply only where policy allows.
   */
  async function queueProposal(
    req: FastifyRequest,
    args: {
      runId: string;
      agentKind: string;
      projectId: string | null;
      targetType: string;
      targetId: string | null;
      proposal: Record<string, unknown>;
      summary: string;
      modelConfidence: number | null;
      evidenceScore: number | null;
      droppedCitations: number;
    },
  ) {
    const policy = await loadEffectivePolicy(app, req.companyId!, args.agentKind);
    const created = await createProposal({
      app,
      companyId: req.companyId!,
      projectId: args.projectId,
      actorId: req.user!.id,
      runId: args.runId,
      agentKind: args.agentKind,
      targetType: args.targetType,
      targetId: args.targetId,
      proposal: { ...args.proposal, runId: args.runId, agentKind: args.agentKind },
      summary: args.summary,
      modelConfidence: args.modelConfidence,
      evidenceScore: args.evidenceScore,
      droppedCitations: args.droppedCitations,
      policy,
    });
    return {
      id: created.reviewId,
      runId: args.runId,
      targetType: args.targetType,
      targetId: args.targetId,
      proposal: args.proposal,
      summary: args.summary.slice(0, 500),
      confidence: created.confidence,
      status:
        created.status === "auto_applied"
          ? ("approved" as const)
          : created.status === "filtered"
            ? ("filtered" as const)
            : ("pending" as const),
      autoApplied: created.status === "auto_applied",
      superseded: created.superseded,
      reason: created.reason,
    };
  }

  /* ================================================================ */
  /* /search — grounded document search with citations (#759-762)      */
  /* ================================================================ */

  /**
   * Collect grounded candidates for the search agent.
   *
   * `drawing_revisions.extracted_text` has no trigram or tsvector index (it
   * belongs to the drawings module), so an ILIKE over it is a sequential scan
   * of every OCR'd page in the project. At production drawing volumes that is
   * a connection-pool hazard, so the scan is BOUNDED rather than pretended
   * away: it runs only for a query long enough to be selective, and only when
   * the cheap sources have not already produced enough evidence. What was and
   * was not searched is returned to the caller and shown in the UI, because a
   * search that quietly skipped half the project is worse than a slow one.
   *
   * The real fix is an index — see the deployment note in the module report.
   */
  const OCR_MIN_QUERY = 4;
  const OCR_SKIP_ABOVE = 15;

  async function collectSearchCandidates(
    companyId: string,
    projectId: string,
    query: string,
    /**
     * The tools the caller actually holds on this project. Every source the
     * search reads is owned by one of them, and the answer quotes the rows
     * verbatim, so a source the caller may not read is not scanned and the
     * omission is reported in `skipped` rather than silently included.
     */
    allowed: Set<ToolKey>,
  ): Promise<{ candidates: SearchCandidate[]; coverage: string[]; skipped: string[] }> {
    const pattern = `%${escapeLike(query)}%`;
    const empty = Promise.resolve([] as never[]);

    const [fileRows, rfiRows, submittalRows] = await Promise.all([
      !allowed.has("documents") ? empty : app.db
        .select({ id: files.id, name: files.name })
        .from(files)
        .where(
          and(
            eq(files.companyId, companyId),
            eq(files.projectId, projectId),
            ilike(files.name, pattern),
          ),
        )
        .limit(10),
      !allowed.has("rfis") ? empty : app.db
        .select({
          id: rfis.id,
          number: rfis.number,
          subject: rfis.subject,
          question: rfis.question,
          officialResponse: rfis.officialResponse,
        })
        .from(rfis)
        .where(
          and(
            eq(rfis.companyId, companyId),
            eq(rfis.projectId, projectId),
            or(
              ilike(rfis.subject, pattern),
              ilike(rfis.question, pattern),
              ilike(rfis.officialResponse, pattern),
            ),
          ),
        )
        .limit(10),
      !allowed.has("submittals") ? empty : app.db
        .select({
          id: submittals.id,
          number: submittals.number,
          title: submittals.title,
          specSection: submittals.specSection,
        })
        .from(submittals)
        .where(
          and(
            eq(submittals.companyId, companyId),
            eq(submittals.projectId, projectId),
            or(ilike(submittals.title, pattern), ilike(submittals.specSection, pattern)),
          ),
        )
        .limit(10),
    ]);

    const cheapCount = fileRows.length + rfiRows.length + submittalRows.length;
    const coverage: string[] = [];
    const skipped: string[] = [];
    for (const [type, tool] of [
      ["rfi", "rfis"],
      ["submittal", "submittals"],
      ["file", "documents"],
    ] as Array<[string, ToolKey]>) {
      if (allowed.has(tool)) coverage.push(type);
      else skipped.push(`${type} records (you do not have read access to ${tool} on this project)`);
    }
    let drawingRows: Array<{
      sheetId: string;
      number: string;
      title: string;
      text: string | null;
    }> = [];
    if (!allowed.has("drawings")) {
      skipped.push(
        "drawing OCR text (you do not have read access to drawings on this project)",
      );
    } else if (query.length < OCR_MIN_QUERY) {
      skipped.push(
        `drawing OCR text (a query shorter than ${OCR_MIN_QUERY} characters is not selective enough to scan it)`,
      );
    } else if (cheapCount > OCR_SKIP_ABOVE) {
      skipped.push(
        `drawing OCR text (${cheapCount} records already matched; the OCR scan is unindexed and is only run when the cheaper sources are thin)`,
      );
    } else {
      coverage.push("drawing_sheet");
      drawingRows = await app.db
        .select({
          sheetId: drawingSheets.id,
          number: drawingSheets.number,
          title: drawingSheets.title,
          text: drawingRevisions.extractedText,
        })
        .from(drawingRevisions)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
        .where(
          and(
            eq(drawingSheets.companyId, companyId),
            eq(drawingSheets.projectId, projectId),
            eq(drawingRevisions.isSuperseded, 0),
            ilike(drawingRevisions.extractedText, pattern),
          ),
        )
        .limit(15);
    }

    // Interleaved rather than concatenated: the old code sliced the tail off,
    // and the tail was always the submittals, so a submittal question could
    // return "no grounded answer" on a drawing-heavy project.
    const candidates = interleave<SearchCandidate>(
      [
        drawingRows.map((r) => ({
          type: "drawing_sheet",
          id: r.sheetId,
          label: `Drawing ${r.number} — ${r.title}`,
          snippet: snippetAround(r.text ?? "", query),
        })),
        rfiRows.map((r) => ({
          type: "rfi",
          id: r.id,
          label: `RFI #${r.number}: ${r.subject}`,
          snippet: snippetAround([r.subject, r.question, r.officialResponse ?? ""].join(" — "), query),
        })),
        submittalRows.map((r) => ({
          type: "submittal",
          id: r.id,
          label: `Submittal #${r.number}: ${r.title}`,
          snippet: `${r.title} (spec section ${r.specSection ?? "n/a"})`,
        })),
        fileRows.map((r) => ({
          type: "file",
          id: r.id,
          label: `File "${r.name}"`,
          snippet: r.name,
        })),
      ],
      40,
    );
    return { candidates, coverage, skipped };
  }

  app.post("/projects/:projectId/ai/search", { preHandler: aiStandard }, async (req, reply) => {
    requireAi();
    const body = searchBodySchema.parse(req.body);
    const projectId = req.projectId!;
    const allowed = await heldTools(req, reply, projectId, [
      "documents",
      "rfis",
      "submittals",
      "drawings",
    ]);
    if (allowed.size === 0) {
      throw forbidden(
        "Grounded search reads drawings, documents, RFIs and submittals; you hold none of them on this project",
      );
    }
    const { candidates, coverage, skipped } = await collectSearchCandidates(
      req.companyId!,
      projectId,
      body.query,
      allowed,
    );

    if (candidates.length === 0) {
      return {
        runId: null,
        answer: null,
        citations: [],
        confidence: null,
        coverage,
        skipped,
        reason: "No drawing, file, RFI or submittal text in this project matches the query",
      };
    }

    const system = [
      "You are the ConstructOS document search agent for a construction project.",
      "Answer the user's query STRICTLY from the numbered snippets provided — never from outside knowledge.",
      'If the snippets do not contain the answer, set "answer" to null and return an empty citations list.',
      'Return ONLY a JSON object: {"answer": string|null, "citations": [{"ref": number, "type": string, "id": string, "excerpt": string}], "confidence": number}.',
      "Each citation's ref is the snippet number it came from; copy type and id exactly from that snippet's header. confidence is 0-1.",
    ].join("\n");
    const user = `Query: ${body.query}\n\nSnippets:\n\n${renderSnippets(candidates)}`;

    const result = await runAgent({
      app,
      req,
      agentKind: "document_search",
      projectId,
      system,
      user,
      inputRefs: candidates.map((c): InputRef => ({ type: c.type, id: c.id })),
      schema: searchResultSchema,
      dataCategories: ["drawing_text", "correspondence", "project_metadata"],
      contextChars: user.length,
    });
    return {
      runId: result.runId,
      ...result.json!,
      // Confidence as the PLATFORM records it, not as the model claimed it.
      confidence: effectiveConfidence(
        result.json!.confidence ?? null,
        result.grounding.evidenceScore,
        result.grounding.dropped,
      ),
      modelConfidence: result.json!.confidence ?? null,
      evidenceScore: result.grounding.evidenceScore,
      droppedCitations: result.grounding.dropped,
      coverage,
      skipped,
    };
  });

  /* ================================================================ */
  /* /daily-log-draft (#764) → review queue                            */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/ai/daily-log-draft",
    // `daily_logs` at read: the prompt carries the previous log's sections
    // verbatim and the proposal becomes a daily log.
    { preHandler: [...aiStandard, app.requireTool("daily_logs", "read")] },
    async (req, reply) => {
      requireAi();
      const body = dailyLogBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;
      const offset = await projectOffset(companyId, projectId);
      const { start, end } = dayRange(body.date, offset);

      // The day's activity comes from three other modules. A source the
      // caller may not read is dropped and reported rather than quietly
      // summarised into a log they can then read.
      const may = await heldTools(req, reply, projectId, ["photos", "punch", "rfis"]);
      const omitted: string[] = [];
      for (const [label, tool] of [
        ["photos taken that day", "photos"],
        ["punch items updated that day", "punch"],
        ["RFIs created or answered that day", "rfis"],
      ] as Array<[string, ToolKey]>) {
        if (!may.has(tool)) omitted.push(`${label} (you do not have read access to ${tool})`);
      }

      const dayPhotos = !may.has("photos") ? [] : await app.db
        .select({ id: photos.id, caption: photos.caption, aiTags: photos.aiTags })
        .from(photos)
        .where(
          and(
            eq(photos.companyId, companyId),
            eq(photos.projectId, projectId),
            or(
              and(gte(photos.takenAt, start), lte(photos.takenAt, end)),
              and(isNull(photos.takenAt), gte(photos.createdAt, start), lte(photos.createdAt, end)),
            ),
          ),
        )
        .limit(50);

      const dayPunch = !may.has("punch") ? [] : await app.db
        .select({
          id: punchItems.id,
          number: punchItems.number,
          title: punchItems.title,
          status: punchItems.status,
        })
        .from(punchItems)
        .where(
          and(
            eq(punchItems.companyId, companyId),
            eq(punchItems.projectId, projectId),
            gte(punchItems.updatedAt, start),
            lte(punchItems.updatedAt, end),
          ),
        )
        .limit(50);

      const dayRfis = !may.has("rfis") ? [] : await app.db
        .select({
          id: rfis.id,
          number: rfis.number,
          subject: rfis.subject,
          status: rfis.status,
          respondedAt: rfis.respondedAt,
        })
        .from(rfis)
        .where(
          and(
            eq(rfis.companyId, companyId),
            eq(rfis.projectId, projectId),
            or(
              and(gte(rfis.createdAt, start), lte(rfis.createdAt, end)),
              and(gte(rfis.respondedAt, start), lte(rfis.respondedAt, end)),
            ),
          ),
        )
        .limit(50);

      let prevLog = (
        await app.db
          .select()
          .from(dailyLogs)
          .where(
            and(
              eq(dailyLogs.companyId, companyId),
              eq(dailyLogs.projectId, projectId),
              lt(dailyLogs.logDate, body.date),
              eq(dailyLogs.status, "approved"),
            ),
          )
          .orderBy(desc(dailyLogs.logDate))
          .limit(1)
      )[0];
      if (!prevLog) {
        prevLog = (
          await app.db
            .select()
            .from(dailyLogs)
            .where(
              and(
                eq(dailyLogs.companyId, companyId),
                eq(dailyLogs.projectId, projectId),
                lt(dailyLogs.logDate, body.date),
              ),
            )
            .orderBy(desc(dailyLogs.logDate))
            .limit(1)
        )[0];
      }

      const inputRefs: InputRef[] = [
        ...dayPhotos.map((p): InputRef => ({ type: "photo", id: p.id })),
        ...dayPunch.map((p): InputRef => ({ type: "punch", id: p.id })),
        ...dayRfis.map((r): InputRef => ({ type: "rfi", id: r.id })),
        ...(prevLog ? [{ type: "daily_log", id: prevLog.id }] : []),
      ];

      const system = [
        "You are the ConstructOS daily-log drafting agent. Draft a construction daily log from the activity evidence supplied.",
        "Only describe activity supported by the evidence; do not invent crews, equipment or events.",
        'Return ONLY a JSON object: {"summary": string, "sections": {"manpower": [], "equipment": [], "deliveries": [], "visitors": [], "delays": []}, "notes": string, "weather": object (optional, carry forward if plausible), "confidence": number 0-1}.',
        "Section entries are short objects, e.g. manpower: {company, workers, hours, activity}; delays: {description, durationHours}.",
      ].join("\n");
      const user = [
        `Log date: ${body.date} (project-local day; window ${start} .. ${end})`,
        omitted.length
          ? `These sources were NOT supplied and must not be described: ${omitted.join("; ")}.`
          : "",
        `Photos captured that day (captions + AI tags):\n${
          dayPhotos.length
            ? dayPhotos
                .map((p) => `- ${p.caption ?? "(no caption)"} [${(p.aiTags ?? []).join(", ")}]`)
                .join("\n")
            : "(none)"
        }`,
        `Punch items updated that day:\n${
          dayPunch.length
            ? dayPunch.map((p) => `- #${p.number} ${p.title} (${p.status})`).join("\n")
            : "(none)"
        }`,
        `RFIs created or answered that day:\n${
          dayRfis.length
            ? dayRfis.map((r) => `- RFI #${r.number} ${r.subject} (${r.status})`).join("\n")
            : "(none)"
        }`,
        `Previous log (${prevLog ? prevLog.logDate : "none"}) sections:\n${
          prevLog ? JSON.stringify(prevLog.sections).slice(0, 4000) : "(none)"
        }`,
        `Previous log weather:\n${prevLog?.weather ? JSON.stringify(prevLog.weather) : "(none)"}`,
      ].join("\n\n");

      const result = await runAgent({
        app,
        req,
        agentKind: "daily_log_draft",
        projectId,
        system,
        user,
        inputRefs,
        schema: dailyLogDraftSchema,
        dataCategories: ["field_records", "images"],
        contextChars: user.length,
      });
      const parsed = result.json!;
      const review = await queueProposal(req, {
        runId: result.runId,
        agentKind: "daily_log_draft",
        projectId,
        targetType: "daily_log",
        targetId: body.date,
        proposal: parsed,
        summary: parsed.summary,
        modelConfidence: parsed.confidence ?? null,
        evidenceScore: result.grounding.evidenceScore,
        droppedCitations: result.grounding.dropped,
      });
      return reply.status(201).send({ runId: result.runId, review, omittedSources: omitted });
    },
  );

  /* ================================================================ */
  /* /rfi-evaluate (#765) → review queue                               */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/ai/rfi-evaluate",
    // `rfis` at read as well as `ai`: the prompt is the RFI's own question
    // and answer text, and the proposal it queues answers that RFI.
    { preHandler: [...aiStandard, app.requireTool("rfis", "read")] },
    async (req, reply) => {
      requireAi();
      const body = rfiEvalBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;

      const rfi = (
        await app.db
          .select()
          .from(rfis)
          .where(
            and(
              eq(rfis.id, body.rfiId),
              eq(rfis.companyId, companyId),
              eq(rfis.projectId, projectId),
            ),
          )
          .limit(1)
      )[0];
      if (!rfi) throw notFound("RFI not found");
      if (rfi.status !== "open") {
        // The proposal could never be applied, so producing it would only
        // spend money and create a queue item destined for supersession.
        throw conflict(
          `RFI #${rfi.number} is "${rfi.status}"; only an open RFI can be answered, so there is nothing to evaluate`,
        );
      }

      // The pinned sheets' OCR is drawing content. A caller with rfis:read and
      // drawings:none gets the evaluation without it, and is told so, rather
      // than getting the drawing text laundered through the AI route.
      const omitted: string[] = [];
      const mayReadDrawings = await holdsProjectTool(req, reply, projectId, "drawings");
      if (!mayReadDrawings) {
        omitted.push("pinned drawing sheet OCR (you do not have read access to drawings)");
      }
      const pins = !mayReadDrawings
        ? []
        : await app.db
        .select({
          sheetId: drawingSheets.id,
          number: drawingSheets.number,
          title: drawingSheets.title,
          currentRevisionId: drawingSheets.currentRevisionId,
        })
        .from(drawingPins)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingPins.sheetId))
        .where(
          and(
            eq(drawingPins.recordType, "rfi"),
            eq(drawingPins.recordId, rfi.id),
            eq(drawingSheets.projectId, projectId),
          ),
        )
        .limit(5);

      let sheetContext = "";
      const sheetRefs: InputRef[] = [];
      const revisionIds = pins
        .map((p) => p.currentRevisionId)
        .filter((id): id is string => Boolean(id));
      const revisions = revisionIds.length
        ? await app.db
            .select({
              id: drawingRevisions.id,
              sheetId: drawingRevisions.sheetId,
              text: drawingRevisions.extractedText,
            })
            .from(drawingRevisions)
            .where(inArray(drawingRevisions.id, revisionIds))
        : [];
      for (const pin of pins) {
        sheetRefs.push({ type: "drawing_sheet", id: pin.sheetId });
        const rev = revisions.find((r) => r.sheetId === pin.sheetId);
        if (rev?.text) {
          sheetContext += `\n--- Sheet ${pin.number} ${pin.title} (type=drawing_sheet id=${pin.sheetId}) ---\n${rev.text}`;
        }
      }
      sheetContext = sheetContext.slice(0, 6000);

      const links = await app.db
        .select()
        .from(recordLinks)
        .where(
          and(
            eq(recordLinks.companyId, companyId),
            eq(recordLinks.projectId, projectId),
            or(
              and(eq(recordLinks.fromType, "rfi"), eq(recordLinks.fromId, rfi.id)),
              and(eq(recordLinks.toType, "rfi"), eq(recordLinks.toId, rfi.id)),
            ),
          ),
        )
        .limit(20);
      const linked = links.map((l) =>
        l.fromType === "rfi" && l.fromId === rfi.id
          ? { type: l.toType, id: l.toId }
          : { type: l.fromType, id: l.fromId },
      );

      const system = [
        "You are the ConstructOS RFI evaluation agent. Draft a suggested official response to the RFI using ONLY the supplied context.",
        'Assess cost and schedule impact conservatively; use "tbd" when the context is insufficient.',
        'Return ONLY a JSON object: {"suggestedResponse": string, "costImpact": "yes"|"no"|"tbd", "scheduleImpact": "yes"|"no"|"tbd", "scheduleImpactDays": number (optional), "reasoning": string, "citations": [{"type": string, "id": string, "excerpt": string}], "confidence": number 0-1}.',
        "Citations must use the exact type and id printed in the context; anything else is dropped and lowers the recorded confidence.",
      ].join("\n");
      const user = [
        `RFI (type=rfi id=${rfi.id}) #${rfi.number}: ${rfi.subject}`,
        `Question:\n${rfi.question}`,
        rfi.proposedSolution ? `Proposed solution by submitter:\n${rfi.proposedSolution}` : "",
        sheetContext
          ? `Pinned drawing sheet text (OCR):${sheetContext}`
          : mayReadDrawings
            ? "No pinned drawing context."
            : "Pinned drawing context was NOT supplied: the requester does not have drawing access. Say so if the answer would depend on it.",
        linked.length
          ? `Linked records: ${linked.map((l) => `${l.type}:${l.id}`).join(", ")}`
          : "No linked records.",
      ]
        .filter(Boolean)
        .join("\n\n");

      const result = await runAgent({
        app,
        req,
        agentKind: "rfi_evaluation",
        projectId,
        system,
        user,
        inputRefs: [
          { type: "rfi", id: rfi.id },
          ...sheetRefs,
          ...linked.map((l): InputRef => ({ type: l.type, id: l.id })),
        ],
        schema: rfiEvaluationSchema,
        dataCategories: ["correspondence", "drawing_text"],
        contextChars: user.length,
      });
      const parsed = result.json!;
      const review = await queueProposal(req, {
        runId: result.runId,
        agentKind: "rfi_evaluation",
        projectId,
        targetType: "rfi_response",
        targetId: rfi.id,
        proposal: parsed,
        summary: `Suggested response for RFI #${rfi.number} "${rfi.subject}" (cost: ${parsed.costImpact}, schedule: ${parsed.scheduleImpact})`,
        modelConfidence: parsed.confidence ?? null,
        evidenceScore: result.grounding.evidenceScore,
        droppedCitations: result.grounding.dropped,
      });
      return reply.status(201).send({ runId: result.runId, review, omittedSources: omitted });
    },
  );

  /* ================================================================ */
  /* /submittal-review (#763) → review queue                           */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/ai/submittal-review",
    // `submittals` at read: the prompt is the submittal, and approval writes
    // an advisory review comment on it.
    { preHandler: [...aiStandard, app.requireTool("submittals", "read")] },
    async (req, reply) => {
      requireAi();
      const body = submittalBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;
      // The two secondary sources are owned by other tools: the governing
      // clause text by `specifications`, the attached documents by
      // `documents`. Each is omitted rather than laundered, and the omission
      // is reported and put in front of the model so it cannot claim a
      // review it could not perform.
      const omitted: string[] = [];
      const maySpecs = await holdsProjectTool(req, reply, projectId, "specifications");
      const mayDocs = await holdsProjectTool(req, reply, projectId, "documents");
      if (!maySpecs) {
        omitted.push("the governing specification clause text (you do not have read access to specifications)");
      }
      if (!mayDocs) {
        omitted.push("the attached documents (you do not have read access to documents)");
      }

      const submittal = (
        await app.db
          .select()
          .from(submittals)
          .where(
            and(
              eq(submittals.id, body.submittalId),
              eq(submittals.companyId, companyId),
              eq(submittals.projectId, projectId),
            ),
          )
          .limit(1)
      )[0];
      if (!submittal) throw notFound("Submittal not found");

      const attachedIds = (submittal.fileIds ?? []).filter(
        (id): id is string => typeof id === "string",
      );
      const attached = attachedIds.length && mayDocs
        ? await app.db
            .select()
            .from(files)
            .where(and(eq(files.companyId, companyId), inArray(files.id, attachedIds)))
        : [];

      // The specification section that GOVERNS the submittal, with its
      // extracted clause text. Without this the agent was reviewing a
      // submittal against a list of file NAMES, which is why its findings
      // could not be grounded.
      const specRows = submittal.specSection && maySpecs
        ? await app.db
            .select({
              sectionId: specSections.id,
              code: specSections.code,
              title: specSections.title,
              text: specSectionRevisions.extractedText,
            })
            .from(specSections)
            .leftJoin(
              specSectionRevisions,
              eq(specSectionRevisions.id, specSections.currentRevisionId),
            )
            .where(
              and(
                eq(specSections.companyId, companyId),
                eq(specSections.projectId, projectId),
                eq(specSections.code, submittal.specSection),
              ),
            )
            .limit(2)
        : [];

      const inputRefs: InputRef[] = [{ type: "submittal", id: submittal.id }];
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      const header = [
        `Submittal (type=submittal id=${submittal.id}) #${submittal.number} rev ${submittal.revision}: ${submittal.title}`,
        `Type: ${submittal.submittalType}; Spec section: ${submittal.specSection ?? "(none)"}; status ${submittal.status}`,
      ].join("\n");
      blocks.push({ type: "text", text: header });

      let specText = "";
      for (const s of specRows) {
        inputRefs.push({ type: "spec_section", id: s.sectionId });
        specText += `\n\nSpecification section (type=spec_section id=${s.sectionId}) ${s.code} — ${s.title}\n${
          s.text ? s.text.slice(0, 12_000) : "(no extracted clause text recorded for this section)"
        }`;
      }
      blocks.push({
        type: "text",
        text:
          specText ||
          (maySpecs
            ? "No specification clause text is available for this submittal."
            : "The governing specification clause text was NOT supplied: the requester does not have specification access."),
      });

      let documentsAttached = 0;
      for (const file of attached) {
        inputRefs.push({ type: "file", id: file.id });
        if (documentsAttached >= MAX_DOCUMENTS) continue;
        if (file.sizeBytes > MAX_DOCUMENT_BYTES) continue;
        try {
          if (file.contentType === "application/pdf") {
            const buffer = await streamToBuffer(app.storage.readStream(file.storageKey));
            blocks.push({
              type: "text",
              text: `Attachment (type=file id=${file.id}) "${file.name}" follows:`,
            });
            blocks.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: buffer.toString("base64"),
              },
            });
            documentsAttached += 1;
          } else if (IMAGE_MEDIA_TYPES.includes(file.contentType as ImageMediaType)) {
            const buffer = await streamToBuffer(app.storage.readStream(file.storageKey));
            blocks.push({
              type: "text",
              text: `Attachment (type=file id=${file.id}) "${file.name}" follows:`,
            });
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: file.contentType as ImageMediaType,
                data: buffer.toString("base64"),
              },
            });
            documentsAttached += 1;
          }
        } catch {
          // A missing or unreadable blob is stated, never silently ignored.
          blocks.push({
            type: "text",
            text: `Attachment (type=file id=${file.id}) "${file.name}" could not be read from storage and was NOT reviewed.`,
          });
        }
      }
      const unread = attached.filter(
        (f) => f.contentType !== "application/pdf" && !IMAGE_MEDIA_TYPES.includes(f.contentType as ImageMediaType),
      );
      if (unread.length > 0) {
        blocks.push({
          type: "text",
          text: `These attachments are of types this agent cannot read and were NOT reviewed: ${unread
            .map((f) => `${f.name} (${f.contentType})`)
            .join(", ")}`,
        });
      }

      if (!mayDocs && attachedIds.length > 0) {
        blocks.push({
          type: "text",
          text: `This submittal has ${attachedIds.length} attachment(s) that were NOT supplied to you: the requester does not have document access. Do not claim to have reviewed them.`,
        });
      }
      const haveContent = documentsAttached > 0 || specRows.some((s) => Boolean(s.text));
      const system = [
        "You are the ConstructOS submittal review agent. Review the submittal against its specification section using ONLY the supplied context.",
        `"recommendation" must be one of: ${SUBMITTAL_RESPONSES.join(", ")}.`,
        'Return ONLY a JSON object: {"recommendation": string, "findings": [{"item": string, "severity": "low"|"medium"|"high", "clauseRef": string, "note": string}], "deviations": [string], "missingItems": [string], "reasoning": string, "citations": [{"type": string, "id": string}], "confidence": number 0-1}.',
        "Cite the submittal, the specification section or an attachment by the exact type and id printed above; any other citation is dropped.",
        haveContent
          ? "Your recommendation is advisory; a human reviewer decides."
          : "NO specification text and NO readable attachment were supplied. You must recommend revise_and_resubmit and say in the reasoning that the review could not be performed on content.",
      ].join("\n");

      const result = await runAgent({
        app,
        req,
        agentKind: "submittal_review",
        projectId,
        system,
        user: blocks,
        inputRefs,
        schema: submittalReviewSchema,
        requireCitations: haveContent,
        dataCategories: ["specification_text", "field_records", "images"],
        contextChars: header.length + specText.length + documentsAttached * 2_000,
      });
      const parsed = result.json!;
      const review = await queueProposal(req, {
        runId: result.runId,
        agentKind: "submittal_review",
        projectId,
        targetType: "submittal_review",
        targetId: submittal.id,
        proposal: { ...parsed, contentReviewed: haveContent, documentsAttached },
        summary: `Recommendation "${parsed.recommendation}" for submittal #${submittal.number} "${submittal.title}"${
          haveContent ? "" : " (NO content was available to review)"
        }`,
        modelConfidence: parsed.confidence ?? null,
        evidenceScore: result.grounding.evidenceScore,
        droppedCitations: result.grounding.dropped,
      });
      return reply.status(201).send({
        runId: result.runId,
        review,
        contentReviewed: haveContent,
        documentsAttached,
        omittedSources: omitted,
      });
    },
  );

  /* ================================================================ */
  /* /sheet-name (#761) → review queue                                 */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/ai/sheet-name",
    // The only source is the drawing revision's title-block OCR, and the
    // proposal renames a sheet.
    { preHandler: [...aiStandard, app.requireTool("drawings", "read")] },
    async (req, reply) => {
      requireAi();
      const body = sheetNameBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;

      const rows = await app.db
        .select({
          revisionId: drawingRevisions.id,
          text: drawingRevisions.extractedText,
          sheetId: drawingSheets.id,
          number: drawingSheets.number,
          title: drawingSheets.title,
        })
        .from(drawingRevisions)
        .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
        .where(
          and(
            eq(drawingRevisions.id, body.revisionId),
            eq(drawingSheets.companyId, companyId),
            eq(drawingSheets.projectId, projectId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("Drawing revision not found");
      if (!row.text) throw badRequest("Revision has no extracted text to analyse");

      const system = [
        "You are the ConstructOS sheet-naming agent. From the OCR text of a drawing sheet's title block, extract the sheet number, title and discipline.",
        `"discipline" must be one of: ${DRAWING_DISCIPLINES.join(", ")}.`,
        'Return ONLY a JSON object: {"number": string, "title": string, "discipline": string, "confidence": number 0-1}.',
      ].join("\n");
      const user = `OCR text (truncated):\n${row.text.slice(0, 4000)}`;

      const result = await runAgent({
        app,
        req,
        agentKind: "sheet_naming",
        projectId,
        system,
        user,
        inputRefs: [
          { type: "drawing_revision", id: row.revisionId },
          { type: "drawing_sheet", id: row.sheetId },
        ],
        schema: sheetNameSchema,
        dataCategories: ["drawing_text"],
        contextChars: user.length,
      });
      const parsed = result.json!;
      const review = await queueProposal(req, {
        runId: result.runId,
        agentKind: "sheet_naming",
        projectId,
        targetType: "drawing_sheet",
        targetId: row.sheetId,
        proposal: parsed,
        summary: `Rename sheet "${row.number}" to "${parsed.number} — ${parsed.title}" (${parsed.discipline})`,
        modelConfidence: parsed.confidence ?? null,
        evidenceScore: result.grounding.evidenceScore,
        droppedCitations: result.grounding.dropped,
      });
      return reply.status(201).send({ runId: result.runId, review });
    },
  );

  /* ================================================================ */
  /* /photo-intel (#770, #771)                                         */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/ai/photo-intel",
    // `photos` at standard as well as `ai`: this route WRITES photos.aiTags /
    // aiSummary and raises safety signals. Gating it on ai:standard alone let
    // a member with photos:none overwrite the field team's tags.
    { preHandler: [...aiStandard, app.requireTool("photos", "standard")] },
    async (req) => {
    requireAi();
    const body = photoIntelBodySchema.parse(req.body);
    const projectId = req.projectId!;
    const companyId = req.companyId!;

    const photo = (
      await app.db
        .select()
        .from(photos)
        .where(
          and(
            eq(photos.id, body.photoId),
            eq(photos.companyId, companyId),
            eq(photos.projectId, projectId),
          ),
        )
        .limit(1)
    )[0];
    if (!photo) throw notFound("Photo not found");

    const file = (
      await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, photo.fileId), eq(files.companyId, companyId)))
        .limit(1)
    )[0];
    if (!file) throw notFound("Photo file not found");
    if (!IMAGE_MEDIA_TYPES.includes(file.contentType as ImageMediaType)) {
      throw badRequest(`Unsupported image content type "${file.contentType}"`);
    }
    if (file.sizeBytes > 5 * 1024 * 1024) {
      throw badRequest("Photo exceeds the 5MB limit for AI analysis");
    }

    const buffer = await streamToBuffer(app.storage.readStream(file.storageKey));
    const instruction = [
      "Analyse this construction jobsite photo.",
      photo.caption ? `Uploader caption: ${photo.caption}` : "",
      'Return ONLY a JSON object: {"tags": string[], "progressSummary": string, "safetySignals": [{"issue": string, "severity": "info"|"low"|"medium"|"high"|"critical"}], "confidence": number 0-1}.',
      "tags are short lowercase keywords (trades, materials, activities). safetySignals lists visible safety issues only; leave it empty when none are visible.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await runAgent({
      app,
      req,
      agentKind: "photo_intelligence",
      projectId,
      system:
        "You are the ConstructOS photo intelligence agent. Describe only what is visible in the image; never speculate beyond it.",
      user: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: file.contentType as ImageMediaType,
            data: buffer.toString("base64"),
          },
        },
        { type: "text", text: instruction },
      ],
      inputRefs: [
        { type: "photo", id: photo.id },
        { type: "file", id: file.id },
      ],
      schema: photoIntelSchema,
      dataCategories: ["images", "field_records"],
      contextChars: instruction.length,
    });
    const parsed = result.json!;
    const recorded = effectiveConfidence(
      parsed.confidence ?? null,
      result.grounding.evidenceScore,
      result.grounding.dropped,
    );

    // The write is recorded as an agent action with a before-image, so it
    // appears in /agents/actions and can be rolled back like every other
    // operational change an agent causes (#1023). It used to be the one
    // agent-caused write on the platform with no inverse.
    const beforeImage = { aiTags: photo.aiTags ?? [], aiSummary: photo.aiSummary };
    const nowIso = new Date().toISOString();
    const policy = await loadEffectivePolicy(app, companyId, "photo_intelligence");
    await app.db
      .update(photos)
      .set({
        aiTags: parsed.tags,
        aiSummary: parsed.progressSummary ?? photo.aiSummary,
      })
      .where(eq(photos.id, photo.id));
    const actionId = await recordAgentAction(app.db, {
      companyId,
      projectId,
      agentKind: "photo_intelligence",
      runId: result.runId,
      reviewId: null,
      draft: {
        actionType: "tag_photo",
        targetType: "photo",
        targetId: photo.id,
        beforeImage,
        afterImage: { aiTags: parsed.tags, aiSummary: parsed.progressSummary ?? photo.aiSummary },
        reversible: true,
        irreversibleReason: null,
      },
      appliedBy: req.user!.id,
      now: nowIso,
      authorisation: "direct",
      policyId: policy.policyId,
      confidence: recorded,
      summary: `Tagged photo ${photo.id} with ${parsed.tags.length} tag(s)`,
    });
    await appendLedger(app.db, {
      companyId,
      actorId: req.user!.id,
      action: "update",
      objectType: "photo",
      objectId: photo.id,
      payload: {
        aiTags: parsed.tags,
        aiSummary: parsed.progressSummary,
        runId: result.runId,
        actionId,
      },
      projectId,
    });

    let signalsCreated = 0;
    for (const s of parsed.safetySignals) {
      if (s.severity !== "high" && s.severity !== "critical") continue;
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId,
        detector: "photo_safety",
        severity: s.severity,
        confidence: recorded ?? 0.5,
        title: s.issue.slice(0, 200),
        explanation: `AI photo intelligence flagged a safety issue in photo ${photo.id}: ${s.issue}`,
        evidenceRefs: [
          { type: "photo", id: photo.id },
          { type: "ai_run", id: result.runId },
        ],
        disposition: "new",
      });
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "create",
        objectType: "signal",
        objectId: signalId,
        payload: { detector: "photo_safety", severity: s.severity, photoId: photo.id },
        projectId,
      });
      signalsCreated += 1;
    }

    return {
      runId: result.runId,
      ...parsed,
      confidence: recorded,
      modelConfidence: parsed.confidence ?? null,
      signalsCreated,
      actionId,
    };
    },
  );

  /* ================================================================ */
  /* /assist — grounded conversational assistant (#759, #760)          */
  /* ================================================================ */

  app.post("/projects/:projectId/ai/assist", { preHandler: aiStandard }, async (req) => {
    requireAi();
    const body = assistBodySchema.parse(req.body);
    const projectId = req.projectId!;
    const companyId = req.companyId!;

    const project = (
      await app.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1)
    )[0];

    async function n(p: Promise<{ n: number }[]>): Promise<number> {
      const [row] = await p;
      return Number(row?.n ?? 0);
    }
    const [rfiCount, submittalCount, punchCount, logCount, photoCount, sheetCount] =
      await Promise.all([
        n(app.db.select({ n: count() }).from(rfis).where(and(eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)))),
        n(app.db.select({ n: count() }).from(submittals).where(and(eq(submittals.companyId, companyId), eq(submittals.projectId, projectId)))),
        n(app.db.select({ n: count() }).from(punchItems).where(and(eq(punchItems.companyId, companyId), eq(punchItems.projectId, projectId)))),
        n(app.db.select({ n: count() }).from(dailyLogs).where(and(eq(dailyLogs.companyId, companyId), eq(dailyLogs.projectId, projectId)))),
        n(app.db.select({ n: count() }).from(photos).where(and(eq(photos.companyId, companyId), eq(photos.projectId, projectId)))),
        n(app.db.select({ n: count() }).from(drawingSheets).where(and(eq(drawingSheets.companyId, companyId), eq(drawingSheets.projectId, projectId)))),
      ]);

    const system = [
      "You are the ConstructOS assistant — an AI-native construction delivery platform (RFIs, submittals, daily logs, punch lists, drawings, photos, BIM, assurance).",
      "Answer questions about how to use the platform and about this project's overall state from the summary below.",
      "You have no live record access in this conversation: for record-level questions, direct the user to the relevant tool or the AI document search. Never fabricate record contents.",
      "",
      `Project: ${project?.name ?? projectId} (stage: ${project?.stage ?? "unknown"})`,
      `Record counts — RFIs: ${rfiCount}, submittals: ${submittalCount}, punch items: ${punchCount}, daily logs: ${logCount}, photos: ${photoCount}, drawing sheets: ${sheetCount}.`,
    ].join("\n");

    const result = await runAgent({
      app,
      req,
      agentKind: "assistant",
      projectId,
      system,
      user: body.message,
      inputRefs: [{ type: "project", id: projectId }],
      maxTokens: 4000,
      dataCategories: ["project_metadata"],
      contextChars: system.length,
    });
    return { runId: result.runId, text: result.text };
  });

  // The company assistant now needs a real role: it was gated on company
  // membership alone, so a guest could trigger paid model calls.
  app.post(
    "/ai/assist",
    { preHandler: [...companyGate, app.requireCompanyRole(["owner", "admin", "member"])] },
    async (req) => {
      requireAi();
      const body = assistBodySchema.parse(req.body);
      const companyId = req.companyId!;

      async function n(p: Promise<{ n: number }[]>): Promise<number> {
        const [row] = await p;
        return Number(row?.n ?? 0);
      }
      const [projectCount, rfiCount, submittalCount, punchCount] = await Promise.all([
        n(app.db.select({ n: count() }).from(projects).where(eq(projects.companyId, companyId))),
        n(app.db.select({ n: count() }).from(rfis).where(eq(rfis.companyId, companyId))),
        n(app.db.select({ n: count() }).from(submittals).where(eq(submittals.companyId, companyId))),
        n(app.db.select({ n: count() }).from(punchItems).where(eq(punchItems.companyId, companyId))),
      ]);

      const system = [
        "You are the ConstructOS assistant — an AI-native construction delivery platform (RFIs, submittals, daily logs, punch lists, drawings, photos, BIM, assurance).",
        "Answer questions about how to use the platform and about this company's portfolio from the summary below.",
        "You have no live record access in this conversation: for record-level questions, direct the user to the relevant project tool. Never fabricate record contents.",
        "",
        `Company-wide counts — projects: ${projectCount}, RFIs: ${rfiCount}, submittals: ${submittalCount}, punch items: ${punchCount}.`,
      ].join("\n");

      const result = await runAgent({
        app,
        req,
        agentKind: "assistant",
        projectId: null,
        system,
        user: body.message,
        inputRefs: [{ type: "company", id: companyId }],
        maxTokens: 4000,
        dataCategories: ["project_metadata"],
        contextChars: system.length,
      });
      return { runId: result.runId, text: result.text };
    },
  );

  /* ================================================================ */
  /* Review queue — the human-in-the-loop gate (Domain X #1020)        */
  /* ================================================================ */

  app.get("/ai/review", { preHandler: companyGate }, async (req) => {
    const q = reviewListQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (visible !== null && q.projectId && !visible.has(q.projectId)) {
      throw forbidden("You do not have AI access to that project");
    }
    // Company-scoped proposals come from company-wide runs that gathered
    // across every project; `gateReviewer` hands one to an owner/admin only,
    // so the list must not carry their summaries to anyone else.
    const scope =
      visible === null
        ? undefined
        : visible.size === 0
          ? sql`false`
          : inArray(aiReviewQueue.projectId, [...visible]);
    const where = and(
      eq(aiReviewQueue.companyId, req.companyId!),
      scope,
      q.status ? eq(aiReviewQueue.status, q.status) : undefined,
      q.targetType ? eq(aiReviewQueue.targetType, q.targetType) : undefined,
      q.projectId ? eq(aiReviewQueue.projectId, q.projectId) : undefined,
      q.stale === "1"
        ? and(
            eq(aiReviewQueue.status, "pending"),
            lt(aiReviewQueue.createdAt, staleCutoff(new Date())),
          )
        : undefined,
    );
    const [items, totalRow] = await Promise.all([
      app.db
        .select()
        .from(aiReviewQueue)
        .where(where)
        .orderBy(desc(aiReviewQueue.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(aiReviewQueue).where(where),
    ]);
    return {
      ...paginate(items.map(reviewListView), Number(totalRow[0]?.n ?? 0), q),
      staleAfterDays: STALE_REVIEW_DAYS,
    };
  });

  app.get("/projects/:projectId/ai/review", { preHandler: aiRead }, async (req) => {
    const q = reviewListQuerySchema.parse(req.query);
    const where = and(
      eq(aiReviewQueue.companyId, req.companyId!),
      eq(aiReviewQueue.projectId, req.projectId!),
      q.status ? eq(aiReviewQueue.status, q.status) : undefined,
      q.targetType ? eq(aiReviewQueue.targetType, q.targetType) : undefined,
      q.stale === "1"
        ? and(
            eq(aiReviewQueue.status, "pending"),
            lt(aiReviewQueue.createdAt, staleCutoff(new Date())),
          )
        : undefined,
    );
    const [items, totalRow] = await Promise.all([
      app.db
        .select()
        .from(aiReviewQueue)
        .where(where)
        .orderBy(desc(aiReviewQueue.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(aiReviewQueue).where(where),
    ]);
    return {
      ...paginate(items.map(reviewListView), Number(totalRow[0]?.n ?? 0), q),
      staleAfterDays: STALE_REVIEW_DAYS,
    };
  });

  async function loadReviewRow(req: FastifyRequest, reply: FastifyReply): Promise<ReviewRow> {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.id, id), eq(aiReviewQueue.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Review item not found");
    await gateReviewer(req, reply, row, "read");
    return row;
  }

  /**
   * A reviewer must hold the OPERATIONAL tool the proposal would move — an
   * `ai:standard` member with no `rfis` access must not be able to answer an
   * RFI by approving a proposal. Advisory proposals need `ai` on the project.
   */
  async function gateReviewer(
    req: FastifyRequest,
    reply: FastifyReply,
    row: ReviewRow,
    level: PermissionLevel,
  ): Promise<void> {
    refuseGuest(req);
    if (!row.projectId) {
      // A company-scoped proposal has no project ACL to consult, and the run
      // behind it gathered records from EVERY project in the tenant (only an
      // owner/admin can start a company-wide run or schedule one). Company
      // membership alone is therefore not a gate for reading or approving it.
      if (req.companyRole !== "owner" && req.companyRole !== "admin") {
        throw forbidden("A company-wide AI proposal is an owner/admin surface");
      }
      return;
    }
    const tool = targetTool(row.targetType) ?? "ai";
    await requireProjectTool(req, reply, row.projectId, tool, level);
  }

  /** Detail: the proposal itself, its run, and the record it would change. */
  app.get("/ai/review/:id", { preHandler: companyGate }, async (req, reply) => {
    const row = await loadReviewRow(req, reply);
    const [run] = await app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, row.runId), eq(aiRuns.companyId, req.companyId!)))
      .limit(1);
    const meta = await loadRunMeta(app.db, req.companyId!, row.runId);
    const [action] = await app.db
      .select()
      .from(agentActions)
      .where(
        and(eq(agentActions.reviewId, row.id), eq(agentActions.companyId, req.companyId!)),
      )
      .limit(1);

    // The CURRENT state of the target, so a reviewer sees a diff rather than
    // a two-line summary and an Approve button.
    let current: Record<string, unknown> | null = null;
    if (row.targetType === "rfi_response" && row.targetId) {
      const [rfi] = await app.db
        .select()
        .from(rfis)
        .where(and(eq(rfis.id, row.targetId), eq(rfis.companyId, req.companyId!)))
        .limit(1);
      current = rfi
        ? {
            number: rfi.number,
            subject: rfi.subject,
            status: rfi.status,
            officialResponse: rfi.officialResponse,
            costImpact: rfi.costImpact,
            scheduleImpact: rfi.scheduleImpact,
            scheduleImpactDays: rfi.scheduleImpactDays,
          }
        : null;
    } else if (row.targetType === "drawing_sheet" && row.targetId) {
      const [sheet] = await app.db
        .select()
        .from(drawingSheets)
        .where(
          and(eq(drawingSheets.id, row.targetId), eq(drawingSheets.companyId, req.companyId!)),
        )
        .limit(1);
      current = sheet
        ? {
            number: sheet.number,
            title: sheet.title,
            discipline: sheet.discipline,
            needsReview: sheet.needsReview,
          }
        : null;
    } else if (row.targetType === "daily_log" && row.targetId && row.projectId) {
      const [log] = await app.db
        .select()
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.companyId, req.companyId!),
            eq(dailyLogs.projectId, row.projectId),
            eq(dailyLogs.logDate, row.targetId),
            eq(dailyLogs.createdBy, req.user!.id),
          ),
        )
        .limit(1);
      current = log
        ? { id: log.id, status: log.status, sections: log.sections, notes: log.notes }
        : null;
    } else if (row.targetType === "signal_explanation" && row.targetId) {
      const [signal] = await app.db
        .select()
        .from(signals)
        .where(and(eq(signals.id, row.targetId), eq(signals.companyId, req.companyId!)))
        .limit(1);
      current = signal
        ? { title: signal.title, severity: signal.severity, explanation: signal.explanation }
        : null;
    }

    const stale =
      row.status === "pending" && row.createdAt < staleCutoff(new Date()) ? true : false;

    return {
      item: { ...reviewListView(row), proposal: row.proposal },
      run: run
        ? {
            ...runListView(run),
            citations: run.citations ?? [],
            inputRefs: run.inputRefs ?? [],
          }
        : null,
      provenance: meta,
      action: action ?? null,
      current,
      stale,
      staleAfterDays: STALE_REVIEW_DAYS,
    };
  });

  app.post("/ai/review/:id/approve", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.id, id), eq(aiReviewQueue.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Review item not found");
    if (row.status !== "pending") throw conflict(`Review item is "${row.status}", not pending`);
    await gateReviewer(req, reply, row, "standard");

    const agentKind =
      ((row.proposal as Record<string, unknown> | null)?.["agentKind"] as string | undefined) ??
      row.targetType;
    const policy = await loadEffectivePolicy(app, req.companyId!, agentKind);
    const applied = await applyReviewItem({
      app,
      reviewId: row.id,
      companyId: req.companyId!,
      actorId: req.user!.id,
      agentKind,
      authorisation: "human_approval",
      policyId: policy.policyId,
    });
    return {
      id: row.id,
      status: "approved",
      applied: applied.applied,
      actionId: applied.actionId,
    };
  });

  app.post("/ai/review/:id/reject", { preHandler: companyGate }, async (req, reply) => {
    const body = rejectBodySchema.parse(req.body ?? {});
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.id, id), eq(aiReviewQueue.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Review item not found");
    if (row.status !== "pending") throw conflict(`Review item is "${row.status}", not pending`);
    await gateReviewer(req, reply, row, "standard");

    const now = new Date().toISOString();
    const claimed = await app.db.transaction(async (tx) =>
      claimReviewItem(tx, row.id, req.companyId!, "rejected", req.user!.id, now),
    );
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "ai_review",
      objectId: claimed.id,
      payload: {
        status: "rejected",
        targetType: claimed.targetType,
        targetId: claimed.targetId,
        runId: claimed.runId,
        reason: body.reason ?? null,
      },
      projectId: claimed.projectId,
    });
    return { id: claimed.id, status: "rejected", reason: body.reason ?? null };
  });

  /** Undo an approved proposal (#1023): restore the before-image. */
  app.post("/ai/review/:id/revert", { preHandler: companyGate }, async (req, reply) => {
    const body = revertBodySchema.parse(req.body ?? {});
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.id, id), eq(aiReviewQueue.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Review item not found");
    if (row.status !== "approved") {
      throw conflict(`Only an approved review item can be reverted; this one is "${row.status}"`);
    }
    await gateReviewer(req, reply, row, "standard");

    const [action] = await app.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.reviewId, row.id), eq(agentActions.companyId, req.companyId!)))
      .orderBy(desc(agentActions.createdAt))
      .limit(1);
    if (!action) {
      throw conflict("No recorded agent action for this item, so there is no before-image to restore");
    }
    const result = await rollbackAction(req, action, body.reason ?? null, row.id);
    return { id: row.id, status: "reverted", restored: result.restored };
  });

  /* ================================================================ */
  /* Agent actions and rollback (#1023)                                */
  /* ================================================================ */

  async function rollbackAction(
    req: FastifyRequest,
    action: ActionRow,
    reason: string | null,
    reviewId: string | null,
  ): Promise<{ restored: Record<string, unknown> }> {
    if (action.reversible !== 1) {
      throw conflict(
        action.irreversibleReason ?? "This agent action changed no operational record",
      );
    }
    const now = new Date().toISOString();
    const outcome = await app.db.transaction(async (tx) => {
      const claimed = await tx
        .update(agentActions)
        .set({
          status: "rolled_back",
          rolledBackBy: req.user!.id,
          rolledBackAt: now,
          rollbackReason: reason,
        })
        .where(
          and(
            eq(agentActions.id, action.id),
            eq(agentActions.companyId, req.companyId!),
            eq(agentActions.status, "applied"),
          ),
        )
        .returning();
      if (!claimed[0]) throw conflict("This agent action was already rolled back");
      const result = await revertAction(tx, claimed[0], {
        companyId: req.companyId!,
        actorId: req.user!.id,
        now,
        agentKind: action.agentKind,
        authorisation: reason ?? "rollback",
        policyId: action.policyId,
      });
      if (reviewId) {
        await tx
          .update(aiReviewQueue)
          .set({ status: "reverted", reviewedAt: now })
          .where(
            and(eq(aiReviewQueue.id, reviewId), eq(aiReviewQueue.companyId, req.companyId!)),
          );
      }
      return result;
    });

    for (const entry of outcome.ledger) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId,
        payload: entry.payload,
        projectId: entry.projectId ?? action.projectId,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "agent_action",
      objectId: action.id,
      payload: {
        status: "rolled_back",
        reason,
        reviewId,
        agentKind: action.agentKind,
        restored: outcome.restored,
      },
      projectId: action.projectId,
    });
    return { restored: outcome.restored };
  }

  /**
   * The gate on ONE agent action, at the level the caller needs.
   *
   * Same shape as `gateReviewer`, for the same reason: the before/after image
   * is the operational record content the agent moved, so the tool that owns
   * the target owns the action too. A company-scoped action (no project ACL to
   * consult) belongs to a company-wide run, which only an owner/admin can
   * start — so only an owner/admin may read it back or reverse it.
   */
  async function gateAction(
    req: FastifyRequest,
    reply: FastifyReply,
    action: ActionRow,
    level: PermissionLevel,
  ): Promise<void> {
    refuseGuest(req);
    if (!action.projectId) {
      if (req.companyRole !== "owner" && req.companyRole !== "admin") {
        throw forbidden("A company-wide agent action is an owner/admin surface");
      }
      return;
    }
    const tool = targetTool(action.targetType) ?? "ai";
    await requireProjectTool(req, reply, action.projectId, tool, level);
  }

  app.get("/agents/actions", { preHandler: companyGate }, async (req) => {
    const q = actionsQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (visible !== null && q.projectId && !visible.has(q.projectId)) {
      throw forbidden("You do not have AI access to that project");
    }
    // A company-scoped action carries a company-wide run's output; the detail
    // route hands it only to an owner/admin, so the list must not advertise
    // it to everyone else either.
    const scope =
      visible === null
        ? undefined
        : visible.size === 0
          ? sql`false`
          : inArray(agentActions.projectId, [...visible]);
    const where = and(
      eq(agentActions.companyId, req.companyId!),
      scope,
      q.projectId ? eq(agentActions.projectId, q.projectId) : undefined,
      q.agentKind ? eq(agentActions.agentKind, q.agentKind) : undefined,
      q.status ? eq(agentActions.status, q.status) : undefined,
    );
    const [items, totalRow] = await Promise.all([
      app.db
        .select()
        .from(agentActions)
        .where(where)
        .orderBy(desc(agentActions.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(agentActions).where(where),
    ]);
    return paginate(items.map(actionListView), Number(totalRow[0]?.n ?? 0), q);
  });

  /** One action WITH its before/after image, behind the owning tool's gate. */
  app.get("/agents/actions/:id", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [action] = await app.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.id, id), eq(agentActions.companyId, req.companyId!)))
      .limit(1);
    if (!action) throw notFound("Agent action not found");
    await gateAction(req, reply, action, "read");
    return {
      action: {
        ...actionListView(action),
        beforeImage: action.beforeImage ?? null,
        afterImage: action.afterImage ?? null,
      },
    };
  });

  app.post("/agents/actions/:id/rollback", { preHandler: companyGate }, async (req, reply) => {
    const body = revertBodySchema.parse(req.body ?? {});
    const { id } = req.params as { id: string };
    const [action] = await app.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.id, id), eq(agentActions.companyId, req.companyId!)))
      .limit(1);
    if (!action) throw notFound("Agent action not found");
    await gateAction(req, reply, action, "standard");
    const result = await rollbackAction(req, action, body.reason ?? null, action.reviewId);
    return { id: action.id, status: "rolled_back", restored: result.restored };
  });

  /* ================================================================ */
  /* Runs audit — the transparency surface (#774, X #1021, #1026)      */
  /* ================================================================ */

  app.get("/ai/runs", { preHandler: companyGate }, async (req) => {
    const q = runsQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    if (visible !== null && q.projectId && !visible.has(q.projectId)) {
      throw forbidden("You do not have AI access to that project");
    }
    // A company-scoped run's prompt can hold records from every project, and
    // GET /ai/runs/:id hands it back only to its requester or an owner/admin.
    // The list follows the same rule rather than listing rows whose detail is
    // a 403.
    const ownCompanyScoped = and(isNull(aiRuns.projectId), eq(aiRuns.requestedBy, req.user!.id));
    const scope =
      visible === null
        ? undefined
        : visible.size === 0
          ? ownCompanyScoped
          : or(ownCompanyScoped, inArray(aiRuns.projectId, [...visible]));
    const where = and(
      eq(aiRuns.companyId, req.companyId!),
      scope,
      q.projectId ? eq(aiRuns.projectId, q.projectId) : undefined,
      q.agentKind ? eq(aiRuns.agentKind, q.agentKind) : undefined,
      q.status ? eq(aiRuns.status, q.status) : undefined,
    );
    const [items, totalRow] = await Promise.all([
      app.db
        .select()
        .from(aiRuns)
        .where(where)
        .orderBy(desc(aiRuns.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(aiRuns).where(where),
    ]);
    const metas = await loadRunMetaMany(
      app.db,
      req.companyId!,
      items.map((r) => r.id),
    );
    return paginate(
      items.map((r) => {
        const meta = metas.get(r.id);
        return {
          ...runListView(r),
          promptVersion: meta?.promptVersion ?? null,
          evidenceScore: meta?.evidenceScore ?? null,
          droppedCitations: meta?.droppedCitations ?? 0,
          source: meta?.source ?? null,
        };
      }),
      Number(totalRow[0]?.n ?? 0),
      q,
    );
  });

  /** The explainability record for one run (#1026): everything it was given. */
  app.get("/ai/runs/:id", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [run] = await app.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.companyId, req.companyId!)))
      .limit(1);
    if (!run) throw notFound("Run not found");
    // Prompts carry record content: the gate is the run's own project AND the
    // tools that own the tables the agent read. `ai:read` alone is not a gate
    // for a cost_forecaster prompt full of budget lines — a field engineer
    // with budget:none would read every figure their template denies. The
    // same list that decides who may START the run decides who may read it
    // back (agents/types.ts `requiredTools`).
    if (run.projectId) {
      await requireProjectTool(req, reply, run.projectId, "ai", "read");
      const refs = run.inputRefs ?? [];
      const entry = AGENT_INVENTORY.find((a) => a.kind === run.agentKind);
      // What this run actually read, when it recorded anything; the agent's
      // declared tools otherwise (a refused or failed run has no refs).
      const tools = refs.length > 0 ? toolsForRefs(refs) : (entry?.requiredTools ?? []);
      for (const tool of tools) {
        await requireProjectTool(req, reply, run.projectId, tool, "read");
      }
    } else {
      // A company-scoped run's prompt can carry records from EVERY project (a
      // company-wide fleet run gathers across the tenant), and there is no
      // project ACL to consult. It is readable by the person who asked for it
      // and by company owners/admins — not by every company member.
      refuseGuest(req);
      const admin = req.companyRole === "owner" || req.companyRole === "admin";
      if (!admin && run.requestedBy !== req.user!.id) {
        throw forbidden(
          "This company-wide AI run is visible to its requester and to company owners/admins",
        );
      }
    }
    const meta = await loadRunMeta(app.db, req.companyId!, run.id);
    const reviews = await app.db
      .select()
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.runId, run.id), eq(aiReviewQueue.companyId, req.companyId!)))
      .limit(50);
    const actions = await app.db
      .select()
      .from(agentActions)
      .where(and(eq(agentActions.runId, run.id), eq(agentActions.companyId, req.companyId!)))
      .limit(50);
    return {
      run: {
        ...runListView(run),
        prompt: run.prompt,
        output: run.output,
        outputJson: run.outputJson,
        citations: run.citations ?? [],
        inputRefs: run.inputRefs ?? [],
      },
      provenance: meta,
      reviews: reviews.map(reviewListView),
      actions,
    };
  });

  /** Model inventory and data-transmission statement (#775, #1027). */
  app.get("/ai/models", { preHandler: companyGate }, async (req) => {
    const policies = await loadEffectivePolicies(app, req.companyId!, KNOWN_AGENT_KINDS);
    return {
      provider: "Anthropic",
      enabled: aiEnabled(app),
      defaultModel: app.appConfig.AI_MODEL,
      retentionStatement:
        "Prompts and model outputs are stored on ai_runs for audit; the prompt is truncated at 20,000 characters. They are visible only to callers with AI read access to the run's project.",
      humanInTheLoop:
        "No agent writes to an operational record. A proposal becomes a change only when a person with the owning tool's standard level approves it, or a tenant policy auto-applies a low-consequence target type; both are ledgered and reversible.",
      agents: AGENT_INVENTORY.map((a) => ({
        ...a,
        model: app.appConfig.AI_MODEL,
        policy: policies.get(a.kind) ?? null,
      })),
    };
  });

  /** Today's (or a given day's) spend against the ceiling (#1022). */
  app.get("/ai/usage", { preHandler: companyGate }, async (req) => {
    const q = usageQuerySchema.parse(req.query);
    const date = q.date ?? usageDate(new Date());
    const policies = await loadEffectivePolicies(app, req.companyId!, KNOWN_AGENT_KINDS);
    const rows = await Promise.all(
      KNOWN_AGENT_KINDS.map(async (kind) => {
        const used = await readUsage(app.db, req.companyId!, date, kind);
        const policy = policies.get(kind)!;
        return {
          agentKind: kind,
          ...used,
          limits: {
            maxRunsPerDay: policy.maxRunsPerDay,
            maxInputTokensPerDay: policy.maxInputTokensPerDay,
            maxOutputTokensPerDay: policy.maxOutputTokensPerDay,
          },
          withinBudget: budgetVerdict(policy, used).allowed,
        };
      }),
    );
    const active = rows.filter((r) => r.runs > 0);
    return {
      date,
      costBasis:
        "estimatedCostMicros is an ESTIMATE in micro-USD from published per-token rates for the model family; it is not a billed amount.",
      totals: {
        runs: active.reduce((a, r) => a + r.runs, 0),
        failures: active.reduce((a, r) => a + r.failures, 0),
        inputTokens: active.reduce((a, r) => a + r.inputTokens, 0),
        outputTokens: active.reduce((a, r) => a + r.outputTokens, 0),
        estimatedCostMicros: active.reduce((a, r) => a + r.costMicros, 0),
      },
      agents: rows,
    };
  });

  /* ================================================================ */
  /* Agent fleet — descriptors, policy, run (plan §3.2)                */
  /* ================================================================ */

  app.get("/agents", { preHandler: companyGate }, async (req) => {
    const companyId = req.companyId!;
    const policies = await loadEffectivePolicies(app, companyId, KNOWN_AGENT_KINDS);
    const statRows = await app.db
      .select({
        agentKind: aiRuns.agentKind,
        runCount: count(),
      })
      .from(aiRuns)
      .where(eq(aiRuns.companyId, companyId))
      .groupBy(aiRuns.agentKind);
    const lastRows = await app.db
      .select({ agentKind: aiRuns.agentKind, createdAt: aiRuns.createdAt })
      .from(aiRuns)
      .where(eq(aiRuns.companyId, companyId))
      .orderBy(desc(aiRuns.createdAt))
      .limit(500);
    const runCounts = new Map(statRows.map((r) => [r.agentKind, Number(r.runCount)]));
    const lastRun = new Map<string, string>();
    for (const r of lastRows) if (!lastRun.has(r.agentKind)) lastRun.set(r.agentKind, r.createdAt);

    const pendingRows = await app.db
      .select({ targetType: aiReviewQueue.targetType, n: count() })
      .from(aiReviewQueue)
      .where(and(eq(aiReviewQueue.companyId, companyId), eq(aiReviewQueue.status, "pending")))
      .groupBy(aiReviewQueue.targetType);
    const pendingByTarget = new Map(pendingRows.map((r) => [r.targetType, Number(r.n)]));

    return {
      aiEnabled: aiEnabled(app),
      items: AGENT_INVENTORY.map((a) => {
        const policy = policies.get(a.kind)!;
        return {
          kind: a.kind,
          name: a.name,
          description: a.description,
          category: a.category,
          scope: a.scope,
          inputs: a.inputs,
          outputs: a.outputs,
          dataCategories: a.dataCategories,
          requiredTools: a.requiredTools,
          targetTypes: a.targetTypes,
          consequential: a.consequential,
          runnable: a.runnable,
          route: a.route,
          promptVersion: a.promptVersion,
          authorisation: policy.authorisation,
          threshold: policy.autoApplyMinConfidence,
          minConfidence: policy.minConfidence,
          schedulable: a.schedulable,
          enabled: policy.enabled,
          policySource: policy.source,
          lastRunAt: lastRun.get(a.kind) ?? null,
          runCount: runCounts.get(a.kind) ?? 0,
          pendingProposals: a.targetTypes.reduce(
            (acc, t) => acc + (pendingByTarget.get(t) ?? 0),
            0,
          ),
        };
      }),
    };
  });

  app.get("/agents/:kind/policy", { preHandler: companyGate }, async (req) => {
    const { kind } = req.params as { kind: string };
    if (!isKnownAgentKind(kind)) throw notFound(`Unknown agent kind "${kind}"`);
    const policy = await loadEffectivePolicy(app, req.companyId!, kind);
    const used = await readUsage(app.db, req.companyId!, usageDate(new Date()), kind);
    return { policy, usedToday: used, verdict: budgetVerdict(policy, used) };
  });

  app.put("/agents/:kind/policy", { preHandler: adminGate }, async (req) => {
    const { kind } = req.params as { kind: string };
    if (!isKnownAgentKind(kind)) throw notFound(`Unknown agent kind "${kind}"`);
    const body = policyBodySchema.parse(req.body ?? {});
    if (body.authorisation && body.authorisation !== "propose_only") {
      const entry = AGENT_INVENTORY.find((a) => a.kind === kind);
      const low = (entry?.targetTypes ?? []).filter((t) => t === "drawing_sheet");
      if (low.length === 0) {
        throw badRequest(
          `"${kind}" produces no low-consequence target type, so it can only ever be propose_only`,
        );
      }
    }
    const policy = await savePolicy(app, req.companyId!, kind, body, req.user!.id);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "agent_policy",
      objectId: policy.policyId ?? kind,
      payload: { agentKind: kind, ...body },
    });
    return { policy };
  });

  /**
   * The two authorisation checks that must happen BEFORE an agent gathers.
   *
   *  1. The tenant's policy may restrict a kind to certain company roles
   *     (#1022). That field was stored, ledgered and rendered but never read,
   *     which told an administrator a limit was in force when it was not.
   *  2. The caller must hold every tool that owns the tables the agent reads
   *     (agents/types.ts `requiredTools`) at level "read" on the run's
   *     project. The gathered rows land verbatim in `ai_runs.prompt`, which
   *     anyone with `ai:read` on that project can read back, so gating the
   *     run on `ai:standard` alone laundered budget, safety and bid data
   *     around the tool that denies it.
   */
  async function authoriseAgentRun(
    req: FastifyRequest,
    reply: FastifyReply,
    def: { kind: string; requiredTools: readonly ToolKey[] },
    projectId: string | null,
  ): Promise<void> {
    const policy = await loadEffectivePolicy(app, req.companyId!, def.kind);
    if (
      policy.allowedRoles.length > 0 &&
      !policy.allowedRoles.includes(req.companyRole ?? "")
    ) {
      throw forbidden(
        `Company policy restricts the "${def.kind}" agent to: ${policy.allowedRoles.join(", ")}`,
      );
    }
    if (!projectId) {
      // A company-wide run is owner/admin only (see the route gates), and
      // owners and admins bypass tool levels by design, so there is nothing
      // narrower to enforce here.
      return;
    }
    for (const tool of def.requiredTools) {
      await requireProjectTool(req, reply, projectId, tool, "read");
    }
  }

  async function runFleetAgent(
    req: FastifyRequest,
    reply: FastifyReply,
    kind: string,
    projectId: string | null,
    params: Record<string, unknown>,
  ) {
    requireAi();
    const def = getAgentDefinition(kind);
    if (!def) {
      const legacy = AGENT_INVENTORY.find((a) => a.kind === kind);
      throw badRequest(
        legacy
          ? `"${kind}" is served by its own endpoint: ${legacy.route}`
          : `Unknown agent kind "${kind}"`,
      );
    }
    if (def.scope === "project" && !projectId) {
      throw badRequest(`The "${kind}" agent needs a projectId`);
    }
    await authoriseAgentRun(req, reply, def, projectId);
    const result = await executeAgent({
      app,
      req,
      companyId: req.companyId!,
      actorId: req.user!.id,
      projectId,
      def,
      params,
      source: "user",
    });
    if (!result.skipped && result.runId) {
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "agent_run",
        objectId: result.runId,
        payload: {
          agentKind: kind,
          proposals: result.proposals,
          actions: result.actions,
          signals: result.signals,
          source: "user",
        },
        projectId,
      });
    }
    return result;
  }

  app.post("/agents/:kind/run", { preHandler: companyGate }, async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const body = runAgentBodySchema.parse(req.body ?? {});
    if (body.projectId) {
      await requireProjectTool(req, reply, body.projectId, "ai", "standard");
    } else {
      // No project means no tool gate can resolve, so a company-wide agent
      // run is an owner/admin action.
      await app.requireCompanyRole(["owner", "admin"])(req, reply);
    }
    const result = await runFleetAgent(req, reply, kind, body.projectId ?? null, body.params);
    return reply.status(result.skipped ? 200 : 201).send(result);
  });

  app.post(
    "/projects/:projectId/agents/:kind/run",
    { preHandler: aiStandard },
    async (req, reply) => {
      const { kind } = req.params as { kind: string };
      const body = projectRunAgentBodySchema.parse(req.body ?? {});
      const result = await runFleetAgent(req, reply, kind, req.projectId!, body.params);
      return reply.status(result.skipped ? 200 : 201).send(result);
    },
  );

  /** Alias of /ai/runs scoped to the console's vocabulary (plan §3.2). */
  app.get("/agents/runs", { preHandler: companyGate }, async (req) => {
    const q = runsQuerySchema.parse(req.query);
    const visible = await visibleProjectIds(app, req);
    // A company-scoped run's prompt can hold records from every project, and
    // GET /ai/runs/:id hands it back only to its requester or an owner/admin.
    // The list follows the same rule rather than listing rows whose detail is
    // a 403.
    const ownCompanyScoped = and(isNull(aiRuns.projectId), eq(aiRuns.requestedBy, req.user!.id));
    const scope =
      visible === null
        ? undefined
        : visible.size === 0
          ? ownCompanyScoped
          : or(ownCompanyScoped, inArray(aiRuns.projectId, [...visible]));
    const where = and(
      eq(aiRuns.companyId, req.companyId!),
      scope,
      q.projectId ? eq(aiRuns.projectId, q.projectId) : undefined,
      q.agentKind ? eq(aiRuns.agentKind, q.agentKind) : undefined,
      q.status ? eq(aiRuns.status, q.status) : undefined,
    );
    const [items, totalRow] = await Promise.all([
      app.db
        .select()
        .from(aiRuns)
        .where(where)
        .orderBy(desc(aiRuns.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(aiRuns).where(where),
    ]);
    const metas = await loadRunMetaMany(
      app.db,
      req.companyId!,
      items.map((r) => r.id),
    );
    return paginate(
      items.map((r) => {
        const meta = metas.get(r.id);
        return {
          ...runListView(r),
          promptVersion: meta?.promptVersion ?? null,
          evidenceScore: meta?.evidenceScore ?? null,
          droppedCitations: meta?.droppedCitations ?? 0,
          source: meta?.source ?? null,
          proposalCount: meta?.proposalCount ?? 0,
        };
      }),
      Number(totalRow[0]?.n ?? 0),
      q,
    );
  });

  /* ================================================================ */
  /* Schedules                                                         */
  /* ================================================================ */

  app.get("/agents/schedules", { preHandler: companyGate }, async (req) => {
    const visible = await visibleProjectIds(app, req);
    const rows = await listSchedules(app.db, req.companyId!);
    return {
      items: rows.filter((r) => canSeeProject(visible, r.projectId)),
      jobs: ["ai.agent-schedules", "ai.review-stale"],
    };
  });

  app.post("/agents/schedules", { preHandler: companyGate }, async (req, reply) => {
    const body = scheduleBodySchema.parse(req.body ?? {});
    const def = getAgentDefinition(body.agentKind);
    if (!def) throw badRequest(`"${body.agentKind}" cannot be scheduled: it has no runnable definition`);
    if (!def.schedulable) throw badRequest(`The "${body.agentKind}" agent is not schedulable`);
    if (body.projectId) {
      await requireProjectTool(req, reply, body.projectId, "ai", "standard");
    } else {
      await app.requireCompanyRole(["owner", "admin"])(req, reply);
      if (def.scope === "project") {
        throw badRequest(`The "${body.agentKind}" agent needs a projectId`);
      }
    }
    // Scheduled runs have no human actor, so the authorisation moment is HERE:
    // whoever puts an agent on a clock must be allowed to run it by hand.
    await authoriseAgentRun(req, reply, def, body.projectId ?? null);
    const row = await createSchedule(app.db, {
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      agentKind: body.agentKind,
      name: body.name ?? null,
      everyMinutes: body.everyMinutes,
      params: body.params,
      enabled: body.enabled,
      createdBy: req.user!.id,
      now: new Date(),
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "agent_schedule",
      objectId: row.id,
      payload: { agentKind: row.agentKind, everyMinutes: row.everyMinutes, enabled: row.enabled },
      projectId: row.projectId,
    });
    return reply.status(201).send(row);
  });

  app.patch("/agents/schedules/:id", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = schedulePatchSchema.parse(req.body ?? {});
    const [row] = await app.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), eq(agentSchedules.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Schedule not found");
    if (row.projectId) await requireProjectTool(req, reply, row.projectId, "ai", "standard");
    else await app.requireCompanyRole(["owner", "admin"])(req, reply);

    await app.db
      .update(agentSchedules)
      .set({
        name: body.name !== undefined ? body.name : row.name,
        everyMinutes: body.everyMinutes ?? row.everyMinutes,
        params: body.params ?? row.params,
        enabled: body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(agentSchedules.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "agent_schedule",
      objectId: row.id,
      payload: { ...body },
      projectId: row.projectId,
    });
    const [updated] = await app.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, row.id))
      .limit(1);
    return updated!;
  });

  app.delete("/agents/schedules/:id", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), eq(agentSchedules.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Schedule not found");
    if (row.projectId) await requireProjectTool(req, reply, row.projectId, "ai", "standard");
    else await app.requireCompanyRole(["owner", "admin"])(req, reply);
    await app.db.delete(agentSchedules).where(eq(agentSchedules.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "agent_schedule",
      objectId: row.id,
      payload: { agentKind: row.agentKind },
      projectId: row.projectId,
    });
    return { id: row.id, deleted: true };
  });

  app.post("/agents/schedules/:id/run", { preHandler: companyGate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), eq(agentSchedules.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Schedule not found");
    if (row.projectId) await requireProjectTool(req, reply, row.projectId, "ai", "standard");
    else await app.requireCompanyRole(["owner", "admin"])(req, reply);
    const def = getAgentDefinition(row.agentKind);
    if (def) await authoriseAgentRun(req, reply, def, row.projectId);
    // runSchedule claims the row first (conditional UPDATE on next_run_at), so
    // "Run now" and a tick that has just picked the same schedule up cannot
    // both call the model.
    const outcome = await runSchedule(app, row, new Date(), { force: true });
    if (outcome.status === "skipped" && outcome.detail.startsWith("Already running")) {
      throw conflict(outcome.detail);
    }
    return outcome;
  });

  /** Manual scheduler cycle for this company (plan §3.2). */
  app.post("/agents/tick", { preHandler: adminGate }, async (req) => {
    const outcomes = await runDueSchedules(app, req.companyId!, new Date());
    return { ran: outcomes.length, outcomes };
  });

  /* ================================================================ */
  /* Governance reports (#1024–#1027)                                  */
  /* ================================================================ */

  // Reading is gated exactly like generating (adminGate). A bias report names
  // the vendors the fleet flags adversely and how often; a validation report
  // aggregates every project's runs in the tenant. Neither is project-scoped,
  // so there is no ACL to filter them by — the only honest gate is the one
  // that already governs who may create them.
  app.get("/agents/reports", { preHandler: adminGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(agentReports)
      .where(eq(agentReports.companyId, req.companyId!))
      .orderBy(desc(agentReports.createdAt))
      .limit(50);
    return { items: rows, kinds: AGENT_REPORT_KINDS };
  });

  app.get("/agents/reports/:id", { preHandler: adminGate }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(agentReports)
      .where(and(eq(agentReports.id, id), eq(agentReports.companyId, req.companyId!)))
      .limit(1);
    if (!row) throw notFound("Report not found");
    return row;
  });

  app.post("/agents/reports/:kind", { preHandler: adminGate }, async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const q = reportQuerySchema.parse(req.query ?? {});
    if (!(AGENT_REPORT_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`Unknown report kind "${kind}"`);
    }
    const now = new Date();
    const windowFrom = new Date(now.getTime() - q.days * 86_400_000).toISOString();

    let data: Record<string, unknown>;
    let title: string;
    let summary: string;
    if (kind === "adversarial") {
      const report = runAdversarialSuite(now);
      data = report as unknown as Record<string, unknown>;
      title = "Adversarial test of the agent guard layer";
      summary = `${report.held}/${report.total} guards held (${Math.round(report.passRate * 100)}%)`;
    } else if (kind === "bias") {
      const report = await buildBiasReport(app.db, req.companyId!, windowFrom, now);
      data = report as unknown as Record<string, unknown>;
      title = `Bias assessment over vendor- and worker-affecting agent output (${q.days} days)`;
      summary = report.verdict;
    } else {
      const report = await buildValidationReport(app.db, req.companyId!, windowFrom, now);
      data = report as unknown as Record<string, unknown>;
      title = `Model validation report (${q.days} days)`;
      summary = `${report.totals.runs} run(s) across ${report.agents.length} agent(s); ${report.totals.approved} proposal(s) approved, ${report.totals.rejected} rejected${
        report.truncated ? " — PARTIAL: the window was truncated, so no rates are stated" : ""
      }`;
    }

    const id = newId("arep");
    await app.db.insert(agentReports).values({
      id,
      companyId: req.companyId!,
      projectId: null,
      kind,
      title,
      summary,
      data,
      windowFrom,
      windowTo: now.toISOString(),
      generatedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "agent_report",
      objectId: id,
      payload: { kind, days: q.days, summary },
    });
    const [row] = await app.db.select().from(agentReports).where(eq(agentReports.id, id)).limit(1);
    return reply.status(201).send(row!);
  });

  /* ================================================================ */
  /* Health inputs (plan §3.5)                                         */
  /* ================================================================ */

  app.get("/projects/:projectId/ai/health-inputs", { preHandler: aiRead }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const [pending, stale, agentSignals, failedRuns] = await Promise.all([
      app.db
        .select({ n: count() })
        .from(aiReviewQueue)
        .where(
          and(
            eq(aiReviewQueue.companyId, companyId),
            eq(aiReviewQueue.projectId, projectId),
            eq(aiReviewQueue.status, "pending"),
          ),
        ),
      app.db
        .select({ n: count() })
        .from(aiReviewQueue)
        .where(
          and(
            eq(aiReviewQueue.companyId, companyId),
            eq(aiReviewQueue.projectId, projectId),
            eq(aiReviewQueue.status, "pending"),
            lt(aiReviewQueue.createdAt, staleCutoff(new Date())),
          ),
        ),
      app.db
        .select({ n: count() })
        .from(signals)
        .where(
          and(
            eq(signals.companyId, companyId),
            eq(signals.projectId, projectId),
            ilike(signals.detector, "agent\\_%"),
            inArray(signals.disposition, ["new", "under_review"]),
          ),
        ),
      app.db
        .select({ n: count() })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.companyId, companyId),
            eq(aiRuns.projectId, projectId),
            ne(aiRuns.status, "succeeded"),
            gte(aiRuns.createdAt, new Date(Date.now() - 30 * 86_400_000).toISOString()),
          ),
        ),
    ]);
    const reasons: string[] = [];
    if (!aiEnabled(app)) reasons.push("AI is disabled: no ANTHROPIC_API_KEY, so no agent has run");
    const staleCount = Number(stale[0]?.n ?? 0);
    if (staleCount > 0) {
      reasons.push(`${staleCount} agent proposal(s) have been pending for over ${STALE_REVIEW_DAYS} days`);
    }
    return {
      metrics: {
        pendingProposals: Number(pending[0]?.n ?? 0),
        staleProposals: staleCount,
        openAgentSignals: Number(agentSignals[0]?.n ?? 0),
        failedRuns30d: Number(failedRuns[0]?.n ?? 0),
      },
      reasons,
    };
  });

  /* ================================================================ */
  /* Jobs (plan §6.1)                                                  */
  /* ================================================================ */

  registerAgentJobs(app);
};
