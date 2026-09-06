/**
 * Environmental, biodiversity, option-appraisal and transport-carbon engines
 * (#493, #502-514) — pure arithmetic with no database access.
 *
 * Four small models that share one rule: a number the platform cannot derive
 * from a recorded quantity and a cited factor is reported as unavailable with
 * the reason, never as zero.
 *
 *  · EXCEEDANCE — a reading is only an exceedance against a limit with a
 *    DIRECTION. A dust limit is a ceiling; a dissolved-oxygen or pH-floor
 *    limit is not. Getting that wrong reports clean water as a breach and a
 *    breach as clean water, so the direction is carried on the point.
 *
 *  · BIODIVERSITY UNITS — the Defra metric shape: area × distinctiveness ×
 *    condition × strategic significance. Net gain is post-intervention
 *    against baseline, and net LOSS is a finding, not a rounding difference.
 *
 *  · MARGINAL ABATEMENT COST — the only carbon number that changes a design
 *    meeting is cost per tonne avoided. It is computable only when an option
 *    carries both its carbon and its cost, and an option that ABATES at
 *    NEGATIVE cost (cheaper and cleaner) must be reported as such rather than
 *    hidden by an absolute-value sort.
 *
 *  · TRANSPORT CARBON — A4/A5 emissions are tonne-kilometres × a mode factor.
 *    The factors are code-resident, dated and cited, like the payments regime
 *    library: a transport factor with no provenance is not evidence.
 */

import type { CarbonTransportMode } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
export const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/* ================================================================== */
/* Environmental limit exceedance                                      */
/* ================================================================== */

export interface LimitCheck {
  exceedance: boolean;
  /** how far past the limit, in the direction that breaches; null when no limit */
  exceedanceBy: number | null;
  /** share of the limit consumed, for a "approaching the limit" view */
  percentOfLimit: number | null;
  basis: string;
}

export function checkLimit(
  value: number,
  limitValue: number | null | undefined,
  direction: string,
  unit: string,
): LimitCheck {
  if (limitValue == null) {
    return {
      exceedance: false,
      exceedanceBy: null,
      percentOfLimit: null,
      basis:
        "No limit is recorded on this monitoring point, so the reading is logged as a " +
        "baseline observation and no compliance conclusion is drawn from it.",
    };
  }
  if (direction === "min") {
    const breach = value < limitValue;
    return {
      exceedance: breach,
      exceedanceBy: breach ? round4(limitValue - value) : 0,
      percentOfLimit: limitValue !== 0 ? round2((value / limitValue) * 100) : null,
      basis: breach
        ? `${value} ${unit} is below the ${limitValue} ${unit} floor by ${round4(limitValue - value)} ${unit}.`
        : `${value} ${unit} meets the ${limitValue} ${unit} floor.`,
    };
  }
  const breach = value > limitValue;
  return {
    exceedance: breach,
    exceedanceBy: breach ? round4(value - limitValue) : 0,
    percentOfLimit: limitValue !== 0 ? round2((value / limitValue) * 100) : null,
    basis: breach
      ? `${value} ${unit} exceeds the ${limitValue} ${unit} ceiling by ${round4(value - limitValue)} ${unit}.`
      : `${value} ${unit} is within the ${limitValue} ${unit} ceiling.`,
  };
}

/* ================================================================== */
/* Biodiversity units (Defra metric shape)                             */
/* ================================================================== */

/** Condition multiplier band used by the Defra metric. */
export const CONDITION_SCORES: Record<string, number> = {
  poor: 1,
  moderate: 2,
  good: 3,
  n_a: 1,
};

export function conditionScoreFor(condition: string): number {
  return CONDITION_SCORES[condition] ?? 1;
}

/** area × distinctiveness × condition × strategic significance. */
export function biodiversityUnits(args: {
  areaHectares: number;
  distinctiveness: number;
  conditionScore: number;
  strategicSignificance: number;
}): number {
  return round4(
    args.areaHectares * args.distinctiveness * args.conditionScore * args.strategicSignificance,
  );
}

export interface NetGainResult {
  baselineUnits: number;
  postInterventionUnits: number;
  targetUnits: number | null;
  netChangeUnits: number;
  /** null when there is no baseline to measure gain against */
  netGainPercent: number | null;
  meetsTarget: boolean | null;
  netLoss: boolean;
  basis: string;
}

/**
 * Net gain against baseline. The statutory English test is +10%; the target
 * stage lets a project record a stricter contractual commitment, and the
 * result says which test it was measured against.
 */
export const STATUTORY_NET_GAIN_PERCENT = 10;

