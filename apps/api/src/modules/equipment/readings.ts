/**
 * M23 — meter and fuel anomaly detection. PURE.
 *
 * WHY READINGS ARE STORED ONE ROW PER READING and not as a running total on
 * the machine: fuel theft and meter tampering are only visible in the
 * DELTAS. A 400-litre fill on a machine with a 250-litre tank is an anomaly
 * that no aggregate would ever show, and a meter that goes backwards is
 * either a replaced ECU or somebody buying themselves hours.
 *
 * FLAG, DON'T DROP. Every check here returns a verdict; none of them refuse
 * the reading. A rejected reading is a reading nobody can audit, and the
 * anomalous ones are precisely the ones worth keeping. The route stores the
 * row with `isAnomalous = 1` and an `anomalyNote`, and raises a Signal.
 *
 * BOUNDARIES ARE INCLUSIVE OF THE LEGITIMATE CASE. Exactly 24 engine hours
 * in exactly one day is a machine that ran all day — real, and not flagged.
 * Exactly a tankful is a fill on an empty tank — real, and not flagged. Only
 * STRICTLY beyond the physical limit is an anomaly, because a detector that
 * cries at the boundary is a detector people switch off.
 */

import type { EquipmentReadingType, MeterType } from "@constructos/shared";

export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

const MS_PER_DAY = 86_400_000;

/** Physical ceilings per 24 hours, by what the meter counts. An engine
 *  cannot run more than 24 hours in a day; the distance ceilings are set
 *  well above any plausible plant or haulage duty so that only nonsense
 *  trips them. */
export const MAX_METER_PER_DAY: Record<MeterType, number | null> = {
  hours: 24,
  kilometres: 1600,
  miles: 1000,
  cycles: 10_000,
  none: null,
};

/** Float slack so 24.000000001 from a double is not an anomaly. */
const EPSILON = 1e-6;

export type MeterAnomalyKind =
  | "meter_regression"
  | "implausible_jump"
  | "fuel_exceeds_capacity"
  | "negative_value"
  | "future_reading";

export interface AnomalyCheckInput {
  readingType: EquipmentReadingType;
  value: number | null;
  readAt: string;
  /** the last reading of the SAME type on this machine, if there is one */
  previousValue: number | null;
  previousReadAt: string | null;
  meterType: MeterType;
  /** for fuel_fill rows: the litres put in */
  fuelLitres: number | null;
  fuelCapacityLitres: number | null;
  /** the instant the reading is being recorded at */
  nowIso: string;
}

export interface AnomalyResult {
  isAnomalous: boolean;
  /** every rule that fired, worst first */
  kinds: MeterAnomalyKind[];
  /** the single sentence that goes on the row and into the Signal */
  note: string | null;
  delta: number | null;
  /** implied rate per day against the previous reading of the same type */
  ratePerDay: number | null;
  elapsedDays: number | null;
  /** why a check could not be run — never a silent pass */
  reasons: string[];
}

/** Reading types that advance a cumulative meter and must never decrease. */
export const CUMULATIVE_READING_TYPES: readonly EquipmentReadingType[] = [
  "hours",
  "odometer",
  "cycles",
  "idle_hours",
];

/** Which meter ceiling applies to a cumulative reading type. */
function ceilingFor(readingType: EquipmentReadingType, meterType: MeterType): number | null {
  if (readingType === "hours" || readingType === "idle_hours") return MAX_METER_PER_DAY.hours;
  if (readingType === "cycles") return MAX_METER_PER_DAY.cycles;
  if (readingType === "odometer") return MAX_METER_PER_DAY[meterType] ?? MAX_METER_PER_DAY.kilometres;
  return null;
}

/**
 * Check one reading against the machine's history and its physical limits.
 *
 * Three rules that matter, in the order they cost money:
 *  1. `meter_regression` — the meter went BACKWARDS. Either the unit was
 *     replaced (say so, and record the swap) or somebody is reducing the
 *     hours a hire will be billed on.
 *  2. `implausible_jump` — more meter movement than the elapsed time can
 *     physically contain. 60 engine hours in a two-day gap is not a busy
 *     week, it is a typo or a second machine's meter.
 *  3. `fuel_exceeds_capacity` — a fill larger than the tank. The classic
 *     fuel-card fraud: the surplus went into something that is not this
 *     machine.
 */
