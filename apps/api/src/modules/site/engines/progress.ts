/**
 * Progress determination (spec Vol II X #995–1003; Vol III §4 primitives).
 *
 * A contractor claims a zone is 80% complete. Somebody walks it, flies it or
 * scans it and forms an independent view. Those are two DIFFERENT primitives:
 * the claim is an Assertion, the observation is Evidence, and the comparison
 * between them is a Reconciliation. This engine decides what that comparison
 * says — and, first, whether it is allowed to say anything at all.
 *
 * THE RULE THAT MATTERS (Vol III §4): an Assertion and the Evidence that tests
 * it may not be authored by the same actor through the same pathway. An
 * observation recorded by the same person who made the claim is not evidence;
 * it is the claim restated. The engine REFUSES it rather than recording a
 * self-verified progress figure — which is precisely the fraud the platform
 * exists to make impossible.
 *
 * Independence is then scored rather than assumed: a laser scan is stronger
 * evidence than someone's eye, and an observation by an employee of the
 * claiming subcontractor is weaker than one by the client's engineer.
 */

export type ReconciliationResultValue =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "contradicted"
  | "insufficient_evidence";

export interface ProgressInput {
  claimedPercent: number;
  observedPercent: number;
  method: string;
  /** the user (or entity) whose claim this is */
  claimantId: string;
  /** the user who made the observation */
  observerId: string;
  /** employer of the claimant and of the observer, when known */
  claimantVendorId?: string | null;
  observerVendorId?: string | null;
  /** photographs, point clouds or survey files attached to the observation */
  attachmentCount?: number;
  /** a capture record (scan or flight) the observation is derived from */
  hasCaptureRecord?: boolean;
  /** percentage points treated as measurement noise */
  tolerancePercent?: number;
}

export interface ProgressAssessment {
  variancePercent: number;
  result: ReconciliationResultValue;
  confidence: number;
  independenceScore: number;
  independenceBasis: string[];
  overclaim: boolean;
  reasons: string[];
}

export class SelfVerifiedProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfVerifiedProgressError";
  }
}

/** How much an observation of this kind is worth on its own, before actors. */
const METHOD_INDEPENDENCE: Record<string, number> = {
  scan: 0.95,
  survey: 0.9,
  drone: 0.85,
  measurement: 0.75,
  photo: 0.6,
  visual: 0.45,
};

const METHOD_LABEL: Record<string, string> = {
  scan: "laser scan",
  survey: "instrument survey",
  drone: "drone capture",
  measurement: "physical measurement",
  photo: "photographic record",
  visual: "visual inspection",
};

/**
 * Throws `SelfVerifiedProgressError` when the observer is the claimant. The
 * caller turns that into a 400 with the reason quoted; it is never downgraded
 * to a low confidence score, because a self-verified claim is not weak
 * evidence, it is no evidence.
 */
export function assertDifferentActors(claimantId: string, observerId: string): void {
  if (claimantId && observerId && claimantId === observerId) {
    throw new SelfVerifiedProgressError(
      "The observation and the claim it tests were authored by the same actor. An assertion and the evidence that tests it must come from different pathways, so this observation cannot be recorded. Have someone other than the claimant observe the work.",
    );
  }
}

export function scoreIndependence(input: ProgressInput): { score: number; basis: string[] } {
  const basis: string[] = [];
  const method = input.method;
  let score = METHOD_INDEPENDENCE[method] ?? 0.4;
  basis.push(`${METHOD_LABEL[method] ?? method} scores ${score.toFixed(2)} as a method.`);

  if (input.claimantVendorId && input.observerVendorId && input.claimantVendorId === input.observerVendorId) {
    score -= 0.3;
    basis.push(
      "The observer and the claimant work for the same company (−0.30): common employment is a common interest.",
    );
  } else if (input.observerVendorId && input.claimantVendorId && input.observerVendorId !== input.claimantVendorId) {
    score += 0.05;
    basis.push("The observer is employed by a different company from the claimant (+0.05).");
  }

  const attachments = input.attachmentCount ?? 0;
  if (input.hasCaptureRecord) {
    score += 0.1;
    basis.push("The observation is tied to a capture record (scan or flight) that can be re-examined (+0.10).");
  } else if (attachments > 0) {
    score += 0.05;
    basis.push(`${attachments} file(s) are attached to the observation (+0.05).`);
  } else {
    score -= 0.1;
    basis.push("Nothing is attached to the observation, so it cannot be re-examined by anyone else (−0.10).");
  }

  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score, basis };
}

export function assessProgress(input: ProgressInput): ProgressAssessment {
  assertDifferentActors(input.claimantId, input.observerId);

  const tolerance = typeof input.tolerancePercent === "number" && input.tolerancePercent >= 0 ? input.tolerancePercent : 5;
  const claimed = clampPercent(input.claimedPercent);
  const observed = clampPercent(input.observedPercent);
  const variance = Math.round((claimed - observed) * 100) / 100;

  const { score: independenceScore, basis: independenceBasis } = scoreIndependence(input);
  const reasons: string[] = [];

  let result: ReconciliationResultValue;
  if (independenceScore < 0.35) {
    result = "insufficient_evidence";
    reasons.push(
      `The observation scores ${independenceScore.toFixed(2)} for independence, below the 0.35 needed to test a claim. Record the observation with a stronger method or an observer outside the claimant's organisation.`,
    );
  } else if (variance <= tolerance) {
    result = "supported";
    if (variance < -tolerance) {
      reasons.push(
        `The work observed (${observed}%) is ahead of what was claimed (${claimed}%). The claim is supported and understated by ${Math.abs(variance)} percentage points.`,
      );
    } else {
      reasons.push(
        `Claimed ${claimed}% against ${observed}% observed — within the ${tolerance} percentage-point tolerance for this method.`,
      );
    }
  } else if (variance <= tolerance * 3) {
    result = "partially_supported";
    reasons.push(
      `Claimed ${claimed}% but only ${observed}% was observed: ${variance} percentage points beyond the ${tolerance}-point tolerance.`,
    );
  } else if (observed === 0 && claimed > 0) {
    result = "contradicted";
    reasons.push(
      `${claimed}% was claimed and nothing was observed in place. The claim is contradicted, not merely unsupported.`,
    );
  } else {
    result = "unsupported";
    reasons.push(
      `Claimed ${claimed}% against ${observed}% observed — an overclaim of ${variance} percentage points, more than three times the ${tolerance}-point tolerance.`,
    );
  }

  // Confidence in the VERDICT: how independent the evidence is, tempered by
  // how close the numbers are to the decision boundary.
  const distanceFromBoundary = Math.min(Math.abs(Math.abs(variance) - tolerance), tolerance) / Math.max(tolerance, 1);
  const confidence =
    result === "insufficient_evidence"
      ? Math.round(independenceScore * 100) / 100
      : Math.round(Math.min(0.99, independenceScore * (0.75 + 0.25 * distanceFromBoundary)) * 100) / 100;

  return {
    variancePercent: variance,
    result,
    confidence,
    independenceScore,
    independenceBasis,
    overclaim: result === "partially_supported" || result === "unsupported" || result === "contradicted",
    reasons,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

/** Severity for the signal an overclaim raises — bigger gaps shout louder. */
export function overclaimSeverity(variancePercent: number): "low" | "medium" | "high" | "critical" {
  if (variancePercent >= 40) return "critical";
  if (variancePercent >= 20) return "high";
  if (variancePercent >= 10) return "medium";
  return "low";
}
