/**
 * Daily briefing agent (Vol I §6.3 #749–752; Vol II X #1017–1019, #1020).
 *
 * The briefing is written by the model from a NUMBERED EVIDENCE LIST the
 * platform assembles — attention items, project health verdicts, and the
 * since-yesterday changes. Every highlight and every proposed action must
 * cite evidence numbers; anything uncited is dropped before it is stored,
 * so the briefing can never assert something the platform does not hold.
 *
 * Proposed actions never self-apply: each one becomes an AI review queue
 * item (targetType "attention_action") for a person to approve or reject.
 * The invocation itself goes through runAgent(), so it is audited in
 * ai_runs like every other model call, and returns 503 AiDisabled when no
 * key is configured — nothing else in the layer depends on it.
 *
 * Pure parts (prompt assembly, schema, citation reconciliation) are exported
 * and unit-tested with no model in the loop.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { aiReviewQueue, pulseBriefings } from "@constructos/db";
import { BRIEFING_ACTION_KINDS, type AiAgentKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";
import { aiDisabledError, aiEnabled, runAgent, type InputRef } from "../ai/service.js";
import type { PulseResponse } from "./types.js";

/**
 * ai_runs.agent_kind is a text column; the shared AI_AGENT_KINDS union is
 * frozen for this wave and WP-AGENTS widens the validation to accept new
 * kinds. The cast records the intent: this run is a briefing, not an
 * "assistant" chat, and the audit trail should say so.
 */
export const BRIEFING_AGENT_KIND = "daily_briefing" as unknown as AiAgentKind;

export interface BriefingEvidence {
  ref: number;
  sourceType: string;
  sourceId: string;
  label: string;
  projectId: string | null;
}

export interface BriefingScope {
  projectId: string | null;
  projectName?: string | null;
  companyName?: string | null;
  today: string;
}

export interface BriefingContext {
  system: string;
  user: string;
  evidence: BriefingEvidence[];
  inputRefs: InputRef[];
}

const MAX_ATTENTION_EVIDENCE = 20;
const MAX_PROJECT_EVIDENCE = 25;

export const briefingOutputSchema = z.object({
  headline: z.string().min(1).max(300),
  summary: z.string().min(1).max(4000),
  highlights: z
    .array(
      z.object({
        text: z.string().min(1).max(1000),
        citations: z.array(z.number().int().min(1)).max(20).default([]),
      }),
    )
    .max(12)
    .default([]),
  proposedActions: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        rationale: z.string().min(1).max(1500),
        kind: z.enum(BRIEFING_ACTION_KINDS).default("other"),
        /** evidence number of the attention item the action is about, when it is about one */
        attentionRef: z.number().int().min(1).nullable().optional(),
        citations: z.array(z.number().int().min(1)).max(20).default([]),
      }),
    )
    .max(10)
    .default([]),
  /** every evidence number used anywhere above — runAgent persists it on the run */
  citations: z.array(z.number().int().min(1)).max(80).default([]),
});
export type BriefingOutput = z.infer<typeof briefingOutputSchema>;