export function detectReadingAnomaly(input: AnomalyCheckInput): AnomalyResult {
  const kinds: MeterAnomalyKind[] = [];
  const notes: string[] = [];
  const reasons: string[] = [];

  const elapsedMs =
    input.previousReadAt !== null ? Date.parse(input.readAt) - Date.parse(input.previousReadAt) : null;
  const elapsedDays =
    elapsedMs !== null && Number.isFinite(elapsedMs) ? round4(elapsedMs / MS_PER_DAY) : null;
  const delta =
    input.value !== null && input.previousValue !== null
      ? round4(input.value - input.previousValue)
      : null;

  /* future-dated */
  const readMs = Date.parse(input.readAt);
  const nowMs = Date.parse(input.nowIso);
  if (Number.isFinite(readMs) && Number.isFinite(nowMs) && readMs > nowMs) {
    kinds.push("future_reading");
    notes.push(`the reading is dated ${input.readAt}, which is in the future`);
  }

  /* negative absolute value on a cumulative meter */
  const isCumulative = CUMULATIVE_READING_TYPES.includes(input.readingType);
  if (isCumulative && input.value !== null && input.value < 0) {
    kinds.push("negative_value");
    notes.push(`a ${input.readingType} meter cannot read ${input.value}`);
  }

  /* nothing to compare against */
  if (isCumulative && input.previousValue === null) {
    reasons.push(
      `no earlier ${input.readingType} reading is held for this machine, so neither the ` +
        "regression check nor the jump check was run — this reading is the baseline the next one " +
        "will be measured against",
    );
  }

  /* regression */
  if (isCumulative && delta !== null && delta < 0) {
    kinds.push("meter_regression");
    notes.push(
      `the meter went backwards: ${input.previousValue} → ${input.value} ` +
        `(${round2(delta)}). Either the unit was replaced — record the swap — or the reading is wrong`,
    );
  }

  /* implausible jump */
  let ratePerDay: number | null = null;
  if (isCumulative && delta !== null && delta > 0) {
    const ceiling = ceilingFor(input.readingType, input.meterType);
    if (ceiling === null) {
      reasons.push(
        `no physical ceiling is defined for a ${input.readingType} reading on a ${input.meterType} ` +
          "meter, so the jump check was not run",
      );
    } else if (elapsedDays === null) {
      reasons.push(
        "no previous reading timestamp, so no rate could be computed and the jump check was not run",
      );
    } else if (elapsedDays <= 0) {
      // Two readings at the same instant (or out of order) give no window to
      // divide by. Flag the movement itself rather than dividing by zero.
      if (delta > EPSILON) {
        kinds.push("implausible_jump");
        notes.push(
          `${round2(delta)} ${input.readingType} of movement between two readings taken at the ` +
            `same instant (${input.readAt}) — no elapsed time can contain it`,
        );
      }
    } else {
      ratePerDay = round2(delta / elapsedDays);
      if (ratePerDay > ceiling + EPSILON) {
        kinds.push("implausible_jump");
        notes.push(
          `${round2(delta)} ${input.readingType} over ${round2(elapsedDays)} day(s) is ` +
            `${ratePerDay}/day against a physical ceiling of ${ceiling}/day`,
        );
      }
    }
  }

  /* fuel over tank capacity */
  if (input.readingType === "fuel_fill") {
    if (input.fuelLitres === null) {
      reasons.push("a fuel fill was recorded with no litres — there is nothing to check");
    } else if (input.fuelLitres < 0) {
      kinds.push("negative_value");
      notes.push(`a fuel fill cannot be ${input.fuelLitres} litres`);
    } else if (input.fuelCapacityLitres === null || input.fuelCapacityLitres <= 0) {
      reasons.push(
        "no tank capacity is recorded on this machine, so a fill larger than the tank cannot be " +
          "detected — record fuelCapacityLitres and this check starts working",
      );
    } else if (input.fuelLitres > input.fuelCapacityLitres + EPSILON) {
      kinds.push("fuel_exceeds_capacity");
      notes.push(
        `${input.fuelLitres} litres were put into a ${input.fuelCapacityLitres} litre tank — ` +
          `${round2(input.fuelLitres - input.fuelCapacityLitres)} litres went somewhere that is ` +
          "not this machine",
      );
    }
  }

  return {
    isAnomalous: kinds.length > 0,
    kinds,
    note: notes.length > 0 ? notes.join("; ") : null,
    delta,
    ratePerDay,
    elapsedDays,
    reasons,
  };
}

/** Severity for the Signal raised off an anomaly. A fill bigger than the
 *  tank and a meter running backwards both point at somebody, not at a
 *  fat finger; an implausible jump is usually a typo. */
export function anomalySeverity(kinds: MeterAnomalyKind[]): "medium" | "high" {
  return kinds.includes("fuel_exceeds_capacity") || kinds.includes("meter_regression")
    ? "high"
    : "medium";
}
