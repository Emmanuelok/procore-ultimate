/**
 * Applying and REVERSING what an agent proposed (Vol II X #1020, #1022,
 * #1023).
 *
 * Three properties this file exists to guarantee:
 *
 *  1. ATOMIC. A proposal is claimed with a conditional UPDATE … WHERE
 *     status='pending' RETURNING, inside the same transaction that applies
 *     it. Two reviewers double-clicking Approve produce one applied change
 *     and one 409, not two RFI updates and two ledger entries.
 *
 *  2. IT OBEYS THE OWNING MODULE'S STATE MACHINE. An approved AI proposal is
 *     not a back door. A stale RFI proposal cannot overwrite a human's
 *     official response on an RFI that has moved on, and a submitted or
 *     approved daily log cannot be replaced by a draft. Where the guard
 *     refuses, the queue item is marked superseded so it can never be tried
 *     again.
 *
 *  3. IT IS REVERSIBLE. Every application records a BEFORE-IMAGE of exactly
 *     the fields it touched, in `agent_actions`. Rollback restores them,
 *     flips the queue item to `reverted`, and ledgers both — so "the agent
 *     did this and we undid it" is a fact on the chain, not a memory.
 *
 * Ledger appends and notifications are RETURNED rather than performed: the
 * caller runs them after the transaction commits, which is how every other
 * module on this platform orders those two things.
 */
import { and, eq, isNull, lt, ne } from "drizzle-orm";
import {
  agentActions,
  aiReviewQueue,
  dailyLogs,
  drawingSheets,
  rfis,
  signals,
} from "@constructos/db";
import type { LedgerAction } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import type { NotifyTarget } from "../notifications/service.js";

export type ReviewRow = typeof aiReviewQueue.$inferSelect;
export type ActionRow = typeof agentActions.$inferSelect;

export interface PendingLedger {
  action: LedgerAction;
  objectType: string;
  objectId: string;
  payload: Record<string, unknown>;
  projectId?: string | null;
}

export interface ApplyContext {
  companyId: string;
  /** the reviewer, or null for a policy auto-apply (system actor) */
  actorId: string | null;
  now: string;
  agentKind: string;
  authorisation: string;
  policyId: string | null;
}

export interface ActionDraft {
  actionType: string;
  targetType: string;
  targetId: string | null;
  beforeImage: Record<string, unknown> | null;
  afterImage: Record<string, unknown> | null;
  reversible: boolean;
  irreversibleReason: string | null;
}

export interface ApplyResult {
  applied: Record<string, unknown>;
  action: ActionDraft;
  ledger: PendingLedger[];
  notifications: NotifyTarget[];
}

const IMPACT_VALUES = new Set(["yes", "no", "tbd"]);

function impactOf(value: unknown, fallback: string): string {
  return typeof value === "string" && IMPACT_VALUES.has(value) ? value : fallback;
}

/** Target types whose approval mutates a record another module owns. */
export const OPERATIONAL_TARGET_TYPES = [
  "daily_log",
  "rfi_response",
  "drawing_sheet",
  "signal_explanation",
] as const;

/* ------------------------------------------------------------------ */
/* Supersession (#1020)                                                */
/* ------------------------------------------------------------------ */

/**
 * Mark every other pending proposal for the same target as superseded.
 * Called when a new proposal is created and when a guard refuses an old one:
 * duplicate pending items for one target were the mechanism by which a stale
 * proposal stayed applicable forever.
 *
 * Scoped by PROJECT as well as company. A `daily_log` proposal's targetId is
 * a calendar DATE, not a record id, so without the project predicate queuing
 * a draft on one project silently superseded another project's pending draft
 * for the same day — and ledgered that state change against the wrong
 * project.
 */
export async function supersedePending(
  db: Db,
  companyId: string,
  projectId: string | null,
  targetType: string,
  targetId: string | null,
  exceptId: string | null,
  now: string,
): Promise<string[]> {
  if (!targetId) return [];
  const rows = await db
    .update(aiReviewQueue)
    .set({ status: "superseded", reviewedAt: now })
    .where(
      and(
        eq(aiReviewQueue.companyId, companyId),
        projectId === null
          ? isNull(aiReviewQueue.projectId)
          : eq(aiReviewQueue.projectId, projectId),
        eq(aiReviewQueue.targetType, targetType),
        eq(aiReviewQueue.targetId, targetId),
        eq(aiReviewQueue.status, "pending"),
        exceptId ? ne(aiReviewQueue.id, exceptId) : undefined,
      ),
    )
    .returning({ id: aiReviewQueue.id });
  return rows.map((r) => r.id);
}

