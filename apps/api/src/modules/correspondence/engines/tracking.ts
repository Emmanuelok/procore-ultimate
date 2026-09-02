/**
 * RESPONSE TRACKING AND ACKNOWLEDGEMENT (spec #443, #446).
 *
 * Two questions this module exists to answer, both pure:
 *
 *   "Who owes whom an answer, and by when?"      → letter classification
 *   "Who has actually acknowledged receipt?"     → transmittal position
 *
 * Ball-in-court is derived, never stored: an outbound letter awaiting a
 * response is with the recipient; an inbound one is with us. Storing it would
 * mean two sources of truth for the same fact.
 */
import { daysBetween } from "./dates.js";

/* ------------------------------------------------------------------ */
/* Letters                                                             */
/* ------------------------------------------------------------------ */

export interface LetterInput {
  id: string;
  reference: string;
  typeKey: string;
  direction: string;
  status: string;
  priority: string;
  responseRequired: boolean;
  responseDueDate: string | null;
  respondedAt: string | null;
  issuedAt: string | null;
  letterDate: string | null;
  createdAt: string;
}

export type BallInCourt = "us" | "recipient" | "none";

export interface LetterAssessment {
  id: string;
  reference: string;
  /** open = issued or acknowledged and not yet responded/closed/void */
  open: boolean;
  awaitingResponse: boolean;
  dueInDays: number | null;
  daysOverdue: number | null;
  overdue: boolean;
  dueSoon: boolean;
  ballInCourt: BallInCourt;
  ageDays: number | null;
  /** days from issue to response, when both are known */
  responseDays: number | null;
}

export const OPEN_LETTER_STATUSES = ["issued", "acknowledged", "pending_approval"] as const;

const DUE_SOON_DAYS = 3;

export function assessLetter(letter: LetterInput, today: string): LetterAssessment {
  const open =
    letter.status === "issued" ||
    letter.status === "acknowledged" ||
    letter.status === "pending_approval";
  const awaitingResponse =
    letter.responseRequired &&
    letter.respondedAt === null &&
    (letter.status === "issued" || letter.status === "acknowledged");

  const dueInDays = awaitingResponse ? daysBetween(today, letter.responseDueDate) : null;
  const daysOverdue = dueInDays !== null && dueInDays < 0 ? -dueInDays : null;
  const anchor = letter.issuedAt ?? letter.letterDate ?? letter.createdAt;
  const ageDays = open || awaitingResponse ? daysBetween(anchor.slice(0, 10), today) : null;
  const responseDays =
    letter.respondedAt && letter.issuedAt
      ? daysBetween(letter.issuedAt.slice(0, 10), letter.respondedAt.slice(0, 10))
      : null;

  let ballInCourt: BallInCourt = "none";
  if (awaitingResponse) ballInCourt = letter.direction === "inbound" ? "us" : "recipient";
  else if (open && letter.direction === "inbound") ballInCourt = "us";

  return {
    id: letter.id,
    reference: letter.reference,
    open,
    awaitingResponse,
    dueInDays,
    daysOverdue,
    overdue: daysOverdue !== null && daysOverdue > 0,
    dueSoon: dueInDays !== null && dueInDays >= 0 && dueInDays <= DUE_SOON_DAYS,
    ballInCourt,
    ageDays,
    responseDays,
  };
}

export interface RegisterStats {
  total: number;
  byStatus: Record<string, number>;
  byDirection: Record<string, number>;
  byType: Record<string, number>;
  open: number;
  awaitingResponse: number;
  overdue: number;
  dueSoon: number;
  ballWithUs: number;
  ballWithRecipient: number;
  /** mean days from issue to response over answered letters; null when none */
  averageResponseDays: number | null;
  averageResponseBasis: string;
  oldestOpenDays: number | null;
}

