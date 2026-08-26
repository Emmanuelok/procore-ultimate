/**
 * The hold-point state machine — the reason an ITP exists.
 *
 * A HOLD POINT stops the work. Nothing may proceed past it until the
 * nominated party releases it, and proceeding anyway is both a contractual
 * breach and, once the work is covered up, an allegation that the evidence
 * was buried deliberately. A WITNESS POINT is weaker on purpose: the party is
 * invited, and if they do not attend within the notice period the work may
 * continue. That is why `noticePeriodHours` and `notifiedAt` are columns —
 * the dispute is never about whether they turned up, it is about whether
 * notice was served, and this file answers that from data.
 *
 * Pure and deterministic: no clock (an `asOf` is always passed), no database,
 * no I/O. Every refusal comes back as a reason string that names the records
 * and parties involved, because a 403 that says "forbidden" is useless to the
 * engineer standing at the pour.
 */

import type { InterventionPoint, ItpActivityStatus } from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** Points at which somebody else is invited and a release is meaningful. */
export const RELEASABLE_INTERVENTION_POINTS: readonly InterventionPoint[] = [
  "hold_point",
  "witness_point",
  "review_point",
  "notification_point",
];

/** Points that stop the work outright until released or waived. */
export const BLOCKING_INTERVENTION_POINTS: readonly InterventionPoint[] = ["hold_point"];

/** Statuses at which the activity is finished with, one way or another. */
export const TERMINAL_ACTIVITY_STATUSES: readonly ItpActivityStatus[] = [
  "released",
  "waived",
  "closed",
  "not_applicable",
];

/** Statuses at which the activity is still outstanding. */
export const OPEN_ACTIVITY_STATUSES: readonly ItpActivityStatus[] = [
  "pending",
  "notified",
  "failed",
];

const releasableSet = new Set<string>(RELEASABLE_INTERVENTION_POINTS);
const blockingSet = new Set<string>(BLOCKING_INTERVENTION_POINTS);
const terminalSet = new Set<string>(TERMINAL_ACTIVITY_STATUSES);

export const isReleasablePoint = (p: string): boolean => releasableSet.has(p);
export const isBlockingPoint = (p: string): boolean => blockingSet.has(p);
export const isTerminalActivityStatus = (s: string): boolean => terminalSet.has(s);

const MS_PER_HOUR = 3_600_000;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/**
 * One nominated verifier. Stored as jsonb on the activity because several
 * parties commonly verify the same point (the engineer AND the client's
 * representative), and because a party is often an ORGANISATION with no user
 * account on this platform — a `party` label with no `userId` is a legitimate
 * and common row, and the release rules below have to cope with it.
 */
export interface VerifyingParty {
  party: string;
  interventionPoint?: string | null;
  vendorId?: string | null;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
}

/** An ITP activity as the state machine needs it. Real rows fit. */
export interface HoldPointActivityLike {
  id: string;
  activity: string;
  activityCode?: string | null;
  interventionPoint: string;
  status: string;
  noticePeriodHours: number | null;
  plannedDate: string | null;
  notifiedAt: string | null;
  notifiedBy: string | null;
  verifyingParties: unknown[];
  releasedBy?: string | null;
  releasedAt?: string | null;
  waivedBy?: string | null;
  waivedAt?: string | null;
}

/**
 * Why a transition was refused. `wrong_party` and `self_release` are
 * AUTHORISATION failures — the route maps them to 403, because the caller is
 * not entitled to make this decision no matter how the request is reworded.
 * Everything else is a state or data problem and maps to 400.
 */
export type RefusalCode =
  | "not_releasable"
  | "terminal"
  | "no_party"
  | "wrong_party"
  | "self_release"
  | "no_reason"
  | "blocked";

export interface Decision {
  allowed: boolean;
  reasons: string[];
  code?: RefusalCode;
}

/** Refusal codes the route layer must answer with 403 rather than 400. */
export const AUTHORISATION_REFUSALS: readonly RefusalCode[] = ["wrong_party", "self_release"];

const allow = (): Decision => ({ allowed: true, reasons: [] });
const refuse = (code: RefusalCode, ...reasons: string[]): Decision => ({
  allowed: false,
  reasons,
  code,
});

/** Parse the jsonb bag into typed parties, discarding anything unusable. */
export function parseVerifyingParties(raw: unknown): VerifyingParty[] {
  if (!Array.isArray(raw)) return [];
  const out: VerifyingParty[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const party = typeof rec["party"] === "string" ? rec["party"] : null;
    if (!party) continue;
    out.push({
      party,
      interventionPoint:
        typeof rec["interventionPoint"] === "string" ? rec["interventionPoint"] : null,
      vendorId: typeof rec["vendorId"] === "string" ? rec["vendorId"] : null,
      userId: typeof rec["userId"] === "string" ? rec["userId"] : null,
      name: typeof rec["name"] === "string" ? rec["name"] : null,
      email: typeof rec["email"] === "string" ? rec["email"] : null,
    });
  }
  return out;
}

