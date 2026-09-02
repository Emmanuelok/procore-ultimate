/**
 * ESTIMATE PRICING ENGINE — spec Vol I §1.2 (#190–199).
 *
 * Everything between a measured quantity and an estimate total:
 *  · the cost-type split of a unit rate and its extension (#190)
 *  · crew hourly cost from a composition (#197)
 *  · the labour half of a rate built from a production rate (#194)
 *  · assembly expansion (#191, #193)
 *  · the roll-up by cost type, and the markup cascade (#198–199)
 *
 * Pure functions only: no database, no clock. The route layer reads rows,
 * calls these, and writes the results back — so the arithmetic in the grid,
 * in the proposal and in the budget conversion is provably the same
 * arithmetic.
 *
 * DELIBERATELY NOT HERE: currency conversion. An estimate has one currency;
 * a sub-quote in another currency is levelled by hand with the rate recorded,
 * because a silent FX conversion inside a tender is a fiction.
 */
import type {
  CostType,
  EstimateMarkupBasis,
  EstimateMarkupMethod,
  ProductionRateBasis,
} from "@constructos/shared";

export const RATE_KEYS = [
  "labour",
  "material",
  "equipment",
  "subcontract",
  "other",
] as const;
export type RateKey = (typeof RATE_KEYS)[number];

export interface RateSplit {
  labour: number;
  material: number;
  equipment: number;
  subcontract: number;
  other: number;
}

export const ZERO_SPLIT: RateSplit = {
  labour: 0,
  material: 0,
  equipment: 0,
  subcontract: 0,
  other: 0,
};

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

const num = (v: number | null | undefined): number => (Number.isFinite(v) ? (v as number) : 0);

export function makeSplit(partial: Partial<RateSplit> | null | undefined): RateSplit {
  return {
    labour: num(partial?.labour),
    material: num(partial?.material),
    equipment: num(partial?.equipment),
    subcontract: num(partial?.subcontract),
    other: num(partial?.other),
  };
}

export function splitTotal(split: RateSplit): number {
  return RATE_KEYS.reduce((sum, key) => sum + num(split[key]), 0);
}

export function addSplits(a: RateSplit, b: RateSplit): RateSplit {
  return {
    labour: a.labour + b.labour,
    material: a.material + b.material,
    equipment: a.equipment + b.equipment,
    subcontract: a.subcontract + b.subcontract,
    other: a.other + b.other,
  };
}

export function scaleSplit(split: RateSplit, factor: number): RateSplit {
  const f = num(factor);
  return {
    labour: split.labour * f,
    material: split.material * f,
    equipment: split.equipment * f,
    subcontract: split.subcontract * f,
    other: split.other * f,
  };
}

/** The rate key a `CostType` contributes to when a rate is given as one number. */
export function rateKeyForCostType(costType: string): RateKey {
  switch (costType) {
    case "labour":
      return "labour";
    case "material":
      return "material";
    case "equipment":
      return "equipment";
    case "subcontract":
      return "subcontract";
    default:
      return "other";
  }
}

/**
 * Which cost type a split belongs to when it has to be reduced to one — the
 * dominant component, ties broken by the RATE_KEYS order so the answer is
 * deterministic.
 */
export function dominantCostType(split: RateSplit): CostType {
  let best: RateKey = "other";
  let bestValue = -Infinity;
  for (const key of RATE_KEYS) {
    const v = num(split[key]);
    if (v > bestValue) {
      bestValue = v;
      best = key;
    }
  }
  if (bestValue <= 0) return "other";
  return best as CostType;
}

/* ------------------------------------------------------------------ */
/* Crews and production rates                                          */
/* ------------------------------------------------------------------ */

export interface CrewMemberSpec {
  trade: string;
  count: number;
  hourlyRate: number;
}

export interface CrewEquipmentSpec {
  description: string;
  count: number;
  hourlyRate: number;
}

export interface CrewCost {
  labourHourlyCost: number;
  equipmentHourlyCost: number;
  hourlyCost: number;
  headcount: number;
}