/**
 * Pending items older than `days` are stale: the record they were computed
 * from has almost certainly moved. Sweeping them is what keeps "pending"
 * meaning "someone should look at this".
 */
export async function supersedeStale(
  db: Db,
  companyId: string,
  olderThanIso: string,
  now: string,
): Promise<string[]> {
  const rows = await db
    .update(aiReviewQueue)
    .set({ status: "superseded", reviewedAt: now })
    .where(
      and(
        eq(aiReviewQueue.companyId, companyId),
        eq(aiReviewQueue.status, "pending"),
        lt(aiReviewQueue.createdAt, olderThanIso),
      ),
    )
    .returning({ id: aiReviewQueue.id });
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Claiming                                                            */
/* ------------------------------------------------------------------ */

/**
 * Claim a pending item for one reviewer. Conditional on status='pending', so
 * exactly one concurrent caller wins and the loser sees 409 rather than
 * applying the same proposal a second time.
 */
export async function claimReviewItem(
  tx: Db,
  id: string,
  companyId: string,
  status: "approved" | "rejected",
  reviewerId: string | null,
  now: string,
): Promise<ReviewRow> {
  const rows = await tx
    .update(aiReviewQueue)
    .set({ status, reviewerId, reviewedAt: now })
    .where(
      and(
        eq(aiReviewQueue.id, id),
        eq(aiReviewQueue.companyId, companyId),
        eq(aiReviewQueue.status, "pending"),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    throw conflict("Review item is not pending — it was already decided, superseded or reverted");
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

export async function applyProposal(
  tx: Db,
  row: ReviewRow,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const proposal = (row.proposal ?? {}) as Record<string, unknown>;
  const actorId = ctx.actorId;

  switch (row.targetType) {
    /* ---------------------------------------------------------------- */
    case "daily_log": {
      const logDate = row.targetId;
      if (!row.projectId || !logDate) throw badRequest("Review item is missing project or date");
      if (!actorId) {
        throw badRequest("A daily log needs an authoring reviewer; it cannot be auto-applied");
      }
      const [existing] = await tx
        .select()
        .from(dailyLogs)
        .where(
          and(
            eq(dailyLogs.companyId, ctx.companyId),
            eq(dailyLogs.projectId, row.projectId),
            eq(dailyLogs.logDate, logDate),
            eq(dailyLogs.createdBy, actorId),
          ),
        )
        .limit(1);

      // field/dailyLogs.ts forbids editing any non-draft log. An approved AI
      // draft must not be the one path that gets around it.
      if (existing && existing.status !== "draft") {
        throw conflict(
          `The ${logDate} daily log is "${existing.status}" and cannot be replaced by an AI draft`,
        );
      }

      const sections = (proposal["sections"] ?? {}) as Record<string, unknown>;
      const notes = typeof proposal["notes"] === "string" ? (proposal["notes"] as string) : null;
      const weather =
        proposal["weather"] && typeof proposal["weather"] === "object"
          ? (proposal["weather"] as Record<string, unknown>)
          : null;

      if (existing) {
        const beforeImage = {
          created: false,
          sections: existing.sections,
          notes: existing.notes,
          weather: existing.weather,
          aiDrafted: existing.aiDrafted,
          status: existing.status,
        };
        await tx
          .update(dailyLogs)
          .set({
            sections,
            notes: notes ?? existing.notes,
            weather: weather ?? existing.weather,
            aiDrafted: 1,
            updatedAt: ctx.now,
          })
          .where(eq(dailyLogs.id, existing.id));
        return {
          applied: { dailyLogId: existing.id, logDate, created: false },
          action: {
            actionType: "update_daily_log",
            targetType: "daily_log",
            targetId: existing.id,
            beforeImage,
            afterImage: { sections, notes, weather, aiDrafted: 1 },
            reversible: true,
            irreversibleReason: null,
          },
          ledger: [
            {
              action: "update",
              objectType: "daily_log",
              objectId: existing.id,
              payload: { logDate, aiDrafted: true, reviewId: row.id, runId: row.runId },
              projectId: row.projectId,
            },
          ],
          notifications: [],
        };
      }

      const logId = newId("dlog");
      await tx.insert(dailyLogs).values({
        id: logId,
        companyId: ctx.companyId,
        projectId: row.projectId,
        logDate,
        status: "draft",
        sections,
        notes,
        weather,
        aiDrafted: 1,
        createdBy: actorId,
      });
      return {
        applied: { dailyLogId: logId, logDate, created: true },
        action: {
          actionType: "create_daily_log",
          targetType: "daily_log",
          targetId: logId,
          beforeImage: { created: true },
          afterImage: { sections, notes, weather },
          reversible: true,
          irreversibleReason: null,
        },
        ledger: [
          {
            action: "create",
            objectType: "daily_log",
            objectId: logId,
            payload: { logDate, aiDrafted: true, reviewId: row.id, runId: row.runId },
            projectId: row.projectId,
          },
        ],
        notifications: [],
      };
    }

    /* ---------------------------------------------------------------- */
    case "rfi_response": {
      if (!row.targetId) throw badRequest("Review item is missing its RFI id");
      if (!actorId) {
        throw badRequest("An official RFI response needs a human author; it cannot be auto-applied");
      }
      const [rfi] = await tx
        .select()
        .from(rfis)
        .where(and(eq(rfis.id, row.targetId), eq(rfis.companyId, ctx.companyId)))
        .limit(1);
      if (!rfi) throw notFound("Target RFI not found");

      // field/rfis.ts: only an OPEN RFI can be answered. A proposal drafted
      // before a human answered (or closed) it must not silently overwrite.
      if (rfi.status !== "open") {
        throw conflict(
          `RFI #${rfi.number} is "${rfi.status}" — only an open RFI can be answered, so this proposal is stale`,
        );
      }

      const suggested = proposal["suggestedResponse"];
      if (typeof suggested !== "string" || suggested.trim() === "") {
        throw badRequest("Proposal has no suggestedResponse");
      }
      const days =
        typeof proposal["scheduleImpactDays"] === "number" &&
        Number.isInteger(proposal["scheduleImpactDays"])
          ? (proposal["scheduleImpactDays"] as number)
          : rfi.scheduleImpactDays;

      const beforeImage = {
        status: rfi.status,
        officialResponse: rfi.officialResponse,
        respondedBy: rfi.respondedBy,
        respondedAt: rfi.respondedAt,
        costImpact: rfi.costImpact,
        scheduleImpact: rfi.scheduleImpact,
        scheduleImpactDays: rfi.scheduleImpactDays,
        ballInCourtId: rfi.ballInCourtId,
        responseRevision: rfi.responseRevision,
      };
      await tx
        .update(rfis)
        .set({
          officialResponse: suggested,
          status: "answered",
          respondedBy: actorId,
          respondedAt: ctx.now,
          costImpact: impactOf(proposal["costImpact"], rfi.costImpact),
          scheduleImpact: impactOf(proposal["scheduleImpact"], rfi.scheduleImpact),
          scheduleImpactDays: days,
          // The manual respond route hands the ball back to the requester.
          ballInCourtId: rfi.createdBy,
          responseRevision: rfi.responseRevision + 1,
          updatedAt: ctx.now,
        })
        .where(eq(rfis.id, rfi.id));

      const title = `RFI #${rfi.number} answered: ${rfi.subject}`;
      const recipients = new Set<string>([rfi.createdBy, ...(rfi.distribution ?? [])]);
      recipients.delete(actorId);

      return {
        applied: { rfiId: rfi.id, status: "answered" },
        action: {
          actionType: "answer_rfi",
          targetType: "rfi_response",
          targetId: rfi.id,
          beforeImage,
          afterImage: { status: "answered", officialResponse: suggested, respondedBy: actorId },
          reversible: true,
          irreversibleReason: null,
        },
        ledger: [
          {
            action: "state_change",
            objectType: "rfi",
            objectId: rfi.id,
            payload: {
              from: "open",
              to: "answered",
              aiAssisted: true,
              reviewId: row.id,
              runId: row.runId,
            },
            projectId: rfi.projectId,
          },
        ],
        notifications: [...recipients].map((userId) => ({
          companyId: ctx.companyId,
          userId,
          projectId: rfi.projectId,
          kind: "status_change" as const,
          title,
          body: "The response was drafted by an AI agent and approved by a reviewer.",
          recordType: "rfi",
          recordId: rfi.id,
        })),
      };
    }

    /* ---------------------------------------------------------------- */
    case "drawing_sheet": {
      if (!row.targetId) throw badRequest("Review item is missing its sheet id");
      const [sheet] = await tx
        .select()
        .from(drawingSheets)
        .where(
          and(eq(drawingSheets.id, row.targetId), eq(drawingSheets.companyId, ctx.companyId)),
        )
        .limit(1);
      if (!sheet) throw notFound("Target drawing sheet not found");

      const number =
        typeof proposal["number"] === "string" && proposal["number"].trim() !== ""
          ? (proposal["number"] as string)
          : sheet.number;
      const title =
        typeof proposal["title"] === "string" && proposal["title"].trim() !== ""
          ? (proposal["title"] as string)
          : sheet.title;
      const discipline =
        typeof proposal["discipline"] === "string" && proposal["discipline"].trim() !== ""
          ? (proposal["discipline"] as string)
          : sheet.discipline;

      if (number !== sheet.number) {
        const [dupe] = await tx
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
        if (dupe) throw conflict(`A sheet numbered "${number}" already exists`);
      }

      const beforeImage = {
        number: sheet.number,
        title: sheet.title,
        discipline: sheet.discipline,
        needsReview: sheet.needsReview,
      };
      await tx
        .update(drawingSheets)
        .set({ number, title, discipline, needsReview: 0, updatedAt: ctx.now })
        .where(eq(drawingSheets.id, sheet.id));

      return {
        applied: { sheetId: sheet.id, number },
        action: {
          actionType: "rename_sheet",
          targetType: "drawing_sheet",
          targetId: sheet.id,
          beforeImage,
          afterImage: { number, title, discipline, needsReview: 0 },
          reversible: true,
          irreversibleReason: null,
        },
        ledger: [
          {
            action: "update",
            objectType: "drawing_sheet",
            objectId: sheet.id,
            payload: { number, title, discipline, reviewId: row.id, runId: row.runId },
            projectId: sheet.projectId,
          },
        ],
        notifications: [],
      };
    }

    /* ---------------------------------------------------------------- */
    case "signal_explanation": {
      if (!row.targetId) throw badRequest("Review item is missing its signal id");
      const [signal] = await tx
        .select()
        .from(signals)
        .where(and(eq(signals.id, row.targetId), eq(signals.companyId, ctx.companyId)))
        .limit(1);
      if (!signal) throw notFound("Target signal not found");

      const benign = typeof proposal["benignExplanation"] === "string"
        ? (proposal["benignExplanation"] as string)
        : "";
      const concerning = typeof proposal["concerningExplanation"] === "string"
        ? (proposal["concerningExplanation"] as string)
        : "";
      if (!benign && !concerning) throw badRequest("Proposal carries no explanation");

      const appended = [
        signal.explanation,
        "",
        "— AI anomaly explainer (approved by a reviewer) —",
        benign ? `Benign reading: ${benign}` : "",
        concerning ? `Concerning reading: ${concerning}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 20_000);

      const beforeImage = { explanation: signal.explanation };
      await tx.update(signals).set({ explanation: appended }).where(eq(signals.id, signal.id));

      return {
        // Deliberately does NOT touch disposition: a signal is dispositioned
        // by an independent reviewer, never by the agent that explained it.
        applied: { signalId: signal.id, explanationUpdated: true },
        action: {
          actionType: "explain_signal",
          targetType: "signal_explanation",
          targetId: signal.id,
          beforeImage,
          afterImage: { explanation: appended },
          reversible: true,
          irreversibleReason: null,
        },
        ledger: [
          {
            action: "update",
            objectType: "signal",
            objectId: signal.id,
            payload: { explanationUpdated: true, reviewId: row.id, runId: row.runId },
            projectId: signal.projectId,
          },
        ],
        notifications: [],
      };
    }

    /* ---------------------------------------------------------------- */
    default: {
      // Advisory artefact: the memo, narrative, forecast or assessment is the
      // deliverable. Approval records that a human accepted it; nothing in
      // another module moves, which is why there is nothing to undo.
      return {
        applied: { advisory: true, targetType: row.targetType, targetId: row.targetId },
        action: {
          actionType: "accept_advisory",
          targetType: row.targetType,
          targetId: row.targetId,
          beforeImage: null,
          afterImage: null,
          reversible: false,
          irreversibleReason:
            "Advisory record: approval changed no operational record, so there is nothing to restore",
        },
        ledger: [],
        notifications: [],
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reversing (#1023)                                                   */
/* ------------------------------------------------------------------ */

export interface RevertResult {
  restored: Record<string, unknown>;
  ledger: PendingLedger[];
}

/**
 * Restore the before-image an application recorded. Runs inside the caller's
 * transaction; the caller ledgers afterwards.
 */
export async function revertAction(
  tx: Db,
  action: ActionRow,
  ctx: ApplyContext,
): Promise<RevertResult> {
  // No status guard here on purpose: the caller claims the action with a
  // conditional UPDATE … WHERE status='applied' RETURNING, and hands us the
  // claimed row — whose status is by then already 'rolled_back'. The claim IS
  // the concurrency guard; re-checking it here would refuse every rollback.
  const before = (action.beforeImage ?? null) as Record<string, unknown> | null;

  switch (action.actionType) {
    case "create_daily_log": {
      if (!action.targetId) throw badRequest("Action has no target");
      const [log] = await tx
        .select()
        .from(dailyLogs)
        .where(and(eq(dailyLogs.id, action.targetId), eq(dailyLogs.companyId, ctx.companyId)))
        .limit(1);
      if (!log) throw notFound("The daily log this action created no longer exists");
      if (log.status !== "draft") {
        throw conflict(
          `The daily log is now "${log.status}"; a submitted or approved log is not rolled back automatically`,
        );
      }
      await tx.delete(dailyLogs).where(eq(dailyLogs.id, log.id));
      return {
        restored: { dailyLogId: log.id, deleted: true },
        ledger: [
          {
            action: "delete",
            objectType: "daily_log",
            objectId: log.id,
            payload: { rollbackOf: action.id, reason: ctx.authorisation },
            projectId: log.projectId,
          },
        ],
      };
    }

    case "update_daily_log": {
      if (!action.targetId || !before) throw badRequest("Action has no before-image");
      const [log] = await tx
        .select()
        .from(dailyLogs)
        .where(and(eq(dailyLogs.id, action.targetId), eq(dailyLogs.companyId, ctx.companyId)))
        .limit(1);
      if (!log) throw notFound("The daily log this action changed no longer exists");
      if (log.status !== "draft") {
        throw conflict(
          `The daily log is now "${log.status}"; restoring it would edit a submitted record`,
        );
      }
      await tx
        .update(dailyLogs)
        .set({
          sections: (before["sections"] ?? {}) as Record<string, unknown>,
          notes: typeof before["notes"] === "string" ? (before["notes"] as string) : null,
          weather:
            before["weather"] && typeof before["weather"] === "object"
              ? (before["weather"] as Record<string, unknown>)
              : null,
          aiDrafted: typeof before["aiDrafted"] === "number" ? (before["aiDrafted"] as number) : 0,
          updatedAt: ctx.now,
        })
        .where(eq(dailyLogs.id, log.id));
      return {
        restored: { dailyLogId: log.id, restored: true },
        ledger: [
          {
            action: "update",
            objectType: "daily_log",
            objectId: log.id,
            payload: { rollbackOf: action.id },
            projectId: log.projectId,
          },
        ],
      };
    }

    case "answer_rfi": {
      if (!action.targetId || !before) throw badRequest("Action has no before-image");
      const [rfi] = await tx
        .select()
        .from(rfis)
        .where(and(eq(rfis.id, action.targetId), eq(rfis.companyId, ctx.companyId)))
        .limit(1);
      if (!rfi) throw notFound("The RFI this action answered no longer exists");
      // If a human has since moved the RFI on, rolling back would silently
      // undo their work as well.
      if (rfi.status !== "answered" || rfi.respondedBy !== action.appliedBy) {
        throw conflict(
          "The RFI has changed since the agent answered it; roll back by hand so the human change is not lost",
        );
      }
      await tx
        .update(rfis)
        .set({
          status: (before["status"] as string) ?? "open",
          officialResponse:
            typeof before["officialResponse"] === "string"
              ? (before["officialResponse"] as string)
              : null,
          respondedBy:
            typeof before["respondedBy"] === "string" ? (before["respondedBy"] as string) : null,
          respondedAt:
            typeof before["respondedAt"] === "string" ? (before["respondedAt"] as string) : null,
          // cost_impact and schedule_impact are NOT NULL with a "tbd" default.
          costImpact: typeof before["costImpact"] === "string" ? (before["costImpact"] as string) : "tbd",
          scheduleImpact:
            typeof before["scheduleImpact"] === "string" ? (before["scheduleImpact"] as string) : "tbd",
          scheduleImpactDays:
            typeof before["scheduleImpactDays"] === "number"
              ? (before["scheduleImpactDays"] as number)
              : null,
          ballInCourtId:
            typeof before["ballInCourtId"] === "string" ? (before["ballInCourtId"] as string) : null,
          responseRevision:
            typeof before["responseRevision"] === "number"
              ? (before["responseRevision"] as number)
              : rfi.responseRevision,
          updatedAt: ctx.now,
        })
        .where(eq(rfis.id, rfi.id));
      return {
        restored: { rfiId: rfi.id, status: before["status"] ?? "open" },
        ledger: [
          {
            action: "state_change",
            objectType: "rfi",
            objectId: rfi.id,
            payload: { rollbackOf: action.id, to: before["status"] ?? "open" },
            projectId: rfi.projectId,
          },
        ],
      };
    }

    case "rename_sheet": {
      if (!action.targetId || !before) throw badRequest("Action has no before-image");
      const [sheet] = await tx
        .select()
        .from(drawingSheets)
        .where(
          and(eq(drawingSheets.id, action.targetId), eq(drawingSheets.companyId, ctx.companyId)),
        )
        .limit(1);
      if (!sheet) throw notFound("The drawing sheet this action renamed no longer exists");
      await tx
        .update(drawingSheets)
        .set({
          number: (before["number"] as string) ?? sheet.number,
          title: (before["title"] as string) ?? sheet.title,
          discipline: (before["discipline"] as string) ?? sheet.discipline,
          needsReview:
            typeof before["needsReview"] === "number" ? (before["needsReview"] as number) : 1,
          updatedAt: ctx.now,
        })
        .where(eq(drawingSheets.id, sheet.id));
      return {
        restored: { sheetId: sheet.id, number: before["number"] },
        ledger: [
          {
            action: "update",
            objectType: "drawing_sheet",
            objectId: sheet.id,
            payload: { rollbackOf: action.id, number: before["number"] },
            projectId: sheet.projectId,
          },
        ],
      };
    }

    case "explain_signal": {
      if (!action.targetId || !before) throw badRequest("Action has no before-image");
      const [signal] = await tx
        .select()
        .from(signals)
        .where(and(eq(signals.id, action.targetId), eq(signals.companyId, ctx.companyId)))
        .limit(1);
      if (!signal) throw notFound("The signal this action explained no longer exists");
      await tx
        .update(signals)
        .set({ explanation: (before["explanation"] as string) ?? signal.explanation })
        .where(eq(signals.id, signal.id));
      return {
        restored: { signalId: signal.id, explanationRestored: true },
        ledger: [
          {
            action: "update",
            objectType: "signal",
            objectId: signal.id,
            payload: { rollbackOf: action.id },
            projectId: signal.projectId,
          },
        ],
      };
    }

    default:
      throw badRequest(
        `Action type "${action.actionType}" changed no operational record, so there is nothing to roll back`,
      );
  }
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

export async function recordAgentAction(
  tx: Db,
  args: {
    companyId: string;
    projectId: string | null;
    agentKind: string;
    runId: string | null;
    reviewId: string | null;
    draft: ActionDraft;
    appliedBy: string | null;
    now: string;
    authorisation: string;
    policyId: string | null;
    confidence: number | null;
    summary: string;
  },
): Promise<string> {
  const id = newId("aact");
  await tx.insert(agentActions).values({
    id,
    companyId: args.companyId,
    projectId: args.projectId,
    agentKind: args.agentKind,
    runId: args.runId,
    reviewId: args.reviewId,
    actionType: args.draft.actionType,
    targetType: args.draft.targetType,
    targetId: args.draft.targetId,
    beforeImage: args.draft.beforeImage,
    afterImage: args.draft.afterImage,
    status: args.draft.reversible ? "applied" : "not_reversible",
    reversible: args.draft.reversible ? 1 : 0,
    irreversibleReason: args.draft.irreversibleReason,
    appliedBy: args.appliedBy,
    appliedAt: args.now,
    authorisation: args.authorisation,
    policyId: args.policyId,
    confidence: args.confidence,
    summary: args.summary.slice(0, 500),
  });
  return id;
}
