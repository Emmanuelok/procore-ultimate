/**
 * Grievance triage routes (#571-572, #574) — the assistant half of intake.
 *
 * Three endpoints, one discipline: a proposal is never a decision.
 *
 *  · `GET  /grievances/:id/triage`        — the precedent panel and the rule
 *    text, computed deterministically. Works with no model, no key and no
 *    network, because the three most similar grievances this project has
 *    already handled are the single most useful thing to show an officer and
 *    they must not disappear when AI is switched off.
 *  · `POST /grievances/:id/triage`        — the cited model proposal. 503
 *    `AiDisabled` without a key (via runAgent), and the GET above still
 *    answers, so the register degrades to "no assistant" rather than "no
 *    triage".
 *  · `POST /grievances/:id/triage/decide` — the officer confirms or
 *    overrides. THIS is the write that changes the grievance: category,
 *    severity, assignee and — because severity IS the SLA — the recomputed
 *    acknowledgement and resolution deadlines and the obligation behind
 *    them. Ledgered with before/after, never with a bare list of keys.
 *  · `GET  /grievances/triage/calibration` — agreement between what was
 *    proposed and what was decided. An assistant nobody measures is an
 *    assistant nobody should trust.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: apply a model proposal by itself,
 * at any confidence. A grievance severity is a promise to a community about
 * how fast they will be answered; a model may draft that promise, it may not
 * make it.
 */

import type { FastifyInstance } from "fastify";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import {
  companyMemberships,
  grievanceTriages,
  grievances,
  obligations,
} from "@constructos/db";
import { GRIEVANCE_SEVERITIES, type GrievanceSeverity } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { addDaysISO } from "../field/dates.js";
import { aiEnabled, runAgent } from "../ai/service.js";
import { registerPolicyDefaults } from "../ai/policy.js";
import { GRIEVANCE_CATEGORIES, GRIEVANCE_SETTLED_STATUSES, GRIEVANCE_SLA } from "./reference.js";
import { wholeDaysBetween } from "./shared.js";
import {
  calibrationOf,
  precedentSuggestion,
  similarGrievances,
  slaCitations,
  type SimilarGrievance,
  type TriageCorpusItem,
} from "./triage.js";

/** How many precedents to retrieve and show. Three is what an officer reads. */
export const TRIAGE_PRECEDENT_LIMIT = 3;
/** Bound on the corpus a single triage scans — never the whole table. */
const TRIAGE_CORPUS_LIMIT = 500;

const decideSchema = z.object({
  category: z.enum(GRIEVANCE_CATEGORIES),
  severity: z.enum(GRIEVANCE_SEVERITIES),
  assigneeId: z.string().min(1).nullable().optional(),
  note: z.string().max(20000).nullable().optional(),
});

/** What the model is asked to return. Anything else fails the run loudly. */
const proposalSchema = z.object({
  category: z.enum(GRIEVANCE_CATEGORIES),
  severity: z.enum(GRIEVANCE_SEVERITIES),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(4000),
  citations: z
    .array(
      z.object({
        type: z.string().max(60),
        id: z.string().max(120),
        quote: z.string().max(2000).optional(),
      }),
    )
    .default([]),
});

const SETTLED: readonly string[] = GRIEVANCE_SETTLED_STATUSES;

const SYSTEM_PROMPT =
  "You are a grievance-redress triage assistant on an infrastructure project governed by IFC " +
  "Performance Standard 5 and the project's published grievance mechanism.\n\n" +
  "You are given ONE new grievance description, the project's published service standard " +
  "(severity to acknowledgement and resolution days), and the most similar grievances this " +
  "project has already handled, with how they were classified and how they ended.\n\n" +
  "Propose a category and a severity. Rules you must follow:\n" +
  "1. Cite. Every element of your reasoning must point at a supplied record: a precedent by its " +
  "id, or the service-standard rule for the severity you propose. Do not cite anything not " +
  "supplied to you.\n" +
  "2. Severity is a service promise, not a sentiment. Choose it by the rule text: harm to " +
  "safety, livelihood, gender-based violence or security-force conduct is critical; loss of " +
  "access, damage to a structure or crop and withheld compensation is high; nuisance impacts " +
  "and employment complaints are medium; information requests are low.\n" +
  "3. When the precedents disagree with each other, say so in the rationale and lower your " +
  "confidence. Do not invent agreement.\n" +
  "4. You are proposing to a human officer who will confirm or override you. Never state a " +
  "conclusion about the merits of the complaint, the complainant, or who is at fault.\n\n" +
  'Reply with JSON only: {"category":…,"severity":…,"confidence":0..1,"rationale":…,' +
  '"citations":[{"type":"grievance"|"sla_rule","id":…,"quote":…}]}';

