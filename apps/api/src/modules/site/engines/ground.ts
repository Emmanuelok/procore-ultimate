/**
 * Ground-condition change detection (spec Vol II Z #1082).
 *
 * A baseline ground model (the GBR, or the tender-stage boreholes) says what
 * is under the site. The investigation carried out during the works says what
 * is actually there. The difference between those two strata logs — depth
 * interval by depth interval — is the factual core of a ground-conditions
 * claim, and it is arithmetic a person should not be doing by eye.
 *
 * The engine compares the two logs at the resolution of their own interval
 * boundaries: every boundary from either log becomes a slice, and each slice
 * is compared on soil type, description and (where present) SPT N-value and
 * undrained strength. A slice where the baseline is silent is reported as
 * `no_baseline` — it is not a change, because there is nothing to change from,
 * and calling it one would manufacture a claim.
 *
 * It classifies; it does not price, and it does not decide entitlement.
 */

export interface Stratum {
  fromM: number;
  toM: number;
  description: string;
  soilType?: string;
  spt?: number;
  strengthKpa?: number;
}

export type GroundFindingCategory =
  | "strata_change"
  | "water_table"
  | "obstruction"
  | "contamination"
  | "rock_level"
  | "bearing_capacity"
  | "archaeology"
  | "voids";

export interface GroundFinding {
  depthFromM: number;
  depthToM: number;
  category: GroundFindingCategory;
  severity: "low" | "medium" | "high" | "critical";
  baselineDescription: string | null;
  observedDescription: string;
  differsFromBaseline: boolean;
  varianceNotes: string;
}

export interface GroundComparison {
  findings: GroundFinding[];
  slicesCompared: number;
  slicesWithoutBaseline: number;
  maxDepthComparedM: number | null;
  reasons: string[];
}

const ROCK_WORDS = ["rock", "granite", "basalt", "sandstone", "limestone", "mudstone", "chalk", "bedrock"];
const OBSTRUCTION_WORDS = ["obstruction", "concrete", "masonry", "boulder", "cobble", "foundation", "buried structure"];
const CONTAMINATION_WORDS = ["contamin", "hydrocarbon", "asbestos", "landfill", "made ground", "tar", "leachate"];
const VOID_WORDS = ["void", "cavity", "mineshaft", "swallow hole", "karst"];
const ARCHAEOLOGY_WORDS = ["archaeolog", "artefact", "burial", "roman", "medieval"];

const contains = (text: string, words: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
};

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function sameMaterial(a: Stratum, b: Stratum): boolean {
  if (a.soilType && b.soilType) return normalise(a.soilType) === normalise(b.soilType);
  return normalise(a.description) === normalise(b.description);
}

function categorise(observed: Stratum, baseline: Stratum | null): GroundFindingCategory {
  const text = `${observed.description} ${observed.soilType ?? ""}`;
  if (contains(text, CONTAMINATION_WORDS)) return "contamination";
  if (contains(text, VOID_WORDS)) return "voids";
  if (contains(text, ARCHAEOLOGY_WORDS)) return "archaeology";
  if (contains(text, OBSTRUCTION_WORDS)) return "obstruction";
  if (contains(text, ROCK_WORDS) && (!baseline || !contains(`${baseline.description} ${baseline.soilType ?? ""}`, ROCK_WORDS))) {
    return "rock_level";
  }
  if (
    baseline &&
    ((typeof observed.spt === "number" && typeof baseline.spt === "number") ||
      (typeof observed.strengthKpa === "number" && typeof baseline.strengthKpa === "number"))
  ) {
    const sptWorse =
      typeof observed.spt === "number" && typeof baseline.spt === "number" && observed.spt < baseline.spt * 0.7;
    const strengthWorse =
      typeof observed.strengthKpa === "number" &&
      typeof baseline.strengthKpa === "number" &&
      observed.strengthKpa < baseline.strengthKpa * 0.7;
    if (sptWorse || strengthWorse) return "bearing_capacity";
  }
  return "strata_change";
}

function severityFor(category: GroundFindingCategory, thicknessM: number): "low" | "medium" | "high" | "critical" {
  if (category === "contamination" || category === "voids") return "critical";
  if (category === "obstruction" || category === "rock_level" || category === "bearing_capacity") {
    return thicknessM >= 1 ? "high" : "medium";
  }
  if (category === "archaeology") return "high";
  return thicknessM >= 2 ? "medium" : "low";
}

const at = (strata: readonly Stratum[], depth: number): Stratum | null =>
  strata.find((s) => depth >= s.fromM && depth < s.toM) ?? null;

/**
 * Compare an observed strata log with a baseline log.
 *
 * `waterStrike` is compared separately because it is a level, not an interval:
 * a water table found materially higher than the baseline is its own finding.
 */
