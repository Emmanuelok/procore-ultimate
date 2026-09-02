import { epochMs } from "../../lib/time.js";
import { badRequest, conflict, forbidden } from "../../lib/errors.js";
import type { BidPackageRow, BidSubmissionRow } from "./shared.js";

/**
 * SEALED BIDDING IS A CONTROL, NOT A FLAG.
 *
 * `bid_packages.isSealed` is not a hint to the UI. While a package is sealed
 * and unopened, no endpoint on this platform returns a submitted amount —
 * not the submission detail, not the submission list, not the package
 * detail's rollups, not the levelling grid, not the tabulation report, not
 * the scoring endpoint. The withholding happens HERE, in one function, on the
 * way out of every read path, because a control implemented in nine places is
 * a control that is missing from the tenth.
 *
 * Three things must be true before the seal lifts:
 *
 *  1. THE TIME HAS PASSED. `sealedUntil` if set, otherwise `bidDueAt`. A
 *     package with neither cannot be opened at all: "the moment nobody could
 *     see a price before" has to be a moment.
 *  2. AN OPENER IS RECORDED. `openedBy` — a named person broke the seal.
 *  3. A WITNESS IS RECORDED, and is not the opener. A single person opening
 *     bids alone is exactly the arrangement the control exists to prevent.
 *     Waivable per package (`detail.requiresOpeningWitness = false`) because
 *     a two-bid plant hire enquiry is not a public works tender — but the
 *     waiver is a recorded decision, and the default is that a witness is
 *     required.
 *
 * The opening itself is a ledgered event carrying opener, witness, the time
 * the seal was due to lift, and the number of bids in the room.
 */

/** Money and money-derived fields withheld from a sealed, unopened bid. */
export const WITHHELD_SUBMISSION_FIELDS = [
  "baseBidAmount",
  "alternatesTotal",
  "allowancesTotal",
  "provisionalSumsTotal",
  "totalAmount",
  "normalisedAmount",
  "commercialScore",
  "technicalScore",
  "totalScore",
  "rank",
  "alternates",
  "valueEngineering",
  "bondsOffered",
] as const;

export interface SealState {
  /** the package was declared sealed at issue */
  isSealed: boolean;
  /** an opening has been recorded (opener + witness where required) */
  isOpened: boolean;
  /** the instant the seal is due to lift: sealedUntil ?? bidDueAt */
  opensAt: string | null;
  /** the time has passed, so a properly witnessed opening would be accepted */
  mayOpenNow: boolean;
  requiresWitness: boolean;
  openedAt: string | null;
  openedBy: string | null;
  witnessedBy: string | null;
  /** TRUE while submitted amounts must not leave the building */
  amountsWithheld: boolean;
  /** plain-English statement of the current position, always populated */
  note: string;
}

/** Does this package require a witness at the opening? Default: yes. */
export function requiresOpeningWitness(pkg: BidPackageRow): boolean {
  const detail = pkg.detail as Record<string, unknown>;
  return detail["requiresOpeningWitness"] === false ? false : true;
}

export function sealState(pkg: BidPackageRow, nowMs: number = Date.now()): SealState {
  const isSealed = pkg.isSealed === 1;
  const opensAt = pkg.sealedUntil ?? pkg.bidDueAt ?? null;
  const opensAtMs = epochMs(opensAt);
  const isOpened = Boolean(pkg.openedAt);
  const requiresWitness = requiresOpeningWitness(pkg);
  const mayOpenNow = opensAtMs !== null && nowMs >= opensAtMs;
  const amountsWithheld = isSealed && !isOpened;

  let note: string;
  if (!isSealed) {
    note = "This package is not sealed — submitted amounts are readable as they are recorded.";
  } else if (isOpened) {
    note =
      `Seal broken at ${pkg.openedAt} by ${pkg.openedBy}` +
      (pkg.witnessedBy ? `, witnessed by ${pkg.witnessedBy}` : "") +
      ". Submitted amounts are readable from that moment on.";
  } else if (!opensAt) {
    note =
      "This package is sealed but carries neither a bid due date nor a sealed-until time, so " +
      "there is no moment at which the seal may lift. Set bidDueAt (or sealedUntil) before " +
      "bids are taken — until then no amount can be read and no opening can be recorded.";
  } else if (!mayOpenNow) {
    note =
      `Sealed until ${opensAt}. Submitted amounts are withheld from every endpoint until an ` +
      `opening is recorded on or after that time` +
      (requiresWitness ? ", by an opener and a witness who are different people." : ".");
  } else {
    note =
      `The seal may now be lifted (due ${opensAt}), but no opening has been recorded yet. ` +
      "Amounts stay withheld until it is: an unopened bid is an unread bid.";
  }

  return {
    isSealed,
    isOpened,
    opensAt,
    mayOpenNow,
    requiresWitness,
    openedAt: pkg.openedAt ?? null,
    openedBy: pkg.openedBy ?? null,
    witnessedBy: pkg.witnessedBy ?? null,
    amountsWithheld,
    note,
  };
}

export interface SealedSubmissionView extends Record<string, unknown> {
  sealed: boolean;
  sealNote: string | null;
  withheldFields: string[];
}

/**
 * Strip every submitted figure from a submission row while the package is
 * sealed and unopened. The KEYS stay, valued null, so a client renders a
 * consistent shape and cannot mistake "withheld" for "zero"; `withheldFields`
 * says exactly what was removed and `sealNote` says why.
 */
