import type { PrequalRiskRating, PrequalTier } from "@constructos/shared";
import { round2, unknowable, type Unknowable } from "./shared.js";

/**
 * AUTOMATIC TIERING — WHAT SIZE OF PACKAGE MAY THIS VENDOR BE CONSIDERED FOR.
 *
 * A prequalification score is a number nobody uses. What a buyer actually
 * asks, standing in front of a £4m package with a shortlist to build, is
 * "may this firm be on this list at all" — so the score, the financial
 * screening and the SAFETY RECORD collapse into one letter, and the letter
 * carries the sentence that produced it.
 *
 * Three rules give this file its shape:
 *
 *  1. THE SCORE OPENS THE DOOR; THE OTHER INPUTS CLOSE IT. A band from the
 *     assessment sets the best tier available, and every other input can only
 *     CAP it — never raise it. A vendor cannot buy their way past a fatality
 *     with a strong balance sheet, and the arithmetic is what makes that
 *     true rather than the assessor's memory of the policy.
 *
 *  2. SAFETY IS A CEILING, NOT A WEIGHTING. A recorded fatality or an EMR
 *     above 1.5 caps the vendor at C whatever else is true; an EMR above 1.2
 *     caps at B. Averaged in with commercial answers, a fatality is worth
 *     about four percentage points and disappears. That is exactly how it
 *     disappears in practice, and it is the failure this rule exists to
 *     prevent.
 *
 *  3. MISSING IS NOT GOOD. No safety record, no financial limit and no
 *     checked reference are three different absences, and each caps the tier
 *     with its own sentence. `unrated` is a real answer and it is never
 *     dressed up as C: "we do not know" and "we looked and it was poor" are
 *     different findings that a buyer must be able to tell apart.
 *
 * Pure: no database, no clock beyond the `asOf` passed in, no I/O. Every
 * branch is unit-tested in tiering.test.ts.
 */

/* ------------------------------------------------------------------ */
/* Thresholds — stated once, cited in every basis sentence             */
/* ------------------------------------------------------------------ */

export interface TieringRule {
  /** score at or above which tier A is reachable */
  tierAScorePercent: number;
  /** score at or above which tier B is reachable */
  tierBScorePercent: number;
  /** score below which no tier is granted at all */
  tierCScorePercent: number;
  /** EMR above this caps at tier C */
  emrHardCap: number;
  /** EMR above this caps at tier B */
  emrSoftCap: number;
  /** TRIR above this caps at tier B */
  trirSoftCap: number;
  /** how many years back a safety record still counts */
  safetyWindowYears: number;
}

export const DEFAULT_TIERING_RULE: TieringRule = {
  tierAScorePercent: 85,
  tierBScorePercent: 70,
  tierCScorePercent: 50,
  emrHardCap: 1.5,
  emrSoftCap: 1.2,
  trirSoftCap: 6,
  safetyWindowYears: 3,
};

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export interface SafetyFact {
  year: number;
  emr: number | null;
  trir: number | null;
  dart: number | null;
  fatalities: number | null;
  /** self_declared | audited | regulator */
  source: string;
}

export interface LicenceFact {
  kind: string;
  status: string;
  /** ISO date, or null where the vendor did not state one */
  expiresAt: string | null;
}

export interface ReferenceFact {
  outcome: string;
  /** who took the reference up — null means nobody did */
  checkedBy: string | null;
}

export interface TieringInput {
  scorePercent: number | null;
  passThreshold: number | null;
  knockoutFailed: boolean;
  /** the recommended single-project limit, in `limitCurrency` */
  singleProjectLimit: number | null;
  limitCurrency: string;
  safety: readonly SafetyFact[];
  licences: readonly LicenceFact[];
  references: readonly ReferenceFact[];
  /** ISO date the assessment is made as at */
  asOf: string;
  rule?: TieringRule;
}

export interface TieringVerdict {
  tier: PrequalTier;
  tierBasis: string;
  riskRating: PrequalRiskRating;
  riskBasis: string;
  /** every rule that lowered the tier below the score band, in order */
  ceilings: string[];
  /** the tier the score alone would have granted */
  scoreBandTier: PrequalTier;
  /** the safety year the ceilings were computed from, where there was one */
  safetyYear: number | null;
  /** headroom on the financial limit, or why there is none */
  limit: Unknowable<number>;
}

const TIER_ORDER: readonly PrequalTier[] = ["a", "b", "c", "unrated"];

/** The WORSE of two tiers. Nothing in this file can improve a tier. */
export function capTier(current: PrequalTier, ceiling: PrequalTier): PrequalTier {
  return TIER_ORDER.indexOf(ceiling) > TIER_ORDER.indexOf(current) ? ceiling : current;
}

