/**
 * The generic agent runner: gather → model → parse → propose → queue.
 *
 * One code path executes every fleet agent, which is the point. It means the
 * policy check, the citation validation, the evidence score, the supersession
 * of stale proposals, the auto-apply ceiling and the ledger entry are written
 * once and are identical for all eighteen kinds — a new agent cannot forget
 * to be governed.
 *
 * Two guarantees worth stating plainly:
 *   · An agent with nothing to look at does NOT call the model. `gather()`
 *     returns a skip reason and the run is reported as skipped with that
 *     reason, because a confident answer over no evidence is the failure mode
 *     this platform exists to prevent.
 *   · Nothing is auto-applied unless the tenant's policy says so AND the
 *     target type is one of the low-consequence ones. Everything else waits
 *     for a person.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { aiReviewQueue, signals } from "@constructos/db";
import {
  AGENT_AUTO_APPLY_TARGET_TYPES,
  type AgentRunSource,
  type SignalSeverity,
} from "@constructos/shared";
import { appendLedger } from "../../lib/ledger.js";
import { newId } from "../../lib/ids.js";
import { pushNotifications } from "../notifications/service.js";
import {
  applyProposal,
  claimReviewItem,
  recordAgentAction,
  supersedePending,
} from "./actions.js";
import { effectiveConfidence } from "./evidence.js";
import { autoApplyVerdict, loadEffectivePolicy, type EffectivePolicy } from "./policy.js";
import { noteRunOutcome } from "./run-meta.js";
import { aiAgentDisabledError, runAgent } from "./service.js";
import type { AgentContext, AnyAgentDefinition, ProposalDraft } from "./agents/types.js";

/* ------------------------------------------------------------------ */
/* Creating one proposal                                               */
/* ------------------------------------------------------------------ */

export interface CreateProposalArgs {
  app: FastifyInstance;
  companyId: string;
  projectId: string | null;
  /** the person on whose behalf the run happened; null for a system run */
  actorId: string | null;
  runId: string;
  agentKind: string;
  targetType: string;
  targetId: string | null;
  proposal: Record<string, unknown>;
  summary: string;
  /** the model's own number */
  modelConfidence: number | null;
  evidenceScore: number | null;
  droppedCitations: number;
  policy: EffectivePolicy;
}

export interface CreateProposalResult {
  status: "queued" | "auto_applied" | "filtered";
  reviewId: string | null;
  actionId: string | null;
  confidence: number | null;
  reason: string;
  superseded: string[];
  applied?: Record<string, unknown>;
}

/**
 * Queue one proposal for review — superseding any earlier pending proposal
 * for the same target — and auto-apply it only where policy permits.
 */
export async function createProposal(args: CreateProposalArgs): Promise<CreateProposalResult> {
  const { app } = args;
  const now = new Date().toISOString();
  const confidence = effectiveConfidence(
    args.modelConfidence,
    args.evidenceScore,
    args.droppedCitations,
  );

  if (
    args.policy.minConfidence !== null &&
    (confidence === null || confidence < args.policy.minConfidence)
  ) {
    return {
      status: "filtered",
      reviewId: null,
      actionId: null,
      confidence,
      reason: `Confidence ${confidence ?? "unavailable"} is below the tenant's minimum ${args.policy.minConfidence}; the proposal was recorded on the run but not queued`,
      superseded: [],
    };
  }

  const id = newId("airev");
  const superseded = await supersedePending(
    app.db,
    args.companyId,
    args.targetType,
    args.targetId,
    id,
    now,
  );
  await app.db.insert(aiReviewQueue).values({
    id,
    companyId: args.companyId,
    projectId: args.projectId,
    runId: args.runId,
    targetType: args.targetType,
    targetId: args.targetId,
    proposal: args.proposal,
    summary: args.summary.slice(0, 500),
    confidence,
    status: "pending",
  });
  for (const supersededId of superseded) {
    await appendLedger(app.db, {
      companyId: args.companyId,
      actorId: args.actorId,
      action: "state_change",
      objectType: "ai_review",
      objectId: supersededId,
      payload: { status: "superseded", supersededBy: id, targetType: args.targetType },
      projectId: args.projectId,
    });
  }
  await appendLedger(app.db, {
    companyId: args.companyId,
    actorId: args.actorId,
    action: "create",
    objectType: "ai_review",
    objectId: id,
    payload: {
      targetType: args.targetType,
      targetId: args.targetId,
      runId: args.runId,
      agentKind: args.agentKind,
      confidence,
    },
    projectId: args.projectId,
  });

  const verdict = autoApplyVerdict(
    args.policy,
    args.targetType,
    confidence,
    AGENT_AUTO_APPLY_TARGET_TYPES,
  );
  if (!verdict.auto) {
    return {
      status: "queued",
      reviewId: id,
      actionId: null,
      confidence,
      reason: verdict.reason,
      superseded,
    };
  }

  const applied = await applyReviewItem({
    app,
    reviewId: id,
    companyId: args.companyId,
    actorId: args.actorId,
    agentKind: args.agentKind,
    authorisation: args.policy.authorisation,
    policyId: args.policy.policyId,
  });
  return {
    status: "auto_applied",
    reviewId: id,
    actionId: applied.actionId,
    confidence,
    reason: verdict.reason,
    superseded,
    applied: applied.applied,
  };
}

