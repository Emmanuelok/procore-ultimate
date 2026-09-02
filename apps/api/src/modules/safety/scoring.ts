/**
 * SAFETY — the pure arithmetic (M21, spec Vol I §2.11).
 *
 * Everything here is a function of its arguments. No clock, no database, no
 * I/O, no `Date.now()`. The route layer reads rows, calls these, and writes
 * the result; that separation is what lets the numbers be exhaustively unit
 * tested and what keeps the lazy sweeps idempotent.
 *
 * Three kinds of number live here, and one rule governs all of them:
 *
 *   A FIGURE THAT CANNOT BE DERIVED IS `null` WITH A REASON. Never a zero,
 *   never a default, never a silently narrowed denominator. A risk score of
 *   0 reads as "assessed and harmless"; a null with "likelihood was never
 *   scored" reads as what it is. On this module in particular the difference
 *   is not cosmetic — an inspection reported as 100% because nobody answered
 *   anything is a lie that gets signed.
 */

import { addDaysISO } from "../field/dates.js";
import type { ChecklistItemType, InspectionResult, InspectionScoringMethod } from "@constructos/shared";

/* ================================================================== */
/* Risk scoring — likelihood × severity                                */
/* ================================================================== */

export const RISK_BANDS = ["low", "medium", "high", "critical"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

/** The 5×5 matrix axis labels, so the UI and the API agree on the words. */
export const RISK_LIKELIHOOD_LABELS: Record<number, string> = {
  1: "rare",
  2: "unlikely",
  3: "possible",
  4: "likely",
  5: "almost certain",
};

export const RISK_SEVERITY_LABELS: Record<number, string> = {
  1: "negligible",
  2: "minor",
  3: "moderate",
  4: "major",
  5: "catastrophic",
};

export interface RiskScore {
  likelihood: number;
  severity: number;
  /** likelihood × severity, 1..25 */
  score: number;
  band: RiskBand;
  /** e.g. "likely × major (16) — critical" */
  label: string;
  /** what the band means operationally, for the payload */
  guidance: string;
}

const BAND_GUIDANCE: Record<RiskBand, string> = {
  low: "Monitor. No further control required beyond what is already in place.",
  medium:
    "Additional control required within the planned works. Assign an owner and a date.",
  high:
    "Do not proceed on the existing controls. A named owner, a dated action and a re-inspection are required.",
  critical:
    "Stop the activity. Work may not resume until the control is in place and has been verified by someone other than the person who applied it.",
};

/**
 * The band boundaries of the conventional 5×5 matrix. Stated as data rather
 * than buried in an if-chain so the thresholds can be read off in a review:
 * 1-4 low, 5-9 medium, 10-14 high, 15-25 critical.
 */
export function riskBand(score: number): RiskBand {
  if (score >= 15) return "critical";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

/**
 * Risk score from likelihood × severity, each scored 1-5.
 *
 * Throws on an out-of-range axis rather than clamping. Clamping a 7 to a 5
 * would produce a plausible number from an impossible input, and the whole
 * point of the score is that somebody will act on it.
 */
export function computeRiskScore(likelihood: number, severity: number): RiskScore {
  assertAxis(likelihood, "likelihood");
  assertAxis(severity, "severity");
  const score = likelihood * severity;
  const band = riskBand(score);
  return {
    likelihood,
    severity,
    score,
    band,
    label: `${RISK_LIKELIHOOD_LABELS[likelihood]} × ${RISK_SEVERITY_LABELS[severity]} (${score}) — ${band}`,
    guidance: BAND_GUIDANCE[band],
  };
}

function assertAxis(value: number, axis: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new RangeError(
      `Risk ${axis} must be a whole number 1-5 (received ${String(value)}). ` +
        `A score computed from an out-of-range axis would look like a real number and be acted on.`,
    );
  }
}

export interface OptionalRiskScore {
  /** null when either axis is missing — never a fabricated zero */
  score: RiskScore | null;
  reasons: string[];
}

/**
 * The tolerant form used on ingest: an observation may legitimately be filed
 * without a risk assessment (a positive observation, a housekeeping note), so
 * a missing axis is reported, not defaulted.
 */
export function optionalRiskScore(
  likelihood: number | null | undefined,
  severity: number | null | undefined,
): OptionalRiskScore {
  const reasons: string[] = [];
  if (likelihood == null) reasons.push("Risk likelihood was not scored.");
  if (severity == null) reasons.push("Risk severity was not scored.");
  if (reasons.length > 0) return { score: null, reasons };
  return { score: computeRiskScore(likelihood as number, severity as number), reasons: [] };
}

/* ================================================================== */
/* Inspection scoring                                                  */
/* ================================================================== */

/** A typed template item. Structural — the jsonb rows satisfy this. */
export interface TemplateItem {
  id: string;
  section?: string | null;
  position?: number | null;
  text: string;
  itemType: ChecklistItemType;
  required?: boolean;
  options?: string[] | null;
  guidance?: string | null;
  /** relative weight under the `weighted` and `points` methods; default 1 */
  weight?: number | null;
  /** a critical item failing fails the whole inspection whatever the score */
  isCritical?: boolean;
  photoRequired?: boolean;
}

export interface InspectionAnswer {
  itemId: string;
  response?: string | null;
  numericValue?: number | null;
  /** null means "not applicable" — excluded from the denominator entirely */
  isPass?: boolean | null;
  note?: string | null;
  photoFileIds?: string[];
  actionId?: string | null;
}

export interface InspectionDefect {
  itemId: string;
  text: string;
  section: string | null;
  isCritical: boolean;
  note: string | null;
  photoFileIds: string[];
}

export interface InspectionScore {
  /** null under `pass_fail` and `none`, and whenever nothing was scorable */
  score: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  result: InspectionResult;
  defects: InspectionDefect[];
  defectCount: number;
  criticalDefectCount: number;
  /** required items with no answer at all — completion is refused on these */
  unansweredRequired: string[];
  /**
   * Items the template marks `photoRequired` that were answered without one.
   *
   * A photograph is not decoration on a safety inspection: it is the only
   * evidence that the inspector was at the thing they signed off. The quality
   * module's checklist engine has always enforced this
   * (`quality/checklistItems.ts`), and the two forms share one vocabulary, so
   * a safety template that asks for a photo and accepts a pass without one
   * makes the flag meaningless — and spec #621 silently unmet.
   */
  missingPhotos: string[];
  /** answers pointing at items the template does not contain */
  unknownItemIds: string[];
  answeredCount: number;
  notApplicableCount: number;
  /** why score / scorePercent are null */
  reasons: string[];
}

/** Item types that carry no verdict and never enter a denominator. */
const NON_SCORING_ITEM_TYPES: ReadonlySet<string> = new Set([
  "section_header",
  "text",
  "long_text",
  "date",
  "signature",
  "photo",
  "file_upload",
  "single_select",
  "multi_select",
]);

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Turn a set of answers into a score and a verdict.
 *
 * Rules, in the order they bite:
 *  1. A critical item answered `isPass: false` fails the inspection outright,
 *     whatever the arithmetic says. That is the entire point of marking an
 *     item critical.
 *  2. `isPass: null` is "not applicable": excluded from numerator AND
 *     denominator. Counting an N/A as a pass inflates every score on site.
 *  3. Nothing scorable answered ⇒ percent is null with a reason, and the
 *     result is `not_applicable`. It is NOT 100% and it is NOT a pass.
 *  4. `pass_threshold` decides pass/fail when a percent exists; without a
 *     threshold, any defect downgrades a pass to `pass_with_observations`.
 */
export function scoreInspection(
  items: readonly TemplateItem[],
  answers: readonly InspectionAnswer[],
  method: InspectionScoringMethod,
  passThreshold: number | null,
): InspectionScore {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const reasons: string[] = [];
  const unknownItemIds = answers.filter((a) => !byId.has(a.itemId)).map((a) => a.itemId);

  const answerById = new Map<string, InspectionAnswer>();
  for (const a of answers) if (byId.has(a.itemId)) answerById.set(a.itemId, a);

  const unansweredRequired: string[] = [];
  const missingPhotos: string[] = [];
  for (const item of items) {
    const a = answerById.get(item.id);
    const answered =
      a !== undefined &&
      (a.isPass !== undefined ||
        (a.response != null && a.response !== "") ||
        a.numericValue != null);
    if (item.required && !(NON_SCORING_ITEM_TYPES.has(item.itemType) && item.itemType === "section_header")) {
      if (!answered) unansweredRequired.push(item.id);
    }
    /* The photo duty attaches to an ANSWERED item, required or not: a pass
     * recorded against a photo-required question with no photograph is the
     * case the flag exists to catch. An unanswered item is already caught
     * above, and reporting it twice would just make the refusal noisier. */
    if (item.photoRequired === true && answered && (a?.photoFileIds ?? []).length === 0) {
      missingPhotos.push(item.id);
    }
  }
  if (missingPhotos.length > 0) {
    reasons.push(
      `${missingPhotos.length} item(s) the template marks photo-required were answered without a ` +
        `photograph (${missingPhotos.join(", ")}). The photograph is the evidence that the ` +
        `inspector was at the thing they signed off; without it the answer is an assertion.`,
    );
  }

  const defects: InspectionDefect[] = [];
  let criticalDefectCount = 0;
  let numerator = 0;
  let denominator = 0;
  let answeredCount = 0;
  let notApplicableCount = 0;

  for (const [itemId, a] of answerById) {
    const item = byId.get(itemId)!;
    if (a.isPass === false) {
      defects.push({
        itemId,
        text: item.text,
        section: item.section ?? null,
        isCritical: item.isCritical === true,
        note: a.note ?? null,
        photoFileIds: a.photoFileIds ?? [],
      });
      if (item.isCritical === true) criticalDefectCount += 1;
    }
    if (a.isPass === null || a.isPass === undefined) {
      if (a.isPass === null) notApplicableCount += 1;
      // an item with no verdict contributes nothing either way
      if (a.isPass === null) answeredCount += 1;
      else if (a.response != null || a.numericValue != null) answeredCount += 1;
      continue;
    }
    answeredCount += 1;
    if (NON_SCORING_ITEM_TYPES.has(item.itemType)) continue;

    const weight = item.weight != null && item.weight > 0 ? item.weight : 1;
    switch (method) {
      case "percentage":
        denominator += 1;
        if (a.isPass) numerator += 1;
        break;
      case "weighted":
        denominator += weight;
        if (a.isPass) numerator += weight;
        break;
      case "points":
        denominator += weight;
        numerator += a.numericValue != null ? a.numericValue : a.isPass ? weight : 0;
        break;
      case "pass_fail":
      case "none":
        break;
    }
  }

  let score: number | null = null;
  let maxScore: number | null = null;
  let scorePercent: number | null = null;

  if (method === "none") {
    reasons.push("The template's scoring method is `none` — this form records verdicts, not a score.");
  } else if (method === "pass_fail") {
    reasons.push(
      "The template's scoring method is `pass_fail` — the verdict is the output; there is no percentage.",
    );
  } else if (denominator <= 0) {
    reasons.push(
      "No scorable item was answered with a pass or fail verdict, so there is no denominator. " +
        "A percentage computed here would be an invented figure.",
    );
  } else {
    score = round2(numerator);
    maxScore = round2(denominator);
    scorePercent = round2((numerator / denominator) * 100);
  }

  const result = decideResult({
    criticalDefectCount,
    defectCount: defects.length,
    scorePercent,
    passThreshold,
    answeredCount,
    method,
  });

  return {
    score,
    maxScore,
    scorePercent,
    result,
    defects,
    defectCount: defects.length,
    criticalDefectCount,
    unansweredRequired,
    missingPhotos,
    unknownItemIds,
    answeredCount,
    notApplicableCount,
    reasons,
  };
}

function decideResult(input: {
  criticalDefectCount: number;
  defectCount: number;
  scorePercent: number | null;
  passThreshold: number | null;
  answeredCount: number;
  method: InspectionScoringMethod;
}): InspectionResult {
  if (input.criticalDefectCount > 0) return "fail";
  if (input.answeredCount === 0) return "not_applicable";
  if (input.method === "pass_fail" || input.method === "none") {
    return input.defectCount > 0 ? "fail" : "pass";
  }
  if (input.scorePercent == null) return "not_applicable";
  if (input.passThreshold != null) {
    if (input.scorePercent < input.passThreshold) return "fail";
    return input.defectCount > 0 ? "pass_with_observations" : "pass";
  }
  return input.defectCount > 0 ? "pass_with_observations" : "pass";
}

/* ================================================================== */
/* Statutory re-inspection intervals                                   */
/* ================================================================== */

export interface NextDue {
  /** null for `ad_hoc` — there is no interval to add */
  nextDueDate: string | null;
  reasons: string[];
}

/**
 * The next date a statutory inspection falls due. The intervals are the ones
 * the duty-holder regimes actually use — a scaffold inspected weekly under
 * the Work at Height Regulations 2005 reg. 12(3), lifting equipment at 6 or
 * 12 months under LOLER 1998 reg. 9 — but the interval is carried on the
 * TEMPLATE, not hard-coded per inspection type, because the same physical
 * asset attracts different intervals in different jurisdictions.
 */
export function nextStatutoryDueDate(performedDateISO: string, frequency: string): NextDue {
  switch (frequency) {
    case "per_shift":
    case "daily":
      return { nextDueDate: addDaysISO(performedDateISO, 1), reasons: [] };
    case "weekly":
      return { nextDueDate: addDaysISO(performedDateISO, 7), reasons: [] };
    case "fortnightly":
      return { nextDueDate: addDaysISO(performedDateISO, 14), reasons: [] };
    case "monthly":
      return { nextDueDate: addMonthsISO(performedDateISO, 1), reasons: [] };
    case "quarterly":
      return { nextDueDate: addMonthsISO(performedDateISO, 3), reasons: [] };
    case "six_monthly":
      return { nextDueDate: addMonthsISO(performedDateISO, 6), reasons: [] };
    case "annual":
      return { nextDueDate: addMonthsISO(performedDateISO, 12), reasons: [] };
    default:
      return {
        nextDueDate: null,
        reasons: [
          `Frequency \`${frequency}\` carries no interval, so no next-due date can be derived. ` +
            `A statutory inspection with no recurrence recorded will never be swept as overdue — ` +
            `set a frequency on the template or a next-due date by hand.`,
        ],
      };
  }
}

/**
 * Month arithmetic that does not silently roll over. 31 January + 1 month is
 * 28/29 February, not 2/3 March: a statutory re-inspection date that jumps
 * the month boundary is a date the duty-holder will be judged against.
 */
export function addMonthsISO(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

/* ================================================================== */
/* Reporting delay                                                     */
/* ================================================================== */

export interface ReportingDelay {
  hours: number | null;
  /** true once the delay crosses the threshold at which lateness is itself a finding */
  isLate: boolean;
  threshold: number;
  reasons: string[];
  note: string | null;
}

/**
 * The gap between the event and the report of it.
 *
 * This is recorded because it is evidence in its own right: an enforcement
 * interview opens on when the site knew, and a 40-hour delay on a serious
 * injury is a finding about the reporting culture regardless of what the
 * investigation concludes about the accident.
 */
export function computeReportingDelay(
  occurredAt: string,
  reportedAt: string | null | undefined,
  thresholdHours = 24,
): ReportingDelay {
  if (!reportedAt) {
    return {
      hours: null,
      isLate: false,
      threshold: thresholdHours,
      reasons: ["The incident has no reported-at timestamp, so the reporting delay is unknown."],
      note: null,
    };
  }
  const start = Date.parse(occurredAt);
  const end = Date.parse(reportedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return {
      hours: null,
      isLate: false,
      threshold: thresholdHours,
      reasons: ["occurredAt or reportedAt is not a parseable timestamp."],
      note: null,
    };
  }
  const hours = round2((end - start) / 3_600_000);
  const isLate = hours > thresholdHours;
  return {
    hours,
    isLate,
    threshold: thresholdHours,
    reasons: [],
    note: isLate
      ? `Reported ${hours} hours after it happened, beyond the ${thresholdHours}-hour internal ` +
        `threshold. Late internal reporting is itself an investigation finding: it delays the ` +
        `preservation of the scene, the witness accounts and — where the event is reportable — ` +
        `the statutory clock the site is judged against.`
      : null,
  };
}