/** Crew composition → hourly cost (#197). Negative counts and rates are ignored. */
export function crewCost(
  members: readonly CrewMemberSpec[] | null | undefined,
  equipment: readonly CrewEquipmentSpec[] | null | undefined,
): CrewCost {
  let labourHourlyCost = 0;
  let headcount = 0;
  for (const m of members ?? []) {
    const count = Math.max(0, num(m?.count));
    const rate = Math.max(0, num(m?.hourlyRate));
    labourHourlyCost += count * rate;
    headcount += count;
  }
  let equipmentHourlyCost = 0;
  for (const e of equipment ?? []) {
    equipmentHourlyCost += Math.max(0, num(e?.count)) * Math.max(0, num(e?.hourlyRate));
  }
  return {
    labourHourlyCost: round2(labourHourlyCost),
    equipmentHourlyCost: round2(equipmentHourlyCost),
    hourlyCost: round2(labourHourlyCost + equipmentHourlyCost),
    headcount: round4(headcount),
  };
}

/**
 * Normalise a production rate into hours per unit (#194).
 * `output_per_hour` of 0 is not "instant"; it is "unknown", and returns null
 * rather than Infinity so the caller states the gap instead of pricing it.
 */
export function hoursPerUnit(
  value: number | null | undefined,
  basis: ProductionRateBasis | string | null | undefined,
): number | null {
  const v = num(value);
  if (!(v > 0)) return null;
  if (basis === "hours_per_unit") return v;
  return 1 / v;
}

export interface LabourBuildUp {
  hoursPerUnit: number | null;
  labourRate: number;
  equipmentRate: number;
  reason: string;
}

/**
 * Build the labour (and plant) half of a unit rate from a crew and a
 * production rate: hours/unit × crew hourly cost. This is the rate build-up a
 * reviewer can argue with, as opposed to a typed number nobody can.
 */
export function buildLabourRate(a: {
  crew: CrewCost | null;
  productionRate: number | null | undefined;
  productionRateBasis: ProductionRateBasis | string | null | undefined;
}): LabourBuildUp {
  const hpu = hoursPerUnit(a.productionRate, a.productionRateBasis);
  if (!a.crew) {
    return {
      hoursPerUnit: hpu,
      labourRate: 0,
      equipmentRate: 0,
      reason: "No crew was selected, so the labour rate could not be built up.",
    };
  }
  if (hpu === null) {
    return {
      hoursPerUnit: null,
      labourRate: 0,
      equipmentRate: 0,
      reason: "No usable production rate was given, so the labour rate could not be built up.",
    };
  }
  return {
    hoursPerUnit: round4(hpu),
    labourRate: round2(hpu * a.crew.labourHourlyCost),
    equipmentRate: round2(hpu * a.crew.equipmentHourlyCost),
    reason: `${round4(hpu)} crew-hours per unit × ${round2(a.crew.hourlyCost)} per crew-hour (${round4(a.crew.headcount)} operatives).`,
  };
}

/* ------------------------------------------------------------------ */
/* Line pricing                                                        */
/* ------------------------------------------------------------------ */

export interface PriceLineInput {
  /** the measured / entered quantity BEFORE waste */
  baseQuantity: number | null | undefined;
  /** declared allowance, as a percentage of the base quantity */
  wastePercent?: number | null;
  rates: Partial<RateSplit>;
  /** when the labour half is built from a crew rather than typed */
  crew?: CrewCost | null;
  productionRate?: number | null;
  productionRateBasis?: ProductionRateBasis | string | null;
}

export interface PricedLine {
  quantity: number;
  rates: RateSplit;
  unitRate: number;
  amounts: RateSplit;
  amount: number;
  labourHours: number;
  basis: string[];
}

/**
 * Price one line. `quantity` is always the PRICED quantity — base × (1 +
 * waste) — and the base is kept by the caller, so "412 m² measured, 437 m²
 * priced, 6% waste" is three separate, checkable facts rather than one number
 * with an argument attached.
 */