/** Assemble the numbered evidence and the two prompt halves. Deterministic. */
export function buildBriefingContext(pulse: PulseResponse, scope: BriefingScope): BriefingContext {
  const evidence: BriefingEvidence[] = [];
  const inputRefs: InputRef[] = [];
  const push = (e: Omit<BriefingEvidence, "ref">) => {
    evidence.push({ ref: evidence.length + 1, ...e });
  };

  const attention = pulse.attention
    .filter((a) => scope.projectId === null || a.projectId === scope.projectId)
    .slice(0, MAX_ATTENTION_EVIDENCE);
  for (const a of attention) {
    push({
      sourceType: "attention_item",
      sourceId: a.id,
      projectId: a.projectId,
      label: `[${a.severity}] ${a.projectName ?? "Company"} · ${a.title} — ${a.detail}${a.dueAt ? ` (due ${a.dueAt.slice(0, 10)})` : ""}`,
    });
    inputRefs.push({ type: "attention_item", id: a.id });
  }

  const scores = pulse.scores
    .filter((s) => scope.projectId === null || s.projectId === scope.projectId)
    .slice(0, MAX_PROJECT_EVIDENCE);
  for (const s of scores) {
    const weak = s.dimensions
      .filter((d) => d.score !== null && d.level !== "on_track")
      .map((d) => `${d.key} ${d.score}`)
      .join(", ");
    const name = (s as { projectName?: string | null }).projectName ?? s.projectId;
    push({
      sourceType: "project_health",
      sourceId: s.projectId,
      projectId: s.projectId,
      label: `${name}: ${s.level.replace("_", " ")}${s.score !== null ? ` (${s.score}/100)` : ""}${weak ? ` — weak: ${weak}` : ""}`,
    });
    inputRefs.push({ type: "project_health", id: s.projectId });
  }

  const ch = pulse.changes;
  if (ch.since) {
    const parts = [
      `${ch.levelChanges.length} project level change${ch.levelChanges.length === 1 ? "" : "s"}`,
      `${ch.newAttention} new attention item${ch.newAttention === 1 ? "" : "s"}`,
      `${ch.resolvedAttention} resolved`,
    ];
    for (const lc of ch.levelChanges.slice(0, 10)) {
      parts.push(`${lc.projectName ?? lc.projectId}: ${lc.from} → ${lc.to}`);
    }
    push({
      sourceType: "pulse_changes",
      sourceId: ch.since,
      projectId: null,
      label: `Since ${ch.since.slice(0, 16).replace("T", " ")}: ${parts.join("; ")}`,
    });
  }

  const scopeLine =
    scope.projectId === null
      ? `Scope: the whole portfolio of ${scope.companyName ?? "the company"} (${pulse.portfolio.projects} projects: ${pulse.portfolio.byHealth.off_track} off track, ${pulse.portfolio.byHealth.watch} on watch, ${pulse.portfolio.byHealth.on_track} on track, ${pulse.portfolio.byHealth.unrated} unrated).`
      : `Scope: the project "${scope.projectName ?? scope.projectId}" only.`;

  const system = [
    "You are the ConstructOS daily briefing writer for a construction delivery and assurance platform.",
    `Today is ${scope.today}.`,
    scopeLine,
    "Write for a delivery director who has ninety seconds. Lead with what needs a decision today.",
    "RULES:",
    "1. Every sentence in a highlight and every proposed action MUST cite evidence numbers from the list, e.g. [3]. Uncited claims are discarded.",
    "2. Never invent figures, dates, names or records. If the evidence does not say it, do not say it.",
    "3. Do not sum money across currencies. Quote amounts with their currency exactly as given.",
    "4. Proposed actions are suggestions for a human reviewer; phrase them as actions a person would take. At most one action per attention item.",
    "5. Output ONLY a JSON object: { headline, summary, highlights: [{ text, citations }], proposedActions: [{ title, rationale, kind, attentionRef, citations }], citations }.",
    `   kind is one of ${BRIEFING_ACTION_KINDS.join(", ")}. attentionRef is the evidence number of the attention item an action concerns, or null.`,
  ].join("\n");

  const user = [
    "EVIDENCE (cite by number):",
    evidence.length === 0 ? "(none — the platform holds no attention items or health verdicts in scope)" : evidence.map((e) => `[${e.ref}] ${e.label}`).join("\n"),
    "",
    "Write the briefing now as JSON.",
  ].join("\n");

  return { system, user, evidence, inputRefs };
}

export interface ReconciledBriefing {
  highlights: Array<{ text: string; citations: number[] }>;
  proposedActions: Array<{
    title: string;
    rationale: string;
    kind: (typeof BRIEFING_ACTION_KINDS)[number];
    attentionId: string | null;
    citations: number[];
  }>;
  citations: BriefingEvidence[];
  droppedHighlights: number;
  droppedActions: number;
}

/**
 * Keep only citations that exist; drop any highlight or action left with no
 * valid citation. The stored citation list is the platform's own evidence,
 * never the model's echo of it.
 */
export function reconcileCitations(output: BriefingOutput, evidence: BriefingEvidence[]): ReconciledBriefing {
  const valid = new Set(evidence.map((e) => e.ref));
  const byRef = new Map(evidence.map((e) => [e.ref, e] as const));
  const used = new Set<number>();
  const clean = (refs: number[]) => {
    const out = [...new Set(refs.filter((r) => valid.has(r)))].sort((a, b) => a - b);
    for (const r of out) used.add(r);
    return out;
  };
  const highlights: ReconciledBriefing["highlights"] = [];
  let droppedHighlights = 0;
  for (const h of output.highlights) {
    const citations = clean(h.citations);
    if (citations.length === 0) {
      droppedHighlights += 1;
      continue;
    }
    highlights.push({ text: h.text, citations });
  }
  const proposedActions: ReconciledBriefing["proposedActions"] = [];
  let droppedActions = 0;
  for (const a of output.proposedActions) {
    const citations = clean(a.citations);
    if (citations.length === 0) {
      droppedActions += 1;
      continue;
    }
    const ev = a.attentionRef ? byRef.get(a.attentionRef) : undefined;
    proposedActions.push({
      title: a.title,
      rationale: a.rationale,
      kind: a.kind,
      attentionId: ev && ev.sourceType === "attention_item" ? ev.sourceId : null,
      citations,
    });
  }
  const citations = [...used].sort((a, b) => a - b).map((r) => byRef.get(r)!).filter(Boolean);
  return { highlights, proposedActions, citations, droppedHighlights, droppedActions };
}