/** The safety records inside the window, most recent year first. */
export function safetyInWindow(
  safety: readonly SafetyFact[],
  asOf: string,
  windowYears: number,
): SafetyFact[] {
  const year = Number(asOf.slice(0, 4));
  const floor = Number.isFinite(year) ? year - windowYears : Number.NEGATIVE_INFINITY;
  return [...safety]
    .filter((s) => s.year >= floor)
    .sort((a, b) => b.year - a.year || sourceWeight(b.source) - sourceWeight(a.source));
}

/** Audited beats filed beats self-declared when two rows describe one year. */
function sourceWeight(source: string): number {
  if (source === "regulator") return 3;
  if (source === "audited") return 2;
  return 1;
}

const isoLte = (a: string | null, b: string): boolean =>
  a !== null && a.slice(0, 10) <= b.slice(0, 10);

/* ------------------------------------------------------------------ */
/* The rule                                                            */
/* ------------------------------------------------------------------ */

export function assessTier(input: TieringInput): TieringVerdict {
  const rule = input.rule ?? DEFAULT_TIERING_RULE;
  const ceilings: string[] = [];
  const asOf = input.asOf.slice(0, 10);

  /* --- the score band -------------------------------------------- */
  let scoreBandTier: PrequalTier;
  let bandSentence: string;
  if (input.knockoutFailed) {
    scoreBandTier = "unrated";
    bandSentence =
      "The submission failed a knockout question, so no tier is granted: a knockout is the " +
      "answer that ends the assessment, not a score to be banded.";
  } else if (input.scorePercent === null) {
    scoreBandTier = "unrated";
    bandSentence =
      "The submission carries no overall score — a required question was left unassessed — so " +
      "there is no band to place it in. This is 'not known', not 'poor'.";
  } else {
    const floor = input.passThreshold ?? rule.tierCScorePercent;
    if (input.scorePercent < floor) {
      scoreBandTier = "unrated";
      bandSentence =
        `Scored ${round2(input.scorePercent)}%, below the ${round2(floor)}% floor, so no tier ` +
        "is granted.";
    } else if (input.scorePercent >= rule.tierAScorePercent) {
      scoreBandTier = "a";
      bandSentence = `Scored ${round2(input.scorePercent)}%, at or above the ${rule.tierAScorePercent}% tier A band.`;
    } else if (input.scorePercent >= rule.tierBScorePercent) {
      scoreBandTier = "b";
      bandSentence = `Scored ${round2(input.scorePercent)}%, in the ${rule.tierBScorePercent}–${rule.tierAScorePercent}% tier B band.`;
    } else {
      scoreBandTier = "c";
      bandSentence = `Scored ${round2(input.scorePercent)}%, in the ${round2(floor)}–${rule.tierBScorePercent}% tier C band.`;
    }
  }

  let tier = scoreBandTier;

  /* --- safety: a ceiling, never a weighting ----------------------- */
  const window = safetyInWindow(input.safety, asOf, rule.safetyWindowYears);
  const latest = window[0] ?? null;
  const fatalities = window.reduce((n, s) => n + (s.fatalities ?? 0), 0);
  const worstEmr = window.reduce<number | null>(
    (worst, s) => (s.emr === null ? worst : worst === null ? s.emr : Math.max(worst, s.emr)),
    null,
  );
  const worstTrir = window.reduce<number | null>(
    (worst, s) => (s.trir === null ? worst : worst === null ? s.trir : Math.max(worst, s.trir)),
    null,
  );

  if (window.length === 0) {
    tier = capTier(tier, "b");
    ceilings.push(
      `No safety record inside the last ${rule.safetyWindowYears} years is on file, so tier A ` +
        "is not available. A missing safety history is not a clean one.",
    );
  }
  if (fatalities > 0) {
    tier = capTier(tier, "c");
    ceilings.push(
      `${fatalities} fatality(ies) recorded in the last ${rule.safetyWindowYears} years caps ` +
        "this vendor at tier C, whatever the balance sheet and the questionnaire say.",
    );
  }
  if (worstEmr !== null && worstEmr > rule.emrHardCap) {
    tier = capTier(tier, "c");
    ceilings.push(
      `Worst EMR in the window is ${round2(worstEmr)}, above the ${rule.emrHardCap} hard cap — ` +
        "tier C.",
    );
  } else if (worstEmr !== null && worstEmr > rule.emrSoftCap) {
    tier = capTier(tier, "b");
    ceilings.push(
      `Worst EMR in the window is ${round2(worstEmr)}, above the ${rule.emrSoftCap} threshold — ` +
        "tier A is not available.",
    );
  }
  if (worstTrir !== null && worstTrir > rule.trirSoftCap) {
    tier = capTier(tier, "b");
    ceilings.push(
      `Worst TRIR in the window is ${round2(worstTrir)}, above ${rule.trirSoftCap} per 200k ` +
        "hours — tier A is not available.",
    );
  }
  if (latest !== null && latest.source === "self_declared" && window.every((s) => s.source === "self_declared")) {
    tier = capTier(tier, "b");
    ceilings.push(
      "Every safety figure on file is self-declared and none has been audited or taken from a " +
        "regulator, so tier A is not available on this evidence.",
    );
  }

  /* --- licences: an expired licence is a stop --------------------- */
  const adverse = input.licences.filter(
    (l) => l.status === "expired" || l.status === "suspended" || l.status === "revoked",
  );
  const lapsed = input.licences.filter(
    (l) => l.status !== "not_applicable" && isoLte(l.expiresAt, asOf),
  );
  if (adverse.length > 0 || lapsed.length > 0) {
    const kinds = [...new Set([...adverse, ...lapsed].map((l) => l.kind))].sort();
    tier = capTier(tier, "c");
    ceilings.push(
      `${kinds.length} licence(s) are expired, suspended or revoked (${kinds.join(", ")}), which ` +
        "caps this vendor at tier C until the register is put right.",
    );
  }

  /* --- money: no derived limit means no known capacity ------------ */
  let limit: Unknowable<number>;
  if (input.singleProjectLimit === null) {
    limit = unknowable<number>(
      "No single-project limit has been derived for this vendor: without filed accounts there " +
        "is no basis for one, and a limit invented here would be a number with no source.",
    );
    tier = capTier(tier, "c");
    ceilings.push(
      "No financial screening produced a single-project limit, so the vendor's capacity is " +
        "unknown and the tier is capped at C.",
    );
  } else {
    limit = { value: round2(input.singleProjectLimit), reasons: [] };
  }

  /* --- references: checked, or merely collected ------------------- */
  const checked = input.references.filter((r) => r.checkedBy !== null && r.checkedBy !== "");
  const badOutcome = input.references.filter(
    (r) => r.outcome === "terminated" || r.outcome === "disputed",
  );
  if (badOutcome.length > 0) {
    tier = capTier(tier, "c");
    ceilings.push(
      `${badOutcome.length} reference(s) report a terminated or disputed contract — tier C ` +
        "until the circumstances are recorded and accepted.",
    );
  } else if (checked.length === 0 && tier === "a") {
    tier = capTier(tier, "b");
    ceilings.push(
      "No reference on file has been taken up by a named person, so tier A is not available: a " +
        "list of names the vendor supplied is not a checked reference.",
    );
  }

  const tierBasis =
    tier === "unrated"
      ? bandSentence
      : `${bandSentence}${ceilings.length > 0 ? ` ${ceilings.join(" ")}` : " No ceiling applied."}`;

  /* --- risk rating ------------------------------------------------ */
  const highReasons: string[] = [];
  if (fatalities > 0) highReasons.push(`${fatalities} fatality(ies) in the window`);
  if (worstEmr !== null && worstEmr > rule.emrSoftCap) {
    highReasons.push(`EMR ${round2(worstEmr)} above ${rule.emrSoftCap}`);
  }
  if (adverse.length > 0 || lapsed.length > 0) highReasons.push("an expired or revoked licence");
  if (badOutcome.length > 0) highReasons.push("a terminated or disputed reference");
  if (input.scorePercent !== null && input.scorePercent < rule.tierBScorePercent) {
    highReasons.push(`an assessment score of ${round2(input.scorePercent)}%`);
  }
  if (input.knockoutFailed) highReasons.push("a knockout failure");

  let riskRating: PrequalRiskRating;
  let riskBasis: string;
  if (highReasons.length > 0) {
    riskRating = "high";
    riskBasis = `High risk on ${highReasons.join("; ")}.`;
  } else if (input.scorePercent === null && window.length === 0) {
    riskRating = "unrated";
    riskBasis =
      "Neither an overall score nor a safety record is on file, so no risk rating is stated. " +
      "An unrated vendor is not a low-risk vendor.";
  } else if (
    input.scorePercent !== null &&
    input.scorePercent >= rule.tierAScorePercent &&
    worstEmr !== null &&
    worstEmr <= 1 &&
    checked.length > 0 &&
    input.singleProjectLimit !== null
  ) {
    riskRating = "low";
    riskBasis =
      `Low risk: scored ${round2(input.scorePercent)}%, worst EMR ${round2(worstEmr)} at or ` +
      `below 1.0, ${checked.length} checked reference(s), and a derived single-project limit of ` +
      `${input.limitCurrency} ${round2(input.singleProjectLimit)}.`;
  } else {
    riskRating = "medium";
    const gaps: string[] = [];
    if (window.length === 0) gaps.push("no safety record on file");
    if (worstEmr === null && window.length > 0) gaps.push("no EMR stated");
    if (checked.length === 0) gaps.push("no reference taken up");
    if (input.singleProjectLimit === null) gaps.push("no derived financial limit");
    riskBasis =
      "Medium risk: nothing adverse is recorded, and the evidence is not strong enough to say " +
      `low${gaps.length > 0 ? ` (${gaps.join(", ")})` : ""}.`;
  }

  return {
    tier,
    tierBasis,
    riskRating,
    riskBasis,
    ceilings,
    scoreBandTier,
    safetyYear: latest?.year ?? null,
    limit,
  };
}
