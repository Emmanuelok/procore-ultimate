/**
 * DESIGN REVIEW CYCLE ENGINE (spec #249, #897–#900) — pure, no I/O.
 *
 * Three questions this file answers and nothing else does:
 *
 *  1. CONSOLIDATION. Given what each reviewer returned, what is the cycle's
 *     code? Never typed by a person: the worst code wins (D > C > B > A),
 *     because a package with one "revise and resubmit" is not "accepted".
 *  2. READINESS TO CLOSE. Which required reviewers have not returned, and
 *     which comments are still open — quoted back as the reason for a refusal.
 *  3. CYCLE TIME. Turnaround per cycle and the rework multiple (#900): how
 *     many issues the same package needed before it was accepted.
 */
import type { DesignReviewCode } from "@constructos/shared";

/** Severity order — the later in this list, the worse. */
const CODE_RANK: Record<DesignReviewCode, number> = { A: 0, B: 1, C: 2, D: 3 };

export const CODE_MEANING: Record<DesignReviewCode, string> = {
  A: "Accepted — proceed",
  B: "Accepted with comments — proceed and incorporate",
  C: "Revise and resubmit",
  D: "Rejected",
};

/** A code that forces another cycle. */
export function requiresResubmission(code: DesignReviewCode | null | undefined): boolean {
  return code === "C" || code === "D";
}

export interface ReviewerReturn {
  id: string;
  isRequired: boolean;
  status: string;
  returnedCode: string | null;
  displayName: string | null;
  discipline: string;
}

export interface Consolidation {
  code: DesignReviewCode | null;
  basis: string;
  returned: number;
  required: number;
  requiredReturned: number;
  declined: number;
  byCode: Record<string, number>;
  /** required reviewers who have not returned, by display name or id */
  outstanding: string[];
}

/**
 * The cycle's code is the worst code any reviewer returned. A reviewer who
 * declined is excluded from the count but recorded, so "3 of 5 returned, 1
 * declined" is legible in the basis rather than being silently rounded away.
 */
export function consolidate(participants: readonly ReviewerReturn[]): Consolidation {
  const declined = participants.filter((p) => p.status === "declined");
  const live = participants.filter((p) => p.status !== "declined");
  const required = live.filter((p) => p.isRequired);
  const returned = live.filter((p) => p.status === "returned" && p.returnedCode !== null);
  const requiredReturned = required.filter((p) => p.status === "returned" && p.returnedCode !== null);

  const byCode: Record<string, number> = {};
  let worst: DesignReviewCode | null = null;
  for (const p of returned) {
    const code = p.returnedCode as DesignReviewCode;
    if (!(code in CODE_RANK)) continue;
    byCode[code] = (byCode[code] ?? 0) + 1;
    if (worst === null || CODE_RANK[code] > CODE_RANK[worst]) worst = code;
  }

  const outstanding = required
    .filter((p) => p.status !== "returned" || p.returnedCode === null)
    .map((p) => p.displayName ?? p.id);

  const basis =
    worst === null
      ? live.length === 0
        ? "No reviewers were appointed to this cycle."
        : `No reviewer has returned a code yet (${live.length} appointed${declined.length > 0 ? `, ${declined.length} declined` : ""}).`
      : `Worst of ${returned.length} returned code${returned.length === 1 ? "" : "s"}: ${Object.entries(byCode)
          .sort()
          .map(([code, n]) => `${n}×${code}`)
          .join(", ")}${declined.length > 0 ? ` (${declined.length} declined)` : ""}.`;

  return {
    code: worst,
    basis,
    returned: returned.length,
    required: required.length,
    requiredReturned: requiredReturned.length,
    declined: declined.length,
    byCode,
    outstanding,
  };
}

export interface CloseCheck {
  canClose: boolean;
  blockers: string[];
  consolidation: Consolidation;
}

/**
 * A cycle may close when every required reviewer has returned. Open comments
 * do NOT block closure — a "B" cycle closes with comments carried into the
 * next issue — but a cycle cannot close while a required reviewer is silent,
 * because the consolidated code would then be a guess.
 */
export function checkClose(
  participants: readonly ReviewerReturn[],
  options: { force?: boolean } = {},
): CloseCheck {
  const consolidation = consolidate(participants);
  const blockers: string[] = [];
  if (participants.length === 0) {
    blockers.push("No reviewers are appointed: there is nothing to consolidate.");
  } else if (consolidation.returned === 0) {
    blockers.push("No reviewer has returned a code, so the cycle has no outcome to record.");
  }
  if (consolidation.outstanding.length > 0 && !options.force) {
    blockers.push(
      `${consolidation.outstanding.length} required reviewer${consolidation.outstanding.length === 1 ? " has" : "s have"} not returned: ${consolidation.outstanding.join(", ")}.`,
    );
  }
  return { canClose: blockers.length === 0, blockers, consolidation };
}

/* ------------------------------------------------------------------ */
/* Cycle time and rework                                               */
/* ------------------------------------------------------------------ */

export interface CycleTimeInput {
  id: string;
  packageId: string;
  cycleNumber: number;
  issuedAt: string | null;
  dueAt: string | null;
  closedAt: string | null;
  consolidatedCode: string | null;
  status: string;
}