export function compareGround(
  observed: readonly Stratum[],
  baseline: readonly Stratum[],
  options?: {
    observedWaterStrikeM?: number | null;
    baselineWaterStrikeM?: number | null;
    /** metres of difference in water level treated as material */
    waterToleranceM?: number;
  },
): GroundComparison {
  const reasons: string[] = [];
  const cleanObserved = observed
    .filter((s) => Number.isFinite(s.fromM) && Number.isFinite(s.toM) && s.toM > s.fromM)
    .sort((a, b) => a.fromM - b.fromM);
  const cleanBaseline = baseline
    .filter((s) => Number.isFinite(s.fromM) && Number.isFinite(s.toM) && s.toM > s.fromM)
    .sort((a, b) => a.fromM - b.fromM);

  if (cleanObserved.length === 0) {
    reasons.push("The investigation holds no usable strata intervals, so nothing can be compared.");
    return { findings: [], slicesCompared: 0, slicesWithoutBaseline: 0, maxDepthComparedM: null, reasons };
  }
  if (cleanBaseline.length === 0) {
    reasons.push(
      "No baseline strata log was supplied. Every interval is reported as having no baseline; none of them is a change.",
    );
  }

  const observedMax = Math.max(...cleanObserved.map((s) => s.toM));
  const boundaries = new Set<number>();
  for (const s of cleanObserved) {
    boundaries.add(s.fromM);
    boundaries.add(s.toM);
  }
  for (const s of cleanBaseline) {
    if (s.fromM < observedMax) boundaries.add(s.fromM);
    if (s.toM < observedMax) boundaries.add(s.toM);
  }
  const cuts = [...boundaries].sort((a, b) => a - b);

  const findings: GroundFinding[] = [];
  let slicesCompared = 0;
  let slicesWithoutBaseline = 0;

  for (let i = 1; i < cuts.length; i += 1) {
    const from = cuts[i - 1]!;
    const to = cuts[i]!;
    if (to <= from) continue;
    const mid = (from + to) / 2;
    const obs = at(cleanObserved, mid);
    if (!obs) continue;
    slicesCompared += 1;
    const base = at(cleanBaseline, mid);
    if (!base) {
      slicesWithoutBaseline += 1;
      findings.push({
        depthFromM: from,
        depthToM: to,
        category: categorise(obs, null),
        severity: "low",
        baselineDescription: null,
        observedDescription: obs.description,
        differsFromBaseline: false,
        varianceNotes: `The baseline ground model says nothing about ${from}–${to} m, so this interval is recorded but is not a change.`,
      });
      continue;
    }
    if (sameMaterial(obs, base)) {
      // Same material — but the strength may still have collapsed.
      const category = categorise(obs, base);
      if (category !== "bearing_capacity") continue;
      findings.push({
        depthFromM: from,
        depthToM: to,
        category,
        severity: severityFor(category, to - from),
        baselineDescription: base.description,
        observedDescription: obs.description,
        differsFromBaseline: true,
        varianceNotes: strengthNote(obs, base),
      });
      continue;
    }
    const category = categorise(obs, base);
    findings.push({
      depthFromM: from,
      depthToM: to,
      category,
      severity: severityFor(category, to - from),
      baselineDescription: base.description,
      observedDescription: obs.description,
      differsFromBaseline: true,
      varianceNotes: `Baseline expected "${base.description}" at ${from}–${to} m; the investigation found "${obs.description}".${strengthNote(obs, base)}`,
    });
  }

  const waterTolerance = options?.waterToleranceM ?? 1;
  const obsWater = options?.observedWaterStrikeM;
  const baseWater = options?.baselineWaterStrikeM;
  if (typeof obsWater === "number" && typeof baseWater === "number") {
    const delta = baseWater - obsWater; // positive = water found higher than expected
    if (Math.abs(delta) >= waterTolerance) {
      findings.push({
        depthFromM: Math.min(obsWater, baseWater),
        depthToM: Math.max(obsWater, baseWater),
        category: "water_table",
        severity: delta >= waterTolerance * 2 ? "high" : "medium",
        baselineDescription: `Water strike expected at ${baseWater} m`,
        observedDescription: `Water struck at ${obsWater} m`,
        differsFromBaseline: true,
        varianceNotes:
          delta > 0
            ? `Water was struck ${Math.round(delta * 100) / 100} m HIGHER than the baseline, which brings dewatering forward.`
            : `Water was struck ${Math.round(-delta * 100) / 100} m lower than the baseline.`,
      });
    }
  } else if (typeof obsWater === "number" || typeof baseWater === "number") {
    reasons.push(
      "Only one of the two water-strike depths is recorded, so the water table cannot be compared. The other must be entered before this is a finding.",
    );
  }

  findings.sort((a, b) => a.depthFromM - b.depthFromM);
  return {
    findings,
    slicesCompared,
    slicesWithoutBaseline,
    maxDepthComparedM: observedMax,
    reasons,
  };
}

function strengthNote(obs: Stratum, base: Stratum): string {
  const parts: string[] = [];
  if (typeof obs.spt === "number" && typeof base.spt === "number") {
    parts.push(`SPT N observed ${obs.spt} against a baseline of ${base.spt}.`);
  }
  if (typeof obs.strengthKpa === "number" && typeof base.strengthKpa === "number") {
    parts.push(`Undrained strength observed ${obs.strengthKpa} kPa against a baseline of ${base.strengthKpa} kPa.`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
