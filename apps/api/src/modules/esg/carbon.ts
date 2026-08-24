import type { CarbonFactorSource, CommitmentStatus } from "@constructos/shared";
import { addDaysISO } from "../field/dates.js";

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

/** Round to `dp` decimal places (plain half-up on the scaled value). */
export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const round2 = (n: number): number => round(n, 2);
/** Reporting precision for tCO2e — 1 mg. Fine enough that a stored figure
 *  divided back out recovers the factor exactly for any sane quantity. */
export const round9 = (n: number): number => round(n, 9);
/** Aggregate presentation precision for tCO2e — 1 gram. */
export const round6 = (n: number): number => round(n, 6);

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return round2((part / whole) * 100);
}

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

const UNIT_ALIASES: Record<string, string> = {
  kg: "kg",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  t: "t",
  te: "t",
  tonne: "t",
  tonnes: "t",
  ton: "t",
  m3: "m3",
  "m^3": "m3",
  "m³": "m3",
  cum: "m3",
  m2: "m2",
  "m^2": "m2",
  "m²": "m2",
  sqm: "m2",
  m: "m",
  lm: "m",
  metre: "m",
  metres: "m",
  l: "litre",
  ltr: "litre",
  litre: "litre",
  litres: "litre",
  liter: "litre",
  liters: "litre",
  item: "item",
  items: "item",
  no: "item",
  nr: "item",
  each: "item",
  ea: "item",
  kwh: "kwh",
  hr: "hr",
  hour: "hr",
  hours: "hr",
};

/**
 * Canonical form of a unit string for comparison. Case, surrounding space
 * and the usual spelling variants (`m³`/`m3`/`cum`, `l`/`litre`, `no`/`nr`/
 * `item`) collapse; anything unrecognised is compared lowercased verbatim so
 * a genuine mismatch is still a mismatch.
 */
export function normaliseUnit(unit: string): string {
  const k = unit.trim().toLowerCase().replace(/\s+/g, "");
  return UNIT_ALIASES[k] ?? k;
}

export function unitsMatch(a: string, b: string): boolean {
  return normaliseUnit(a) === normaliseUnit(b);
}

/* ------------------------------------------------------------------ */
/* Carbon arithmetic                                                   */
/* ------------------------------------------------------------------ */

/**
 * tCO2e for a quantity measured against a kgCO2e-per-unit factor.
 * Factors are published per unit in kilograms; the register reports tonnes,
 * so the ÷1000 lives here and nowhere else.
 */
export function computeTco2e(quantity: number, factorKgCo2ePerUnit: number): number {
  return round9((quantity * factorKgCo2ePerUnit) / 1000);
}

/**
 * Recover the kgCO2e-per-unit factor a stored entry was written with. Used
 * for manually-entered factors, which have no row in the library to read
 * back. Exact for any quantity whose product survives 9dp rounding.
 */
export function factorFromEntry(quantity: number, tco2e: number): number {
  if (quantity <= 0) return 0;
  return round9((tco2e * 1000) / quantity);
}

export type CarbonBudgetStatus = "on_track" | "at_risk" | "exceeded";

/**
 * Budget drawdown (#495). Percent is actual ÷ target; the bands are
 * on_track below 80%, at_risk from 80% up to and including 100%, exceeded
 * beyond it. A non-positive target is treated as instantly exceeded by any
 * emission at all — a zero-carbon target with emissions against it is not
 * "on track".
 */
export function budgetDrawdown(
  actualTco2e: number,
  targetTco2e: number,
): { drawdownPercent: number; remaining: number; status: CarbonBudgetStatus } {
  const remaining = round6(targetTco2e - actualTco2e);
  if (targetTco2e <= 0) {
    return {
      drawdownPercent: actualTco2e > 0 ? 100 : 0,
      remaining,
      status: actualTco2e > 0 ? "exceeded" : "on_track",
    };
  }
  const drawdownPercent = round2((actualTco2e / targetTco2e) * 100);
  const status: CarbonBudgetStatus =
    drawdownPercent > 100 ? "exceeded" : drawdownPercent >= 80 ? "at_risk" : "on_track";
  return { drawdownPercent, remaining, status };
}

/* ------------------------------------------------------------------ */
/* Waste                                                               */
/* ------------------------------------------------------------------ */

/**
 * Diversion from landfill (#514): everything that did not go to landfill,
 * as a share of the total tonnage moved. Incineration WITHOUT recovery is
 * counted as diverted here because the destination taxonomy separates
 * `incinerated` from `recovered` — a site reporting energy-from-waste should
 * book it as `recovered`. `recycledPercent` is the narrow measure: the
 * `recycled` destination alone, not reuse or recovery.
 */
export function wasteDiversion(
  totalTonnes: number,
  landfillTonnes: number,
  recycledTonnes: number,
): { diversionFromLandfillPercent: number; recycledPercent: number } {
  return {
    diversionFromLandfillPercent: percent(totalTonnes - landfillTonnes, totalTonnes),
    recycledPercent: percent(recycledTonnes, totalTonnes),
  };
}

