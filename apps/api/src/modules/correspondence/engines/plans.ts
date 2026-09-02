/**
 * ACTION PLAN PROGRESS AND GATING (spec #448–456).
 *
 * The rules an action plan exists to enforce, all pure:
 *
 *  · EVIDENCE BEFORE SIGN-OFF (#449). An activity that declares an evidence
 *    requirement cannot be signed off until evidence is attached. "I did it"
 *    is an assertion; the file is the evidence, and the platform's whole
 *    thesis is that the two are different things.
 *  · MULTI-PARTY SIGN-OFF (#451–452). An activity completes when EVERY
 *    required party has signed, not when the first one has.
 *  · QUALITY CONTROL CHECKPOINTS (#456). A checkpoint blocks every activity
 *    after it. Until it is signed off, later activities cannot be started or
 *    signed off — which is the entire point of a hold point.
 *  · PROGRESS (#454–455) is signed-off + waived over total. With no
 *    activities there is no percentage to report, and the engine says so
 *    rather than reporting 0% or 100%.
 */

export interface ActivityInput {
  id: string;
  seq: number;
  title: string;
  status: string;
  isQualityCheckpoint: boolean;
  evidenceRequired: boolean;
  evidenceFileIds: readonly string[];
  signoffRequiredCount: number;
  signoffCount: number;
  dueDate: string | null;
}

export const TERMINAL_ACTIVITY_STATUSES = ["signed_off", "waived"] as const;

export const isActivityComplete = (status: string): boolean =>
  status === "signed_off" || status === "waived";

/* ------------------------------------------------------------------ */
/* Checkpoint gating                                                   */
/* ------------------------------------------------------------------ */

export interface GateVerdict {
  allowed: boolean;
  /** the checkpoint standing in the way, when there is one */
  blockedBy: { id: string; seq: number; title: string } | null;
  reason: string | null;
}

/**
 * May work proceed on the activity at `seq`? Only if every EARLIER quality
 * checkpoint is complete. The checkpoint itself is never blocked by itself.
 */
export function checkpointGate(
  activities: readonly ActivityInput[],
  seq: number,
): GateVerdict {
  const blocking = activities
    .filter((a) => a.isQualityCheckpoint && a.seq < seq && !isActivityComplete(a.status))
    .sort((a, b) => a.seq - b.seq)[0];
  if (!blocking) return { allowed: true, blockedBy: null, reason: null };
  return {
    allowed: false,
    blockedBy: { id: blocking.id, seq: blocking.seq, title: blocking.title },
    reason: `Activity ${seq} is held behind quality checkpoint ${blocking.seq} ("${blocking.title}"), which has not been signed off.`,
  };
}

/* ------------------------------------------------------------------ */
/* Sign-off readiness                                                  */
/* ------------------------------------------------------------------ */

export interface ReadinessVerdict {
  ready: boolean;
  blockers: string[];
}

/**
 * Can this activity be signed off right now? Evidence, checkpoint order and
 * the activity's own state all have to agree.
 */
export function signoffReadiness(
  activity: ActivityInput,
  activities: readonly ActivityInput[],
): ReadinessVerdict {
  const blockers: string[] = [];
  if (isActivityComplete(activity.status)) {
    blockers.push(`Activity ${activity.seq} is already ${activity.status.replace("_", " ")}.`);
  }
  if (activity.evidenceRequired && activity.evidenceFileIds.length === 0) {
    blockers.push(
      `Activity ${activity.seq} requires evidence and none is attached. Attach the evidence, then sign off — the platform will not accept a signature that stands on nothing.`,
    );
  }
  const gate = checkpointGate(activities, activity.seq);
  if (!gate.allowed && gate.reason) blockers.push(gate.reason);
  return { ready: blockers.length === 0, blockers };
}

