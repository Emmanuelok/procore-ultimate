/**
 * Scan-versus-model deviation statistics (spec Vol II Z #1079; Vol I §2.15).
 *
 * The input is a list of per-element signed deviations in millimetres, as
 * produced outside the platform by a cloud-to-mesh comparison. What this
 * engine adds is the arithmetic and — more importantly — the refusal: a
 * comparison whose scan is not registered, or which carries no tolerance, or
 * which has no elements, produces `not_assessable`, never "within tolerance".
 *
 * Verdict ladder, per element and rolled up:
 *   |d| ≤ tolerance × marginalFactor   within_tolerance
 *   |d| ≤ tolerance                    marginal
 *   |d| >  tolerance                   out_of_tolerance
 *
 * The overall verdict is the worst element verdict, because a single column
 * 40 mm out is not averaged away by a hundred good ones.
 */

export interface DeviationItemInput {
  elementId: string;
  elementName?: string;
  zone?: string;
  deviationMm: number;
}

export type DeviationVerdict = "within_tolerance" | "marginal" | "out_of_tolerance" | "not_assessable";

export interface DeviationItem extends DeviationItemInput {
  verdict: DeviationVerdict;
}

export interface ZoneRollup {
  zone: string;
  elements: number;
  outOfTolerance: number;
  maxDeviationMm: number | null;
  verdict: DeviationVerdict;
}

export interface DeviationReport {
  toleranceMm: number;
  marginalFactor: number;
  elementCount: number;
  withinToleranceCount: number;
  marginalCount: number;
  outOfToleranceCount: number;
  maxDeviationMm: number | null;
  meanAbsDeviationMm: number | null;
  rmsDeviationMm: number | null;
  verdict: DeviationVerdict;
  items: DeviationItem[];
  byZone: ZoneRollup[];
  reasons: string[];
}

const RANK: Record<DeviationVerdict, number> = {
  within_tolerance: 0,
  marginal: 1,
  out_of_tolerance: 2,
  not_assessable: -1,
};

export function classifyDeviation(
  deviationMm: number,
  toleranceMm: number,
  marginalFactor: number,
): DeviationVerdict {
  const abs = Math.abs(deviationMm);
  if (abs <= toleranceMm * marginalFactor) return "within_tolerance";
  if (abs <= toleranceMm) return "marginal";
  return "out_of_tolerance";
}

export function buildDeviationReport(
  items: readonly DeviationItemInput[],
  options: {
    toleranceMm: number;
    marginalFactor?: number;
    /** the scan's registration state; an unregistered scan proves nothing */
    registrationStatus?: string;
    registrationErrorMm?: number | null;
  },
): DeviationReport {
  const marginalFactor =
    typeof options.marginalFactor === "number" && options.marginalFactor > 0 && options.marginalFactor <= 1
      ? options.marginalFactor
      : 0.8;
  const reasons: string[] = [];

  const usable = items.filter((i) => typeof i.deviationMm === "number" && Number.isFinite(i.deviationMm));
  if (usable.length < items.length) {
    reasons.push(`${items.length - usable.length} element(s) carried no finite deviation and were excluded.`);
  }

  const blocked: string[] = [];
  if (!(options.toleranceMm > 0)) {
    blocked.push("No positive tolerance was given, so no element can be judged within or outside it.");
  }
  if (usable.length === 0) {
    blocked.push("The comparison holds no elements with a deviation.");
  }
  if (options.registrationStatus && options.registrationStatus !== "registered") {
    blocked.push(
      `The scan's registration status is "${options.registrationStatus}". A scan that is not registered to the project control has no defensible relationship to the model, so deviations from it are not assessable.`,
    );
  }
  if (
    typeof options.registrationErrorMm === "number" &&
    options.toleranceMm > 0 &&
    options.registrationErrorMm >= options.toleranceMm
  ) {
    blocked.push(
      `The scan's registration error (${options.registrationErrorMm} mm) is at or above the tolerance being tested (${options.toleranceMm} mm): a deviation cannot be distinguished from the registration itself.`,
    );
  }

  if (blocked.length > 0) {
    return {
      toleranceMm: options.toleranceMm,
      marginalFactor,
      elementCount: usable.length,
      withinToleranceCount: 0,
      marginalCount: 0,
      outOfToleranceCount: 0,
      maxDeviationMm: null,
      meanAbsDeviationMm: null,
      rmsDeviationMm: null,
      verdict: "not_assessable",
      items: usable.map((i) => ({ ...i, verdict: "not_assessable" as const })),
      byZone: [],
      reasons: [...reasons, ...blocked],
    };
  }

  const classified: DeviationItem[] = usable.map((item) => ({
    ...item,
    verdict: classifyDeviation(item.deviationMm, options.toleranceMm, marginalFactor),
  }));

  let within = 0;
  let marginal = 0;
  let out = 0;
  let sumAbs = 0;
  let sumSq = 0;
  let maxAbs = 0;
  let maxSigned = 0;
  for (const item of classified) {
    if (item.verdict === "within_tolerance") within += 1;
    else if (item.verdict === "marginal") marginal += 1;
    else out += 1;
    const abs = Math.abs(item.deviationMm);
    sumAbs += abs;
    sumSq += item.deviationMm * item.deviationMm;
    if (abs > maxAbs) {
      maxAbs = abs;
      maxSigned = item.deviationMm;
    }
  }

  const zones = new Map<string, DeviationItem[]>();
  for (const item of classified) {
    const key = item.zone ?? "unzoned";
    const list = zones.get(key) ?? [];
    list.push(item);
    zones.set(key, list);
  }
  const byZone: ZoneRollup[] = [...zones.entries()]
    .map(([zone, list]) => {
      const worst = list.reduce<DeviationVerdict>(
        (acc, i) => (RANK[i.verdict] > RANK[acc] ? i.verdict : acc),
        "within_tolerance",
      );
      const maxZone = list.reduce((m, i) => (Math.abs(i.deviationMm) > Math.abs(m) ? i.deviationMm : m), 0);
      return {
        zone,
        elements: list.length,
        outOfTolerance: list.filter((i) => i.verdict === "out_of_tolerance").length,
        maxDeviationMm: Math.round(maxZone * 10) / 10,
        verdict: worst,
      };
    })
    .sort((a, b) => b.outOfTolerance - a.outOfTolerance || a.zone.localeCompare(b.zone));

  const verdict: DeviationVerdict = out > 0 ? "out_of_tolerance" : marginal > 0 ? "marginal" : "within_tolerance";
  if (out > 0) {
    reasons.push(
      `${out} of ${classified.length} element(s) exceed the ${options.toleranceMm} mm tolerance; the worst is ${Math.round(maxSigned * 10) / 10} mm.`,
    );
  } else if (marginal > 0) {
    reasons.push(
      `No element exceeds the tolerance, but ${marginal} sit between ${Math.round(options.toleranceMm * marginalFactor * 10) / 10} mm and the ${options.toleranceMm} mm limit.`,
    );
  }

  return {
    toleranceMm: options.toleranceMm,
    marginalFactor,
    elementCount: classified.length,
    withinToleranceCount: within,
    marginalCount: marginal,
    outOfToleranceCount: out,
    maxDeviationMm: Math.round(maxSigned * 10) / 10,
    meanAbsDeviationMm: Math.round((sumAbs / classified.length) * 10) / 10,
    rmsDeviationMm: Math.round(Math.sqrt(sumSq / classified.length) * 10) / 10,
    verdict,
    items: classified,
    byZone,
    reasons,
  };
}
