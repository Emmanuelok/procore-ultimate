/**
 * The sequential sign-off chain on an intervention point (#1092–1094).
 *
 * A hold point in a real ITP is rarely one signature. The contractor's own QC
 * signs first, then the engineer, then — on the joints, welds and pours that
 * matter — a third-party surveillance body. The order is the control: an
 * engineer who signs before the contractor's own QC has inspected is
 * certifying something nobody has looked at, and a third-party body that signs
 * before the engineer has no engineer's position to witness.
 *
 * This engine decides three things and nothing else:
 *
 *  1. WHOSE TURN IT IS — the first required leg not yet released.
 *  2. MAY THIS ACTOR SIGN THAT LEG — the nominated user signs their own leg;
 *     where the leg names only an organisation, anybody but the party who
 *     raised the point may record it, and never the same person twice in one
 *     chain (one human standing in for two independent parties is the failure
 *     the chain exists to prevent).
 *  3. IS THE CHAIN COMPLETE — every REQUIRED leg released or waived.
 *
 * Pure: no clock, no database. `asOf` and the actor are passed in.
 */

export interface ReleaseLegLike {
  id: string;
  position: number;
  party: string;
  required: number;
  userId: string | null;
  organisation: string | null;
  contactName: string | null;
  status: string;
  releasedBy: string | null;
  releasedAt: string | null;
}

export type LegRefusalCode =
  | "terminal"
  | "out_of_sequence"
  | "wrong_party"
  | "self_release"
  | "duplicate_actor"
  | "no_legs";

export interface LegDecision {
  allowed: boolean;
  reasons: string[];
  code?: LegRefusalCode;
}

const allow = (): LegDecision => ({ allowed: true, reasons: [] });
const refuse = (code: LegRefusalCode, ...reasons: string[]): LegDecision => ({
  allowed: false,
  reasons,
  code,
});

/** Refusal codes the route layer answers with 403 rather than 400. */
export const LEG_AUTHORISATION_REFUSALS: readonly LegRefusalCode[] = [
  "wrong_party",
  "self_release",
  "duplicate_actor",
];

const TERMINAL_LEG_STATUSES = new Set(["released", "waived", "rejected", "not_required"]);

export const isLegTerminal = (status: string): boolean => TERMINAL_LEG_STATUSES.has(status);

export const legLabel = (leg: ReleaseLegLike): string =>
  `${leg.party.replace(/_/g, " ")}${leg.organisation ? ` (${leg.organisation})` : leg.contactName ? ` (${leg.contactName})` : ""}`;

function ordered(legs: ReleaseLegLike[]): ReleaseLegLike[] {
  return [...legs].sort((a, b) => (a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : 1));
}

/** The first required leg still outstanding — whose turn it is. */
export function nextLeg(legs: ReleaseLegLike[]): ReleaseLegLike | null {
  return ordered(legs).find((l) => l.required === 1 && !isLegTerminal(l.status)) ?? null;
}

export interface ChainSummary {
  legCount: number;
  requiredCount: number;
  releasedCount: number;
  waivedCount: number;
  rejectedCount: number;
  outstanding: Array<{ id: string; position: number; party: string; status: string; label: string }>;
  nextLegId: string | null;
  /** every required leg is released or waived */
  complete: boolean;
  /** a leg was rejected: the point is refused, not merely outstanding */
  rejected: boolean;
  reasons: string[];
}

