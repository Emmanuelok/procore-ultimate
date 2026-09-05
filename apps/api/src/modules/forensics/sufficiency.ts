/**
 * Record sufficiency scoring, gap detection and Scott Schedule assembly
 * (spec Vol II Domain D #307-309, #317-319) — pure.
 *
 * A claim is only as good as the contemporaneous record behind it. This scores
 * that record on four axes that a tribunal actually weighs:
 *
 *   PRESENCE        is there any evidence at all for this limb / event?
 *   INDEPENDENCE    was it produced by someone other than the claimant?
 *                   (the platform's own design rule: an assertion and the
 *                   evidence that tests it must not share an author)
 *   CONTEMPORANEITY was it captured near the event, or reconstructed later?
 *   COVERAGE        do the record TYPES a tribunal expects exist — a notice
 *                   inside the time bar, daily logs across the delay period,
 *                   photographs, an instruction?
 *
 * Scores are 0..1 and every one of them names what would raise it. The gap
 * detector reports date ranges inside a delay event with no daily log, and
 * events with no notice served inside the contractual time bar.
 *
 * Nothing here calls a claim good or bad — it reports what is missing.
 */

export interface EvidenceRecord {
  id: string;
  kind: string;
  /** 0..1; higher = more independent of the claimant */
  independenceScore: number | null;
  capturedAt: string | null;
}

export interface ChainLimbInput {
  key: "cause" | "effect" | "entitlement" | "quantum";
  text: string;
  /** evidence ids cited by this limb (from the linked events) */
  evidence: EvidenceRecord[];
}

export interface EventSufficiencyInput {
  eventId: string;
  number?: number;
  title: string;
  startDate: string;
  durationDays: number;
  evidence: EvidenceRecord[];
  /** notice served date, when a contract event is linked */
  noticeServedAt: string | null;
  /** contractual date by which notice had to be served */
  noticeDueDate: string | null;
  /** ISO dates on which a daily log exists within the event span */
  dailyLogDates: string[];
  /** record types present, e.g. ["daily_log","photo","rfi"] */
  recordTypes: string[];
}

export interface LimbScore {
  key: string;
  present: boolean;
  wordCount: number;
  evidenceCount: number;
  independenceScore: number | null;
  score: number;
  reasons: string[];
}

export interface EventScore {
  eventId: string;
  title: string;
  score: number;
  presence: number;
  independence: number | null;
  contemporaneity: number | null;
  coverage: number;
  noticeServed: boolean;
  noticeInTimeBar: boolean | null;
  logCoveragePercent: number;
  gaps: { from: string; to: string; days: number; kind: "no_daily_log" }[];
  reasons: string[];
}