/* ------------------------------------------------------------------ */
/* Approving (the atomic path)                                         */
/* ------------------------------------------------------------------ */

export interface ApplyReviewArgs {
  app: FastifyInstance;
  reviewId: string;
  companyId: string;
  actorId: string | null;
  agentKind: string;
  authorisation: string;
  policyId: string | null;
}

export interface ApplyReviewResult {
  reviewId: string;
  actionId: string | null;
  applied: Record<string, unknown>;
  projectId: string | null;
  targetType: string;
  targetId: string | null;
  runId: string;
}

/**
 * Claim + apply + record the action in ONE transaction; ledger and notify
 * after it commits (the ordering every module on this platform uses).
 *
 * If the guard refuses (a stale RFI proposal, a submitted daily log) the
 * transaction rolls back — the claim included — and the item is then marked
 * superseded so nobody can try the same stale proposal again.
 */
export async function applyReviewItem(args: ApplyReviewArgs): Promise<ApplyReviewResult> {
  const { app } = args;
  const now = new Date().toISOString();

  let outcome: {
    reviewId: string;
    actionId: string | null;
    applied: Record<string, unknown>;
    projectId: string | null;
    targetType: string;
    targetId: string | null;
    runId: string;
    ledger: Awaited<ReturnType<typeof applyProposal>>["ledger"];
    notifications: Awaited<ReturnType<typeof applyProposal>>["notifications"];
    confidence: number | null;
    summary: string;
  };

  try {
    outcome = await app.db.transaction(async (tx) => {
      const row = await claimReviewItem(
        tx,
        args.reviewId,
        args.companyId,
        "approved",
        args.actorId,
        now,
      );
      const result = await applyProposal(tx, row, {
        companyId: args.companyId,
        actorId: args.actorId,
        now,
        agentKind: args.agentKind,
        authorisation: args.authorisation,
        policyId: args.policyId,
      });
      const actionId = await recordAgentAction(tx, {
        companyId: args.companyId,
        projectId: row.projectId,
        agentKind: args.agentKind,
        runId: row.runId,
        reviewId: row.id,
        draft: result.action,
        appliedBy: args.actorId,
        now,
        authorisation: args.authorisation,
        policyId: args.policyId,
        confidence: row.confidence,
        summary: row.summary,
      });
      return {
        reviewId: row.id,
        actionId,
        applied: result.applied,
        projectId: row.projectId,
        targetType: row.targetType,
        targetId: row.targetId,
        runId: row.runId,
        ledger: result.ledger,
        notifications: result.notifications,
        confidence: row.confidence,
        summary: row.summary,
      };
    });
  } catch (err) {
    // The claim rolled back with everything else, so the item is still
    // pending. A guard refusal means the proposal is STALE, not retryable:
    // mark it superseded so the next reviewer is not offered it again.
    if (err instanceof Error && (err as { statusCode?: number }).statusCode === 409) {
      await app.db
        .update(aiReviewQueue)
        .set({ status: "superseded", reviewedAt: now })
        .where(
          and(
            eq(aiReviewQueue.id, args.reviewId),
            eq(aiReviewQueue.companyId, args.companyId),
            eq(aiReviewQueue.status, "pending"),
          ),
        );
    }
    throw err;
  }

  for (const entry of outcome.ledger) {
    await appendLedger(app.db, {
      companyId: args.companyId,
      actorId: args.actorId,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      payload: entry.payload,
      projectId: entry.projectId ?? outcome.projectId,
    });
  }
  await appendLedger(app.db, {
    companyId: args.companyId,
    actorId: args.actorId,
    action: "state_change",
    objectType: "ai_review",
    objectId: outcome.reviewId,
    payload: {
      status: "approved",
      targetType: outcome.targetType,
      targetId: outcome.targetId,
      runId: outcome.runId,
      agentKind: args.agentKind,
      authorisation: args.authorisation,
      actionId: outcome.actionId,
      applied: outcome.applied,
    },
    projectId: outcome.projectId,
  });
  if (outcome.notifications.length > 0) {
    await pushNotifications(app.db, outcome.notifications);
  }

  return {
    reviewId: outcome.reviewId,
    actionId: outcome.actionId,
    applied: outcome.applied,
    projectId: outcome.projectId,
    targetType: outcome.targetType,
    targetId: outcome.targetId,
    runId: outcome.runId,
  };
}

/* ------------------------------------------------------------------ */
/* Executing one agent                                                 */
/* ------------------------------------------------------------------ */

