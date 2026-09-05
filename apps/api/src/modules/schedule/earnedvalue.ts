/**
 * Earned value over a programme (spec Vol I §2.6 / #363-369) — pure.
 *
 * PV / EV / AC are computed activity by activity from a budget at completion
 * (BAC) per activity and the activity's planned dates, percent complete and
 * booked cost:
 *
 *   PV (planned value)  = Σ BAC × plannedFraction(dataDate)
 *   EV (earned value)   = Σ BAC × percentComplete/100
 *   AC (actual cost)    = Σ booked cost (from resources, or the budget line)
 *   SV = EV − PV,  SPI = EV / PV,  CV = EV − AC,  CPI = EV / AC
 *   EAC = BAC / CPI  (cost-performance EAC)
 *   Schedule EAC (time) = plannedDuration / SPI, reported in days
 *
 * plannedFraction is the linear share of an activity's baseline (or planned)
 * duration that lies on or before the data date. Linear spread is stated, not
 * hidden: an S-curve would be a fabrication unless the platform actually
 * holds a spread curve, and it does not.
 *
 * HONESTY RULES enforced here:
 *  - an activity with no cost basis contributes to NOTHING (it is counted in
 *    `unpriced` and named in `reasons`), it is never treated as zero;
 *  - SPI/CPI are null when their denominator is 0, never Infinity or 1;
 *  - currencies are never mixed: the caller passes one currency's worth of
 *    activities, and the result carries that currency.
 */

export interface EvActivity {
  id: string;
  name: string;
  /** budget at completion for this activity, in the schedule's currency */
  bac: number | null;
  /** cost booked against the activity to date */
  actualCost: number | null;
  percentComplete: number;
  /** baseline (preferred) or current planned dates */
  plannedStart: string | null;
  plannedFinish: string | null;
  /** working duration used when the planned dates are missing */
  durationDays: number;
  isCritical?: boolean;
}

export interface EvInput {
  dataDate: string;
  currency: string;
  activities: EvActivity[];
}

export interface EvActivityResult {
  id: string;
  name: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  plannedFraction: number;
}

export interface EvResult {
  dataDate: string;
  currency: string;
  bac: number;
  pv: number;
  ev: number;
  ac: number;
  sv: number;
  cv: number;
  /** null when PV is 0 — a ratio against nothing is not 1 */
  spi: number | null;
  cpi: number | null;
  /** BAC / CPI; null when CPI is null */
  eac: number | null;
  /** EAC − AC */
  etc: number | null;
  /** BAC − EAC; negative is an overrun */
  vac: number | null;
  /** planned programme days ÷ SPI */
  scheduleEacDays: number | null;
  plannedDurationDays: number | null;
  activities: EvActivityResult[];
  /** activities excluded for want of a cost basis */
  unpriced: number;
  pricedActivities: number;
  reasons: string[];
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function dayOf(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

/** Linear share of [start, finish] that has elapsed by `asOf` (inclusive days). */
export function plannedFraction(
  start: string | null,
  finish: string | null,
  durationDays: number,
  asOf: string,
): number | null {
  if (!start) return null;
  const s = dayOf(start);
  const f = finish ? dayOf(finish) : s + Math.max(0, durationDays - 1);
  const a = dayOf(asOf);
  const span = Math.max(1, f - s + 1);
  if (a < s) return 0;
  if (a >= f) return 1;
  return round4((a - s + 1) / span);
}

export function computeEarnedValue(input: EvInput): EvResult {
  const reasons: string[] = [];
  const activities: EvActivityResult[] = [];
  let bac = 0;
  let pv = 0;
  let ev = 0;
  let ac = 0;
  let unpriced = 0;
  let noDates = 0;

  for (const a of input.activities) {
    if (a.bac === null || !Number.isFinite(a.bac) || a.bac <= 0) {
      unpriced += 1;
      continue;
    }
    const fraction = plannedFraction(a.plannedStart, a.plannedFinish, a.durationDays, input.dataDate);
    if (fraction === null) noDates += 1;
    const f = fraction ?? 0;
    const pct = Math.min(100, Math.max(0, a.percentComplete)) / 100;
    const aPv = a.bac * f;
    const aEv = a.bac * pct;
    const aAc = a.actualCost ?? 0;
    bac += a.bac;
    pv += aPv;
    ev += aEv;
    ac += aAc;
    activities.push({
      id: a.id,
      name: a.name,
      bac: round2(a.bac),
      pv: round2(aPv),
      ev: round2(aEv),
      ac: round2(aAc),
      sv: round2(aEv - aPv),
      cv: round2(aEv - aAc),
      plannedFraction: round4(f),
    });
  }

  if (unpriced > 0) {
    reasons.push(
      `${unpriced} activit${unpriced === 1 ? "y is" : "ies are"} excluded — no budget line, budgeted cost or resource cost is mapped to them`,
    );
  }
  if (noDates > 0) {
    reasons.push(`${noDates} priced activit${noDates === 1 ? "y has" : "ies have"} no planned start — planned value counted as 0 for ${noDates === 1 ? "it" : "them"}`);
  }
  if (activities.length === 0) {
    reasons.push("No activity carries a cost basis — earned value is not available for this schedule");
  }

  const spi = pv > 0 ? round4(ev / pv) : null;
  const cpi = ac > 0 ? round4(ev / ac) : null;
  const eac = cpi !== null && cpi > 0 ? round2(bac / cpi) : null;

  const starts = input.activities.map((a) => a.plannedStart).filter((d): d is string => d !== null);
  const finishes = input.activities.map((a) => a.plannedFinish).filter((d): d is string => d !== null);
  const plannedDurationDays =
    starts.length > 0 && finishes.length > 0
      ? dayOf(finishes.reduce((x, y) => (y > x ? y : x))) - dayOf(starts.reduce((x, y) => (y < x ? y : x))) + 1
      : null;

  return {
    dataDate: input.dataDate,
    currency: input.currency,
    bac: round2(bac),
    pv: round2(pv),
    ev: round2(ev),
    ac: round2(ac),
    sv: round2(ev - pv),
    cv: round2(ev - ac),
    spi,
    cpi,
    eac,
    etc: eac !== null ? round2(eac - ac) : null,
    vac: eac !== null ? round2(bac - eac) : null,
    scheduleEacDays: spi !== null && spi > 0 && plannedDurationDays !== null ? Math.round(plannedDurationDays / spi) : null,
    plannedDurationDays,
    activities,
    unpriced,
    pricedActivities: activities.length,
    reasons,
  };
}