export interface GenerateBriefingOptions {
  projectId: string | null;
  projectName?: string | null;
  companyName?: string | null;
  pulse: PulseResponse;
  now: Date;
}

export type BriefingRow = typeof pulseBriefings.$inferSelect;

/**
 * Run the agent, reconcile, store, route proposals to the review queue and
 * ledger the briefing. Throws AiDisabled (503) when no key is configured.
 */
export async function generateBriefing(
  app: FastifyInstance,
  req: FastifyRequest,
  opts: GenerateBriefingOptions,
): Promise<{ briefing: BriefingRow; reviewIds: string[]; dropped: { highlights: number; actions: number } }> {
  if (!aiEnabled(app)) throw aiDisabledError();
  const companyId = req.companyId!;
  const actorId = req.user!.id;
  const ctx = buildBriefingContext(opts.pulse, {
    projectId: opts.projectId,
    projectName: opts.projectName ?? null,
    companyName: opts.companyName ?? null,
    today: opts.now.toISOString().slice(0, 10),
  });
  const result = await runAgent<BriefingOutput>({
    app,
    req,
    agentKind: BRIEFING_AGENT_KIND,
    projectId: opts.projectId,
    system: ctx.system,
    user: ctx.user,
    inputRefs: ctx.inputRefs,
    maxTokens: 4000,
    schema: briefingOutputSchema,
  });
  // Fallback when the model did not return parseable JSON: the summary field
  // is bounded (1..4000), so clamp rather than let a ZodError 400 the request
  // after the run has already been made and audited.
  const output =
    result.json ??
    briefingOutputSchema.parse({
      headline: "Briefing",
      summary: (result.text.trim() || "The model returned no usable text.").slice(0, 4000),
    });
  const reconciled = reconcileCitations(output, ctx.evidence);

  const briefingId = newId("brf");
  const reviewIds: string[] = [];
  const proposals: unknown[] = [];
  for (const action of reconciled.proposedActions) {
    const reviewId = newId("airev");
    const proposal = {
      kind: action.kind,
      title: action.title,
      rationale: action.rationale,
      attentionId: action.attentionId,
      briefingId,
      citations: action.citations.map((r) => reconciled.citations.find((c) => c.ref === r)).filter(Boolean),
    };
    await app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId,
      projectId: opts.projectId,
      runId: result.runId,
      targetType: "attention_action",
      targetId: action.attentionId,
      proposal,
      summary: action.title,
      confidence: null,
      status: "pending",
    });
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "create",
      objectType: "ai_review_item",
      objectId: reviewId,
      projectId: opts.projectId,
      payload: { targetType: "attention_action", targetId: action.attentionId, runId: result.runId, briefingId },
    });
    reviewIds.push(reviewId);
    proposals.push({ ...action, reviewId });
  }

  const [briefing] = await app.db
    .insert(pulseBriefings)
    .values({
      id: briefingId,
      companyId,
      projectId: opts.projectId,
      runId: result.runId,
      headline: output.headline,
      summary: output.summary,
      highlights: reconciled.highlights,
      citations: reconciled.citations,
      proposals,
      reviewIds,
      requestedBy: actorId,
      generatedAt: opts.now.toISOString(),
    })
    .returning();

  await appendLedger(app.db, {
    companyId,
    actorId,
    action: "create",
    objectType: "pulse_briefing",
    objectId: briefingId,
    projectId: opts.projectId,
    storePayload: true,
    payload: {
      runId: result.runId,
      headline: output.headline,
      highlights: reconciled.highlights.length,
      proposals: proposals.length,
      droppedHighlights: reconciled.droppedHighlights,
      droppedActions: reconciled.droppedActions,
    },
  });

  if (reviewIds.length > 0) {
    await pushNotifications(app.db, [
      {
        companyId,
        userId: actorId,
        projectId: opts.projectId,
        kind: "agent_proposal",
        title: `Briefing proposes ${reviewIds.length} action${reviewIds.length === 1 ? "" : "s"}`,
        body: `${output.headline} — the proposals are waiting in the AI review queue.`,
        recordType: "pulse_briefing",
        recordId: briefingId,
      },
    ]);
  }

  return {
    briefing: briefing!,
    reviewIds,
    dropped: { highlights: reconciled.droppedHighlights, actions: reconciled.droppedActions },
  };
}