export interface ExecuteAgentArgs {
  app: FastifyInstance;
  req?: FastifyRequest;
  companyId: string;
  actorId: string | null;
  projectId: string | null;
  def: AnyAgentDefinition;
  params: Record<string, unknown>;
  source: AgentRunSource;
  sourceRef?: string | null;
  now?: Date;
}

export interface ExecuteAgentResult {
  runId: string | null;
  agentKind: string;
  skipped: boolean;
  summary: string;
  proposals: number;
  queued: number;
  filtered: number;
  actions: number;
  signals: number;
  reviewIds: string[];
  evidenceScore: number | null;
  droppedCitations: number;
  confidence: number | null;
  usage: { inputTokens: number; outputTokens: number; costMicros: number } | null;
}

export async function executeAgent(args: ExecuteAgentArgs): Promise<ExecuteAgentResult> {
  const { app, def } = args;
  const now = args.now ?? new Date();
  const ctx: AgentContext = {
    app,
    db: app.db,
    companyId: args.companyId,
    projectId: args.projectId,
    params: args.params,
    now,
  };

  // Policy first: a disabled agent must not even read the tenant's records,
  // and a refusal must not depend on whether there happened to be data.
  const policy = await loadEffectivePolicy(app, args.companyId, def.kind);
  if (!policy.enabled) {
    throw aiAgentDisabledError(
      `The "${def.kind}" agent is disabled for this company by policy`,
    );
  }

  const gathered = await def.gather(ctx);
  if (gathered.skip || gathered.inputRefs.length === 0) {
    return {
      runId: null,
      agentKind: def.kind,
      skipped: true,
      summary: gathered.skip ?? "No records to analyse",
      proposals: 0,
      queued: 0,
      filtered: 0,
      actions: 0,
      signals: 0,
      reviewIds: [],
      evidenceScore: null,
      droppedCitations: 0,
      confidence: null,
      usage: null,
    };
  }

  const result = await runAgent({
    app,
    req: args.req,
    companyId: args.companyId,
    actorId: args.actorId,
    source: args.source,
    sourceRef: args.sourceRef ?? null,
    agentKind: def.kind,
    projectId: args.projectId,
    system: def.system,
    user: gathered.context,
    inputRefs: gathered.inputRefs,
    schema: def.schema,
    requireCitations: def.requireCitations,
    maxTokens: def.maxTokens,
    dataCategories: [...def.dataCategories],
    contextChars: gathered.context.length,
    policy,
  });

  const drafts: ProposalDraft[] = def.propose(result.json, ctx, gathered);
  const reviewIds: string[] = [];
  let queued = 0;
  let filtered = 0;
  let actions = 0;
  let signalCount = 0;
  let confidence: number | null = null;

  for (const draft of drafts) {
    const created = await createProposal({
      app,
      companyId: args.companyId,
      projectId: args.projectId,
      actorId: args.actorId,
      runId: result.runId,
      agentKind: def.kind,
      targetType: draft.targetType,
      targetId: draft.targetId,
      proposal: { ...draft.proposal, runId: result.runId, agentKind: def.kind },
      summary: draft.summary,
      modelConfidence: draft.confidence,
      evidenceScore: result.grounding.evidenceScore,
      droppedCitations: result.grounding.dropped,
      policy,
    });
    confidence = confidence ?? created.confidence;
    if (created.status === "filtered") filtered += 1;
    else {
      queued += 1;
      if (created.reviewId) reviewIds.push(created.reviewId);
      if (created.status === "auto_applied") actions += 1;
    }

    if (draft.signal) {
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId: args.companyId,
        projectId: args.projectId,
        detector: draft.signal.detector,
        severity: draft.signal.severity as SignalSeverity,
        confidence: created.confidence ?? 0.5,
        title: draft.signal.title.slice(0, 200),
        explanation: `${draft.signal.explanation}\n\n(Raised by the ${def.name} from AI run ${result.runId}; a human reviewer dispositions it.)`.slice(
          0,
          20_000,
        ),
        evidenceRefs: [...draft.signal.evidenceRefs, { type: "ai_run", id: result.runId }],
        disposition: "new",
      });
      await appendLedger(app.db, {
        companyId: args.companyId,
        actorId: args.actorId,
        action: "create",
        objectType: "signal",
        objectId: signalId,
        payload: {
          detector: draft.signal.detector,
          severity: draft.signal.severity,
          agentKind: def.kind,
          runId: result.runId,
        },
        projectId: args.projectId,
      });
      signalCount += 1;
    }
  }

  await noteRunOutcome(app.db, result.runId, {
    proposalCount: drafts.length,
    actionCount: actions,
  });

  return {
    runId: result.runId,
    agentKind: def.kind,
    skipped: false,
    summary: def.summarise(result.json, drafts),
    proposals: drafts.length,
    queued,
    filtered,
    actions,
    signals: signalCount,
    reviewIds,
    evidenceScore: result.grounding.evidenceScore,
    droppedCitations: result.grounding.dropped,
    confidence,
    usage: result.usage,
  };
}