export function chainSummary(legs: ReleaseLegLike[]): ChainSummary {
  const inOrder = ordered(legs);
  const required = inOrder.filter((l) => l.required === 1);
  const released = inOrder.filter((l) => l.status === "released");
  const waived = inOrder.filter((l) => l.status === "waived");
  const rejected = inOrder.filter((l) => l.status === "rejected");
  const outstanding = required.filter((l) => !isLegTerminal(l.status));
  const next = nextLeg(inOrder);
  const reasons: string[] = [];
  if (inOrder.length === 0) {
    reasons.push(
      "No sign-off chain is recorded on this point, so the single-release rule on the activity governs it.",
    );
  } else if (rejected.length > 0) {
    reasons.push(
      `${rejected.length} leg(s) rejected the point: ${rejected.map(legLabel).join(", ")}. A rejected leg is a refusal to certify, not a delay.`,
    );
  } else if (outstanding.length > 0) {
    reasons.push(
      `Waiting on ${outstanding.length} required leg(s), next: ${next ? legLabel(next) : "—"}. Work may not proceed past a hold point whose chain is incomplete.`,
    );
  } else {
    reasons.push(
      `Every required leg is signed: ${required.map((l) => `${legLabel(l)} (${l.status})`).join(", ")}.`,
    );
  }
  return {
    legCount: inOrder.length,
    requiredCount: required.length,
    releasedCount: released.length,
    waivedCount: waived.length,
    rejectedCount: rejected.length,
    outstanding: outstanding.map((l) => ({
      id: l.id,
      position: l.position,
      party: l.party,
      status: l.status,
      label: legLabel(l),
    })),
    nextLegId: next?.id ?? null,
    complete: rejected.length === 0 && outstanding.length === 0 && inOrder.length > 0,
    rejected: rejected.length > 0,
    reasons,
  };
}

export interface LegReleaseContext {
  actorId: string;
  /** who raised the point — the ITP author, or whoever served the notice */
  raisedBy: string | null;
  /** false for a rejection or a waiver, which do not need the actor's turn */
  enforceSequence?: boolean;
}

/**
 * May this actor sign this leg now?
 *
 * The duplicate-actor rule is the one worth reading: a chain in which the same
 * human signs the contractor's leg and the engineer's leg has recorded two
 * independent verifications that were the same verification. It is refused
 * even when that human is nominated on both, because the nomination is a
 * clerical fact and the independence is the control.
 */
export function canReleaseLeg(
  legs: ReleaseLegLike[],
  legId: string,
  ctx: LegReleaseContext,
): LegDecision {
  const inOrder = ordered(legs);
  const leg = inOrder.find((l) => l.id === legId);
  if (!leg) return refuse("no_legs", `Leg ${legId} is not part of this point's chain.`);
  if (isLegTerminal(leg.status)) {
    return refuse(
      "terminal",
      `The ${legLabel(leg)} leg is already ${leg.status}${leg.releasedBy ? ` (by ${leg.releasedBy})` : ""}.`,
    );
  }
  if (ctx.enforceSequence !== false) {
    const ahead = inOrder.filter(
      (l) => l.required === 1 && l.position < leg.position && !isLegTerminal(l.status),
    );
    if (ahead.length > 0) {
      return refuse(
        "out_of_sequence",
        `The ${legLabel(leg)} leg cannot be signed yet: ${ahead.map(legLabel).join(", ")} ${ahead.length === 1 ? "is" : "are"} ahead of it in the chain and still outstanding. ` +
          `Signing out of sequence certifies an inspection that has not happened — the order is the control, not a formality.`,
      );
    }
  }
  if (leg.userId) {
    if (leg.userId !== ctx.actorId) {
      return refuse(
        "wrong_party",
        `The ${legLabel(leg)} leg is nominated to user ${leg.userId}; user ${ctx.actorId} may not sign it. ` +
          `Re-nominate the leg deliberately if the verifier has changed — that is a recorded act, and it should be.`,
      );
    }
  } else if (ctx.raisedBy && ctx.raisedBy === ctx.actorId) {
    return refuse(
      "self_release",
      `User ${ctx.actorId} raised this point and cannot also sign the ${legLabel(leg)} leg. The chain exists so that somebody else looks.`,
    );
  }
  const alreadySigned = inOrder.find(
    (l) => l.id !== leg.id && l.releasedBy === ctx.actorId && isLegTerminal(l.status),
  );
  if (alreadySigned) {
    return refuse(
      "duplicate_actor",
      `User ${ctx.actorId} has already signed the ${legLabel(alreadySigned)} leg of this point. One person cannot stand in for two independent parties — that is the failure the chain is built to prevent.`,
    );
  }
  return allow();
}
