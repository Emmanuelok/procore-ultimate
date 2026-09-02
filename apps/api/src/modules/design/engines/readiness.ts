/**
 * DESIGN-TO-CONSTRUCTION HANDOVER READINESS (spec #907–#908) and the
 * PROFESSIONAL INDEMNITY ADEQUACY CHECK (#912) — pure, no I/O.
 *
 * Readiness is a weighted roll-up of six dimensions. The rule that makes it
 * honest: a dimension with NO inputs scores `null` and is dropped from the
 * weighting, and the confidence falls to say so. It is never scored 0 —
 * "we have no information" and "the information is bad" are different
 * statements and a handover decision turns on which one it is.
 *
 * What it deliberately does not do: read the database, or block anything. It
 * produces a verdict and its basis; the routes decide what to do with it.
 */
import type { DesignReadinessLevel } from "@constructos/shared";

export interface ReadinessDimension {
  key: string;
  label: string;
  score: number | null; // 0..100
  weight: number;
  basis: string;
  inputs: Record<string, number | null>;
  reasons: string[];
}

export interface ReadinessVerdict {
  score: number | null;
  level: DesignReadinessLevel;
  confidence: number; // 0..1 — share of weight that had inputs
  dimensions: ReadinessDimension[];
  blockers: string[];
  reasons: string[];
}

export interface ReadinessInputs {
  /** design packages in scope */
  packages: Array<{ id: string; status: string; stageKey: string | null }>;
  /** review cycles for those packages */
  reviews: Array<{ packageId: string; status: string; consolidatedCode: string | null }>;
  /** open comments across those reviews */
  openComments: number;
  totalComments: number;
  /** issue register */
  issues: Array<{ status: string; priority: string }>;
  /** deliverables */
  deliverables: Array<{ status: string; slippageLevel: string }>;
  /** information requirements */
  infoRequirements: Array<{ status: string }>;
  /** change notices */
  changeNotices: Array<{ status: string; isPostFreeze: boolean }>;
  /** freezes in force over the scope */
  activeFreezes: number;
}

const pct = (numerator: number, denominator: number): number => Math.round((numerator / denominator) * 1000) / 10;

const ACCEPTED_CODES = new Set(["A", "B"]);

/**
 * Score the six dimensions and roll them up.
 *
 * approval    — packages approved or frozen out of packages in scope
 * review      — review cycles that closed with an accepted code
 * comments    — comments closed out of comments raised
 * issues      — issues closed, with critical/high open counted as blockers
 * deliverables— deliverables issued and not late
 * information — EIR/BEP/TIDP milestones delivered or verified
 */
