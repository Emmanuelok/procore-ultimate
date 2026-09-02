/**
 * UPSTREAM CHANGE CONTROL ENGINE (spec #255, #890–#896) — pure, no I/O.
 *
 * Four judgements, all of them explainable:
 *
 *  1. IMPACT ROLL-UP (#891). Per-discipline assessments become one position:
 *     cost bucketed BY CURRENCY and never summed across them, time as the
 *     longest impact on the critical path rather than the sum (two disciplines
 *     each taking two weeks in parallel is two weeks, not four), rework hours
 *     added because hours are hours.
 *  2. POST-FREEZE (#896). Is this change landing inside an active freeze? The
 *     answer is stamped at submission and never recomputed, because whether a
 *     change was post-freeze is a fact about the moment it was raised.
 *  3. AUTHORISATION (#892). Which level must sign it off, from the money, the
 *     time, the freeze position and the classification.
 *  4. ENTITLEMENT (#894/#895). Design development carries no entitlement;
 *     a design change does, and the originator carries the cost (#893).
 */
import type {
  DcnAuthorisationLevel,
  DcnClassification,
  DcnOriginator,
} from "@constructos/shared";

/* ------------------------------------------------------------------ */
/* Impact roll-up                                                      */
/* ------------------------------------------------------------------ */

export interface ImpactLine {
  discipline: string;
  costImpact: number | null;
  currency: string;
  timeImpactDays: number | null;
  reworkHours: number | null;
  affectedPackageIds?: string[];
}

export interface ImpactRollup {
  /** cost per currency — NEVER one cross-currency total */
  costByCurrency: Record<string, number>;
  currencies: string[];
  /** the single-currency total when there is exactly one currency, else null */
  cost: number | null;
  costReasons: string[];
  /** the longest single-discipline impact: parallel work does not add up */
  timeDays: number | null;
  timeBasis: string;
  reworkHours: number | null;
  disciplines: string[];
  affectedPackageIds: string[];
  lineCount: number;
  linesWithoutCost: number;
  linesWithoutTime: number;
}

export function rollupImpacts(lines: readonly ImpactLine[]): ImpactRollup {
  const costByCurrency: Record<string, number> = {};
  const costReasons: string[] = [];
  const disciplines = new Set<string>();
  const affected = new Set<string>();
  let linesWithoutCost = 0;
  let linesWithoutTime = 0;
  let maxTime: number | null = null;
  let reworkHours: number | null = null;

  for (const line of lines) {
    disciplines.add(line.discipline);
    for (const id of line.affectedPackageIds ?? []) affected.add(id);
    if (line.costImpact === null || !Number.isFinite(line.costImpact)) {
      linesWithoutCost += 1;
    } else {
      const currency = (line.currency || "USD").toUpperCase();
      costByCurrency[currency] = Math.round(((costByCurrency[currency] ?? 0) + line.costImpact) * 100) / 100;
    }
    if (line.timeImpactDays === null || !Number.isFinite(line.timeImpactDays)) {
      linesWithoutTime += 1;
    } else if (maxTime === null || line.timeImpactDays > maxTime) {
      maxTime = line.timeImpactDays;
    }
    if (line.reworkHours !== null && Number.isFinite(line.reworkHours)) {
      reworkHours = (reworkHours ?? 0) + line.reworkHours;
    }
  }

  const currencies = Object.keys(costByCurrency).sort();
  if (lines.length === 0) costReasons.push("No discipline has assessed this change yet.");
  if (linesWithoutCost > 0) {
    costReasons.push(`${linesWithoutCost} assessment${linesWithoutCost === 1 ? "" : "s"} carr${linesWithoutCost === 1 ? "ies" : "y"} no cost figure.`);
  }
  if (currencies.length > 1) {
    costReasons.push(
      `Impacts are assessed in ${currencies.length} currencies (${currencies.join(", ")}); they are reported side by side and never added.`,
    );
  }

  return {
    costByCurrency,
    currencies,
    cost: currencies.length === 1 ? (costByCurrency[currencies[0] as string] ?? null) : null,
    costReasons,
    timeDays: maxTime,
    timeBasis:
      maxTime === null
        ? lines.length === 0
          ? "No assessment carries a time impact."
          : "No assessment carries a time impact figure."
        : "The longest single-discipline impact — disciplines working in parallel do not add.",
    reworkHours: reworkHours === null ? null : Math.round(reworkHours * 10) / 10,
    disciplines: [...disciplines].sort(),
    affectedPackageIds: [...affected].sort(),
    lineCount: lines.length,
    linesWithoutCost,
    linesWithoutTime,
  };
}