/** An activity is complete once every required signature is in. */
export function signoffsSatisfied(activity: {
  signoffRequiredCount: number;
  signoffCount: number;
}): boolean {
  return activity.signoffCount >= activity.signoffRequiredCount;
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export interface PlanProgress {
  total: number;
  signedOff: number;
  waived: number;
  outstanding: number;
  blocked: number;
  overdue: number;
  /** null when there is nothing to measure — never a fabricated 0 or 100 */
  percent: number | null;
  reasons: string[];
  /** the lowest-seq activity that can be worked on now */
  nextActivity: { id: string; seq: number; title: string } | null;
  /** the checkpoint holding the plan up, when one is */
  heldBy: { id: string; seq: number; title: string } | null;
  byStatus: Record<string, number>;
}

export function planProgress(
  activities: readonly ActivityInput[],
  today: string,
): PlanProgress {
  const total = activities.length;
  const byStatus: Record<string, number> = {};
  for (const a of activities) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  const signedOff = activities.filter((a) => a.status === "signed_off").length;
  const waived = activities.filter((a) => a.status === "waived").length;
  const blocked = activities.filter((a) => a.status === "blocked").length;
  const overdue = activities.filter(
    (a) => !isActivityComplete(a.status) && a.dueDate !== null && a.dueDate < today,
  ).length;
  const outstanding = total - signedOff - waived;

  const reasons: string[] = [];
  let percent: number | null = null;
  if (total === 0) {
    reasons.push("This plan has no activities, so there is no progress to measure. Add the required activities the plan exists to enforce.");
  } else {
    percent = Math.round(((signedOff + waived) / total) * 1000) / 10;
    if (waived > 0) {
      reasons.push(
        `${waived} of ${total} activities were waived rather than performed; the percentage counts them as closed, not as done.`,
      );
    }
  }

  const ordered = [...activities].sort((a, b) => a.seq - b.seq);
  let heldBy: PlanProgress["heldBy"] = null;
  let nextActivity: PlanProgress["nextActivity"] = null;
  for (const a of ordered) {
    if (isActivityComplete(a.status)) continue;
    const gate = checkpointGate(activities, a.seq);
    if (!gate.allowed) {
      heldBy = gate.blockedBy;
      break;
    }
    nextActivity = { id: a.id, seq: a.seq, title: a.title };
    break;
  }
  if (heldBy) {
    reasons.push(
      `Work is held behind quality checkpoint ${heldBy.seq} ("${heldBy.title}"). Nothing after it may be signed off until it is.`,
    );
  }

  return {
    total,
    signedOff,
    waived,
    outstanding,
    blocked,
    overdue,
    percent,
    reasons,
    nextActivity,
    heldBy,
    byStatus,
  };
}

/**
 * The status a plan should be in, given its activities. Draft and cancelled
 * are human decisions and are never overwritten.
 */
export function derivePlanStatus(
  current: string,
  progress: PlanProgress,
): "draft" | "active" | "blocked" | "completed" | "cancelled" {
  if (current === "draft") return "draft";
  if (current === "cancelled") return "cancelled";
  if (progress.total > 0 && progress.outstanding === 0) return "completed";
  if (progress.heldBy !== null || progress.blocked > 0) return "blocked";
  return "active";
}

/* ------------------------------------------------------------------ */
/* Completion report (#455)                                            */
/* ------------------------------------------------------------------ */

export interface CompletionRow {
  seq: number;
  title: string;
  status: string;
  isQualityCheckpoint: boolean;
  evidenceRequired: boolean;
  evidenceCount: number;
  signoffCount: number;
  signoffRequiredCount: number;
  dueDate: string | null;
  overdue: boolean;
  /** what is missing before this activity can close */
  gaps: string[];
}

export interface CompletionReport {
  rows: CompletionRow[];
  progress: PlanProgress;
  /** every gap across the plan, in sequence order */
  gaps: string[];
  /** true only when nothing is outstanding and no gap remains */
  complete: boolean;
}

export function completionReport(
  activities: readonly ActivityInput[],
  today: string,
): CompletionReport {
  const progress = planProgress(activities, today);
  const rows: CompletionRow[] = [...activities]
    .sort((a, b) => a.seq - b.seq)
    .map((a) => {
      const gaps: string[] = [];
      if (!isActivityComplete(a.status)) {
        if (a.evidenceRequired && a.evidenceFileIds.length === 0) {
          gaps.push(`Activity ${a.seq}: evidence required and none attached.`);
        }
        const missingSignatures = Math.max(0, a.signoffRequiredCount - a.signoffCount);
        if (missingSignatures > 0) {
          gaps.push(
            `Activity ${a.seq}: ${missingSignatures} of ${a.signoffRequiredCount} required signatures outstanding.`,
          );
        }
        if (a.dueDate !== null && a.dueDate < today) {
          gaps.push(`Activity ${a.seq}: past its due date of ${a.dueDate}.`);
        }
        if (gaps.length === 0) gaps.push(`Activity ${a.seq}: not yet signed off.`);
      }
      return {
        seq: a.seq,
        title: a.title,
        status: a.status,
        isQualityCheckpoint: a.isQualityCheckpoint,
        evidenceRequired: a.evidenceRequired,
        evidenceCount: a.evidenceFileIds.length,
        signoffCount: a.signoffCount,
        signoffRequiredCount: a.signoffRequiredCount,
        dueDate: a.dueDate,
        overdue: !isActivityComplete(a.status) && a.dueDate !== null && a.dueDate < today,
        gaps,
      };
    });
  const gaps = rows.flatMap((r) => r.gaps);
  return { rows, progress, gaps, complete: progress.total > 0 && gaps.length === 0 };
}