/** How the nominated parties read on screen and in a refusal. */
export function describeParties(parties: VerifyingParty[]): string {
  if (parties.length === 0) return "(none nominated)";
  return parties.map((p) => (p.name ? `${p.party} (${p.name})` : p.party)).join(", ");
}

export const activityLabel = (a: HoldPointActivityLike): string =>
  a.activityCode ? `${a.activityCode} — ${a.activity}` : a.activity;

/* ------------------------------------------------------------------ */
/* Notice                                                              */
/* ------------------------------------------------------------------ */

export interface NoticeStatus {
  served: boolean;
  servedAt: string | null;
  noticePeriodHours: number | null;
  /** the instant the notice period runs out; null when it cannot be computed */
  noticeExpiresAt: string | null;
  /** the notice period has fully run at `nowMs` */
  noticeElapsed: boolean;
  reasons: string[];
}

/**
 * Where the notice stands. Never guesses: an activity with no recorded notice
 * period returns `noticeExpiresAt: null` with a reason rather than assuming
 * zero hours, because assuming zero would silently license proceeding past a
 * witness point the moment the invitation was sent.
 */
export function noticeStatus(a: HoldPointActivityLike, nowMs: number): NoticeStatus {
  const reasons: string[] = [];
  const servedAt = a.notifiedAt;
  if (!servedAt) {
    return {
      served: false,
      servedAt: null,
      noticePeriodHours: a.noticePeriodHours,
      noticeExpiresAt: null,
      noticeElapsed: false,
      reasons: ["No notice has been served on this activity."],
    };
  }
  const servedMs = Date.parse(servedAt);
  if (!Number.isFinite(servedMs)) {
    return {
      served: false,
      servedAt,
      noticePeriodHours: a.noticePeriodHours,
      noticeExpiresAt: null,
      noticeElapsed: false,
      reasons: [`Recorded notice timestamp ${servedAt} is unreadable.`],
    };
  }
  if (a.noticePeriodHours === null) {
    reasons.push(
      "No notice period is recorded on this activity, so whether the notice has run cannot be computed.",
    );
    return {
      served: true,
      servedAt,
      noticePeriodHours: null,
      noticeExpiresAt: null,
      noticeElapsed: false,
      reasons,
    };
  }
  const expiresMs = servedMs + a.noticePeriodHours * MS_PER_HOUR;
  return {
    served: true,
    servedAt,
    noticePeriodHours: a.noticePeriodHours,
    noticeExpiresAt: new Date(expiresMs).toISOString(),
    noticeElapsed: nowMs >= expiresMs,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

/** May notice be served on this activity now? */
export function canNotify(a: HoldPointActivityLike): Decision {
  if (!isReleasablePoint(a.interventionPoint)) {
    return refuse(
      "not_releasable",
      `A ${a.interventionPoint.replace(/_/g, " ")} is continuous monitoring: no party is summoned to it, so no notice is served.`,
    );
  }
  if (isTerminalActivityStatus(a.status)) {
    return refuse(
      "terminal",
      `Activity "${activityLabel(a)}" is already ${a.status}; serving notice on a closed point records nothing.`,
    );
  }
  return allow();
}

export interface ReleaseContext {
  /** the user releasing */
  actorId: string;
  /** who raised the point — the ITP author, or whoever served the notice */
  raisedBy: string | null;
}

/**
 * May THIS user release this point?
 *
 * Three refusals, in order:
 *
 *  1. The point is not the kind that gets released, or is already closed.
 *  2. No verifying party is nominated. A hold point released by nobody in
 *     particular is a signature on a blank line; the ITP is supposed to name
 *     who holds the point before the work starts.
 *  3. SEGREGATION. Where the nomination names users, only those users may
 *     release. Where it names organisations only, the party who raised the
 *     point may not also release it — self-release is the exact act the hold
 *     point exists to prevent, and an inability to prove the actor IS the
 *     nominated organisation is not a licence to assume they are.
 */
export function canRelease(a: HoldPointActivityLike, ctx: ReleaseContext): Decision {
  if (!isReleasablePoint(a.interventionPoint)) {
    return refuse(
      "not_releasable",
      `A ${a.interventionPoint.replace(/_/g, " ")} carries no release — there is nothing held to let go of.`,
    );
  }
  if (isTerminalActivityStatus(a.status)) {
    const by = a.status === "released" ? a.releasedBy : a.status === "waived" ? a.waivedBy : null;
    return refuse(
      "terminal",
      `Activity "${activityLabel(a)}" is already ${a.status}${by ? ` (by ${by})` : ""}.`,
    );
  }
  const parties = parseVerifyingParties(a.verifyingParties);
  if (parties.length === 0) {
    return refuse(
      "no_party",
      `No verifying party is nominated on activity "${activityLabel(a)}". A hold point must name who holds it before it can be released.`,
    );
  }
  const nominatedUserIds = parties
    .map((p) => p.userId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (nominatedUserIds.length > 0) {
    if (!nominatedUserIds.includes(ctx.actorId)) {
      return refuse(
        "wrong_party",
        `Release of "${activityLabel(a)}" is reserved to the nominated verifying party: ${describeParties(parties)}. ` +
          `User ${ctx.actorId} is not among them.`,
      );
    }
    return allow();
  }
  if (ctx.raisedBy && ctx.raisedBy === ctx.actorId) {
    return refuse(
      "self_release",
      `User ${ctx.actorId} raised this point and cannot also release it. The nominated verifying party is ${describeParties(parties)}; ` +
        `record the release against that party, or waive the point in writing with a reason.`,
    );
  }
  return allow();
}

/** May this point be waived, and is the waiver defensible? */
export function canWaive(a: HoldPointActivityLike, reason: string | null | undefined): Decision {
  if (isTerminalActivityStatus(a.status)) {
    return refuse("terminal", `Activity "${activityLabel(a)}" is already ${a.status}.`);
  }
  if (!reason || reason.trim().length === 0) {
    return refuse(
      "no_reason",
      "A waived hold point is a different fact from an attended one and only survives a challenge if the reason was written down at the time. A waiver reason is required.",
    );
  }
  return allow();
}

/**
 * May work proceed past this point at `nowMs`?
 *
 * Hold points: only once released or waived — full stop.
 * Witness points: released, waived, OR the notice period has fully run
 *   (the party was invited and did not attend, which is what the notice
 *   period buys the contractor).
 * Everything else: yes, the point records rather than gates.
 */
export function mayProceedPast(a: HoldPointActivityLike, nowMs: number): Decision {
  if (a.status === "released" || a.status === "waived" || a.status === "not_applicable") {
    return allow();
  }
  if (a.status === "failed") {
    return refuse(
      "blocked",
      `Activity "${activityLabel(a)}" failed its verification and has not been re-verified.`,
    );
  }
  if (a.interventionPoint === "hold_point") {
    return refuse(
      "blocked",
      `Hold point "${activityLabel(a)}" has not been released. Work may not proceed past an unreleased hold point.`,
    );
  }
  if (a.interventionPoint === "witness_point") {
    const notice = noticeStatus(a, nowMs);
    if (notice.noticeElapsed) return allow();
    if (!notice.served) {
      return refuse(
        "blocked",
        `Witness point "${activityLabel(a)}" has had no notice served. Work may not proceed until the party has been invited and the notice period has run.`,
      );
    }
    if (notice.noticeExpiresAt === null) {
      return refuse(
        "blocked",
        `Witness point "${activityLabel(a)}" has notice served at ${notice.servedAt} but no notice period recorded, so it cannot be shown that the period has run. ` +
          notice.reasons.join(" "),
      );
    }
    return refuse(
      "blocked",
      `Witness point "${activityLabel(a)}" was notified at ${notice.servedAt}; the ${notice.noticePeriodHours}h notice period does not run out until ${notice.noticeExpiresAt}.`,
    );
  }
  return allow();
}

/**
 * An unreleased hold point whose planned date has gone by. Either the work
 * is standing idle waiting for somebody, or it went ahead without them —
 * both worth a signal, and the platform cannot tell which from here, which
 * is exactly why a human is asked.
 */
export function isUnreleasedPastPlannedDate(
  a: HoldPointActivityLike,
  todayIso: string,
): boolean {
  if (a.interventionPoint !== "hold_point") return false;
  if (isTerminalActivityStatus(a.status)) return false;
  if (!a.plannedDate) return false;
  return a.plannedDate < todayIso;
}

/* ------------------------------------------------------------------ */
/* Rollups                                                             */
/* ------------------------------------------------------------------ */

export interface HoldPointSummary {
  activityCount: number;
  holdPointCount: number;
  witnessPointCount: number;
  openHoldPointCount: number;
  overdueHoldPointIds: string[];
  blockingActivityIds: string[];
}

export function summariseActivities(
  activities: HoldPointActivityLike[],
  todayIso: string,
  nowMs: number,
): HoldPointSummary {
  const overdueHoldPointIds: string[] = [];
  const blockingActivityIds: string[] = [];
  let holdPointCount = 0;
  let witnessPointCount = 0;
  let openHoldPointCount = 0;
  for (const a of activities) {
    if (a.interventionPoint === "hold_point") {
      holdPointCount += 1;
      if (!isTerminalActivityStatus(a.status)) openHoldPointCount += 1;
      if (isUnreleasedPastPlannedDate(a, todayIso)) overdueHoldPointIds.push(a.id);
    }
    if (a.interventionPoint === "witness_point") witnessPointCount += 1;
    if (!mayProceedPast(a, nowMs).allowed) blockingActivityIds.push(a.id);
  }
  return {
    activityCount: activities.length,
    holdPointCount,
    witnessPointCount,
    openHoldPointCount,
    overdueHoldPointIds,
    blockingActivityIds,
  };
}
