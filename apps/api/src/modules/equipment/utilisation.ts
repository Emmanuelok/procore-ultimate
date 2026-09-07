/**
 * M23 — the utilisation and idle-cost engine. PURE: no clock, no database,
 * no I/O. Every function is a total function of its arguments and an
 * explicit `asOf`, so the numbers the commercial team will argue over can be
 * unit-tested against hand-worked examples.
 *
 * WHY THIS FILE EXISTS AT ALL. A plant register that lists machines answers
 * "what have we got". It does not answer the only question that costs money:
 * "what are we paying for that is not working". A 30-tonne excavator on full
 * hire standing for three weeks is not a fleet problem, it is a commercial
 * one, and the loss is the product of two figures nobody computes by hand —
 * a utilisation percentage and an accumulated standing cost.
 *
 * HONESTY RULE (platform-wide). A figure that cannot be computed from the
 * inputs present is returned as `null` with a `reasons` array saying why. It
 * is never defaulted to zero: a zero utilisation percentage reads as "idle",
 * and "we do not know" is a completely different management fact from "it
 * stood all week". The same applies to cost — a machine with no hire rate
 * recorded produces `hireCost: null` and a reason, never 0.
 *
 * CURRENCY RULE. Nothing here sums money across currencies. Every cost
 * function carries exactly one currency through, taken from the machine, and
 * the aggregate functions bucket by currency rather than adding.
 */

import type { HireRateUnit } from "@constructos/shared";

/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Float slack for hour arithmetic — 0.36 seconds. */
const HOUR_EPSILON = 1e-4;

/* ------------------------------------------------------------------ */
/* The hour split                                                      */
/* ------------------------------------------------------------------ */

/**
 * One machine, one day, one shift. `availableHours` is the window the
 * machine was on site and could have worked; the five buckets are how that
 * window was actually spent. `availableHours` is nullable because a great
 * many sites record the split without recording the window.
 */
export interface UtilisationHours {
  availableHours: number | null;
  workingHours: number;
  idleHours: number;
  standbyHours: number;
  downtimeHours: number;
  travelHours: number;
}

export type UtilisationBasis = "available_hours" | "accounted_hours";

export interface UtilisationResult {
  /** working ÷ denominator × 100, or null when it cannot be computed */
  utilisationPercent: number | null;
  /** Σ of the five buckets */
  accountedHours: number;
  /** the denominator actually used, null when none could be */
  denominatorHours: number | null;
  basis: UtilisationBasis | null;
  /** hours that were paid for and produced nothing (idle + standby + downtime) */
  unproductiveHours: number;
  reasons: string[];
}

const HOUR_KEYS = [
  "workingHours",
  "idleHours",
  "standbyHours",
  "downtimeHours",
  "travelHours",
] as const;

/**
 * Utilisation for one machine-day-shift.
 *
 * DEFINITION, stated because every plant hire company uses a different one:
 * utilisation is WORKING hours over the available window. Travel counts in
 * the denominator but not the numerator — a low-loader move is time the
 * machine was paid for and produced nothing on this project, and hiding it
 * in the numerator is how a fleet reports 90% while the site stands.
 *
 * The denominator is `availableHours` when it was recorded, and otherwise
 * the sum of the five buckets ("accounted hours"), which is the best the
 * inputs support. `basis` always says which was used, because the two are
 * not the same number and a reader comparing machines must know.
 *
 * Refusals — all return `utilisationPercent: null` with a reason:
 *  - any negative bucket (a negative hour is a data-entry fault, not a fact)
 *  - a denominator of zero (nothing to divide by)
 *  - accounted hours exceeding the available window by more than epsilon
 *    (the row contradicts itself; a percentage over 100 would look like
 *    over-performance rather than the bad input it is)
 */