/* ------------------------------------------------------------------ */
/* Freeze position                                                     */
/* ------------------------------------------------------------------ */

export interface FreezeRecord {
  id: string;
  scope: string; // "project" | "stage" | "package"
  packageId: string | null;
  stageKey: string | null;
  status: string;
  effectiveFrom: string;
  requiredAuthorisation: string;
}

export interface FreezePosition {
  isPostFreeze: boolean;
  freezeId: string | null;
  requiredAuthorisation: DcnAuthorisationLevel | null;
  basis: string;
}

/**
 * The freeze that covers this change at `atISO`, most specific first: a
 * package freeze beats a stage freeze beats a project freeze, because the
 * narrower declaration is the more deliberate one.
 */
export function freezePosition(
  freezes: readonly FreezeRecord[],
  target: { packageId: string | null; stageKey: string | null },
  atISO: string,
): FreezePosition {
  const at = Date.parse(atISO);
  const active = freezes.filter((f) => {
    if (f.status !== "active") return false;
    const from = Date.parse(f.effectiveFrom);
    return !Number.isNaN(from) && !Number.isNaN(at) && from <= at;
  });
  const rank = (f: FreezeRecord): number => (f.scope === "package" ? 0 : f.scope === "stage" ? 1 : 2);
  const covering = active
    .filter((f) => {
      if (f.scope === "package") return target.packageId !== null && f.packageId === target.packageId;
      if (f.scope === "stage") return target.stageKey !== null && f.stageKey === target.stageKey;
      return true;
    })
    .sort((a, b) => rank(a) - rank(b));

  const hit = covering[0];
  if (!hit) {
    return {
      isPostFreeze: false,
      freezeId: null,
      requiredAuthorisation: null,
      basis:
        active.length === 0
          ? "No design freeze is in force."
          : "A freeze is in force but none of them covers this package or stage.",
    };
  }
  const level = isAuthorisationLevel(hit.requiredAuthorisation) ? hit.requiredAuthorisation : "client";
  return {
    isPostFreeze: true,
    freezeId: hit.id,
    requiredAuthorisation: level,
    basis: `Covered by the ${hit.scope} freeze effective ${hit.effectiveFrom.slice(0, 10)}, which requires ${level.replace(/_/g, " ")} authorisation.`,
  };
}

const LEVELS: readonly DcnAuthorisationLevel[] = ["design_lead", "project_manager", "client", "board"];

function isAuthorisationLevel(value: string): value is DcnAuthorisationLevel {
  return (LEVELS as readonly string[]).includes(value);
}

export const authorisationRank = (level: DcnAuthorisationLevel): number => LEVELS.indexOf(level);

/** The higher of two levels. */
export function maxAuthorisation(a: DcnAuthorisationLevel, b: DcnAuthorisationLevel): DcnAuthorisationLevel {
  return authorisationRank(a) >= authorisationRank(b) ? a : b;
}

/* ------------------------------------------------------------------ */
/* Authorisation                                                       */
/* ------------------------------------------------------------------ */

export interface AuthorisationThresholds {
  /** cost at or above which the project manager must sign */
  projectManagerAbove: number;
  /** cost at or above which the client must sign */
  clientAbove: number;
  /** cost at or above which the board must sign */
  boardAbove: number;
  /** programme impact at or above which the client must sign */
  clientTimeDaysAbove: number;
}

export const DEFAULT_THRESHOLDS: AuthorisationThresholds = {
  projectManagerAbove: 10_000,
  clientAbove: 100_000,
  boardAbove: 1_000_000,
  clientTimeDaysAbove: 10,
};

export interface AuthorisationVerdict {
  level: DcnAuthorisationLevel;
  basis: string;
  reasons: string[];
}