export interface SufficiencyResult {
  overallScore: number;
  limbs: LimbScore[];
  events: EventScore[];
  gaps: { eventId: string; title: string; from: string; to: string; days: number; kind: string }[];
  missingNotices: { eventId: string; title: string; reason: string }[];
  reasons: string[];
  scoredAt: string;
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

/** Expected record types for a delay event; each missing one costs coverage. */
const EXPECTED_TYPES = ["daily_log", "photo", "correspondence", "instruction"];

/** Evidence captured within this many days of the event reads as contemporaneous. */
export const CONTEMPORANEITY_WINDOW_DAYS = 14;

function scoreLimb(limb: ChainLimbInput): LimbScore {
  const text = (limb.text ?? "").trim();
  const wordCount = text.length === 0 ? 0 : text.split(/\s+/).length;
  const reasons: string[] = [];
  if (wordCount === 0) reasons.push("The limb is empty");
  else if (wordCount < 25) reasons.push("The limb is very short — a tribunal expects the argument to be made, not gestured at");
  if (limb.evidence.length === 0) reasons.push("No evidence is linked through the claim's delay events");

  const independence =
    limb.evidence.length > 0
      ? round2(
          limb.evidence.reduce((s, e) => s + (e.independenceScore ?? 0), 0) / limb.evidence.length,
        )
      : null;
  if (independence !== null && independence < 0.5) {
    reasons.push("The supporting evidence is mostly self-generated — independent corroboration carries far more weight");
  }

  // Text presence 50%, evidence presence 30%, independence 20%.
  const textScore = wordCount === 0 ? 0 : Math.min(1, wordCount / 80);
  const evidenceScore = Math.min(1, limb.evidence.length / 3);
  const score = round2(0.5 * textScore + 0.3 * evidenceScore + 0.2 * (independence ?? 0));

  return {
    key: limb.key,
    present: wordCount > 0,
    wordCount,
    evidenceCount: limb.evidence.length,
    independenceScore: independence,
    score,
    reasons,
  };
}

function scoreEvent(e: EventSufficiencyInput): EventScore {
  const reasons: string[] = [];
  const spanDays = Math.max(1, e.durationDays);
  const logDates = new Set(e.dailyLogDates);

  /* ---- daily-log coverage and gaps ---- */
  const gaps: EventScore["gaps"] = [];
  let covered = 0;
  let runStart: string | null = null;
  for (let i = 0; i < spanDays; i += 1) {
    const day = addDays(e.startDate, i);
    if (logDates.has(day)) {
      covered += 1;
      if (runStart !== null) {
        gaps.push({ from: runStart, to: addDays(day, -1), days: diffDays(day, runStart), kind: "no_daily_log" });
        runStart = null;
      }
    } else if (runStart === null) {
      runStart = day;
    }
  }
  if (runStart !== null) {
    const last = addDays(e.startDate, spanDays - 1);
    gaps.push({ from: runStart, to: last, days: diffDays(last, runStart) + 1, kind: "no_daily_log" });
  }
  const logCoveragePercent = round2((covered / spanDays) * 100);
  if (logCoveragePercent < 100) {
    reasons.push(`Daily logs cover ${logCoveragePercent}% of the event's ${spanDays}-day span`);
  }

  /* ---- notice ---- */
  const noticeServed = e.noticeServedAt !== null;
  const noticeInTimeBar =
    e.noticeServedAt === null
      ? null
      : e.noticeDueDate === null
        ? null
        : e.noticeServedAt.slice(0, 10) <= e.noticeDueDate;
  if (!noticeServed) reasons.push("No notice has been recorded against this event");
  else if (noticeInTimeBar === false) reasons.push("The notice was served after the contractual time bar");

  /* ---- independence and contemporaneity ---- */
  const independence =
    e.evidence.length > 0
      ? round2(e.evidence.reduce((s, x) => s + (x.independenceScore ?? 0), 0) / e.evidence.length)
      : null;
  const dated = e.evidence.filter((x) => x.capturedAt !== null);
  const contemporaneity =
    dated.length > 0
      ? round2(
          dated.filter((x) => {
            const d = x.capturedAt!.slice(0, 10);
            const from = addDays(e.startDate, -CONTEMPORANEITY_WINDOW_DAYS);
            const to = addDays(e.startDate, spanDays + CONTEMPORANEITY_WINDOW_DAYS);
            return d >= from && d <= to;
          }).length / dated.length,
        )
      : null;
  if (contemporaneity !== null && contemporaneity < 0.5) {
    reasons.push("Most of the evidence was captured well outside the event window — reconstructed records carry little weight");
  }
  if (e.evidence.length === 0) reasons.push("No evidence is linked to this event");

  /* ---- coverage of expected record types ---- */
  const present = EXPECTED_TYPES.filter((t) => e.recordTypes.includes(t));
  const coverage = round2(present.length / EXPECTED_TYPES.length);
  const missingTypes = EXPECTED_TYPES.filter((t) => !e.recordTypes.includes(t));
  if (missingTypes.length > 0) reasons.push(`No ${missingTypes.join(", ")} record is linked`);

  const presence = Math.min(1, e.evidence.length / 3);
  const noticeScore = noticeServed ? (noticeInTimeBar === false ? 0.4 : 1) : 0;
  const score = round2(
    0.25 * presence +
      0.2 * (independence ?? 0) +
      0.2 * (contemporaneity ?? 0) +
      0.15 * coverage +
      0.1 * (logCoveragePercent / 100) +
      0.1 * noticeScore,
  );

  return {
    eventId: e.eventId,
    title: e.title,
    score,
    presence: round2(presence),
    independence,
    contemporaneity,
    coverage,
    noticeServed,
    noticeInTimeBar,
    logCoveragePercent,
    gaps,
    reasons,
  };
}

export function scoreClaimSufficiency(input: {
  limbs: ChainLimbInput[];
  events: EventSufficiencyInput[];
}): SufficiencyResult {
  const limbs = input.limbs.map(scoreLimb);
  const events = input.events.map(scoreEvent);
  const reasons: string[] = [];

  if (input.events.length === 0) {
    reasons.push("The claim links no delay events — there is nothing to score the record against");
  }
  const emptyLimbs = limbs.filter((l) => !l.present).map((l) => l.key);
  if (emptyLimbs.length > 0) {
    reasons.push(`The ${emptyLimbs.join(", ")} limb${emptyLimbs.length === 1 ? " is" : "s are"} empty`);
  }

  const limbAvg = limbs.length > 0 ? limbs.reduce((s, l) => s + l.score, 0) / limbs.length : 0;
  const eventAvg = events.length > 0 ? events.reduce((s, e) => s + e.score, 0) / events.length : 0;
  const overallScore = round2(events.length > 0 ? 0.5 * limbAvg + 0.5 * eventAvg : limbAvg * 0.5);

  return {
    overallScore,
    limbs,
    events,
    gaps: events.flatMap((e) =>
      e.gaps.map((g) => ({ eventId: e.eventId, title: e.title, from: g.from, to: g.to, days: g.days, kind: g.kind })),
    ),
    missingNotices: events
      .filter((e) => !e.noticeServed || e.noticeInTimeBar === false)
      .map((e) => ({
        eventId: e.eventId,
        title: e.title,
        reason: e.noticeServed ? "the notice was served outside the contractual time bar" : "no notice has been recorded",
      })),
    reasons,
    scoredAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Scott Schedule (#317-319)                                           */
/* ------------------------------------------------------------------ */

export interface ScottScheduleRow {
  item: number;
  reference: string;
  description: string;
  claimantContention: string;
  evidenceRefs: string[];
  daysClaimed: number | null;
  amountClaimed: number | null;
  /** filled in by the respondent; empty on generation */
  respondentResponse: string;
  daysAdmitted: number | null;
  amountAdmitted: number | null;
  /** filled in by the tribunal */
  tribunalFinding: string;
  daysAwarded: number | null;
  amountAwarded: number | null;
}

export interface ScottScheduleInput {
  claimNumber: number;
  claimTitle: string;
  currency: string;
  events: {
    id: string;
    number?: number;
    title: string;
    description: string | null;
    cause: string;
    party: string;
    excusable: boolean;
    compensable: boolean;
    startDate: string;
    durationDays: number;
    evidenceIds: string[];
    tiaDeltaDays: number | null;
  }[];
  /** per-event money, when the claim apportions it */
  amountsByEvent?: Record<string, number>;
}

/**
 * Build the Scott Schedule rows: one row per delay event, claimant columns
 * filled from the platform's records, respondent and tribunal columns left
 * deliberately empty — this platform does not write the other side's case.
 */
export function buildScottSchedule(input: ScottScheduleInput): ScottScheduleRow[] {
  return input.events.map((e, i) => ({
    item: i + 1,
    reference: e.number !== undefined ? `DE-${e.number}` : e.id,
    description: e.description ?? e.title,
    claimantContention:
      `${e.title}: a ${e.cause.replace(/_/g, " ")} event attributable to the ${e.party.replace(/_/g, " ")}, ` +
      `commencing ${e.startDate} and lasting ${e.durationDays} day(s). ` +
      (e.tiaDeltaDays !== null
        ? `Time impact analysis shows a ${e.tiaDeltaDays}-day movement of the completion date.`
        : "No time impact analysis has been run for this event.") +
      ` Classified ${e.excusable ? "excusable" : "non-excusable"} and ${e.compensable ? "compensable" : "non-compensable"}.`,
    evidenceRefs: e.evidenceIds,
    daysClaimed: e.tiaDeltaDays,
    amountClaimed: input.amountsByEvent?.[e.id] ?? null,
    respondentResponse: "",
    daysAdmitted: null,
    amountAdmitted: null,
    tribunalFinding: "",
    daysAwarded: null,
    amountAwarded: null,
  }));
}