export function computeNetGain(args: {
  baselineUnits: number;
  postInterventionUnits: number;
  targetUnits?: number | null;
  requiredGainPercent?: number;
}): NetGainResult {
  const required = args.requiredGainPercent ?? STATUTORY_NET_GAIN_PERCENT;
  const baseline = round4(args.baselineUnits);
  const post = round4(args.postInterventionUnits);
  const net = round4(post - baseline);
  const netGainPercent = baseline > 0 ? round2((net / baseline) * 100) : null;
  const target = args.targetUnits ?? null;
  const meetsTarget =
    target != null ? post >= target : netGainPercent != null ? netGainPercent >= required : null;
  return {
    baselineUnits: baseline,
    postInterventionUnits: post,
    targetUnits: target,
    netChangeUnits: net,
    netGainPercent,
    meetsTarget,
    netLoss: net < 0,
    basis:
      baseline <= 0
        ? `No baseline habitat units are recorded, so net gain cannot be computed — a ` +
          `post-intervention figure on its own says nothing about gain or loss.`
        : target != null
          ? `${post} units post-intervention against a recorded target of ${target} units ` +
            `(baseline ${baseline}, net ${net}, ${netGainPercent}%).`
          : `${post} units post-intervention against a ${baseline}-unit baseline: net ${net} ` +
            `units (${netGainPercent}%) against the ${required}% test.`,
  };
}

/* ================================================================== */
/* Marginal abatement cost (#502-504)                                  */
/* ================================================================== */

export interface OptionInput {
  id: string;
  name: string;
  isBaseline: boolean;
  tco2e: number;
  cost: number | null;
}

export interface MaccRow {
  id: string;
  name: string;
  isBaseline: boolean;
  tco2e: number;
  cost: number | null;
  /** baseline carbon − option carbon; positive = a saving */
  abatementTco2e: number | null;
  /** option cost − baseline cost; positive = the option costs more */
  costDelta: number | null;
  /** £ per tonne avoided; negative = cheaper AND cleaner */
  abatementCostPerTonne: number | null;
  unavailableReason: string | null;
}

export interface MaccResult {
  baselineId: string | null;
  rows: MaccRow[];
  /** the cheapest positive-abatement option, or null when none is computable */
  bestValueId: string | null;
  /** options that save carbon at negative cost — always adopt these first */
  noRegretIds: string[];
  note: string | null;
}

/**
 * Rank design options by cost per tonne abated against the study's baseline.
 *
 * An option with no cost is NOT treated as free: it is reported with
 * `abatementCostPerTonne: null` and a reason. The commonest way a carbon
 * option appraisal misleads is by ranking priced and unpriced options in one
 * list as though the unpriced ones cost nothing.
 */
export function buildMacc(options: readonly OptionInput[]): MaccResult {
  const baseline = options.find((o) => o.isBaseline) ?? null;
  if (!baseline) {
    return {
      baselineId: null,
      rows: options.map((o) => ({
        id: o.id,
        name: o.name,
        isBaseline: false,
        tco2e: round6(o.tco2e),
        cost: o.cost,
        abatementTco2e: null,
        costDelta: null,
        abatementCostPerTonne: null,
        unavailableReason: "No baseline option is marked in this study",
      })),
      bestValueId: null,
      noRegretIds: [],
      note:
        "No option in this study is marked as the baseline, so abatement — which is measured " +
        "against a reference case — cannot be computed for any of them.",
    };
  }

  const rows: MaccRow[] = options.map((o) => {
    if (o.id === baseline.id) {
      return {
        id: o.id,
        name: o.name,
        isBaseline: true,
        tco2e: round6(o.tco2e),
        cost: o.cost,
        abatementTco2e: 0,
        costDelta: 0,
        abatementCostPerTonne: null,
        unavailableReason: "Baseline: abatement is measured against this option",
      };
    }
    const abatement = round6(baseline.tco2e - o.tco2e);
    if (o.cost == null || baseline.cost == null) {
      return {
        id: o.id,
        name: o.name,
        isBaseline: false,
        tco2e: round6(o.tco2e),
        cost: o.cost,
        abatementTco2e: abatement,
        costDelta: null,
        abatementCostPerTonne: null,
        unavailableReason:
          o.cost == null
            ? "This option carries no cost, so cost per tonne abated is not computable"
            : "The baseline option carries no cost, so no cost delta is computable",
      };
    }
    const costDelta = round2(o.cost - baseline.cost);
    if (abatement === 0) {
      return {
        id: o.id,
        name: o.name,
        isBaseline: false,
        tco2e: round6(o.tco2e),
        cost: o.cost,
        abatementTco2e: 0,
        costDelta,
        abatementCostPerTonne: null,
        unavailableReason: "This option abates nothing against the baseline",
      };
    }
    return {
      id: o.id,
      name: o.name,
      isBaseline: false,
      tco2e: round6(o.tco2e),
      cost: o.cost,
      abatementTco2e: abatement,
      costDelta,
      abatementCostPerTonne: round2(costDelta / abatement),
      unavailableReason: null,
    };
  });

  const abating = rows.filter(
    (r) => !r.isBaseline && r.abatementCostPerTonne != null && (r.abatementTco2e ?? 0) > 0,
  );
  abating.sort((a, b) => a.abatementCostPerTonne! - b.abatementCostPerTonne!);
  const noRegret = abating.filter((r) => r.abatementCostPerTonne! < 0).map((r) => r.id);

  return {
    baselineId: baseline.id,
    rows,
    bestValueId: abating[0]?.id ?? null,
    noRegretIds: noRegret,
    note:
      rows.some((r) => r.unavailableReason != null && !r.isBaseline)
        ? "Some options could not be priced per tonne abated; they are listed with the reason " +
          "rather than ranked as though they were free."
        : null,
  };
}