export function redactSubmission(
  row: BidSubmissionRow & Record<string, unknown>,
  seal: SealState,
): SealedSubmissionView {
  if (!seal.amountsWithheld) {
    return { ...row, sealed: false, sealNote: null, withheldFields: [] };
  }
  const out: Record<string, unknown> = { ...row };
  for (const field of WITHHELD_SUBMISSION_FIELDS) {
    out[field] = Array.isArray(out[field]) ? [] : null;
  }
  const detail = { ...((row.detail as Record<string, unknown>) ?? {}) };
  delete detail["criterionScores"];
  delete detail["priceAnalysis"];
  out["detail"] = detail;
  // Priced lines carry rates; a rate is a price. They come back empty.
  out["lines"] = [];
  out["lineCount"] = row.lineCount;
  return {
    ...out,
    sealed: true,
    sealNote: seal.note,
    withheldFields: [...WITHHELD_SUBMISSION_FIELDS, "lines"],
  } as SealedSubmissionView;
}

/**
 * Refuse an operation that requires knowing what a bidder priced. Levelling,
 * scoring, tabulating and awarding all read amounts; none of them may run
 * against a package whose bids nobody has lawfully opened.
 */
export function assertUnsealedForAnalysis(pkg: BidPackageRow, what: string): void {
  const seal = sealState(pkg);
  if (!seal.amountsWithheld) return;
  throw conflict(
    `${what} requires reading submitted amounts, and this package is sealed. ${seal.note}`,
  );
}

export interface OpeningRequest {
  openerId: string;
  witnessId: string | null;
  note: string | null;
}

/**
 * Validate an attempt to break the seal. Throws with the reason; returns the
 * facts the caller should persist and ledger.
 */
export function assertOpeningPermitted(
  pkg: BidPackageRow,
  req: OpeningRequest,
  nowMs: number = Date.now(),
): { opensAt: string; witnessId: string | null; requiresWitness: boolean } {
  if (pkg.isSealed !== 1) {
    throw badRequest(
      "This package is not sealed, so there is no seal to break. An opening is recorded only " +
        "for sealed packages — recording one here would assert a control that was never applied.",
    );
  }
  if (pkg.openedAt) {
    throw conflict(
      `This package was already opened at ${pkg.openedAt} by ${pkg.openedBy}. A seal is broken ` +
        "once; a second opening would overwrite the record of the first.",
    );
  }
  const seal = sealState(pkg, nowMs);
  if (!seal.opensAt) {
    throw badRequest(
      "This sealed package has neither bidDueAt nor sealedUntil, so the moment the seal may " +
        "lift is undefined. Set the tender timetable before opening.",
    );
  }
  if (!seal.mayOpenNow) {
    throw forbidden(
      `Opening refused — the seal does not lift until ${seal.opensAt}. Opening a sealed ` +
        "package early is the procurement failure the seal exists to prevent: a price read " +
        "before the deadline can be passed to a competitor who has not yet bid.",
    );
  }
  const requiresWitness = requiresOpeningWitness(pkg);
  if (requiresWitness && !req.witnessId) {
    throw badRequest(
      "Opening refused — this package requires a witness and none was named. A sealed bid " +
        "opened by one person alone has no witness to the fact that the prices were not " +
        "altered between the deadline and the record. Name a witness, or record the decision " +
        "to waive one on the package before bids are invited.",
    );
  }
  if (req.witnessId && req.witnessId === req.openerId) {
    throw badRequest(
      "Opening refused — the witness may not be the person opening the bids. A witness who " +
        "is the opener witnesses nothing.",
    );
  }
  return { opensAt: seal.opensAt, witnessId: req.witnessId, requiresWitness };
}

/**
 * Lateness measured against the package deadline, in whole minutes, rounded
 * UP: a bid one second late is one minute late, never zero minutes late.
 */
export function computeLateness(
  bidDueAt: string | null,
  receivedAt: string,
): { isLate: boolean; lateByMinutes: number | null; reason: string | null } {
  const dueMs = epochMs(bidDueAt);
  const gotMs = epochMs(receivedAt);
  if (dueMs === null) {
    return {
      isLate: false,
      lateByMinutes: null,
      reason:
        "The package carries no bid due date, so lateness cannot be measured. A tender with " +
        "no deadline has no late bids and no fair ones either — set bidDueAt.",
    };
  }
  if (gotMs === null) {
    return { isLate: false, lateByMinutes: null, reason: "Receipt time could not be read." };
  }
  if (gotMs <= dueMs) return { isLate: false, lateByMinutes: null, reason: null };
  return {
    isLate: true,
    lateByMinutes: Math.ceil((gotMs - dueMs) / 60_000),
    reason: null,
  };
}

/**
 * A late bid is comparable only once somebody has taken responsibility for
 * accepting it, in writing. Silently letting one into the comparison is a
 * procurement integrity failure — it is how the last bidder to be told the
 * deadline wins.
 */
export function assertLateBidUsable(submission: BidSubmissionRow, what: string): void {
  if (submission.isLate !== 1) return;
  if (submission.lateAcceptedBy && submission.lateAcceptanceReason) return;
  throw conflict(
    `${what} refused — bid ${submission.reference} arrived ${submission.lateByMinutes ?? "?"} ` +
      "minute(s) after the deadline and no one has accepted it late. Record the acceptance " +
      "with a stated reason first, or leave it out of the comparison.",
  );
}