export function priceLine(input: PriceLineInput): PricedLine {
  const basis: string[] = [];
  const base = num(input.baseQuantity);
  const waste = num(input.wastePercent);
  const quantity = round4(base * (1 + waste / 100));
  if (waste !== 0) {
    basis.push(`${round4(base)} measured + ${round4(waste)}% waste = ${quantity}.`);
  }

  let rates = makeSplit(input.rates);
  const buildUp = input.crew
    ? buildLabourRate({
        crew: input.crew,
        productionRate: input.productionRate,
        productionRateBasis: input.productionRateBasis,
      })
    : null;
  if (buildUp && buildUp.hoursPerUnit !== null) {
    // An explicit typed labour rate wins over the build-up: a person who
    // overrode the crew rate meant it. Everything else is filled in.
    rates = {
      ...rates,
      labour: rates.labour !== 0 ? rates.labour : buildUp.labourRate,
      equipment: rates.equipment !== 0 ? rates.equipment : buildUp.equipmentRate,
    };
    basis.push(`Labour rate: ${buildUp.reason}`);
  } else if (buildUp) {
    basis.push(buildUp.reason);
  }

  const amounts: RateSplit = {
    labour: round2(quantity * rates.labour),
    material: round2(quantity * rates.material),
    equipment: round2(quantity * rates.equipment),
    subcontract: round2(quantity * rates.subcontract),
    other: round2(quantity * rates.other),
  };
  const unitRate = round4(splitTotal(rates));
  const amount = round2(splitTotal(amounts));
  const hpu = buildUp?.hoursPerUnit ?? hoursPerUnit(input.productionRate, input.productionRateBasis);
  const labourHours = hpu === null ? 0 : round4(quantity * hpu);

  basis.push(`${quantity} × ${unitRate} = ${amount}.`);
  return { quantity, rates, unitRate, amounts, amount, labourHours, basis };
}

/* ------------------------------------------------------------------ */
/* Assemblies                                                          */
/* ------------------------------------------------------------------ */

export interface AssemblyComponentSpec {
  id?: string;
  description: string;
  unit?: string | null;
  costType?: string | null;
  quantityPer: number;
  wastePercent?: number | null;
  rates: Partial<RateSplit>;
  catalogueItemId?: string | null;
  costCodeId?: string | null;
  costCode?: string | null;
}

export interface AssemblyPricing {
  /** rate split for ONE assembly unit */
  rates: RateSplit;
  unitRate: number;
  componentCount: number;
}

/**
 * The price of one assembly unit: Σ component (quantityPer × waste × rate).
 * Waste is applied at the component, not the assembly, because "5% extra
 * blocks" and "5% extra bricklayers" are different claims.
 */
export function assemblyUnitRate(components: readonly AssemblyComponentSpec[]): AssemblyPricing {
  let rates: RateSplit = { ...ZERO_SPLIT };
  for (const c of components) {
    const qty = num(c.quantityPer) * (1 + num(c.wastePercent) / 100);
    rates = addSplits(rates, scaleSplit(makeSplit(c.rates), qty));
  }
  const rounded: RateSplit = {
    labour: round4(rates.labour),
    material: round4(rates.material),
    equipment: round4(rates.equipment),
    subcontract: round4(rates.subcontract),
    other: round4(rates.other),
  };
  return {
    rates: rounded,
    unitRate: round4(splitTotal(rounded)),
    componentCount: components.length,
  };
}

export interface ExpandedAssemblyLine {
  description: string;
  unit: string | null;
  costType: string;
  baseQuantity: number;
  wastePercent: number;
  rates: RateSplit;
  catalogueItemId: string | null;
  costCodeId: string | null;
  costCode: string | null;
  priced: PricedLine;
}

/**
 * Expand an assembly onto an estimate at `quantity` assembly units (#191).
 * One output line per component; the parent line is written by the caller so
 * the grid shows the assembly and what it is made of.
 */
