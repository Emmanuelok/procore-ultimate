/**
 * Prolongation cost seed (spec Domain D #299-301) — pure.
 *
 * Prolongation = compensable delay days × time-related preliminaries rate.
 * The rate is either given explicitly or derived from commercial data: the
 * project's prelims_time BQ items summed and spread over the programme
 * duration (#299 "time-related preliminaries"). Head-office overhead formulae
 * (#301 Hudson/Emden/Eichleay) are deliberately out of this seed's scope.
 */

export interface ProlongationInput {
  compensableDays: number;
  /** explicit daily rate — wins over derivation when provided */
  prelimsRatePerDay?: number | null;
  /** sum of prelims_time BQ item amounts across the project's BoQs */
  prelimsTimeTotal?: number | null;
  /** programme duration in days used to spread the prelims total */
  scheduleDurationDays?: number | null;
}

export type ProlongationResult =
  | {
      ok: true;
      compensableDays: number;
      prelimsRatePerDay: number;
      amount: number;
      derivation: string;
    }
  | { ok: false; reason: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeProlongation(input: ProlongationInput): ProlongationResult {
  const { compensableDays } = input;
  if (!Number.isFinite(compensableDays) || compensableDays < 0) {
    return { ok: false, reason: "compensableDays must be a non-negative number" };
  }

  if (input.prelimsRatePerDay != null) {
    const rate = input.prelimsRatePerDay;
    return {
      ok: true,
      compensableDays,
      prelimsRatePerDay: round2(rate),
      amount: round2(compensableDays * rate),
      derivation: "explicit prelimsRatePerDay supplied",
    };
  }

  const total = input.prelimsTimeTotal;
  const duration = input.scheduleDurationDays;
  if (total == null || total <= 0) {
    return {
      ok: false,
      reason:
        "prelimsRatePerDay was not given and no prelims_time BQ items exist to derive it from — " +
        "provide a rate or price time-related preliminaries in the BoQ",
    };
  }
  if (duration == null || duration <= 0) {
    return {
      ok: false,
      reason:
        "prelimsRatePerDay was not given and the programme duration is unknown — " +
        "provide a rate or compute the active schedule first",
    };
  }

  const rate = total / duration;
  return {
    ok: true,
    compensableDays,
    prelimsRatePerDay: round2(rate),
    amount: round2(compensableDays * rate),
    derivation:
      `derived: prelims_time BQ items totalling ${round2(total)} spread over ` +
      `${duration} programme days = ${round2(rate)}/day`,
  };
}
