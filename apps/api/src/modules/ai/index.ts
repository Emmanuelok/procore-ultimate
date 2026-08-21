import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, count, desc, eq, gte, ilike, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
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
  submittals,
} from "@constructos/db";
import {
  AI_AGENT_KINDS,
  AI_REVIEW_STATUSES,
  DRAWING_DISCIPLINES,
  SIGNAL_SEVERITIES,
  SUBMITTAL_RESPONSES,
  type ToolKey,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
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

const reviewListQuerySchema = pageQuerySchema.extend({
  status: z.enum(AI_REVIEW_STATUSES).optional(),
  targetType: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
});

const runsQuerySchema = pageQuerySchema.extend({
  projectId: z.string().max(64).optional(),
  agentKind: z.enum(AI_AGENT_KINDS).optional(),
});

/* ------------------------------------------------------------------ */
/* Agent output schemas (tolerant where a bad field should not kill    */
/* an otherwise usable proposal)                                       */
/* ------------------------------------------------------------------ */

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
        note: z.string().max(2000).optional(),
      }),
    )
    .default([])
    .catch([]),
  reasoning: z.string().max(10_000).optional(),
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
/* Module                                                              */
/* ------------------------------------------------------------------ */

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

function dayRange(date: string): { start: string; end: string } {
  return { start: `${date}T00:00:00.000Z`, end: `${date}T23:59:59.999Z` };
}

/** Which operational tool must the reviewer hold to apply a proposal? */
function targetTool(targetType: string): ToolKey | null {
  switch (targetType) {
    case "daily_log":
      return "daily_logs";
    case "rfi_response":
      return "rfis";
    case "drawing_sheet":
      return "drawings";
    case "submittal_review":
      return "submittals";
    default:
      return null;
  }
}