/**
 * Triage proposes; it never applies. `propose_only` is not a conservative
 * default here, it is the only correct one: the severity decides how fast a
 * community member is answered, and that promise is made by a person.
 */
registerPolicyDefaults("grievance_triage", {
  authorisation: "propose_only",
  minConfidence: 0.35,
  allowedTargetTypes: ["grievance"],
  maxRunsPerDay: 300,
});

export async function registerGrievanceTriageRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];

  async function fetchGrievance(grievanceId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(grievances)
      .where(
        and(
          eq(grievances.id, grievanceId),
          eq(grievances.companyId, companyId),
          eq(grievances.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Grievance not found");
    return rows[0];
  }

  /**
   * The precedent corpus: every OTHER grievance on this project, most recent
   * first, bounded. Bounded matters — a scheme with fifteen thousand
   * grievances must not load them all to rank three.
   */
  async function loadCorpus(
    companyId: string,
    projectId: string,
    excludeId: string,
  ): Promise<TriageCorpusItem[]> {
    const rows = await app.db
      .select({
        id: grievances.id,
        number: grievances.number,
        description: grievances.description,
        category: grievances.category,
        severity: grievances.severity,
        status: grievances.status,
        resolution: grievances.resolution,
        receivedAt: grievances.receivedAt,
        resolvedAt: grievances.resolvedAt,
        complainantSatisfied: grievances.complainantSatisfied,
      })
      .from(grievances)
      .where(
        and(
          eq(grievances.companyId, companyId),
          eq(grievances.projectId, projectId),
          ne(grievances.id, excludeId),
        ),
      )
      .orderBy(desc(grievances.number))
      .limit(TRIAGE_CORPUS_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      description: r.description,
      category: r.category,
      severity: r.severity,
      status: r.status,
      resolution: r.resolution,
      resolutionDays:
        r.resolvedAt === null
          ? null
          : wholeDaysBetween(r.receivedAt, r.resolvedAt.slice(0, 10)),
      complainantSatisfied:
        r.complainantSatisfied === null ? null : r.complainantSatisfied === 1,
    }));
  }

  /** Precedent view-model: never leaks a complainant's identity into a panel. */
  const precedentView = (m: SimilarGrievance) => ({
    id: m.id,
    number: m.number,
    score: m.score,
    category: m.category,
    severity: m.severity,
    status: m.status,
    resolutionDays: m.resolutionDays,
    complainantSatisfied: m.complainantSatisfied,
    sharedTerms: m.sharedTerms,
    excerpt: m.description.slice(0, 400),
  });

  /* ---------------------------------------------------------------- */
  /* Deterministic panel — works with the model switched off           */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/grievances/:grievanceId/triage",
    { preHandler: readGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      const corpus = await loadCorpus(req.companyId!, req.projectId!, g.id);
      const matches = similarGrievances(g.description, corpus, TRIAGE_PRECEDENT_LIMIT);
      const suggestion = precedentSuggestion(matches);
      const history = await app.db
        .select()
        .from(grievanceTriages)
        .where(
          and(
            eq(grievanceTriages.companyId, req.companyId!),
            eq(grievanceTriages.grievanceId, g.id),
          ),
        )
        .orderBy(desc(grievanceTriages.createdAt));
      return {
        grievanceId: g.id,
        number: g.number,
        current: { category: g.category, severity: g.severity, assigneeId: g.assigneeId },
        precedents: matches.map(precedentView),
        corpusSize: corpus.length,
        corpusTruncated: corpus.length === TRIAGE_CORPUS_LIMIT,
        suggestion,
        slaRules: slaCitations(),
        proposals: history,
        aiAvailable: aiEnabled(app),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cited model proposal                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/grievances/:grievanceId/triage",
    { preHandler: standardGate },
    async (req, reply) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) {
        throw badRequest(`A ${g.status} grievance is no longer awaiting triage`);
      }
      const corpus = await loadCorpus(req.companyId!, req.projectId!, g.id);
      const matches = similarGrievances(g.description, corpus, TRIAGE_PRECEDENT_LIMIT);
      const rules = slaCitations();

      const context =
        `NEW GRIEVANCE ${g.number}\n` +
        `Received: ${g.receivedAt}\nChannel: ${g.channel}\n` +
        `Currently classified: ${g.category} / ${g.severity} (the intake officer's first pass)\n` +
        `Description:\n${g.description}\n\n` +
        `PUBLISHED SERVICE STANDARD\n` +
        rules.map((r) => `[sla_rule:${r.severity}] ${r.rule}`).join("\n") +
        `\n\nSIMILAR GRIEVANCES ALREADY HANDLED ON THIS PROJECT\n` +
        (matches.length === 0
          ? "(none — this project has no prior grievance sharing wording with this one)"
          : matches
              .map(
                (m) =>
                  `[grievance:${m.id}] #${m.number} · ${m.category}/${m.severity} · ` +
                  `${m.status}${m.resolutionDays === null ? "" : ` · resolved in ${m.resolutionDays}d`}` +
                  `${m.complainantSatisfied === null ? "" : ` · complainant ${m.complainantSatisfied ? "satisfied" : "not satisfied"}`}\n` +
                  `${m.description.slice(0, 800)}` +
                  `${m.resolution ? `\nResolution offered: ${m.resolution.slice(0, 400)}` : ""}`,
              )
              .join("\n\n"));

      const result = await runAgent({
        app,
        req,
        agentKind: "grievance_triage",
        projectId: req.projectId!,
        source: "user",
        sourceRef: g.id,
        system: SYSTEM_PROMPT,
        user: context,
        schema: proposalSchema,
        maxTokens: 2000,
        contextChars: context.length,
        dataCategories: ["community_grievance"],
        inputRefs: [
          { type: "grievance", id: g.id },
          ...matches.map((m) => ({ type: "grievance", id: m.id })),
          ...rules.map((r) => ({ type: "sla_rule", id: r.severity })),
        ],
      });
      const proposal = result.json;
      if (!proposal) throw badRequest("The triage agent returned no usable proposal");

      const id = newId("gtri");
      await app.db.insert(grievanceTriages).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        grievanceId: g.id,
        runId: result.runId,
        method: "agent",
        proposedCategory: proposal.category,
        proposedSeverity: proposal.severity,
        proposedAssigneeId: null,
        confidence: proposal.confidence,
        rationale: proposal.rationale,
        ruleCitations: rules as unknown[],
        precedents: matches.map(precedentView) as unknown[],
        citations: result.grounding.citations,
        createdBy: req.user!.id,
      });
      /*
       * A proposal is an AI output about a community complaint: it goes in
       * the ledger as an `access` (a read that produced a record), never as a
       * state change of the grievance — nothing about the grievance changed.
       */
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "grievance_triage",
        objectId: id,
        projectId: req.projectId!,
        payload: {
          grievanceId: g.id,
          runId: result.runId,
          proposed: { category: proposal.category, severity: proposal.severity },
          current: { category: g.category, severity: g.severity },
          confidence: proposal.confidence,
          citations: result.grounding.citations.length,
          droppedCitations: result.grounding.dropped,
          precedents: matches.map((m) => m.id),
        },
        storePayload: true,
      });

      return reply.status(201).send({
        id,
        runId: result.runId,
        method: "agent",
        proposedCategory: proposal.category,
        proposedSeverity: proposal.severity,
        confidence: proposal.confidence,
        rationale: proposal.rationale,
        citations: result.grounding.citations,
        droppedCitations: result.grounding.dropped,
        evidenceScore: result.grounding.evidenceScore,
        precedents: matches.map(precedentView),
        slaRules: rules,
        /* the honest framing: this changed nothing yet */
        applied: false,
        decisionRequired:
          "A triage proposal changes nothing on its own. POST .../triage/decide to confirm or " +
          "override it; the severity you decide is the SLA the community is promised.",
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* The officer decides — the only write that moves the grievance     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/grievances/:grievanceId/triage/decide",
    { preHandler: standardGate },
    async (req) => {
      const { grievanceId } = req.params as { grievanceId: string };
      const body = decideSchema.parse(req.body);
      const g = await fetchGrievance(grievanceId, req.companyId!, req.projectId!);
      if (SETTLED.includes(g.status)) {
        throw badRequest(`A ${g.status} grievance can no longer be re-triaged`);
      }
      if (body.assigneeId) {
        const member = await app.db
          .select({ userId: companyMemberships.userId })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, req.companyId!),
              eq(companyMemberships.userId, body.assigneeId),
            ),
          )
          .limit(1);
        if (!member[0]) throw badRequest("assigneeId is not a member of this company");
      }

      const severity = body.severity as GrievanceSeverity;
      const sla = GRIEVANCE_SLA[severity];
      /*
       * Severity IS the SLA, so a re-triage moves the clocks. They are
       * recomputed from `receivedAt` — the date the community raised it —
       * never from today, because re-classifying a grievance must not buy the
       * project a fresh 30 days.
       */
      const acknowledgeDueAt = addDaysISO(g.receivedAt, sla.acknowledgeDays);
      const resolveDueAt = addDaysISO(g.receivedAt, sla.resolveDays);
      const now = new Date().toISOString();
      const before = {
        category: g.category,
        severity: g.severity,
        assigneeId: g.assigneeId,
        status: g.status,
        acknowledgeDueAt: g.acknowledgeDueAt,
        resolveDueAt: g.resolveDueAt,
      };
      const assigneeId = body.assigneeId === undefined ? g.assigneeId : body.assigneeId;
      /*
       * Naming a handler at triage is the same act as POST /assign, so it
       * moves the case the same way: a grievance that has only been received
       * or acknowledged is now being investigated by someone. Two routes
       * writing the same column must not leave the record in two different
       * states.
       */
      const status =
        assigneeId !== null &&
        assigneeId !== g.assigneeId &&
        (g.status === "received" || g.status === "acknowledged")
          ? "investigating"
          : g.status;
      const after = {
        category: body.category,
        severity: body.severity,
        assigneeId,
        status,
        acknowledgeDueAt,
        resolveDueAt,
      };

      /** the newest undecided proposal is the one this decision answers */
      const [pending] = await app.db
        .select()
        .from(grievanceTriages)
        .where(
          and(
            eq(grievanceTriages.companyId, req.companyId!),
            eq(grievanceTriages.grievanceId, g.id),
          ),
        )
        .orderBy(desc(grievanceTriages.createdAt))
        .limit(1);

      await app.db.transaction(async (tx) => {
        await tx
          .update(grievances)
          .set({ ...after, updatedAt: now })
          .where(eq(grievances.id, g.id));
        if (g.obligationId) {
          await tx
            .update(obligations)
            .set({
              deadline: `${resolveDueAt}T23:59:59Z`,
              trigger:
                `Grievance ${g.number} received ${g.receivedAt}; severity ${body.severity} → ` +
                `${sla.resolveDays}-day resolution standard`,
            })
            .where(
              and(
                eq(obligations.id, g.obligationId),
                eq(obligations.companyId, req.companyId!),
              ),
            );
        }
        if (pending && pending.decidedAt === null) {
          await tx
            .update(grievanceTriages)
            .set({
              decidedCategory: body.category,
              decidedSeverity: body.severity,
              decidedAssigneeId: after.assigneeId,
              decisionNote: body.note ?? null,
              decidedAt: now,
              decidedBy: req.user!.id,
            })
            .where(eq(grievanceTriages.id, pending.id));
        }
      });

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "grievance",
        objectId: g.id,
        projectId: req.projectId!,
        payload: {
          event: "triaged",
          before,
          after,
          note: body.note ?? null,
          triageId: pending && pending.decidedAt === null ? pending.id : null,
          proposalAgreed:
            pending && pending.decidedAt === null
              ? {
                  category: pending.proposedCategory === body.category,
                  severity: pending.proposedSeverity === body.severity,
                }
              : null,
          slaBasis: `${sla.acknowledgeDays}-day acknowledgement / ${sla.resolveDays}-day resolution`,
        },
        storePayload: true,
      });

      const updated = await fetchGrievance(g.id, req.companyId!, req.projectId!);
      return {
        ...updated,
        isAnonymous: updated.isAnonymous === 1,
        slaBasis: sla,
        deadlinesRecomputedFrom: updated.receivedAt,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Calibration                                                       */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/grievances/triage/calibration",
    { preHandler: readGate },
    async (req) => {
      const rows = await app.db
        .select({
          proposedCategory: grievanceTriages.proposedCategory,
          proposedSeverity: grievanceTriages.proposedSeverity,
          proposedAssigneeId: grievanceTriages.proposedAssigneeId,
          decidedCategory: grievanceTriages.decidedCategory,
          decidedSeverity: grievanceTriages.decidedSeverity,
          decidedAssigneeId: grievanceTriages.decidedAssigneeId,
          decidedAt: grievanceTriages.decidedAt,
          method: grievanceTriages.method,
        })
        .from(grievanceTriages)
        .where(
          and(
            eq(grievanceTriages.companyId, req.companyId!),
            eq(grievanceTriages.projectId, req.projectId!),
          ),
        );
      const agentRows = rows.filter((r) => r.method === "agent");
      return {
        overall: calibrationOf(rows),
        agent: calibrationOf(agentRows),
      };
    },
  );
}