export function assessReadiness(input: ReadinessInputs): ReadinessVerdict {
  const dimensions: ReadinessDimension[] = [];
  const blockers: string[] = [];
  const reasons: string[] = [];

  /* approval ------------------------------------------------------- */
  {
    const live = input.packages.filter((p) => p.status !== "cancelled" && p.status !== "superseded");
    const done = live.filter((p) => p.status === "approved" || p.status === "frozen");
    dimensions.push({
      key: "package_approval",
      label: "Package approval",
      weight: 0.25,
      score: live.length === 0 ? null : pct(done.length, live.length),
      basis:
        live.length === 0
          ? "No live design package is in scope."
          : `${done.length} of ${live.length} live package(s) are approved or frozen.`,
      inputs: { livePackages: live.length, approved: done.length },
      reasons: live.length === 0 ? ["No design package has been registered for this scope."] : [],
    });
    if (live.length > 0 && done.length < live.length) {
      blockers.push(`${live.length - done.length} design package(s) are not yet approved.`);
    }
  }

  /* review --------------------------------------------------------- */
  {
    const closed = input.reviews.filter((r) => r.status === "closed");
    const accepted = closed.filter((r) => r.consolidatedCode !== null && ACCEPTED_CODES.has(r.consolidatedCode));
    const open = input.reviews.filter((r) => r.status !== "closed" && r.status !== "cancelled");
    dimensions.push({
      key: "review_outcome",
      label: "Review outcome",
      weight: 0.2,
      score: closed.length === 0 ? null : pct(accepted.length, closed.length),
      basis:
        closed.length === 0
          ? input.reviews.length === 0
            ? "No review cycle has been run."
            : "No review cycle has closed yet."
          : `${accepted.length} of ${closed.length} closed cycle(s) ended accepted (code A or B).`,
      inputs: { cycles: input.reviews.length, closed: closed.length, accepted: accepted.length, open: open.length },
      reasons: closed.length === 0 ? ["No closed review cycle, so review outcome cannot be scored."] : [],
    });
    if (open.length > 0) blockers.push(`${open.length} review cycle(s) are still open.`);
  }

  /* comments ------------------------------------------------------- */
  {
    const closedComments = input.totalComments - input.openComments;
    dimensions.push({
      key: "comment_closeout",
      label: "Comment close-out",
      weight: 0.15,
      score: input.totalComments === 0 ? null : pct(closedComments, input.totalComments),
      basis:
        input.totalComments === 0
          ? "No review comments have been raised."
          : `${closedComments} of ${input.totalComments} comment(s) are closed.`,
      inputs: { comments: input.totalComments, open: input.openComments },
      reasons: input.totalComments === 0 ? ["No comment has been raised, so close-out cannot be scored."] : [],
    });
    if (input.openComments > 0) blockers.push(`${input.openComments} review comment(s) are still open.`);
  }

  /* issues --------------------------------------------------------- */
  {
    const live = input.issues.filter((i) => i.status !== "void");
    const closed = live.filter((i) => i.status === "closed" || i.status === "resolved");
    const criticalOpen = live.filter(
      (i) => (i.priority === "critical" || i.priority === "high") && i.status !== "closed" && i.status !== "resolved",
    );
    dimensions.push({
      key: "issue_closeout",
      label: "Issue close-out",
      weight: 0.15,
      score: live.length === 0 ? null : pct(closed.length, live.length),
      basis:
        live.length === 0
          ? "No design issue has been raised."
          : `${closed.length} of ${live.length} issue(s) are resolved or closed; ${criticalOpen.length} critical/high remain open.`,
      inputs: { issues: live.length, closed: closed.length, criticalOpen: criticalOpen.length },
      reasons: live.length === 0 ? ["No design issue has been raised, so close-out cannot be scored."] : [],
    });
    if (criticalOpen.length > 0) {
      blockers.push(`${criticalOpen.length} critical or high-priority design issue(s) are open.`);
    }
  }

  /* deliverables --------------------------------------------------- */
  {
    const live = input.deliverables.filter((d) => d.status !== "cancelled");
    const issued = live.filter((d) => d.status === "issued" || d.status === "accepted");
    const late = live.filter((d) => d.slippageLevel === "late");
    dimensions.push({
      key: "deliverables",
      label: "Deliverables issued",
      weight: 0.15,
      score: live.length === 0 ? null : pct(issued.length, live.length),
      basis:
        live.length === 0
          ? "No consultant deliverable is scheduled."
          : `${issued.length} of ${live.length} deliverable(s) are issued or accepted; ${late.length} are late.`,
      inputs: { deliverables: live.length, issued: issued.length, late: late.length },
      reasons: live.length === 0 ? ["No deliverable schedule exists, so issue progress cannot be scored."] : [],
    });
    if (late.length > 0) blockers.push(`${late.length} consultant deliverable(s) are late.`);
  }

  /* information requirements --------------------------------------- */
  {
    const live = input.infoRequirements.filter((r) => r.status !== "waived");
    const met = live.filter((r) => r.status === "delivered" || r.status === "verified");
    dimensions.push({
      key: "information_requirements",
      label: "Information requirements",
      weight: 0.1,
      score: live.length === 0 ? null : pct(met.length, live.length),
      basis:
        live.length === 0
          ? "No information requirement is registered."
          : `${met.length} of ${live.length} requirement(s) are delivered or verified.`,
      inputs: { requirements: live.length, met: met.length },
      reasons:
        live.length === 0
          ? ["No EIR/BEP/TIDP milestone is registered, so information readiness cannot be scored."]
          : [],
    });
    const overdue = live.filter((r) => r.status === "overdue").length;
    if (overdue > 0) blockers.push(`${overdue} information requirement(s) are overdue.`);
  }

  /* open change notices are a blocker, not a dimension --------------- */
  const openDcns = input.changeNotices.filter(
    (n) => n.status === "submitted" || n.status === "assessing" || n.status === "approved",
  );
  if (openDcns.length > 0) {
    blockers.push(
      `${openDcns.length} design change notice(s) are in flight; the design is not stable while a change is unimplemented.`,
    );
  }
  if (input.activeFreezes === 0) {
    reasons.push("No design freeze is in force over this scope: post-freeze change control is not protecting it.");
  }

  /* roll-up --------------------------------------------------------- */
  const scored = dimensions.filter((d) => d.score !== null);
  const totalWeight = dimensions.reduce((a, d) => a + d.weight, 0);
  const scoredWeight = scored.reduce((a, d) => a + d.weight, 0);
  const confidence = totalWeight === 0 ? 0 : Math.round((scoredWeight / totalWeight) * 100) / 100;

  let score: number | null = null;
  if (scoredWeight > 0) {
    const weighted = scored.reduce((a, d) => a + (d.score ?? 0) * d.weight, 0);
    score = Math.round((weighted / scoredWeight) * 10) / 10;
  } else {
    reasons.push("No dimension had any input, so no readiness score can be produced.");
  }

  let level: DesignReadinessLevel;
  if (score === null || confidence < 0.4) {
    level = "not_assessable";
    if (score !== null && confidence < 0.4) {
      reasons.push(
        `Only ${Math.round(confidence * 100)}% of the assessment's weight had inputs, which is too little to call readiness.`,
      );
    }
  } else if (score >= 90 && blockers.length === 0) {
    level = "ready";
  } else if (score >= 70) {
    level = "nearly_ready";
  } else {
    level = "not_ready";
  }
  if (level === "ready" && blockers.length > 0) level = "nearly_ready";

  return { score, level, confidence, dimensions, blockers, reasons };
}