export function registerStats(letters: readonly LetterInput[], today: string): RegisterStats {
  const byStatus: Record<string, number> = {};
  const byDirection: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let open = 0;
  let awaiting = 0;
  let overdue = 0;
  let dueSoon = 0;
  let ballUs = 0;
  let ballRecipient = 0;
  let oldestOpen: number | null = null;
  const responseDays: number[] = [];

  for (const letter of letters) {
    byStatus[letter.status] = (byStatus[letter.status] ?? 0) + 1;
    byDirection[letter.direction] = (byDirection[letter.direction] ?? 0) + 1;
    byType[letter.typeKey] = (byType[letter.typeKey] ?? 0) + 1;
    const a = assessLetter(letter, today);
    if (a.open) open += 1;
    if (a.awaitingResponse) awaiting += 1;
    if (a.overdue) overdue += 1;
    else if (a.dueSoon) dueSoon += 1;
    if (a.ballInCourt === "us") ballUs += 1;
    if (a.ballInCourt === "recipient") ballRecipient += 1;
    if (a.open && a.ageDays !== null && (oldestOpen === null || a.ageDays > oldestOpen)) {
      oldestOpen = a.ageDays;
    }
    if (a.responseDays !== null && a.responseDays >= 0) responseDays.push(a.responseDays);
  }

  const averageResponseDays =
    responseDays.length === 0
      ? null
      : Math.round((responseDays.reduce((x, y) => x + y, 0) / responseDays.length) * 10) / 10;

  return {
    total: letters.length,
    byStatus,
    byDirection,
    byType,
    open,
    awaitingResponse: awaiting,
    overdue,
    dueSoon,
    ballWithUs: ballUs,
    ballWithRecipient: ballRecipient,
    averageResponseDays,
    averageResponseBasis:
      responseDays.length === 0
        ? "No letter in this register has both an issue date and a recorded response, so there is no cycle time to average."
        : `Mean of ${responseDays.length} answered letter${responseDays.length === 1 ? "" : "s"}, measured from issue to response.`,
    oldestOpenDays: oldestOpen,
  };
}

/* ------------------------------------------------------------------ */
/* Acknowledgement (#443)                                              */
/* ------------------------------------------------------------------ */

export interface RecipientInput {
  id: string;
  name: string;
  kind: string;
  acknowledgementRequired: boolean;
  acknowledgedAt: string | null;
  firstReadAt: string | null;
  deliveryStatus: string;
}

export interface AckPosition {
  recipients: number;
  required: number;
  acknowledged: number;
  outstanding: number;
  read: number;
  bounced: number;
  /** null when nobody was asked to acknowledge — not 0%, not 100% */
  percent: number | null;
  reasons: string[];
  overdue: boolean;
  daysOverdue: number | null;
  outstandingNames: string[];
}

export function ackPosition(
  recipients: readonly RecipientInput[],
  ackDueDate: string | null,
  today: string,
): AckPosition {
  const required = recipients.filter((r) => r.acknowledgementRequired);
  const acknowledged = required.filter((r) => r.acknowledgedAt !== null);
  const read = recipients.filter((r) => r.firstReadAt !== null).length;
  const bounced = recipients.filter(
    (r) => r.deliveryStatus === "bounced" || r.deliveryStatus === "failed",
  ).length;
  const reasons: string[] = [];
  let percent: number | null = null;
  if (required.length === 0) {
    reasons.push(
      "No recipient on this transmittal was asked to acknowledge receipt, so there is no acknowledgement rate to report.",
    );
  } else {
    percent = Math.round((acknowledged.length / required.length) * 1000) / 10;
  }
  if (bounced > 0) {
    reasons.push(
      `${bounced} recipient${bounced === 1 ? "" : "s"} could not be reached (bounced or failed); their silence is not evidence of receipt.`,
    );
  }
  const days = daysBetween(ackDueDate, today);
  const outstanding = required.filter((r) => r.acknowledgedAt === null);
  const overdue = outstanding.length > 0 && days !== null && days > 0;

  return {
    recipients: recipients.length,
    required: required.length,
    acknowledged: acknowledged.length,
    outstanding: outstanding.length,
    read,
    bounced,
    percent,
    reasons,
    overdue,
    daysOverdue: overdue ? days : null,
    outstandingNames: outstanding.map((r) => r.name),
  };
}

/**
 * The status an issued transmittal should carry, given its recipients. Draft,
 * closed and void are human decisions and are never overwritten.
 */
export function deriveTransmittalStatus(
  current: string,
  position: AckPosition,
): "draft" | "issued" | "partially_acknowledged" | "acknowledged" | "closed" | "void" {
  if (current === "draft" || current === "closed" || current === "void") {
    return current as "draft" | "closed" | "void";
  }
  if (position.required === 0) return "issued";
  if (position.acknowledged === 0) return "issued";
  if (position.acknowledged >= position.required) return "acknowledged";
  return "partially_acknowledged";
}