export function expandAssembly(
  components: readonly AssemblyComponentSpec[],
  quantity: number,
): ExpandedAssemblyLine[] {
  const q = num(quantity);
  return components.map((c) => {
    const rates = makeSplit(c.rates);
    const baseQuantity = round4(num(c.quantityPer) * q);
    const priced = priceLine({
      baseQuantity,
      wastePercent: c.wastePercent ?? 0,
      rates,
    });
    return {
      description: c.description,
      unit: c.unit ?? null,
      costType: c.costType ?? dominantCostType(rates),
      baseQuantity,
      wastePercent: num(c.wastePercent),
      rates,
      catalogueItemId: c.catalogueItemId ?? null,
      costCodeId: c.costCodeId ?? null,
      costCode: c.costCode ?? null,
      priced,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Roll-up                                                             */
/* ------------------------------------------------------------------ */

export interface RollupLine {
  sectionId?: string | null;
  costType: string;
  status: string;
  labourAmount: number;
  materialAmount: number;
  equipmentAmount: number;
  subcontractAmount: number;
  otherAmount: number;
  amount: number;
  labourHours?: number | null;
}

export interface EstimateRollup {
  directCostTotal: number;
  labourTotal: number;
  materialTotal: number;
  equipmentTotal: number;
  subcontractTotal: number;
  otherTotal: number;
  labourHours: number;
  lineCount: number;
  /** lines flagged `excluded` — outside the total, kept for the reasoning */
  excludedTotal: number;
  /** lines flagged `alternate` — priced, offered, not in the number */
  alternateTotal: number;
  /** direct cost per cost type, for a cost-type-based markup */
  byCostType: Record<string, number>;
  /** direct cost per section id ("" = unsectioned), for a section markup */
  bySection: Record<string, number>;
}

/** A line is in the estimate total when it is active or provisional. */
export const isCountedLine = (status: string): boolean =>
  status === "active" || status === "provisional";

export function rollUpLines(lines: readonly RollupLine[]): EstimateRollup {
  const rollup: EstimateRollup = {
    directCostTotal: 0,
    labourTotal: 0,
    materialTotal: 0,
    equipmentTotal: 0,
    subcontractTotal: 0,
    otherTotal: 0,
    labourHours: 0,
    lineCount: lines.length,
    excludedTotal: 0,
    alternateTotal: 0,
    byCostType: {},
    bySection: {},
  };
  for (const line of lines) {
    const amount = num(line.amount);
    if (!isCountedLine(line.status)) {
      if (line.status === "alternate") rollup.alternateTotal += amount;
      else rollup.excludedTotal += amount;
      continue;
    }
    rollup.directCostTotal += amount;
    rollup.labourTotal += num(line.labourAmount);
    rollup.materialTotal += num(line.materialAmount);
    rollup.equipmentTotal += num(line.equipmentAmount);
    rollup.subcontractTotal += num(line.subcontractAmount);
    rollup.otherTotal += num(line.otherAmount);
    rollup.labourHours += num(line.labourHours);
    const ct = line.costType || "other";
    rollup.byCostType[ct] = round2((rollup.byCostType[ct] ?? 0) + amount);
    const sect = line.sectionId ?? "";
    rollup.bySection[sect] = round2((rollup.bySection[sect] ?? 0) + amount);
  }
  return {
    ...rollup,
    directCostTotal: round2(rollup.directCostTotal),
    labourTotal: round2(rollup.labourTotal),
    materialTotal: round2(rollup.materialTotal),
    equipmentTotal: round2(rollup.equipmentTotal),
    subcontractTotal: round2(rollup.subcontractTotal),
    otherTotal: round2(rollup.otherTotal),
    labourHours: round4(rollup.labourHours),
    excludedTotal: round2(rollup.excludedTotal),
    alternateTotal: round2(rollup.alternateTotal),
  };
}

/* ------------------------------------------------------------------ */
/* Markup cascade                                                      */
/* ------------------------------------------------------------------ */

export interface MarkupSpec {
  id: string;
  sequence: number;
  kind: string;
  name: string;
  method: EstimateMarkupMethod | string;
  basis: EstimateMarkupBasis | string;
  rate: number;
  costTypes?: readonly string[] | null;
  sectionIds?: readonly string[] | null;
  quantity?: number | null;
  enabled?: boolean;
}

export interface AppliedMarkup {
  id: string;
  sequence: number;
  kind: string;
  name: string;
  method: string;
  basis: string;
  rate: number;
  baseAmount: number;
  amount: number;
  /** the sentence a reviewer needs: what this was a percentage of */
  explanation: string;
}

export interface MarkupCascade {
  markups: AppliedMarkup[];
  markupTotal: number;
  total: number;
  warnings: string[];
}

/**
 * Apply the markup tiers in sequence (#198–199).
 *
 * The cascade is the whole point: `direct_cost` always means the priced
 * lines, `running_total` means direct cost plus every markup already applied,
 * and `cost_type` narrows to the selected families. Two markups with the same
 * sequence are applied in id order so the result is deterministic.
 */
export function applyMarkups(
  markups: readonly MarkupSpec[],
  rollup: EstimateRollup,
): MarkupCascade {
  const warnings: string[] = [];
  const ordered = [...markups]
    .filter((m) => m.enabled !== false)
    .sort((a, b) => (a.sequence - b.sequence) || a.id.localeCompare(b.id));

  let running = rollup.directCostTotal;
  const applied: AppliedMarkup[] = [];

  for (const m of ordered) {
    let baseAmount: number;
    let baseLabel: string;
    const sections = (m.sectionIds ?? []).filter((s) => s.length > 0);
    if (m.basis === "cost_type") {
      const types = (m.costTypes ?? []).filter((t) => t.length > 0);
      if (types.length === 0) {
        baseAmount = rollup.directCostTotal;
        baseLabel = "direct cost (no cost type selected, so every type)";
        warnings.push(
          `"${m.name}" is a cost-type markup with no cost type selected; it was applied to the whole direct cost.`,
        );
      } else {
        baseAmount = types.reduce((sum, t) => sum + (rollup.byCostType[t] ?? 0), 0);
        baseLabel = `direct cost of ${types.join(", ")}`;
      }
    } else if (m.basis === "running_total" || m.basis === "estimate_total") {
      baseAmount = running;
      baseLabel = "direct cost plus the markups sequenced before this one";
    } else {
      baseAmount = rollup.directCostTotal;
      baseLabel = "direct cost";
    }

    if (sections.length > 0) {
      if (m.basis === "running_total" || m.basis === "estimate_total") {
        warnings.push(
          `"${m.name}" narrows to sections but is applied to the running total, which is not sectioned; the section filter was ignored.`,
        );
      } else {
        baseAmount = sections.reduce((sum, s) => sum + (rollup.bySection[s] ?? 0), 0);
        baseLabel = `${baseLabel} in ${sections.length} selected section${sections.length === 1 ? "" : "s"}`;
      }
    }

    baseAmount = round2(baseAmount);
    let amount: number;
    let explanation: string;
    if (m.method === "fixed") {
      amount = round2(num(m.rate));
      explanation = `Fixed amount of ${amount}.`;
    } else if (m.method === "per_unit") {
      const q = num(m.quantity);
      amount = round2(num(m.rate) * q);
      explanation = `${round4(num(m.rate))} per unit × ${round4(q)} units = ${amount}.`;
      if (!(q > 0)) {
        warnings.push(
          `"${m.name}" is a per-unit markup with no quantity, so it contributes nothing.`,
        );
      }
    } else {
      amount = round2((baseAmount * num(m.rate)) / 100);
      explanation = `${round4(num(m.rate))}% of ${baseAmount} (${baseLabel}) = ${amount}.`;
    }

    running = round2(running + amount);
    applied.push({
      id: m.id,
      sequence: m.sequence,
      kind: m.kind,
      name: m.name,
      method: String(m.method),
      basis: String(m.basis),
      rate: num(m.rate),
      baseAmount,
      amount,
      explanation,
    });
  }

  const markupTotal = round2(applied.reduce((sum, a) => sum + a.amount, 0));
  return {
    markups: applied,
    markupTotal,
    total: round2(rollup.directCostTotal + markupTotal),
    warnings,
  };
}

export interface EstimateTotals extends EstimateRollup {
  markupTotal: number;
  total: number;
  appliedMarkups: AppliedMarkup[];
  warnings: string[];
}

/** The one function the route layer calls to get every header number. */
export function estimateTotals(
  lines: readonly RollupLine[],
  markups: readonly MarkupSpec[],
): EstimateTotals {
  const rollup = rollUpLines(lines);
  const cascade = applyMarkups(markups, rollup);
  return {
    ...rollup,
    markupTotal: cascade.markupTotal,
    total: cascade.total,
    appliedMarkups: cascade.markups,
    warnings: cascade.warnings,
  };
}
