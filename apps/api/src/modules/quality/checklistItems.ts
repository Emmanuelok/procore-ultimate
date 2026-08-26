/**
 * THE typed-checklist-item validator and scoring engine.
 *
 * The `ChecklistItemType` vocabulary is shared by quality checklists, safety
 * inspection templates and prequalification questionnaires (see the comment
 * on CHECKLIST_ITEM_TYPES in packages/shared/src/enums.ts). This file is the
 * ONE implementation of what those types mean — what a valid answer looks
 * like, and whether an answer passes. Safety and prequalification import it
 * rather than writing a second and a third copy that drift apart on the
 * boundary cases below.
 *
 * Pure and deterministic: no clock, no database, no I/O. Everything is a
 * function of its arguments, which is why the boundary arithmetic can be
 * tested exhaustively (checklistScoring.test.ts) and the route layer can stay
 * thin.
 *
 * Honesty rule, carried through the whole file: an item that CANNOT be judged
 * — a measurement with a target but no tolerance, a free-text answer, a
 * select with no declared passing set — is `isPass: null` with a reason, and
 * is excluded from the score entirely. It is never silently counted as a
 * pass, because a checklist that scores 100% by counting unjudgeable items as
 * passes is worse than no checklist at all.
 */

import { z } from "zod";
import {
  CHECKLIST_ITEM_TYPES,
  type ChecklistItemType,
  type InspectionResult,
  type InspectionScoringMethod,
} from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* The vocabulary, grouped by how an answer is judged                  */
/* ------------------------------------------------------------------ */

/** The shared validator: every module that renders a typed item parses with this. */
export const checklistItemTypeSchema = z.enum(CHECKLIST_ITEM_TYPES);

/** Types whose answer is a number and whose pass is arithmetic. */
export const NUMERIC_ITEM_TYPES = [
  "numeric",
  "measurement",
  "instrument_reading",
  "temperature",
] as const;

/** Types whose answer is a token with a fixed pass/fail meaning. */
export const BOOLEAN_ITEM_TYPES = ["pass_fail", "pass_fail_na", "yes_no"] as const;

/** Types whose answer is drawn from the item's declared options. */
export const CHOICE_ITEM_TYPES = ["single_select", "multi_select"] as const;

/** Types whose answer is prose, a date or a signature — recorded, not judged. */
export const TEXT_ITEM_TYPES = ["text", "long_text", "date", "signature"] as const;

/** Types whose answer is one or more attached files. */
export const ATTACHMENT_ITEM_TYPES = ["photo", "file_upload"] as const;

/** Types that carry no answer at all — layout only. */
export const STRUCTURAL_ITEM_TYPES = ["section_header"] as const;

const numericSet = new Set<string>(NUMERIC_ITEM_TYPES);
const booleanSet = new Set<string>(BOOLEAN_ITEM_TYPES);
const choiceSet = new Set<string>(CHOICE_ITEM_TYPES);
const textSet = new Set<string>(TEXT_ITEM_TYPES);
const attachmentSet = new Set<string>(ATTACHMENT_ITEM_TYPES);
const structuralSet = new Set<string>(STRUCTURAL_ITEM_TYPES);

export const isNumericItemType = (t: string): boolean => numericSet.has(t);
export const isBooleanItemType = (t: string): boolean => booleanSet.has(t);
export const isChoiceItemType = (t: string): boolean => choiceSet.has(t);
export const isTextItemType = (t: string): boolean => textSet.has(t);
export const isAttachmentItemType = (t: string): boolean => attachmentSet.has(t);
export const isStructuralItemType = (t: string): boolean => structuralSet.has(t);

/** Types the platform can judge pass/fail without a human verdict. */
export const isJudgeableItemType = (t: string): boolean =>
  numericSet.has(t) || booleanSet.has(t);