/**
 * The authorisation a DCN needs. Money and time each push the level up; a
 * post-freeze change never sits below the level the freeze demands; and a
 * change with NO cost assessment is escalated to the project manager rather
 * than being waved through at design-lead level on a missing number.
 */
export function requiredAuthorisation(input: {
  rollup: ImpactRollup;
  classification: DcnClassification;
  freeze: FreezePosition;
  thresholds?: AuthorisationThresholds;
}): AuthorisationVerdict {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const reasons: string[] = [];
  let level: DcnAuthorisationLevel = "design_lead";

  const worstCost = Math.max(0, ...Object.values(input.rollup.costByCurrency).map((v) => Math.abs(v)));
  const hasCost = input.rollup.currencies.length > 0;

  if (!hasCost) {
    level = maxAuthorisation(level, "project_manager");
    reasons.push("No cost has been assessed, so it cannot be signed off at design-lead level.");
  } else {
    if (worstCost >= t.boardAbove) {
      level = maxAuthorisation(level, "board");
      reasons.push(`Assessed cost reaches ${worstCost.toLocaleString()} in a single currency, at or above the board threshold.`);
    } else if (worstCost >= t.clientAbove) {
      level = maxAuthorisation(level, "client");
      reasons.push(`Assessed cost reaches ${worstCost.toLocaleString()} in a single currency, at or above the client threshold.`);
    } else if (worstCost >= t.projectManagerAbove) {
      level = maxAuthorisation(level, "project_manager");
      reasons.push(`Assessed cost reaches ${worstCost.toLocaleString()} in a single currency, at or above the project-manager threshold.`);
    } else {
      reasons.push(`Assessed cost of ${worstCost.toLocaleString()} sits below every escalation threshold.`);
    }
    if (input.rollup.currencies.length > 1) {
      reasons.push("The largest single-currency figure was used; currencies are never added together.");
    }
  }

  if (input.rollup.timeDays !== null && input.rollup.timeDays >= t.clientTimeDaysAbove) {
    level = maxAuthorisation(level, "client");
    reasons.push(`Programme impact of ${input.rollup.timeDays} days is at or above the client threshold of ${t.clientTimeDaysAbove}.`);
  }

  if (input.classification === "design_change") {
    level = maxAuthorisation(level, "project_manager");
    reasons.push("Classified as a design change (not design development), so it needs at least project-manager authorisation.");
  }

  if (input.freeze.isPostFreeze && input.freeze.requiredAuthorisation) {
    level = maxAuthorisation(level, input.freeze.requiredAuthorisation);
    reasons.push(input.freeze.basis);
  }

  return {
    level,
    basis: `${level.replace(/_/g, " ")} — ${reasons[0] ?? "default level"}`,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Entitlement and cost attribution                                    */
/* ------------------------------------------------------------------ */

export interface EntitlementVerdict {
  /** whether the change can carry an entitlement to time or money */
  carriesEntitlement: boolean;
  /** who the cost is attributed to (#893) */
  costCarrier: DcnOriginator;
  /** whether a change event should be raised downstream */
  raisesChangeEvent: boolean;
  reasons: string[];
}

/**
 * #894 — design development is the design maturing inside its stage and is
 * already paid for; a design change alters something previously fixed and is
 * not. #895/#893 — the originator carries the cost. A designer-originated
 * design change is a designer cost, not an owner variation, and the platform
 * says so rather than letting it drift into the owner's change register.
 */
export function assessEntitlement(input: {
  classification: DcnClassification;
  originator: DcnOriginator;
  isPostFreeze: boolean;
}): EntitlementVerdict {
  const reasons: string[] = [];
  if (input.classification === "design_development") {
    reasons.push(
      "Classified as design development: the design maturing within its stage carries no entitlement to time or money.",
    );
    if (input.isPostFreeze) {
      reasons.push(
        "It nevertheless lands after a design freeze, so it still needs the freeze's authorisation before it is implemented.",
      );
    }
    return {
      carriesEntitlement: false,
      costCarrier: input.originator,
      raisesChangeEvent: false,
      reasons,
    };
  }

  reasons.push("Classified as a design change: it alters something already fixed, so it can carry entitlement.");
  switch (input.originator) {
    case "client":
      reasons.push("Originated by the client, so the cost is attributed to the client and a change event is warranted.");
      return { carriesEntitlement: true, costCarrier: "client", raisesChangeEvent: true, reasons };
    case "designer":
      reasons.push(
        "Originated by the designer. The cost is attributed to the designer — this is a candidate professional-indemnity or fee-recovery item, not an owner variation.",
      );
      return { carriesEntitlement: false, costCarrier: "designer", raisesChangeEvent: false, reasons };
    case "contractor":
      reasons.push(
        "Originated by the contractor. Unless it is accepted as a value-engineering proposal, the cost sits with the contractor.",
      );
      return { carriesEntitlement: false, costCarrier: "contractor", raisesChangeEvent: false, reasons };
    case "statutory":
      reasons.push("Originated by a statutory requirement, which is normally an employer risk under most standard forms.");
      return { carriesEntitlement: true, costCarrier: "statutory", raisesChangeEvent: true, reasons };
    case "site_condition":
      reasons.push("Originated by a site condition, which is an employer risk under most standard forms unless the contract says otherwise.");
      return { carriesEntitlement: true, costCarrier: "site_condition", raisesChangeEvent: true, reasons };
    default:
      reasons.push("Originator not attributed, so entitlement cannot be concluded from the record alone.");
      return { carriesEntitlement: false, costCarrier: "other", raisesChangeEvent: false, reasons };
  }
}

/* ------------------------------------------------------------------ */
/* Change frequency (#906 — churn on a package)                        */
/* ------------------------------------------------------------------ */

export interface ChangeFrequencyInput {
  packageId: string | null;
  submittedAt: string | null;
  classification: string;
  isPostFreeze: boolean;
}

export interface ChangeFrequencyVerdict {
  packageId: string;
  windowDays: number;
  changes: number;
  postFreeze: number;
  ratePerMonth: number;
  exceedsThreshold: boolean;
  basis: string;
}

/**
 * Packages churning faster than `threshold` changes per 30 days in the window
 * ending at `asOf`. Churn is a leading indicator of an unstable brief; it is
 * reported per package, never as a project-level average that hides it.
 */
export function changeFrequency(
  notices: readonly ChangeFrequencyInput[],
  asOfISO: string,
  options: { windowDays?: number; threshold?: number } = {},
): ChangeFrequencyVerdict[] {
  const windowDays = options.windowDays ?? 90;
  const threshold = options.threshold ?? 3;
  // A date-only as-of means "up to the end of that day". Parsing it as
  // midnight would silently drop everything submitted today, which is exactly
  // the churn a sweep run this afternoon is looking for.
  const asOf = Date.parse(asOfISO.length <= 10 ? `${asOfISO}T23:59:59.999Z` : asOfISO);
  if (Number.isNaN(asOf)) return [];
  const from = asOf - windowDays * 86_400_000;

  const byPackage = new Map<string, ChangeFrequencyInput[]>();
  for (const notice of notices) {
    if (!notice.packageId || !notice.submittedAt) continue;
    const at = Date.parse(notice.submittedAt);
    if (Number.isNaN(at) || at < from || at > asOf) continue;
    const list = byPackage.get(notice.packageId) ?? [];
    list.push(notice);
    byPackage.set(notice.packageId, list);
  }

  return [...byPackage.entries()]
    .map(([packageId, list]) => {
      const ratePerMonth = Math.round(((list.length / windowDays) * 30) * 10) / 10;
      return {
        packageId,
        windowDays,
        changes: list.length,
        postFreeze: list.filter((n) => n.isPostFreeze).length,
        ratePerMonth,
        exceedsThreshold: ratePerMonth >= threshold,
        basis: `${list.length} change notice${list.length === 1 ? "" : "s"} submitted in the ${windowDays} days to ${asOfISO.slice(0, 10)} — ${ratePerMonth} per 30 days against a threshold of ${threshold}.`,
      };
    })
    .sort((a, b) => b.ratePerMonth - a.ratePerMonth);
}