/* ================================================================== */
/* Transport carbon (A4 / A5)                                          */
/* ================================================================== */

export interface TransportFactor {
  mode: CarbonTransportMode;
  label: string;
  /** kgCO2e per tonne-kilometre */
  kgCo2ePerTonneKm: number;
  source: string;
}

/**
 * Code-resident transport factors, well-to-wheel, per tonne-kilometre.
 * Values follow the shape and order of magnitude of the UK Government GHG
 * conversion factors for freight; they are stated with their source so a
 * project on a different published set can override the factor per leg.
 */
export const TRANSPORT_FACTORS: readonly TransportFactor[] = [
  {
    mode: "rigid_truck",
    label: "Rigid HGV (>7.5t–17t), average laden",
    kgCo2ePerTonneKm: 0.2,
    source: "UK Government GHG conversion factors — freighting goods, rigid HGV",
  },
  {
    mode: "articulated_truck",
    label: "Articulated HGV (>33t), average laden",
    kgCo2ePerTonneKm: 0.08,
    source: "UK Government GHG conversion factors — freighting goods, articulated HGV",
  },
  {
    mode: "van",
    label: "Van (class III, up to 3.5t)",
    kgCo2ePerTonneKm: 0.6,
    source: "UK Government GHG conversion factors — freighting goods, vans",
  },
  {
    mode: "rail",
    label: "Rail freight",
    kgCo2ePerTonneKm: 0.027,
    source: "UK Government GHG conversion factors — freighting goods, rail",
  },
  {
    mode: "sea_container",
    label: "Container ship",
    kgCo2ePerTonneKm: 0.016,
    source: "UK Government GHG conversion factors — freighting goods, container ship",
  },
  {
    mode: "sea_bulk",
    label: "Bulk carrier",
    kgCo2ePerTonneKm: 0.005,
    source: "UK Government GHG conversion factors — freighting goods, bulk carrier",
  },
  {
    mode: "inland_barge",
    label: "Inland waterway barge",
    kgCo2ePerTonneKm: 0.031,
    source: "UK Government GHG conversion factors — freighting goods, inland waterway",
  },
  {
    mode: "air_freight",
    label: "Air freight (long haul, belly hold)",
    kgCo2ePerTonneKm: 0.6,
    source: "UK Government GHG conversion factors — freighting goods, air freight",
  },
];

const TRANSPORT_BY_MODE = new Map(TRANSPORT_FACTORS.map((f) => [f.mode, f]));

export function transportFactorFor(mode: string): TransportFactor | null {
  return TRANSPORT_BY_MODE.get(mode as CarbonTransportMode) ?? null;
}

export interface TransportLegResult {
  tonneKm: number;
  factorKgCo2ePerTonneKm: number;
  factorSource: string;
  tco2e: number;
  basis: string;
}

/**
 * tonne-km × factor ÷ 1000 → tCO2e, multiplied by the number of trips.
 * `factorOverride` lets a project use its own published figure; when it does,
 * the source recorded says so rather than claiming the library's provenance.
 */
export function computeTransportLeg(args: {
  mode: string;
  distanceKm: number;
  payloadTonnes: number;
  trips?: number;
  factorOverride?: number | null;
  factorSourceOverride?: string | null;
}): TransportLegResult | null {
  const trips = args.trips ?? 1;
  const library = transportFactorFor(args.mode);
  const factor = args.factorOverride ?? library?.kgCo2ePerTonneKm ?? null;
  if (factor == null) return null;
  const source =
    args.factorOverride != null
      ? (args.factorSourceOverride ?? "Project-supplied factor")
      : (library?.source ?? "unknown");
  const tonneKm = round4(args.distanceKm * args.payloadTonnes * trips);
  const tco2e = round6((tonneKm * factor) / 1000);
  return {
    tonneKm,
    factorKgCo2ePerTonneKm: factor,
    factorSource: source,
    tco2e,
    basis:
      `${args.payloadTonnes} t × ${args.distanceKm} km × ${trips} trip(s) = ${tonneKm} tonne-km ` +
      `at ${factor} kgCO2e/tonne-km (${source}) = ${tco2e} tCO2e.`,
  };
}
