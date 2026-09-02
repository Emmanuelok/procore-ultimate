/**
 * Deterministic evidence-sufficiency scoring (Vol II X #1017–#1018).
 *
 * The platform must never present a model's own confidence as if it were a
 * measure of how well grounded the answer is. This score is computed from the
 * PROVENANCE of the run — how many records were supplied, how many distinct
 * kinds, how much grounded text, whether anything contradicting was included
 * — before the model is called, so it is reproducible and explainable.
 *
 * It is a measure of the EVIDENCE, not of the ANSWER. A perfect score on a
 * wrong answer is possible; a low score is a reason to distrust a confident
 * one, and policies can refuse auto-approval below a threshold.
 */
import type { InputRef } from "./service.js";

export interface EvidenceScoreInput {
  inputRefs: InputRef[];
  /** characters of grounded context actually placed in the prompt */
  contextChars: number;
  /** the agent's schema demands citations */
  citationsRequired: boolean;
  /** records supplied that could contradict the proposition (0 when unknown) */
  contradictions?: number;
}

export interface EvidenceScoreResult {
  score: number;
  basis: Record<string, unknown>;
}

/** Records beyond this add nothing: breadth saturates. */
const BREADTH_TARGET = 8;
/** Distinct record TYPES beyond this add nothing. */
const DIVERSITY_TARGET = 4;
/** Grounded characters beyond this add nothing. */
const DENSITY_TARGET = 4_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 0..1. Four components with fixed weights, every one of them reported in the
 * basis so the number can be argued with:
 *
 *   breadth   0.35  how many records were supplied
 *   diversity 0.25  how many distinct kinds of record
 *   density   0.25  how much grounded text reached the model
 *   challenge 0.15  whether anything that could contradict was included
 */
export function computeEvidenceScore(input: EvidenceScoreInput): EvidenceScoreResult {
  const refs = input.inputRefs ?? [];
  const types = new Set(refs.map((r) => r.type));
  const contradictions = input.contradictions ?? 0;

  const breadth = Math.min(refs.length / BREADTH_TARGET, 1);
  const diversity = Math.min(types.size / DIVERSITY_TARGET, 1);
  const density = Math.min(Math.max(input.contextChars, 0) / DENSITY_TARGET, 1);
  // No contradicting record is not proof there is none, so the floor is 0.4
  // rather than 0 — the score says "untested", not "refuted".
  const challenge = contradictions > 0 ? 1 : 0.4;

  const score =
    refs.length === 0 && input.contextChars === 0
      ? 0
      : round2(0.35 * breadth + 0.25 * diversity + 0.25 * density + 0.15 * challenge);

  return {
    score,
    basis: {
      records: refs.length,
      distinctTypes: types.size,
      types: [...types].sort(),
      contextChars: input.contextChars,
      contradictionsSupplied: contradictions,
      citationsRequired: input.citationsRequired,
      components: {
        breadth: round2(breadth),
        diversity: round2(diversity),
        density: round2(density),
        challenge: round2(challenge),
      },
      weights: { breadth: 0.35, diversity: 0.25, density: 0.25, challenge: 0.15 },
    },
  };
}

/**
 * What the review queue should show as the CONFIDENCE of a proposal: the
 * model's own number, damped by the evidence it was actually given and by any
 * citation it invented. Never raises the model's number.
 */
export function effectiveConfidence(
  modelConfidence: number | null | undefined,
  evidenceScore: number | null,
  droppedCitations: number,
): number | null {
  if (typeof modelConfidence !== "number" || !Number.isFinite(modelConfidence)) return null;
  let value = Math.min(Math.max(modelConfidence, 0), 1);
  if (typeof evidenceScore === "number") value = Math.min(value, 0.4 + 0.6 * evidenceScore);
  // A fabricated citation is a grounding failure, not a rounding error.
  if (droppedCitations > 0) value = Math.min(value, 0.5);
  return round2(value);
}