/** Accepted answer tokens per boolean type, and which of them mean "passed". */
const BOOLEAN_TOKENS: Record<string, { accepted: string[]; passing: string[]; na: string[] }> = {
  pass_fail: { accepted: ["pass", "fail"], passing: ["pass"], na: [] },
  pass_fail_na: { accepted: ["pass", "fail", "na"], passing: ["pass"], na: ["na"] },
  yes_no: { accepted: ["yes", "no"], passing: ["yes"], na: [] },
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Comparison slack for tolerance arithmetic. A reading of 0.1 + 0.2 must not
 * fail an upper bound of 0.3 because IEEE-754 says 0.30000000000000004 — the
 * instrument did not misbehave, the float did. Ten orders of magnitude below
 * any construction tolerance, so it can never turn a real exceedance into a
 * pass.
 */
export const TOLERANCE_EPSILON = 1e-9;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Row shapes (structural — real drizzle rows satisfy these)           */
/* ------------------------------------------------------------------ */

/** A template item as the engine needs it. Real `checklist_template_items` rows fit. */
export interface ChecklistItemSpec {
  id: string;
  itemNumber?: string | null;
  text?: string;
  itemType: string;
  required: boolean;
  options: string[];
  targetValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  tolerancePlus: number | null;
  toleranceMinus: number | null;
  unit?: string | null;
  weight: number;
  isCritical: boolean;
  photoRequired: boolean;
  raisesNcrOnFail: boolean;
}

/** An answer as given. Real `checklist_responses` rows fit. */
export interface ChecklistAnswer {
  response?: string | null;
  numericValue?: number | null;
  selectedOptions?: string[] | null;
  isNotApplicable?: boolean;
  naReason?: string | null;
  photoFileIds?: string[] | null;
  fileIds?: string[] | null;
}

/* ------------------------------------------------------------------ */
/* Tolerance arithmetic                                                */
/* ------------------------------------------------------------------ */

export interface ToleranceBounds {
  lower: number | null;
  upper: number | null;
  /** why a bound is missing, or why the pair is unusable */
  reasons: string[];
}

/**
 * Resolve the acceptance window of a numeric item.
 *
 * Two independent ways of stating it, and BOTH bind when both are present:
 * an explicit `minValue`/`maxValue` pair, and a `targetValue` with
 * `toleranceMinus`/`tolerancePlus`. Where they disagree the TIGHTER wins,
 * because each is an acceptance criterion in its own right and work outside
 * either one is out of tolerance. The alternative — letting one silently
 * widen the other — is how a specified ±2mm becomes an accepted ±5mm.
 *
 * Tolerances are taken as magnitudes: a `toleranceMinus` recorded as -2 and
 * one recorded as 2 both mean "2 below target".
 */
export function toleranceBounds(item: ChecklistItemSpec): ToleranceBounds {
  const reasons: string[] = [];
  const fromToleranceLower =
    item.targetValue !== null && item.toleranceMinus !== null
      ? item.targetValue - Math.abs(item.toleranceMinus)
      : null;
  const fromToleranceUpper =
    item.targetValue !== null && item.tolerancePlus !== null
      ? item.targetValue + Math.abs(item.tolerancePlus)
      : null;

  const lowers = [item.minValue, fromToleranceLower].filter((v): v is number => v !== null);
  const uppers = [item.maxValue, fromToleranceUpper].filter((v): v is number => v !== null);
  const lower = lowers.length > 0 ? Math.max(...lowers) : null;
  const upper = uppers.length > 0 ? Math.min(...uppers) : null;

  if (lower === null && upper === null) {
    reasons.push(
      item.targetValue !== null
        ? "Item carries a target value but neither a tolerance nor a min/max bound — a reading cannot be judged against a target alone."
        : "Item carries no acceptance bound (no min, no max, no target with tolerance) — a reading cannot be judged.",
    );
  }
  if (lower !== null && upper !== null && lower > upper + TOLERANCE_EPSILON) {
    reasons.push(
      `Acceptance bounds are contradictory: lower ${lower} is above upper ${upper}. No reading can satisfy them.`,
    );
  }
  return { lower, upper, reasons };
}

export interface NumericVerdict {
  isPass: boolean | null;
  lower: number | null;
  upper: number | null;
  reasons: string[];
}

/**
 * Judge a reading against the item's window. Bounds are INCLUSIVE — a
 * reading exactly on the limit is in tolerance, which is what every
 * specification means by "±2mm" and what the boundary tests assert.
 */
export function evaluateNumeric(
  item: ChecklistItemSpec,
  value: number | null | undefined,
): NumericVerdict {
  const { lower, upper, reasons } = toleranceBounds(item);
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      isPass: null,
      lower,
      upper,
      reasons: [...reasons, "No numeric value was recorded against this item."],
    };
  }
  if (reasons.length > 0) return { isPass: null, lower, upper, reasons };
  const aboveLower = lower === null || value >= lower - TOLERANCE_EPSILON;
  const belowUpper = upper === null || value <= upper + TOLERANCE_EPSILON;
  return { isPass: aboveLower && belowUpper, lower, upper, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Answer validation                                                   */
/* ------------------------------------------------------------------ */

export interface AnswerValidation {
  ok: boolean;
  errors: string[];
}

/** Does this answer carry anything at all? */
export function answerIsPopulated(answer: ChecklistAnswer | null | undefined): boolean {
  if (!answer) return false;
  if (answer.isNotApplicable) return true;
  if (typeof answer.response === "string" && answer.response.trim() !== "") return true;
  if (typeof answer.numericValue === "number" && Number.isFinite(answer.numericValue)) return true;
  if (answer.selectedOptions && answer.selectedOptions.length > 0) return true;
  if (answer.photoFileIds && answer.photoFileIds.length > 0) return true;
  if (answer.fileIds && answer.fileIds.length > 0) return true;
  return false;
}

/**
 * Validate an answer against its typed item. Returns every problem at once
 * rather than the first, so a mobile client can mark up the whole form.
 */
export function validateAnswer(
  item: ChecklistItemSpec,
  answer: ChecklistAnswer,
): AnswerValidation {
  const errors: string[] = [];
  const label = item.itemNumber ? `Item ${item.itemNumber}` : `Item ${item.id}`;

  if (isStructuralItemType(item.itemType)) {
    if (answerIsPopulated(answer)) {
      errors.push(`${label} is a section header and takes no answer.`);
    }
    return { ok: errors.length === 0, errors };
  }

  if (answer.isNotApplicable) {
    if (item.itemType === "pass_fail" || item.itemType === "yes_no") {
      errors.push(
        `${label} is a ${item.itemType} item, which does not permit "not applicable". Use a pass_fail_na item where NA is a legitimate answer.`,
      );
    }
    if (!answer.naReason || answer.naReason.trim() === "") {
      errors.push(`${label} was marked not applicable without a reason.`);
    }
    return { ok: errors.length === 0, errors };
  }

  const populated = answerIsPopulated(answer);
  if (item.required && !populated) {
    errors.push(`${label} is required and has no answer.`);
  }

  if (isNumericItemType(item.itemType)) {
    if (answer.numericValue !== null && answer.numericValue !== undefined) {
      if (!Number.isFinite(answer.numericValue)) {
        errors.push(`${label} expects a finite numeric value.`);
      }
    } else if (populated) {
      errors.push(`${label} is a ${item.itemType} item and expects numericValue.`);
    }
  } else if (isBooleanItemType(item.itemType)) {
    const spec = BOOLEAN_TOKENS[item.itemType]!;
    if (populated) {
      const token = (answer.response ?? "").trim().toLowerCase();
      if (!spec.accepted.includes(token)) {
        errors.push(
          `${label} expects one of ${spec.accepted.join(" / ")} — received ${JSON.stringify(answer.response)}.`,
        );
      }
    }
  } else if (item.itemType === "single_select") {
    if (populated) {
      const token = answer.response ?? "";
      if (!item.options.includes(token)) {
        errors.push(
          `${label} expects one of the declared options (${item.options.join(", ") || "none declared"}) — received ${JSON.stringify(token)}.`,
        );
      }
    }
  } else if (item.itemType === "multi_select") {
    const chosen = answer.selectedOptions ?? [];
    const unknown = chosen.filter((o) => !item.options.includes(o));
    if (unknown.length > 0) {
      errors.push(`${label} received options not declared on the template: ${unknown.join(", ")}.`);
    }
  } else if (item.itemType === "date") {
    if (populated && !ISO_DATE_RE.test(answer.response ?? "")) {
      errors.push(`${label} expects an ISO date (YYYY-MM-DD).`);
    }
  } else if (item.itemType === "photo") {
    if (item.required && (answer.photoFileIds ?? []).length === 0) {
      errors.push(`${label} requires at least one photo.`);
    }
  } else if (item.itemType === "file_upload") {
    if (item.required && (answer.fileIds ?? []).length === 0) {
      errors.push(`${label} requires at least one attached file.`);
    }
  }

  if (item.photoRequired && (answer.photoFileIds ?? []).length === 0 && populated) {
    errors.push(`${label} requires a photograph alongside the answer.`);
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Per-item evaluation                                                 */
/* ------------------------------------------------------------------ */

export interface ItemEvaluation {
  itemId: string;
  /** true / false where the platform can judge it, null where it cannot */
  isPass: boolean | null;
  /** the item took part in the arithmetic */
  judged: boolean;
  answered: boolean;
  notApplicable: boolean;
  score: number | null;
  maxScore: number | null;
  /** critical AND failed — the band that fails the whole checklist */
  criticalFailure: boolean;
  reasons: string[];
}

export function evaluateAnswerItem(
  item: ChecklistItemSpec,
  answer: ChecklistAnswer | null | undefined,
): ItemEvaluation {
  const base = {
    itemId: item.id,
    isPass: null as boolean | null,
    judged: false,
    answered: false,
    notApplicable: false,
    score: null as number | null,
    maxScore: null as number | null,
    criticalFailure: false,
  };

  if (isStructuralItemType(item.itemType)) {
    return { ...base, reasons: ["Section header — carries no answer and no score."] };
  }
  const answered = answerIsPopulated(answer);
  if (!answered) {
    return {
      ...base,
      reasons: [
        item.required
          ? "Required item is unanswered — it is excluded from the score rather than counted as a pass."
          : "Item is unanswered.",
      ],
    };
  }
  if (answer!.isNotApplicable) {
    return {
      ...base,
      answered: true,
      notApplicable: true,
      reasons: [
        `Marked not applicable${answer!.naReason ? `: ${answer!.naReason}` : ""} — excluded from the score.`,
      ],
    };
  }

  if (isNumericItemType(item.itemType)) {
    const verdict = evaluateNumeric(item, answer!.numericValue);
    if (verdict.isPass === null) {
      return { ...base, answered: true, reasons: verdict.reasons };
    }
    return {
      ...base,
      answered: true,
      judged: true,
      isPass: verdict.isPass,
      score: verdict.isPass ? item.weight : 0,
      maxScore: item.weight,
      criticalFailure: item.isCritical && !verdict.isPass,
      reasons: [],
    };
  }

  if (isBooleanItemType(item.itemType)) {
    const spec = BOOLEAN_TOKENS[item.itemType]!;
    const token = (answer!.response ?? "").trim().toLowerCase();
    if (spec.na.includes(token)) {
      return {
        ...base,
        answered: true,
        notApplicable: true,
        reasons: ["Answered not applicable — excluded from the score."],
      };
    }
    if (!spec.accepted.includes(token)) {
      return {
        ...base,
        answered: true,
        reasons: [
          `Answer ${JSON.stringify(answer!.response)} is not one of ${spec.accepted.join(" / ")} — the item cannot be judged.`,
        ],
      };
    }
    const isPass = spec.passing.includes(token);
    return {
      ...base,
      answered: true,
      judged: true,
      isPass,
      score: isPass ? item.weight : 0,
      maxScore: item.weight,
      criticalFailure: item.isCritical && !isPass,
      reasons: [],
    };
  }

  const why = isChoiceItemType(item.itemType)
    ? "A select item declares options but no passing set, so the platform records the choice and does not judge it."
    : isAttachmentItemType(item.itemType)
      ? "An attachment item records evidence; whether the evidence is acceptable is a human judgement."
      : "A free-text answer is recorded, not judged.";
  return { ...base, answered: true, reasons: [why] };
}

/* ------------------------------------------------------------------ */
/* Whole-checklist scoring                                             */
/* ------------------------------------------------------------------ */

export interface ScoreEntry {
  item: ChecklistItemSpec;
  answer: ChecklistAnswer | null;
}

export interface ChecklistScore {
  /** null when the method produces no score, or nothing could be judged */
  score: number | null;
  maxScore: number | null;
  scorePercent: number | null;
  /** null when there is not enough answered to state a verdict */
  result: InspectionResult | null;
  answeredItemCount: number;
  judgedItemCount: number;
  failedItemCount: number;
  criticalFailureCount: number;
  notApplicableCount: number;
  unansweredRequiredItemIds: string[];
  failedItemIds: string[];
  criticalFailureItemIds: string[];
  evaluations: ItemEvaluation[];
  /** why a figure is null, or how a verdict was reached without one */
  reasons: string[];
}

export interface ScoreOptions {
  scoringMethod: InspectionScoringMethod | string;
  passThreshold: number | null;
}

/**
 * Score a checklist.
 *
 * `pass_fail` and `none` deliberately produce NO number (see the enum
 * comment): a pass/fail form has no percentage, and inventing one from the
 * count of ticked boxes would put a figure on a record that never carried
 * one. `percentage` counts judged items equally; `weighted` and `points` sum
 * the item weights.
 *
 * The verdict, in order of precedence:
 *   1. any critical item failed          → fail, whatever the score says
 *   2. pass_fail method                  → fail iff anything failed
 *   3. a pass threshold is recorded      → compare the percentage to it
 *   4. no threshold                      → pass with zero failures, otherwise
 *                                          pass_with_observations, and a
 *                                          reason saying the score was not
 *                                          used because no threshold exists
 */
export function scoreChecklist(entries: ScoreEntry[], opts: ScoreOptions): ChecklistScore {
  const reasons: string[] = [];
  const evaluations: ItemEvaluation[] = [];
  const unansweredRequiredItemIds: string[] = [];
  const failedItemIds: string[] = [];
  const criticalFailureItemIds: string[] = [];
  let answeredItemCount = 0;
  let judgedItemCount = 0;
  let notApplicableCount = 0;
  let rawScore = 0;
  let rawMax = 0;
  let passedCount = 0;

  for (const entry of entries) {
    const evaluation = evaluateAnswerItem(entry.item, entry.answer);
    evaluations.push(evaluation);
    if (isStructuralItemType(entry.item.itemType)) continue;
    if (evaluation.answered) answeredItemCount += 1;
    else if (entry.item.required) unansweredRequiredItemIds.push(entry.item.id);
    if (evaluation.notApplicable) notApplicableCount += 1;
    if (!evaluation.judged) continue;
    judgedItemCount += 1;
    rawScore += evaluation.score ?? 0;
    rawMax += evaluation.maxScore ?? 0;
    if (evaluation.isPass) passedCount += 1;
    else {
      failedItemIds.push(entry.item.id);
      if (evaluation.criticalFailure) criticalFailureItemIds.push(entry.item.id);
    }
  }

  const failedItemCount = failedItemIds.length;
  const criticalFailureCount = criticalFailureItemIds.length;

  let score: number | null = null;
  let maxScore: number | null = null;
  if (opts.scoringMethod === "none" || opts.scoringMethod === "pass_fail") {
    reasons.push(
      `Scoring method "${opts.scoringMethod}" produces no score — the record carries a verdict only.`,
    );
  } else if (judgedItemCount === 0) {
    reasons.push(
      "No item on this checklist could be judged pass or fail, so no score can be computed.",
    );
  } else if (opts.scoringMethod === "percentage") {
    score = passedCount;
    maxScore = judgedItemCount;
  } else {
    score = round2(rawScore);
    maxScore = round2(rawMax);
  }

  let scorePercent: number | null = null;
  if (score !== null && maxScore !== null) {
    if (maxScore > 0) scorePercent = round2((score / maxScore) * 100);
    else reasons.push("Maximum score is zero — no percentage can be computed.");
  }

  let result: InspectionResult | null = null;
  if (answeredItemCount === 0) {
    reasons.push("No items have been answered — no result can be stated.");
  } else if (criticalFailureCount > 0) {
    result = "fail";
  } else if (judgedItemCount === 0 && notApplicableCount === answeredItemCount) {
    result = "not_applicable";
  } else if (opts.scoringMethod === "pass_fail" || opts.scoringMethod === "none") {
    result = failedItemCount > 0 ? "fail" : "pass";
  } else if (opts.passThreshold !== null) {
    if (scorePercent === null) {
      reasons.push(
        `A pass threshold of ${opts.passThreshold}% is recorded but no percentage could be computed, so the threshold cannot be applied.`,
      );
    } else if (scorePercent >= opts.passThreshold - TOLERANCE_EPSILON) {
      result = failedItemCount > 0 ? "pass_with_observations" : "pass";
    } else {
      result = "fail";
    }
  } else {
    result = failedItemCount > 0 ? "pass_with_observations" : "pass";
    reasons.push(
      "No pass threshold is recorded on the template, so the verdict reflects failures only and not the score.",
    );
  }

  if (unansweredRequiredItemIds.length > 0) {
    reasons.push(
      `${unansweredRequiredItemIds.length} required item(s) are unanswered and were excluded from the score rather than counted as passes.`,
    );
  }

  return {
    score,
    maxScore,
    scorePercent,
    result,
    answeredItemCount,
    judgedItemCount,
    failedItemCount,
    criticalFailureCount,
    notApplicableCount,
    unansweredRequiredItemIds,
    failedItemIds,
    criticalFailureItemIds,
    evaluations,
    reasons,
  };
}

/** Narrowing helper for callers holding a plain string. */
export function asChecklistItemType(value: string): ChecklistItemType | null {
  return (CHECKLIST_ITEM_TYPES as readonly string[]).includes(value)
    ? (value as ChecklistItemType)
    : null;
}

/* ------------------------------------------------------------------ */
/* Template-time validation                                            */
/* ------------------------------------------------------------------ */

/**
 * Validate an item DEFINITION, before anybody answers it.
 *
 * The point is to refuse a template that cannot be judged rather than
 * discover it at the pour: a `measurement` item carrying a target and no
 * tolerance produces `isPass: null` for every reading ever taken against it,
 * so it fails silently for the life of the form. Caught here it is one 400;
 * caught later it is a year of unjudgeable records.
 */
export function validateItemDefinition(item: {
  itemType: string;
  options?: string[];
  targetValue?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  tolerancePlus?: number | null;
  toleranceMinus?: number | null;
  isCritical?: boolean;
  raisesNcrOnFail?: boolean;
  weight?: number;
}): AnswerValidation {
  const errors: string[] = [];
  if (isChoiceItemType(item.itemType) && (item.options ?? []).length === 0) {
    errors.push(
      `A ${item.itemType} item must declare its options — a select with nothing to select from cannot be answered.`,
    );
  }
  if (!isChoiceItemType(item.itemType) && (item.options ?? []).length > 0) {
    errors.push(
      `Options are only meaningful on ${CHOICE_ITEM_TYPES.join(" / ")} items; a ${item.itemType} item ignores them, so recording them would mislead whoever reads the template.`,
    );
  }
  if (isNumericItemType(item.itemType)) {
    const bounds = toleranceBounds({
      id: "",
      itemType: item.itemType,
      required: true,
      options: [],
      targetValue: item.targetValue ?? null,
      minValue: item.minValue ?? null,
      maxValue: item.maxValue ?? null,
      tolerancePlus: item.tolerancePlus ?? null,
      toleranceMinus: item.toleranceMinus ?? null,
      weight: 1,
      isCritical: false,
      photoRequired: false,
      raisesNcrOnFail: false,
    });
    if (bounds.reasons.length > 0) {
      errors.push(...bounds.reasons);
    }
  } else if (
    item.targetValue !== null &&
    item.targetValue !== undefined &&
    !isNumericItemType(item.itemType)
  ) {
    errors.push(
      `A target value is only judged on ${NUMERIC_ITEM_TYPES.join(" / ")} items; a ${item.itemType} item would carry it unused.`,
    );
  }
  if (item.weight !== undefined && (!Number.isFinite(item.weight) || item.weight < 0)) {
    errors.push("Item weight must be a finite, non-negative number.");
  }
  if (isStructuralItemType(item.itemType) && (item.isCritical || item.raisesNcrOnFail)) {
    errors.push("A section header cannot be critical or raise an NCR — it carries no answer to fail.");
  }
  return { ok: errors.length === 0, errors };
}