export const aiModule: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const aiStandard = [...companyGate, app.requireTool("ai", "standard")];
  const aiRead = [...companyGate, app.requireTool("ai", "read")];

  function requireAi(): void {
    if (!aiEnabled(app)) throw aiDisabledError();
  }

  async function createReviewItem(
    req: FastifyRequest,
    args: {
      runId: string;
      projectId: string | null;
      targetType: string;
      targetId: string | null;
      proposal: unknown;
      summary: string;
      confidence?: number;
    },
  ) {
    const id = newId("airev");
    await app.db.insert(aiReviewQueue).values({
      id,
      companyId: req.companyId!,
      projectId: args.projectId,
      runId: args.runId,
      targetType: args.targetType,
      targetId: args.targetId,
      proposal: args.proposal,
      summary: args.summary.slice(0, 500),
      confidence: args.confidence ?? null,
      status: "pending",
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "ai_review",
      objectId: id,
      payload: { targetType: args.targetType, targetId: args.targetId, runId: args.runId },
    });
    return {
      id,
      runId: args.runId,
      targetType: args.targetType,
      targetId: args.targetId,
      proposal: args.proposal,
      summary: args.summary.slice(0, 500),
      confidence: args.confidence ?? null,
      status: "pending" as const,
    };
  }

  /* ---------------------------------------------------------------- */
  /* /search — grounded document search with citations (#759-762)      */
  /* ---------------------------------------------------------------- */

  async function collectSearchCandidates(
    companyId: string,
    projectId: string,
    query: string,
  ): Promise<SearchCandidate[]> {
    const pattern = `%${escapeLike(query)}%`;
    const out: SearchCandidate[] = [];

    const drawingRows = await app.db
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
    for (const r of drawingRows) {
      out.push({
        type: "drawing_sheet",
        id: r.sheetId,
        label: `Drawing ${r.number} — ${r.title}`,
        snippet: snippetAround(r.text ?? "", query),
      });
    }

    const fileRows = await app.db
      .select({ id: files.id, name: files.name })
      .from(files)
      .where(
        and(
          eq(files.companyId, companyId),
          eq(files.projectId, projectId),
          ilike(files.name, pattern),
        ),
      )
      .limit(10);
    for (const r of fileRows) {
      out.push({ type: "file", id: r.id, label: `File "${r.name}"`, snippet: r.name });
    }

    const rfiRows = await app.db
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
      .limit(10);
    for (const r of rfiRows) {
      const body = [r.subject, r.question, r.officialResponse ?? ""].join(" — ");
      out.push({
        type: "rfi",
        id: r.id,
        label: `RFI #${r.number}: ${r.subject}`,
        snippet: snippetAround(body, query),
      });
    }

    const submittalRows = await app.db
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
      .limit(10);
    for (const r of submittalRows) {
      out.push({
        type: "submittal",
        id: r.id,
        label: `Submittal #${r.number}: ${r.title}`,
        snippet: `${r.title} (spec section ${r.specSection ?? "n/a"})`,
      });
    }

    return out.slice(0, 40);
  }

  app.post("/projects/:projectId/ai/search", { preHandler: aiStandard }, async (req) => {
    requireAi();
    const body = searchBodySchema.parse(req.body);
    const projectId = req.projectId!;
    const candidates = await collectSearchCandidates(req.companyId!, projectId, body.query);

    if (candidates.length === 0) {
      return { runId: null, answer: null, citations: [], confidence: null };
    }

    const system = [
      "You are the ConstructOS document search agent for a construction project.",
      "Answer the user's query STRICTLY from the numbered snippets provided — never from outside knowledge.",
      "If the snippets do not contain the answer, set \"answer\" to null and return an empty citations list.",
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
    });
    return { runId: result.runId, ...result.json! };
  });

  /* ---------------------------------------------------------------- */
  /* /daily-log-draft (#764) → review queue                            */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ai/daily-log-draft",
    { preHandler: aiStandard },
    async (req, reply) => {
      requireAi();
      const body = dailyLogBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;
      const { start, end } = dayRange(body.date);

      const dayPhotos = await app.db
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

      const dayPunch = await app.db
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

      const dayRfis = await app.db
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
        `Log date: ${body.date}`,
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
      });
      const parsed = result.json!;
      const review = await createReviewItem(req, {
        runId: result.runId,
        projectId,
        targetType: "daily_log",
        targetId: body.date,
        proposal: parsed,
        summary: parsed.summary,
        confidence: parsed.confidence,
      });
      return reply.status(201).send({ runId: result.runId, review });
    },
  );

  /* ---------------------------------------------------------------- */
  /* /rfi-evaluate (#765) → review queue                               */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ai/rfi-evaluate",
    { preHandler: aiStandard },
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

      const pins = await app.db
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
            .select({ id: drawingRevisions.id, sheetId: drawingRevisions.sheetId, text: drawingRevisions.extractedText })
            .from(drawingRevisions)
            .where(inArray(drawingRevisions.id, revisionIds))
        : [];
      for (const pin of pins) {
        sheetRefs.push({ type: "drawing_sheet", id: pin.sheetId });
        const rev = revisions.find((r) => r.sheetId === pin.sheetId);
        if (rev?.text) {
          sheetContext += `\n--- Sheet ${pin.number} ${pin.title} ---\n${rev.text}`;
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
        "Assess cost and schedule impact conservatively; use \"tbd\" when the context is insufficient.",
        'Return ONLY a JSON object: {"suggestedResponse": string, "costImpact": "yes"|"no"|"tbd", "scheduleImpact": "yes"|"no"|"tbd", "scheduleImpactDays": number (optional), "reasoning": string, "citations": [{"type": string, "id": string, "excerpt": string}], "confidence": number 0-1}.',
        "Citations must reference the drawing sheets / linked records provided.",
      ].join("\n");
      const user = [
        `RFI #${rfi.number}: ${rfi.subject}`,
        `Question:\n${rfi.question}`,
        rfi.proposedSolution ? `Proposed solution by submitter:\n${rfi.proposedSolution}` : "",
        sheetContext ? `Pinned drawing sheet text (OCR):${sheetContext}` : "No pinned drawing context.",
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
      });
      const parsed = result.json!;
      const review = await createReviewItem(req, {
        runId: result.runId,
        projectId,
        targetType: "rfi_response",
        targetId: rfi.id,
        proposal: parsed,
        summary: `Suggested response for RFI #${rfi.number} "${rfi.subject}" (cost: ${parsed.costImpact}, schedule: ${parsed.scheduleImpact})`,
        confidence: parsed.confidence,
      });
      return reply.status(201).send({ runId: result.runId, review });
    },
  );

  /* ---------------------------------------------------------------- */
  /* /submittal-review (#763) → review queue                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ai/submittal-review",
    { preHandler: aiStandard },
    async (req, reply) => {
      requireAi();
      const body = submittalBodySchema.parse(req.body);
      const projectId = req.projectId!;
      const companyId = req.companyId!;

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

      const attachedIds = submittal.fileIds ?? [];
      const attached = attachedIds.length
        ? await app.db
            .select({ id: files.id, name: files.name })
            .from(files)
            .where(and(eq(files.companyId, companyId), inArray(files.id, attachedIds)))
        : [];

      const specFiles = submittal.specSection
        ? await app.db
            .select({ id: files.id, name: files.name })
            .from(files)
            .where(
              and(
                eq(files.companyId, companyId),
                eq(files.projectId, projectId),
                ilike(files.name, `%${escapeLike(submittal.specSection)}%`),
              ),
            )
            .limit(10)
        : [];

      const system = [
        "You are the ConstructOS submittal review agent. Review the submittal against its specification section using ONLY the supplied context.",
        `"recommendation" must be one of: ${SUBMITTAL_RESPONSES.join(", ")}.`,
        'Return ONLY a JSON object: {"recommendation": string, "findings": [{"item": string, "severity": "low"|"medium"|"high", "note": string}], "reasoning": string, "confidence": number 0-1}.',
        "Your recommendation is advisory; a human reviewer decides. When the evidence is thin, prefer revise_and_resubmit and say why.",
      ].join("\n");
      const user = [
        `Submittal #${submittal.number} rev ${submittal.revision}: ${submittal.title}`,
        `Type: ${submittal.submittalType}; Spec section: ${submittal.specSection ?? "(none)"}`,
        `Attached files:\n${attached.length ? attached.map((f) => `- ${f.name}`).join("\n") : "(none)"}`,
        `Project files matching the spec section:\n${
          specFiles.length ? specFiles.map((f) => `- ${f.name}`).join("\n") : "(none)"
        }`,
      ].join("\n\n");

      const result = await runAgent({
        app,
        req,
        agentKind: "submittal_review",
        projectId,
        system,
        user,
        inputRefs: [
          { type: "submittal", id: submittal.id },
          ...attached.map((f): InputRef => ({ type: "file", id: f.id })),
          ...specFiles.map((f): InputRef => ({ type: "file", id: f.id })),
        ],
        schema: submittalReviewSchema,
      });
      const parsed = result.json!;
      const review = await createReviewItem(req, {
        runId: result.runId,
        projectId,
        targetType: "submittal_review",
        targetId: submittal.id,
        proposal: parsed,
        summary: `Recommendation "${parsed.recommendation}" for submittal #${submittal.number} "${submittal.title}"`,
        confidence: parsed.confidence,
      });
      return reply.status(201).send({ runId: result.runId, review });
    },
  );

  /* ---------------------------------------------------------------- */
  /* /sheet-name — OCR-driven sheet naming (#761) → review queue       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ai/sheet-name",
    { preHandler: aiStandard },
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
      });
      const parsed = result.json!;
      const review = await createReviewItem(req, {
        runId: result.runId,
        projectId,
        targetType: "drawing_sheet",
        targetId: row.sheetId,
        proposal: parsed,
        summary: `Rename sheet "${row.number}" to "${parsed.number} — ${parsed.title}" (${parsed.discipline})`,
        confidence: parsed.confidence,
      });
      return reply.status(201).send({ runId: result.runId, review });
    },
  );

  /* ---------------------------------------------------------------- */
  /* /photo-intel (#770, #771) — direct low-consequence enrichment     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/ai/photo-intel",
    { preHandler: aiStandard },
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
      });
      const parsed = result.json!;

      await app.db
        .update(photos)
        .set({
          aiTags: parsed.tags,
          aiSummary: parsed.progressSummary ?? photo.aiSummary,
        })
        .where(eq(photos.id, photo.id));
      await appendLedger(app.db, {
        companyId,
        actorId: req.user!.id,
        action: "update",
        objectType: "photo",
        objectId: photo.id,
        payload: { aiTags: parsed.tags, aiSummary: parsed.progressSummary, runId: result.runId },
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
          confidence: parsed.confidence ?? 0.5,
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
        });
        signalsCreated += 1;
      }

      return { runId: result.runId, ...parsed, signalsCreated };
    },
  );

  /* ---------------------------------------------------------------- */
  /* /assist — grounded conversational assistant (#759, #760)          */
  /* ---------------------------------------------------------------- */

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
    });
    return { runId: result.runId, text: result.text };
  });

  app.post("/ai/assist", { preHandler: companyGate }, async (req) => {
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
    });
    return { runId: result.runId, text: result.text };
  });

  /* ---------------------------------------------------------------- */
  /* Review queue — the human-in-the-loop gate (Domain X #1020)        */
  /* ---------------------------------------------------------------- */

  app.get("/ai/review", { preHandler: companyGate }, async (req) => {
    const q = reviewListQuerySchema.parse(req.query);
    const where = and(
      eq(aiReviewQueue.companyId, req.companyId!),
      q.status ? eq(aiReviewQueue.status, q.status) : undefined,
      q.targetType ? eq(aiReviewQueue.targetType, q.targetType) : undefined,
      q.projectId ? eq(aiReviewQueue.projectId, q.projectId) : undefined,
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
    return paginate(items, Number(totalRow[0]?.n ?? 0), q);
  });

  app.get("/projects/:projectId/ai/review", { preHandler: aiRead }, async (req) => {
    const q = reviewListQuerySchema.parse(req.query);
    const where = and(
      eq(aiReviewQueue.companyId, req.companyId!),
      eq(aiReviewQueue.projectId, req.projectId!),
      q.status ? eq(aiReviewQueue.status, q.status) : undefined,
      q.targetType ? eq(aiReviewQueue.targetType, q.targetType) : undefined,
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
    return paginate(items, Number(totalRow[0]?.n ?? 0), q);
  });

  type ReviewRow = typeof aiReviewQueue.$inferSelect;

  async function loadPendingReviewRow(req: FastifyRequest): Promise<ReviewRow> {
    const { id } = req.params as { id: string };
    const row = (
      await app.db
        .select()
        .from(aiReviewQueue)
        .where(and(eq(aiReviewQueue.id, id), eq(aiReviewQueue.companyId, req.companyId!)))
        .limit(1)
    )[0];
    if (!row) throw notFound("Review item not found");
    if (row.status !== "pending") throw conflict("Review item is not pending");
    return row;
  }

  /** Reviewer must hold standard on the target tool (project rows) or be a non-guest member. */
  async function gateReviewer(req: FastifyRequest, reply: FastifyReply, row: ReviewRow) {
    const tool = targetTool(row.targetType);
    if (row.projectId && tool) {
      (req.params as Record<string, string>).projectId = row.projectId;
      await app.requireTool(tool, "standard")(req, reply);
    } else if (req.companyRole === "guest") {
      throw forbidden("Guests cannot review AI proposals");
    }
  }

  async function applyProposal(
    req: FastifyRequest,
    row: ReviewRow,
  ): Promise<Record<string, unknown>> {
    const companyId = req.companyId!;
    const reviewerId = req.user!.id;
    const now = new Date().toISOString();
    const proposal = (row.proposal ?? {}) as Record<string, unknown>;

    switch (row.targetType) {
      case "daily_log": {
        const logDate = row.targetId;
        if (!row.projectId || !logDate) throw badRequest("Review item is missing project or date");
        const parsed = dailyLogDraftSchema
          .omit({ summary: true })
          .extend({ summary: z.string().optional() })
          .parse(proposal);
        const existing = (
          await app.db
            .select()
            .from(dailyLogs)
            .where(
              and(
                eq(dailyLogs.companyId, companyId),
                eq(dailyLogs.projectId, row.projectId),
                eq(dailyLogs.logDate, logDate),
                eq(dailyLogs.createdBy, reviewerId),
              ),
            )
            .limit(1)
        )[0];
        let logId: string;
        if (existing) {
          logId = existing.id;
          await app.db
            .update(dailyLogs)
            .set({
              sections: parsed.sections as Record<string, unknown>,
              notes: parsed.notes ?? existing.notes,
              weather: (parsed.weather as Record<string, unknown> | undefined) ?? existing.weather,
              aiDrafted: 1,
              updatedAt: now,
            })
            .where(eq(dailyLogs.id, logId));
        } else {
          logId = newId("dlog");
          await app.db.insert(dailyLogs).values({
            id: logId,
            companyId,
            projectId: row.projectId,
            logDate,
            status: "draft",
            sections: parsed.sections as Record<string, unknown>,
            notes: parsed.notes ?? null,
            weather: (parsed.weather as Record<string, unknown> | undefined) ?? null,
            aiDrafted: 1,
            createdBy: reviewerId,
          });
        }
        await appendLedger(app.db, {
          companyId,
          actorId: reviewerId,
          action: existing ? "update" : "create",
          objectType: "daily_log",
          objectId: logId,
          payload: { logDate, aiDrafted: true, reviewId: row.id, runId: row.runId },
        });
        return { dailyLogId: logId, logDate };
      }

      case "rfi_response": {
        if (!row.targetId) throw badRequest("Review item is missing its RFI id");
        const rfi = (
          await app.db
            .select()
            .from(rfis)
            .where(and(eq(rfis.id, row.targetId), eq(rfis.companyId, companyId)))
            .limit(1)
        )[0];
        if (!rfi) throw notFound("Target RFI not found");
        const suggested =
          typeof proposal.suggestedResponse === "string" ? proposal.suggestedResponse : null;
        if (!suggested) throw badRequest("Proposal has no suggestedResponse");
        const costImpact = impact.parse(proposal.costImpact ?? "tbd");
        const scheduleImpact = impact.parse(proposal.scheduleImpact ?? "tbd");
        const days =
          typeof proposal.scheduleImpactDays === "number" &&
          Number.isInteger(proposal.scheduleImpactDays)
            ? proposal.scheduleImpactDays
            : null;
        await app.db
          .update(rfis)
          .set({
            officialResponse: suggested,
            status: "answered",
            respondedBy: reviewerId,
            respondedAt: now,
            costImpact,
            scheduleImpact,
            scheduleImpactDays: days,
            updatedAt: now,
          })
          .where(eq(rfis.id, rfi.id));
        await appendLedger(app.db, {
          companyId,
          actorId: reviewerId,
          action: "state_change",
          objectType: "rfi",
          objectId: rfi.id,
          payload: { status: "answered", aiAssisted: true, reviewId: row.id, runId: row.runId },
        });
        return { rfiId: rfi.id, status: "answered" };
      }

      case "drawing_sheet": {
        if (!row.targetId) throw badRequest("Review item is missing its sheet id");
        const sheet = (
          await app.db
            .select()
            .from(drawingSheets)
            .where(and(eq(drawingSheets.id, row.targetId), eq(drawingSheets.companyId, companyId)))
            .limit(1)
        )[0];
        if (!sheet) throw notFound("Target drawing sheet not found");
        const parsed = sheetNameSchema
          .omit({ confidence: true })
          .partial()
          .parse(proposal);
        const number = parsed.number ?? sheet.number;
        if (number !== sheet.number) {
          const dupe = await app.db
            .select({ id: drawingSheets.id })
            .from(drawingSheets)
            .where(
              and(
                eq(drawingSheets.projectId, sheet.projectId),
                eq(drawingSheets.number, number),
                ne(drawingSheets.id, sheet.id),
              ),
            )
            .limit(1);
          if (dupe[0]) throw conflict(`A sheet numbered "${number}" already exists`);
        }
        await app.db
          .update(drawingSheets)
          .set({
            number,
            title: parsed.title ?? sheet.title,
            discipline: parsed.discipline ?? sheet.discipline,
            needsReview: 0,
            updatedAt: now,
          })
          .where(eq(drawingSheets.id, sheet.id));
        await appendLedger(app.db, {
          companyId,
          actorId: reviewerId,
          action: "update",
          objectType: "drawing_sheet",
          objectId: sheet.id,
          payload: {
            number,
            title: parsed.title ?? sheet.title,
            discipline: parsed.discipline ?? sheet.discipline,
            reviewId: row.id,
            runId: row.runId,
          },
        });
        return { sheetId: sheet.id, number };
      }

      case "submittal_review": {
        // Advisory only: the recommendation is recorded on the queue item and
        // in the run audit trail; the operational response stays human-driven.
        return { advisory: true, submittalId: row.targetId };
      }

      default:
        throw badRequest(`Unsupported review target type "${row.targetType}"`);
    }
  }

  app.post("/ai/review/:id/approve", { preHandler: companyGate }, async (req, reply) => {
    const row = await loadPendingReviewRow(req);
    await gateReviewer(req, reply, row);
    const applied = await applyProposal(req, row);
    const now = new Date().toISOString();
    await app.db
      .update(aiReviewQueue)
      .set({ status: "approved", reviewerId: req.user!.id, reviewedAt: now })
      .where(eq(aiReviewQueue.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "ai_review",
      objectId: row.id,
      payload: {
        status: "approved",
        targetType: row.targetType,
        targetId: row.targetId,
        runId: row.runId,
        applied,
      },
    });
    return { id: row.id, status: "approved", applied };
  });

  app.post("/ai/review/:id/reject", { preHandler: companyGate }, async (req, reply) => {
    const body = rejectBodySchema.parse(req.body ?? {});
    const row = await loadPendingReviewRow(req);
    await gateReviewer(req, reply, row);
    const now = new Date().toISOString();
    await app.db
      .update(aiReviewQueue)
      .set({ status: "rejected", reviewerId: req.user!.id, reviewedAt: now })
      .where(eq(aiReviewQueue.id, row.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "ai_review",
      objectId: row.id,
      payload: {
        status: "rejected",
        targetType: row.targetType,
        targetId: row.targetId,
        runId: row.runId,
        reason: body.reason ?? null,
      },
    });
    return { id: row.id, status: "rejected" };
  });

  /* ---------------------------------------------------------------- */
  /* Runs audit — the transparency surface (#774, Domain X #1021)      */
  /* ---------------------------------------------------------------- */

  app.get("/ai/runs", { preHandler: companyGate }, async (req) => {
    const q = runsQuerySchema.parse(req.query);
    const where = and(
      eq(aiRuns.companyId, req.companyId!),
      q.projectId ? eq(aiRuns.projectId, q.projectId) : undefined,
      q.agentKind ? eq(aiRuns.agentKind, q.agentKind) : undefined,
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
    return paginate(items, Number(totalRow[0]?.n ?? 0), q);
  });
};