export function computeUtilisation(hours: UtilisationHours): UtilisationResult {
  const reasons: string[] = [];
  const accountedHours = round4(HOUR_KEYS.reduce((s, k) => s + (hours[k] || 0), 0));
  const unproductiveHours = round4(
    (hours.idleHours || 0) + (hours.standbyHours || 0) + (hours.downtimeHours || 0),
  );

  const negatives: string[] = HOUR_KEYS.filter((k) => (hours[k] || 0) < 0);
  if (hours.availableHours !== null && hours.availableHours < 0) negatives.push("availableHours");
  if (negatives.length > 0) {
    reasons.push(
      `negative hours recorded (${negatives.join(", ")}) — a machine cannot work a negative shift`,
    );
    return {
      utilisationPercent: null,
      accountedHours,
      denominatorHours: null,
      basis: null,
      unproductiveHours,
      reasons,
    };
  }

  const hasAvailable = hours.availableHours !== null && hours.availableHours > 0;
  if (hours.availableHours !== null && hours.availableHours === 0) {
    reasons.push("availableHours is 0 — the machine was not on site for any part of the shift");
  }
  if (hasAvailable && accountedHours > hours.availableHours! + HOUR_EPSILON) {
    reasons.push(
      `hours accounted (${accountedHours}) exceed the available window (${hours.availableHours}) — ` +
        `the row contradicts itself and no honest percentage can be taken from it`,
    );
    return {
      utilisationPercent: null,
      accountedHours,
      denominatorHours: null,
      basis: null,
      unproductiveHours,
      reasons,
    };
  }

  const denominatorHours = hasAvailable ? hours.availableHours! : accountedHours;
  const basis: UtilisationBasis | null = hasAvailable
    ? "available_hours"
    : accountedHours > 0
      ? "accounted_hours"
      : null;
  if (!hasAvailable && accountedHours > 0) {
    reasons.push(
      "availableHours was not recorded — the percentage is taken over the hours accounted for, " +
        "which cannot show a machine that sat outside the recorded shift",
    );
  }
  if (denominatorHours <= 0) {
    reasons.push("no hours were recorded at all — there is nothing to take a percentage of");
    return {
      utilisationPercent: null,
      accountedHours,
      denominatorHours: null,
      basis: null,
      unproductiveHours,
      reasons,
    };
  }

  return {
    utilisationPercent: round2(((hours.workingHours || 0) / denominatorHours) * 100),
    accountedHours,
    denominatorHours: round4(denominatorHours),
    basis,
    unproductiveHours,
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

/**
 * How a hire rate expressed per week or per month is apportioned to a single
 * machine-day. These divisors are CALENDAR divisors and are stated here
 * rather than buried in an expression, because a weekly rate divided by 5
 * working days and one divided by 7 calendar days differ by 40% and the
 * choice must be visible to whoever reads the number.
 *
 * `cycle` and `lump_sum` have no defensible daily share at all: a cycle rate
 * needs a cycle count and a lump sum belongs to a mobilisation, not a day.
 * Those return null with a reason rather than a guess.
 */
export const HIRE_UNIT_DAY_DIVISOR: Record<HireRateUnit, number | null> = {
  hour: null, // priced on hours, not on a day share — see computeHireCost
  shift: 1,
  day: 1,
  week: 7,
  month: 30,
  cycle: null,
  lump_sum: null,
};

export interface HireCostInput {
  hireRateAmount: number | null;
  hireRateUnit: HireRateUnit | null;
  /** the standing rate — what idle and standby hours cost */
  idleRateAmount: number | null;
  hours: UtilisationHours;
  /**
   * OWNED PLANT. `equipment.internalRateAmount` is the internal charge-out
   * rate, and without it every owned machine costs nothing on the utilisation
   * report, in the summary and in the value-at-risk of the telematics
   * reconciliation — which is how a fleet that is 60% owned shows a labour-only
   * cost report. Read per hour, and the basis says so, because an internal
   * rate is a management convention rather than an invoice.
   */
  internalRateAmount?: number | null;
  ownership?: string | null;
}

export interface CostComponent {
  amount: number | null;
  basis: string | null;
  reasons: string[];
}

/**
 * The hire cost of one machine-day.
 *
 * Per-hour rates: working and travel hours at the hire rate; idle and
 * standby at the standing rate where one is recorded, and at the full hire
 * rate where none is — because a hire company that has not agreed a standing
 * rate charges the full one, and assuming otherwise understates the loss.
 * DOWNTIME IS NOT CHARGED: a machine broken down comes off hire under every
 * standard hire condition, and charging for it would flatter nobody.
 *
 * Per-shift/day/week/month rates: the rate's daily share, whole. A day rate
 * does not become cheaper because the machine stood — that is the entire
 * reason idle plant is expensive.
 */
export function computeHireCost(input: HireCostInput): CostComponent {
  const reasons: string[] = [];
  if (
    (input.hireRateAmount === null || input.hireRateAmount < 0) &&
    input.internalRateAmount != null &&
    input.internalRateAmount >= 0
  ) {
    // Owned plant charged out internally (#714). Priced per hour on the same
    // ladder as a per-hour hire, with downtime excluded for the same reason.
    const h = input.hours;
    const workedRateHours = (h.workingHours || 0) + (h.travelHours || 0);
    const standingHours = (h.idleHours || 0) + (h.standbyHours || 0);
    const standingRate = input.idleRateAmount ?? input.internalRateAmount;
    return {
      amount: round2(
        workedRateHours * input.internalRateAmount + standingHours * standingRate,
      ),
      basis:
        `${round2(workedRateHours)}h at the internal charge-out rate of ` +
        `${input.internalRateAmount}/hour` +
        (standingHours > 0 ? ` + ${round2(standingHours)}h standing at ${standingRate}/hour` : ""),
      reasons: [
        "this machine is " +
          `${input.ownership ?? "owned"} and carries no hire rate, so it is costed at the internal ` +
          "charge-out rate. That is a management convention, not an invoice: it is the right number " +
          "for comparing owned against hired plant and the wrong one for a claim.",
      ],
    };
  }
  if (input.hireRateAmount === null || input.hireRateAmount < 0) {
    reasons.push(
      "no hire rate is recorded on this machine — its standing cost cannot be stated, " +
        "which is exactly how idle plant stays invisible",
    );
    if (input.internalRateAmount == null) {
      reasons.push(
        "nor an internal charge-out rate: owned plant costs nothing on this report until one is set",
      );
    }
    return { amount: null, basis: null, reasons };
  }
  const unit = input.hireRateUnit;
  if (!unit) {
    reasons.push("a hire rate amount is recorded but no hire rate unit — the figure is unusable");
    return { amount: null, basis: null, reasons };
  }
  const h = input.hours;
  if (unit === "hour") {
    const workedRateHours = (h.workingHours || 0) + (h.travelHours || 0);
    const standingHours = (h.idleHours || 0) + (h.standbyHours || 0);
    const standingRate = input.idleRateAmount ?? input.hireRateAmount;
    if (input.idleRateAmount === null && standingHours > 0) {
      reasons.push(
        "no standing (idle) rate is recorded, so idle and standby hours are charged at the full " +
          "hire rate — which is what the hire company will do in the absence of an agreed one",
      );
    }
    if (h.downtimeHours > 0) {
      reasons.push(
        `${round2(h.downtimeHours)} downtime hour(s) are excluded — plant under breakdown comes ` +
          "off hire; if the hire company has charged for them, that is a credit to claim",
      );
    }
    return {
      amount: round2(workedRateHours * input.hireRateAmount + standingHours * standingRate),
      basis:
        `${round2(workedRateHours)}h at ${input.hireRateAmount}/hour` +
        (standingHours > 0 ? ` + ${round2(standingHours)}h standing at ${standingRate}/hour` : ""),
      reasons,
    };
  }
  const divisor = HIRE_UNIT_DAY_DIVISOR[unit];
  if (divisor === null) {
    reasons.push(
      `hire is priced per ${unit}, which has no defensible share of a single day — ` +
        "price the period, not the day",
    );
    return { amount: null, basis: null, reasons };
  }
  return {
    amount: round2(input.hireRateAmount / divisor),
    basis:
      divisor === 1
        ? `one ${unit} at ${input.hireRateAmount}`
        : `${input.hireRateAmount} per ${unit} ÷ ${divisor} calendar days`,
    reasons,
  };
}

export interface OperatorCostInput {
  /** per hour — the only unit the column carries */
  operatorRateAmount: number | null;
  hours: UtilisationHours;
}

/** Operator cost: the paid window (available, else accounted) at the hourly
 *  operator rate. An operator standing next to an idle machine is still paid. */
export function computeOperatorCost(input: OperatorCostInput): CostComponent {
  const reasons: string[] = [];
  if (input.operatorRateAmount === null) {
    reasons.push("no operator rate is recorded on this machine");
    return { amount: null, basis: null, reasons };
  }
  const h = input.hours;
  const accounted = HOUR_KEYS.reduce((s, k) => s + (h[k] || 0), 0);
  const paidHours = h.availableHours !== null && h.availableHours > 0 ? h.availableHours : accounted;
  if (paidHours <= 0) {
    reasons.push("no hours were recorded, so no operator time can be priced");
    return { amount: null, basis: null, reasons };
  }
  if (h.availableHours === null) {
    reasons.push(
      "availableHours was not recorded — operator time is priced over the hours accounted for",
    );
  }
  return {
    amount: round2(paidHours * input.operatorRateAmount),
    basis: `${round2(paidHours)}h at ${input.operatorRateAmount}/hour`,
    reasons,
  };
}

export interface DayCostInput extends HireCostInput, OperatorCostInput {
  /** fuel cost as captured on the day, or null when only litres are known */
  fuelCost: number | null;
  fuelLitres: number | null;
  currency: string;
}

export interface DayCostResult {
  hireCost: number | null;
  fuelCost: number | null;
  operatorCost: number | null;
  /** Σ of the components that COULD be computed */
  totalCost: number | null;
  /** false when any component is null — the total is then a floor, not a total */
  totalIsComplete: boolean;
  currency: string;
  basis: { hire: string | null; operator: string | null };
  reasons: string[];
}

/**
 * Roll one machine-day to money. The total is the sum of the components that
 * could be computed and `totalIsComplete` says whether anything was left
 * out, so a reader is never shown a partial figure dressed as a full one.
 */
export function computeDayCost(input: DayCostInput): DayCostResult {
  const hire = computeHireCost(input);
  const operator = computeOperatorCost(input);
  const reasons = [...hire.reasons, ...operator.reasons];
  let fuelCost = input.fuelCost;
  if (fuelCost === null && input.fuelLitres !== null && input.fuelLitres > 0) {
    reasons.push(
      `${input.fuelLitres} litres of fuel are recorded with no cost — the litres are known, ` +
        "the money is not, so fuel is excluded from the total rather than valued at a guess",
    );
  }
  if (fuelCost === null && (input.fuelLitres === null || input.fuelLitres === 0)) {
    fuelCost = null;
  }
  const parts = [hire.amount, fuelCost, operator.amount];
  const present = parts.filter((p): p is number => p !== null);
  const totalIsComplete = present.length === parts.length;
  if (!totalIsComplete) {
    reasons.push(
      "the total is the sum of the components that could be computed — it is a floor on the " +
        "day's cost, not the day's cost",
    );
  }
  return {
    hireCost: hire.amount,
    fuelCost,
    operatorCost: operator.amount,
    totalCost: present.length > 0 ? round2(present.reduce((s, p) => s + p, 0)) : null,
    totalIsComplete,
    currency: input.currency,
    basis: { hire: hire.basis, operator: operator.basis },
    reasons,
  };
}

/* ------------------------------------------------------------------ */
/* Idle plant still on hire — where the money leaks                    */
/* ------------------------------------------------------------------ */

/** A machine working at or below this share of its window is treated as idle
 *  for the purposes of the off-hire question. 20% of a 10-hour day is two
 *  hours' work: enough to be "used", nowhere near enough to justify hire. */
export const IDLE_UTILISATION_THRESHOLD_PERCENT = 20;

/** Days of sustained low utilisation before the machine is reported. Below
 *  this a low week is weather or a sequencing gap; at and above it, somebody
 *  has forgotten to off-hire. */
export const IDLE_SUSTAINED_DAYS = 5;

/** Ownership kinds where an off-hire actually stops a charge. Owned plant is
 *  excluded on purpose: it is a sunk asset and "off-hiring" it is not a
 *  thing you can do, so reporting it here would dilute the list that has an
 *  action attached to it. */
export const HIRED_OWNERSHIPS = ["hired", "operator_hired", "leased"] as const;

export interface IdleDayInput {
  date: IsoDate;
  hours: UtilisationHours;
  /** what the site said the machine was waiting for, when it said anything */
  idleReason: string | null;
}

export interface IdlePlantInput {
  equipmentId: string;
  reference: string;
  name: string;
  ownership: string;
  status: string;
  currency: string;
  hireRateAmount: number | null;
  hireRateUnit: HireRateUnit | null;
  idleRateAmount: number | null;
  /** internal charge-out rate, so owned plant standing still costs (#714) */
  internalRateAmount?: number | null;
  operatorRateAmount: number | null;
  /** set once somebody has asked for the machine to go back */
  offHireRequestedAt: string | null;
  /** set once it actually went back — after this the leak has stopped */
  offHiredAt: string | null;
  hireEndDate: IsoDate | null;
  /** utilisation rows inside the window, any order */
  days: IdleDayInput[];
  windowStart: IsoDate;
  windowEnd: IsoDate;
}

export interface IdlePlantAssessment {
  equipmentId: string;
  reference: string;
  name: string;
  ownership: string;
  currency: string;
  windowStart: IsoDate;
  windowEnd: IsoDate;
  /** utilisation across the whole window, null when it cannot be taken */
  utilisationPercent: number | null;
  daysRecorded: number;
  /** days at or below the threshold */
  lowDays: number;
  /** the TRAILING run of low days — the run that is still going on */
  consecutiveLowDays: number;
  workingHours: number;
  idleHours: number;
  /** accumulated hire cost of the trailing idle run, in `currency` */
  idleCost: number | null;
  /** whole-window hire cost, for context */
  windowCost: number | null;
  /** true when the machine is hired, not off-hired, and sustained-low */
  isIdleOnHire: boolean;
  /** the reasons the site gave, most frequent first */
  idleReasons: string[];
  offHireRequestedAt: string | null;
  reasons: string[];
}

function isoDaysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Is this machine sustained-idle while still on hire, and what has that cost?
 *
 * The accumulated figure is deliberately the cost of the TRAILING run of low
 * days — the run that is still running — rather than of every low day in the
 * window. That is the number that answers "what will another week cost", and
 * it is the number an off-hire request stops. Scattered low days across a
 * month are a sequencing problem, not an off-hire one.
 *
 * Returns `isIdleOnHire: false` with a reason for every machine it declines
 * to flag, so the caller can show why a machine is absent from the list.
 */
export function assessIdlePlant(
  input: IdlePlantInput,
  options: {
    thresholdPercent?: number;
    sustainedDays?: number;
  } = {},
): IdlePlantAssessment {
  const threshold = options.thresholdPercent ?? IDLE_UTILISATION_THRESHOLD_PERCENT;
  const sustained = options.sustainedDays ?? IDLE_SUSTAINED_DAYS;
  const reasons: string[] = [];
  const days = [...input.days].sort((a, b) => a.date.localeCompare(b.date));

  const totals: UtilisationHours = {
    availableHours: 0,
    workingHours: 0,
    idleHours: 0,
    standbyHours: 0,
    downtimeHours: 0,
    travelHours: 0,
  };
  let anyAvailable = false;
  for (const d of days) {
    if (d.hours.availableHours !== null) {
      anyAvailable = true;
      totals.availableHours = (totals.availableHours ?? 0) + d.hours.availableHours;
    }
    for (const k of HOUR_KEYS) totals[k] += d.hours[k] || 0;
  }
  if (!anyAvailable) totals.availableHours = null;
  const window = computeUtilisation(totals);
  reasons.push(...window.reasons);

  const perDay = days.map((d) => ({
    date: d.date,
    idleReason: d.idleReason,
    result: computeUtilisation(d.hours),
    cost: computeHireCost({
      hireRateAmount: input.hireRateAmount,
      hireRateUnit: input.hireRateUnit,
      idleRateAmount: input.idleRateAmount,
      internalRateAmount: input.internalRateAmount ?? null,
      ownership: input.ownership,
      hours: d.hours,
    }),
  }));
  const isLow = (p: number | null): boolean => p !== null && p <= threshold;
  const lowDays = perDay.filter((d) => isLow(d.result.utilisationPercent)).length;

  let consecutiveLowDays = 0;
  for (let i = perDay.length - 1; i >= 0; i -= 1) {
    const entry = perDay[i]!;
    if (!isLow(entry.result.utilisationPercent)) break;
    consecutiveLowDays += 1;
  }
  const trailing = perDay.slice(perDay.length - consecutiveLowDays);
  const trailingCosts = trailing.map((d) => d.cost.amount);
  const idleCost = trailingCosts.every((c) => c !== null)
    ? round2((trailingCosts as number[]).reduce((s, c) => s + c, 0))
    : null;
  if (idleCost === null && consecutiveLowDays > 0) {
    const first = trailing.find((d) => d.cost.amount === null);
    reasons.push(
      ...(first?.cost.reasons ?? [
        "the standing cost of the idle run cannot be computed from the rates recorded",
      ]),
    );
  }
  const windowCosts = perDay.map((d) => d.cost.amount);
  const windowCost = windowCosts.every((c) => c !== null)
    ? round2((windowCosts as number[]).reduce((s, c) => s + c, 0))
    : null;

  const reasonCounts = new Map<string, number>();
  for (const d of trailing) {
    if (d.idleReason) reasonCounts.set(d.idleReason, (reasonCounts.get(d.idleReason) ?? 0) + 1);
  }
  const idleReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r]) => r);

  const onHire = (HIRED_OWNERSHIPS as readonly string[]).includes(input.ownership);
  if (!onHire) {
    reasons.push(
      `ownership is "${input.ownership}" — there is no hire to stop, so idle time here is a ` +
        "productivity question rather than an off-hire one",
    );
  }
  if (input.offHiredAt) {
    reasons.push(`already off-hired on ${input.offHiredAt} — the charge has stopped`);
  }
  if (days.length === 0) {
    reasons.push(
      "no utilisation was recorded for this machine in the window at all — that is itself worth " +
        "chasing, but it is not evidence of idleness",
    );
  }
  if (input.offHireRequestedAt && !input.offHiredAt) {
    reasons.push(
      `off-hire was requested on ${input.offHireRequestedAt} but the machine has not been ` +
        "collected — the charge runs until it is, and the request is the evidence for the credit",
    );
  }

  const isIdleOnHire =
    onHire &&
    !input.offHiredAt &&
    days.length > 0 &&
    consecutiveLowDays >= sustained;

  return {
    equipmentId: input.equipmentId,
    reference: input.reference,
    name: input.name,
    ownership: input.ownership,
    currency: input.currency,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    utilisationPercent: window.utilisationPercent,
    daysRecorded: days.length,
    lowDays,
    consecutiveLowDays,
    workingHours: round2(totals.workingHours),
    idleHours: round2(totals.idleHours + totals.standbyHours + totals.downtimeHours),
    idleCost,
    windowCost,
    isIdleOnHire,
    idleReasons,
    offHireRequestedAt: input.offHireRequestedAt,
    reasons,
  };
}

/**
 * Rank a fleet worst-first. Cost is compared only WITHIN a currency — a
 * £3,000 leak and a $3,000 leak are not comparable and are never added, so
 * machines are ordered by idle run length first and by cost only as a
 * tie-break inside the same currency.
 */
export function rankIdlePlant(rows: IdlePlantAssessment[]): IdlePlantAssessment[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.isIdleOnHire) - Number(a.isIdleOnHire) ||
      b.consecutiveLowDays - a.consecutiveLowDays ||
      (a.currency === b.currency ? (b.idleCost ?? 0) - (a.idleCost ?? 0) : 0) ||
      a.reference.localeCompare(b.reference),
  );
}

/** Idle cost bucketed by currency — never a single cross-currency total. */
export function idleCostByCurrency(rows: IdlePlantAssessment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.isIdleOnHire || r.idleCost === null) continue;
    out[r.currency] = round2((out[r.currency] ?? 0) + r.idleCost);
  }
  return out;
}

/** Inclusive day count of a window, for reporting. */
export function windowDays(from: IsoDate, to: IsoDate): number {
  return isoDaysBetween(from, to) + 1;
}