/* ------------------------------------------------------------------ */
/* Social value                                                        */
/* ------------------------------------------------------------------ */

/** Days of grace after the due date before under-delivery becomes shortfall. */
export const SHORTFALL_GRACE_DAYS = 30;

/**
 * Commitment status (#539-540). Delivery first: anything at or above target
 * is delivered whatever the date. Then the clock: past due date + 30 days
 * and still short is a shortfall (the number the client's tender-compliance
 * team asks for); past the due date and under 70% is at risk. A commitment
 * with nothing delivered and no date pressure stays `committed`.
 */
export function commitmentStatus(
  deliveredValue: number,
  targetValue: number,
  dueDate: string | null,
  today: string,
): CommitmentStatus {
  if (targetValue > 0 && deliveredValue >= targetValue) return "delivered";
  const progress = targetValue > 0 ? (deliveredValue / targetValue) * 100 : 0;
  if (dueDate) {
    if (today > addDaysISO(dueDate, SHORTFALL_GRACE_DAYS)) return "shortfall";
    if (today > dueDate && progress < 70) return "at_risk";
  }
  return deliveredValue > 0 ? "on_track" : "committed";
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

export function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/* Default factor library                                              */
/* ------------------------------------------------------------------ */

export interface SeedFactor {
  name: string;
  materialCategory: string;
  unit: string;
  factorKgCo2ePerUnit: number;
}

/**
 * Starter carbon factor set, seeded on demand into a tenant's library.
 *
 * ⚠ THESE ARE INDICATIVE PUBLISHED-ORDER VALUES, NOT A LICENSED DATASET.
 *
 * They are hand-entered approximations of the order of magnitude reported in
 * the public literature for generic UK materials — broadly the cradle-to-gate
 * (A1-A3) shape of the ICE database, with the diesel figure being a
 * combustion-plus-well-to-tank fuel conversion factor rather than a materials
 * figure at all. They exist so a project can be stood up and the arithmetic
 * exercised on day one. They are NOT:
 *   - version-controlled against any published edition of ICE or DEFRA;
 *   - specific to any supplier, mix design, recycled content or region;
 *   - a substitute for an EPD where a product-specific declaration exists
 *     (#497-498 — product-specific factors always beat generic ones).
 *
 * Before ANY contractual, tender or disclosure reporting the client must
 * replace these with their own verified dataset (a licensed ICE release,
 * supplier EPDs, or the assessor's own factor set) and re-run the register.
 * Every seeded row is marked `ice_database` / `isProductSpecific = 0` so
 * `productSpecificSharePercent` (#498) reports the generic reliance honestly.
 */
export const DEFAULT_CARBON_FACTORS: readonly SeedFactor[] = [
  { name: "Concrete C30/37 (generic)", materialCategory: "concrete", unit: "kg", factorKgCo2ePerUnit: 0.103 },
  { name: "Reinforcement steel (rebar)", materialCategory: "steel", unit: "kg", factorKgCo2ePerUnit: 1.99 },
  { name: "Structural steel section", materialCategory: "steel", unit: "kg", factorKgCo2ePerUnit: 1.55 },
  { name: "Cement (CEM I)", materialCategory: "cement", unit: "kg", factorKgCo2ePerUnit: 0.86 },
  { name: "Aggregate (crushed)", materialCategory: "aggregate", unit: "kg", factorKgCo2ePerUnit: 0.007 },
  { name: "Brick (common clay)", materialCategory: "masonry", unit: "kg", factorKgCo2ePerUnit: 0.24 },
  { name: "Timber (softwood, kiln dried)", materialCategory: "timber", unit: "kg", factorKgCo2ePerUnit: 0.31 },
  { name: "Glass (float)", materialCategory: "glass", unit: "kg", factorKgCo2ePerUnit: 1.4 },
  { name: "Aluminium (general)", materialCategory: "metal", unit: "kg", factorKgCo2ePerUnit: 9.16 },
  { name: "Plasterboard", materialCategory: "board", unit: "kg", factorKgCo2ePerUnit: 0.39 },
  { name: "Insulation (mineral wool)", materialCategory: "insulation", unit: "kg", factorKgCo2ePerUnit: 1.28 },
  { name: "Asphalt (hot rolled)", materialCategory: "asphalt", unit: "kg", factorKgCo2ePerUnit: 0.066 },
  { name: "Copper (general)", materialCategory: "metal", unit: "kg", factorKgCo2ePerUnit: 2.71 },
  { name: "Plastic pipe (PVC-U)", materialCategory: "plastics", unit: "kg", factorKgCo2ePerUnit: 3.1 },
  { name: "Diesel (combustion + WTT)", materialCategory: "fuel", unit: "litre", factorKgCo2ePerUnit: 2.68 },
];

/** Every seeded row carries this source and generic flag (see the note above). */
export const SEED_FACTOR_SOURCE: CarbonFactorSource = "ice_database";