export interface CycleTimeStats {
  cyclesClosed: number;
  cyclesOpen: number;
  cyclesOverdue: number;
  /** null, not 0, when nothing has closed */
  averageTurnaroundDays: number | null;
  medianTurnaroundDays: number | null;
  averageAgainstTargetDays: number | null;
  onTimeCount: number;
  lateCount: number;
  onTimePercent: number | null;
  byCode: Record<string, number>;
  /** #900 — issues per package before acceptance */
  reworkMultiple: number | null;
  packagesAccepted: number;
  reasons: string[];
}

const dayDiff = (from: string, to: string): number | null => {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 86_400_000;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return (lo + hi) / 2;
};

/**
 * Turnaround is measured from issue to close. A cycle with no issue date
 * contributes nothing and says so — it is not counted as a zero-day review.
 */
export function cycleTimeStats(cycles: readonly CycleTimeInput[], asOfISO: string): CycleTimeStats {
  const reasons: string[] = [];
  const closed = cycles.filter((c) => c.status === "closed" && c.closedAt !== null);
  const open = cycles.filter((c) => c.status !== "closed" && c.status !== "cancelled");
  const durations: number[] = [];
  const againstTarget: number[] = [];
  let onTime = 0;
  let late = 0;
  let missingIssueDate = 0;

  for (const cycle of closed) {
    if (!cycle.issuedAt || !cycle.closedAt) {
      missingIssueDate += 1;
      continue;
    }
    const days = dayDiff(cycle.issuedAt, cycle.closedAt);
    if (days === null) continue;
    durations.push(days);
    if (cycle.dueAt) {
      const delta = dayDiff(cycle.dueAt, cycle.closedAt);
      if (delta !== null) {
        againstTarget.push(delta);
        if (delta <= 0) onTime += 1;
        else late += 1;
      }
    }
  }
  if (missingIssueDate > 0) {
    reasons.push(`${missingIssueDate} closed cycle(s) carry no issue date and are excluded from turnaround.`);
  }
  if (durations.length === 0) {
    reasons.push("No closed cycle has both an issue and a close date, so turnaround is not available.");
  }
  if (againstTarget.length === 0 && closed.length > 0) {
    reasons.push("No closed cycle carried a due date, so on-time performance is not available.");
  }

  const asOf = Date.parse(asOfISO);
  const overdue = open.filter((c) => {
    if (!c.dueAt) return false;
    const due = Date.parse(c.dueAt);
    return !Number.isNaN(due) && !Number.isNaN(asOf) && due < asOf;
  }).length;

  const byCode: Record<string, number> = {};
  for (const cycle of closed) {
    if (cycle.consolidatedCode) byCode[cycle.consolidatedCode] = (byCode[cycle.consolidatedCode] ?? 0) + 1;
  }

  // Rework multiple: for packages that reached an accepted code (A or B),
  // how many cycles did that take on average?
  const byPackage = new Map<string, CycleTimeInput[]>();
  for (const cycle of cycles) {
    const list = byPackage.get(cycle.packageId) ?? [];
    list.push(cycle);
    byPackage.set(cycle.packageId, list);
  }
  const cyclesToAccept: number[] = [];
  for (const [, list] of byPackage) {
    const accepted = list
      .filter((c) => c.status === "closed" && (c.consolidatedCode === "A" || c.consolidatedCode === "B"))
      .sort((a, b) => a.cycleNumber - b.cycleNumber)[0];
    if (accepted) cyclesToAccept.push(accepted.cycleNumber);
  }
  if (cyclesToAccept.length === 0) {
    reasons.push("No package has reached an accepted code yet, so the rework multiple is not available.");
  }

  const avg = (xs: number[]): number | null =>
    xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

  return {
    cyclesClosed: closed.length,
    cyclesOpen: open.length,
    cyclesOverdue: overdue,
    averageTurnaroundDays: avg(durations),
    medianTurnaroundDays: (() => {
      const m = median(durations);
      return m === null ? null : Math.round(m * 10) / 10;
    })(),
    averageAgainstTargetDays: avg(againstTarget),
    onTimeCount: onTime,
    lateCount: late,
    onTimePercent: onTime + late === 0 ? null : Math.round((onTime / (onTime + late)) * 1000) / 10,
    byCode,
    reworkMultiple: avg(cyclesToAccept),
    packagesAccepted: cyclesToAccept.length,
    reasons,
  };
}

/** Cycles past their due date and still open, with how many days over. */
export function overdueCycles(
  cycles: readonly CycleTimeInput[],
  asOfISO: string,
): Array<{ id: string; packageId: string; daysOverdue: number }> {
  const asOf = Date.parse(asOfISO);
  if (Number.isNaN(asOf)) return [];
  const out: Array<{ id: string; packageId: string; daysOverdue: number }> = [];
  for (const cycle of cycles) {
    if (cycle.status === "closed" || cycle.status === "cancelled") continue;
    if (!cycle.dueAt) continue;
    const due = Date.parse(cycle.dueAt);
    if (Number.isNaN(due) || due >= asOf) continue;
    out.push({
      id: cycle.id,
      packageId: cycle.packageId,
      daysOverdue: Math.floor((asOf - due) / 86_400_000),
    });
  }
  return out;
}