/* ------------------------------------------------------------------ */
/* Professional indemnity adequacy (#912)                              */
/* ------------------------------------------------------------------ */

export interface PiInput {
  id: string;
  name: string;
  status: string;
  piRequiredAmount: number | null;
  piCoverAmount: number | null;
  piCurrency: string | null;
  piExpiresOn: string | null;
}

export interface PiVerdict {
  consultantId: string;
  adequate: boolean | null;
  shortfall: number | null;
  expiresInDays: number | null;
  severity: "info" | "low" | "medium" | "high" | "critical";
  reasons: string[];
  key: string;
}

/**
 * A consultant's PI cover is inadequate when it is below the appointment's
 * requirement, expired, or expiring inside `warnDays`. `adequate: null` means
 * the platform does not know — no requirement recorded — and says so instead
 * of implying the cover is fine.
 */
export function assessPi(
  consultant: PiInput,
  asOfISO: string,
  options: { warnDays?: number } = {},
): PiVerdict {
  const warnDays = options.warnDays ?? 60;
  const reasons: string[] = [];
  const asOf = Date.parse(`${asOfISO.slice(0, 10)}T00:00:00Z`);
  let expiresInDays: number | null = null;
  if (consultant.piExpiresOn) {
    const exp = Date.parse(`${consultant.piExpiresOn.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(exp) && !Number.isNaN(asOf)) {
      expiresInDays = Math.round((exp - asOf) / 86_400_000);
    }
  }

  let adequate: boolean | null = null;
  let shortfall: number | null = null;
  let severity: PiVerdict["severity"] = "info";

  if (consultant.piRequiredAmount === null || !Number.isFinite(consultant.piRequiredAmount)) {
    reasons.push("No professional indemnity requirement is recorded for this appointment, so adequacy cannot be judged.");
  } else if (consultant.piCoverAmount === null || !Number.isFinite(consultant.piCoverAmount)) {
    adequate = false;
    severity = "medium";
    reasons.push(
      `The appointment requires ${consultant.piRequiredAmount.toLocaleString()} of professional indemnity cover but no cover amount has been recorded.`,
    );
  } else if (consultant.piCoverAmount < consultant.piRequiredAmount) {
    adequate = false;
    shortfall = Math.round((consultant.piRequiredAmount - consultant.piCoverAmount) * 100) / 100;
    severity = shortfall / consultant.piRequiredAmount >= 0.5 ? "high" : "medium";
    reasons.push(
      `Cover of ${consultant.piCoverAmount.toLocaleString()} ${consultant.piCurrency ?? ""} is ${shortfall.toLocaleString()} below the required ${consultant.piRequiredAmount.toLocaleString()}.`.trim(),
    );
  } else {
    adequate = true;
    reasons.push(
      `Cover of ${consultant.piCoverAmount.toLocaleString()} meets the required ${consultant.piRequiredAmount.toLocaleString()}.`,
    );
  }

  if (expiresInDays !== null) {
    if (expiresInDays < 0) {
      adequate = false;
      severity = "high";
      reasons.push(`The policy expired ${-expiresInDays} day(s) ago on ${consultant.piExpiresOn}.`);
    } else if (expiresInDays <= warnDays) {
      if (adequate !== false) adequate = false;
      severity = severity === "high" ? "high" : "medium";
      reasons.push(`The policy expires in ${expiresInDays} day(s), on ${consultant.piExpiresOn}.`);
    }
  } else if (consultant.piRequiredAmount !== null) {
    reasons.push("No policy expiry date is recorded, so continuity of cover cannot be confirmed.");
  }

  return {
    consultantId: consultant.id,
    adequate,
    shortfall,
    expiresInDays,
    severity,
    reasons,
    key: `design_pi:${consultant.id}:${consultant.piExpiresOn ?? "no-expiry"}:${consultant.piCoverAmount ?? "no-cover"}`,
  };
}
