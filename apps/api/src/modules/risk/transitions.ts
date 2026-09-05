/**
 * Risk lifecycle transitions (spec Vol II Domain H #450).
 *
 * Before this, `POST /risks/:id/status` accepted any enum value, so a
 * `realised` risk that had already driven contingency drawdowns could be
 * flipped back to `open` and silently re-enter the next QCRA — the same
 * exposure counted twice. A risk register is a chronology; it moves in the
 * directions a risk can actually move.
 *
 *   open ⇄ mitigating          — active management, either way
 *   open | mitigating → closed — the risk went away or was retired
 *   open | mitigating → realised — it happened
 *   realised → closed          — the consequence has been dealt with
 *   closed → open              — reopening (needs a note)
 *   realised → open|mitigating — REFUSED except by an admin with a note:
 *                                un-realising a risk rewrites history that
 *                                drawdowns and claims may already rely on.
 */
import type { RiskStatus } from "@constructos/shared";

export interface TransitionCheck {
  allowed: boolean;
  /** true when the move is only open to a risk:admin with a stated reason */
  requiresAdmin: boolean;
  requiresNote: boolean;
  reason: string;
}

const FREE: Record<RiskStatus, RiskStatus[]> = {
  open: ["mitigating", "closed", "realised"],
  mitigating: ["open", "closed", "realised"],
  realised: ["closed"],
  closed: [],
};

/** Moves permitted only to an administrator, and only with a note. */
const PRIVILEGED: Record<RiskStatus, RiskStatus[]> = {
  open: [],
  mitigating: [],
  realised: ["open", "mitigating"],
  closed: ["open", "mitigating"],
};

export function checkRiskTransition(
  from: RiskStatus,
  to: RiskStatus,
  actor: { isAdmin: boolean; hasNote: boolean },
): TransitionCheck {
  if (from === to) {
    return {
      allowed: false,
      requiresAdmin: false,
      requiresNote: false,
      reason: `The risk is already ${from}.`,
    };
  }
  if (FREE[from].includes(to)) {
    return { allowed: true, requiresAdmin: false, requiresNote: false, reason: "" };
  }
  if (PRIVILEGED[from].includes(to)) {
    if (!actor.isAdmin) {
      return {
        allowed: false,
        requiresAdmin: true,
        requiresNote: true,
        reason:
          from === "realised"
            ? "A realised risk has already had its consequence recorded — contingency drawdowns and claims may cite it. Reversing that requires risk:admin and a stated reason."
            : "Reopening a closed risk requires risk:admin and a stated reason.",
      };
    }
    if (!actor.hasNote) {
      return {
        allowed: false,
        requiresAdmin: true,
        requiresNote: true,
        reason: `Moving a risk from ${from} to ${to} rewrites the register — a note explaining why is required.`,
      };
    }
    return { allowed: true, requiresAdmin: true, requiresNote: true, reason: "" };
  }
  return {
    allowed: false,
    requiresAdmin: false,
    requiresNote: false,
    reason: `A ${from} risk cannot move to ${to}. Permitted: ${[
      ...FREE[from],
      ...PRIVILEGED[from],
    ].join(", ") || "no further transitions"}.`,
  };
}
