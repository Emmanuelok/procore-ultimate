/**
 * The calibration register's arithmetic (#1097).
 *
 * A reading taken with an out-of-calibration instrument is not a reading, and
 * the commissioning module already refuses to record a pass on one. That
 * refusal is only as good as the dates behind it, which is what this engine
 * governs: the due date is DERIVED from the last calibration and the interval
 * rather than typed in, so an instrument cannot quietly be given a due date
 * that its certificate does not support.
 *
 * The consequence that makes the register worth keeping: when an instrument
 * comes back from calibration marked "as found — out of tolerance", every
 * reading taken with it since its last pass is in doubt. `readingsInDoubt`
 * names that window rather than leaving somebody to work it out from paper.
 *
 * Pure and deterministic — the caller passes `asOf`.
 */

import type { InstrumentStatus } from "@constructos/shared";
import { addMonths, daysBetween } from "./weldStats.js";

export { addMonths, daysBetween };

export interface InstrumentLike {
  id: string;
  reference: string;
  name: string;
  serialNumber: string;
  lastCalibratedAt: string | null;
  calibrationDueDate: string | null;
  calibrationIntervalMonths: number;
  status: string;
  certificateFileId?: string | null;
  certificateNumber?: string | null;
}

export interface InstrumentStanding {
  status: InstrumentStatus;
  /** the due date as derived from the last calibration and the interval */
  derivedDueDate: string | null;
  daysUntilDue: number | null;
  usable: boolean;
  reasons: string[];
}

/** The due date the interval implies, or null when nothing implies one. */
export function derivedDueDate(instrument: InstrumentLike): string | null {
  if (!instrument.lastCalibratedAt) return null;
  if (!Number.isFinite(instrument.calibrationIntervalMonths)) return null;
  return addMonths(instrument.lastCalibratedAt, instrument.calibrationIntervalMonths);
}

/**
 * Where an instrument stands on `asOf`.
 *
 * `retired`, `lost`, `out_of_service` and `under_calibration` are decisions
 * and are reported as they stand; everything else is date arithmetic. An
 * instrument with no calibration record at all is NOT reported as in service:
 * it is `overdue`, because nothing shows it was ever calibrated.
 */
export function instrumentStanding(
  instrument: InstrumentLike,
  asOf: string,
  dueSoonDays = 30,
): InstrumentStanding {
  const reasons: string[] = [];
  const derived = derivedDueDate(instrument);
  const due = instrument.calibrationDueDate ?? derived;

  if (
    instrument.status === "retired" ||
    instrument.status === "lost" ||
    instrument.status === "out_of_service" ||
    instrument.status === "under_calibration"
  ) {
    reasons.push(
      `The instrument is recorded as ${instrument.status.replace(/_/g, " ")}; no reading may be taken with it until that changes.`,
    );
    return {
      status: instrument.status,
      derivedDueDate: derived,
      daysUntilDue: due ? daysBetween(asOf, due) : null,
      usable: false,
      reasons,
    };
  }

  if (derived && instrument.calibrationDueDate && instrument.calibrationDueDate > derived) {
    reasons.push(
      `The recorded due date ${instrument.calibrationDueDate} is later than the ${instrument.calibrationIntervalMonths}-month interval from the last calibration (${instrument.lastCalibratedAt}) allows, which would be ${derived}. The earlier date governs.`,
    );
  }
  const governing =
    derived && instrument.calibrationDueDate
      ? instrument.calibrationDueDate < derived
        ? instrument.calibrationDueDate
        : derived
      : due;

  if (!governing) {
    reasons.push(
      "No calibration date and no due date are held for this instrument, so it cannot be shown to be in calibration. Until a certificate is recorded it is treated as overdue rather than as in service.",
    );
    return {
      status: "overdue",
      derivedDueDate: derived,
      daysUntilDue: null,
      usable: false,
      reasons,
    };
  }

  const days = daysBetween(asOf, governing);
  if (days !== null && days < 0) {
    reasons.push(
      `Calibration ran out on ${governing}, ${Math.abs(days)} day(s) ago. Readings taken with it since then cannot be relied on.`,
    );
    return { status: "overdue", derivedDueDate: derived, daysUntilDue: days, usable: false, reasons };
  }
  if (days !== null && days <= dueSoonDays) {
    reasons.push(
      `Calibration runs out on ${governing}, in ${days} day(s). Book it before the tests that depend on it.`,
    );
    return { status: "due_soon", derivedDueDate: derived, daysUntilDue: days, usable: true, reasons };
  }
  if (!instrument.certificateFileId && !instrument.certificateNumber) {
    reasons.push(
      "No calibration certificate is recorded against the current calibration, so the traceability chain to a national standard is not evidenced.",
    );
  }
  return { status: "in_service", derivedDueDate: derived, daysUntilDue: days, usable: true, reasons };
}

export interface DoubtWindow {
  from: string | null;
  to: string;
  reasons: string[];
}

/**
 * The window of readings put in doubt by a calibration that came back out of
 * tolerance: everything between the previous PASSING calibration and this one.
 * Returns `from: null` with a reason when no earlier passing calibration is
 * held, because "everything ever measured with it" is a real answer and a
 * fabricated start date would be a worse one.
 */
export function readingsInDoubt(
  history: Array<{ calibratedAt: string; result: string }>,
  failedAt: string,
): DoubtWindow {
  const earlierPasses = history
    .filter((h) => h.calibratedAt < failedAt && (h.result === "pass" || h.result === "adjusted"))
    .sort((a, b) => (a.calibratedAt < b.calibratedAt ? 1 : -1));
  const last = earlierPasses[0];
  if (!last) {
    return {
      from: null,
      to: failedAt,
      reasons: [
        `No earlier passing calibration is recorded, so every reading taken with this instrument up to ${failedAt} is in doubt. Identify the tests that used it and decide which need repeating.`,
      ],
    };
  }
  return {
    from: last.calibratedAt,
    to: failedAt,
    reasons: [
      `The instrument last passed calibration on ${last.calibratedAt} and was found out of tolerance on ${failedAt}. Readings taken between those dates are in doubt.`,
    ],
  };
}
