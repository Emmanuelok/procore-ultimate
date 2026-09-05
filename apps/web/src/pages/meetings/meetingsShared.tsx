/**
 * Shared machinery for the MEETINGS workspace.
 *
 * The minutes are not the product. The ACTION ITEM is, and everything in this
 * workspace exists to give one a defensible provenance: which meeting, who was
 * in the room, whether there was a quorum, what was decided, and — when the
 * action discharges something a contract already required — the obligation it
 * was promoted into.
 *
 * FOUR THINGS THIS FILE MAKES IMPOSSIBLE TO LOOK AWAY FROM
 *
 *  1. CARRY COUNT. An item carried three times is a project failing to decide.
 *     The API exposes `carryCount` for exactly that reason, so `<CarryBadge>`
 *     escalates with it and never renders a carried item as a plain row.
 *  2. SLIPPAGE. Re-dating an action does not clear its overdue signal. The
 *     original date survives in `originalDueDate` and every move increments
 *     `revisedCount`, so `<DueDate>` prints the original alongside the current
 *     one — a moved date must never look clean.
 *  3. QUORUM AND THE OBJECTION WINDOW are reported, never inferred. Both come
 *     back as `{ value…, reasons[] }`-shaped facts with `null` for "this
 *     platform does not hold that", and both are printed with their reasons.
 *  4. A DECISION'S COST is an honest figure. "Flagged as cost-impacting but no
 *     estimate was recorded" is a null with a reason, not a zero — and money
 *     is never summed across decisions, because each decision carries its own
 *     currency and there is no rate on the record.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Tooltip } from "../../ui";
import { formatCurrency } from "../../ui";
import { cx } from "../../ui/cx";
import { IconHistory, IconWarning } from "../../ui/icons";
import { type Tone } from "../../ui/tokens";

/* ================================================================== */
/* Wire types                                                          */
/* ================================================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The platform-wide honest-figure shape. */
export interface Unknowable {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface MeetingSeries {
  id: string;
  projectId: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  meetingType: string;
  recurrence: string;
  recurrenceRule: string | null;
  dayOfWeek: number | null;
  startTime: string | null;
  durationMinutes: number | null;
  timezone: string | null;
  defaultLocation: string | null;
  defaultLocationId: string | null;
  isVirtual: number;
  meetingUrl: string | null;
  chairId: string | null;
  minuteTakerId: string | null;
  defaultAttendees: unknown[];
  agendaTemplate: unknown[];
  distribution: string[];
  contractRequirement: string | null;
  contractId: string | null;
  status: string;
  occurrenceCount: number;
  nextOccurrenceAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Meeting {
  id: string;
  seriesId: string | null;
  number: number;
  reference: string;
  occurrenceNumber: number | null;
  title: string;
  meetingType: string;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  location: string | null;
  isVirtual: number;
  meetingUrl: string | null;
  chairId: string | null;
  minuteTakerId: string | null;
  minutesBody: string | null;
  minutesFileId: string | null;
  minutesIssuedAt: string | null;
  minutesIssuedBy: string | null;
  objectionPeriodDays: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  distribution: string[];
  quorumRequired: number | null;
  quorumMet: number;
  attendeeCount: number;
  actionItemCount: number;
  openActionItemCount: number;
  previousMeetingId: string | null;
  cancelledReason: string | null;
  aiDrafted: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** `checkQuorum` — `met: null` when no quorum is required, with the reason. */
export interface QuorumResult {
  met: boolean | null;
  required: number | null;
  counted: number;
  present: number;
  apologies: number;
  absent: number;
  reasons: string[];
}

export interface MinutesWindow {
  closesAt: string | null;
  expired: boolean | null;
  objections: number;
  openObjections: number;
  deemedAccepted: boolean | null;
  reasons: string[];
}

export interface Attendee {
  id: string;
  meetingId: string;
  userId: string | null;
  contactId: string | null;
  vendorId: string | null;
  name: string;
  organisation: string | null;
  email: string | null;
  jobTitle: string | null;
  role: string;
  attendance: string;
  delegateName: string | null;
  delegateForUserId: string | null;
  apologiesReceivedAt: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  signedInAt: string | null;
  notes: string | null;
}

export interface AgendaItem {
  id: string;
  meetingId: string;
  seriesId: string | null;
  itemNumber: string | null;
  position: number;
  parentItemId: string | null;
  title: string;
  description: string | null;
  category: string;
  status: string;
  presenterId: string | null;
  allocatedMinutes: number | null;
  discussion: string | null;
  firstRaisedMeetingId: string | null;
  carriedFromItemId: string | null;
  carriedForwardToItemId: string | null;
  carryCount: number;
  originType: string | null;
  originId: string | null;
  closedAt: string | null;
  closedBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  meetingId: string;
  agendaItemId: string | null;
  number: number;
  reference: string;
  title: string;
  decision: string;
  rationale: string | null;
  decidedById: string | null;
  decidedByName: string | null;
  decisionDate: string | null;
  status: string;
  ratifiedBy: string | null;
  ratifiedAt: string | null;
  impactsCost: number;
  estimatedCostImpact: number | null;
  currency: string | null;
  impactsSchedule: number;
  estimatedScheduleImpactDays: number | null;
  resultingRecordType: string | null;
  resultingRecordId: string | null;
  supersedesDecisionId: string | null;
  supersededByDecisionId: string | null;
  disputedBy: string | null;
  disputedAt: string | null;
  disputeNote: string | null;
  createdBy: string;
  createdAt: string;
  /** Added by `withImpacts` on every response a decision appears in. */
  costImpact: Unknowable;
  scheduleImpact: Unknowable;
}

export interface ActionItem {
  id: string;
  meetingId: string | null;
  seriesId: string | null;
  agendaItemId: string | null;
  decisionId: string | null;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  category: string;
  status: string;
  priority: string;
  ownerId: string | null;
  ownerContactId: string | null;
  ownerVendorId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  sourceClause: string | null;
  obligorId: string | null;
  obligeeId: string | null;
  deadline: string | null;
  warnDaysBefore: number | null;
  evidenceRequirement: string | null;
  obligationId: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
  completedAt: string | null;
  completedBy: string | null;
  closureNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  carriedFromActionId: string | null;
  carryCount: number;
  /** The date it was FIRST due. Survives every re-dating. */
  originalDueDate: string | null;
  /** How many times the due date has been moved. */
  revisedCount: number;
  escalatedToId: string | null;
  escalatedAt: string | null;
  blockedReason: string | null;
  linkedRecordType: string | null;
  linkedRecordId: string | null;
  signalId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Present on list responses. */
  isOverdue?: boolean;
}

export interface ActionItemDetail extends ActionItem {
  obligation: {
    id: string;
    sourceClause: string;
    obligorId: string | null;
    obligeeId: string | null;
    trigger: string | null;
    deadline: string | null;
    warnDaysBefore: number | null;
    evidenceRequirement: string | null;
    status: string;
  } | null;
}

export interface MinutesObjection {
  id?: string;
  note?: string;
  raisedBy?: string;
  raisedAt?: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  [k: string]: unknown;
}

/** One recipient's copy of one issue of the minutes (#422, #425). */
export interface MinuteDelivery {
  id: string;
  minutesVersion: number;
  userId: string | null;
  contactId: string | null;
  recipientName: string;
  email: string | null;
  channel: string;
  status: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  failureReason: string | null;
  documentSha256: string | null;
}

export interface MeetingDetail extends Meeting {
  attendees: Attendee[];
  agendaItems: AgendaItem[];
  decisions: Decision[];
  actionItems: ActionItem[];
  quorum: QuorumResult;
  minutesObjectionWindow: MinutesWindow;
  /** live objections against the current issue — unresolved ones block sign-off */
  objections: MinutesObjection[];
  /** objections raised against versions that were withdrawn for correction */
  objectionHistory: unknown[];
  minutesDocument: {
    fileId: string;
    sha256: string | null;
    renderedAt: string | null;
    minutesVersion: number;
  } | null;
  agendaPack: { fileId: string; sha256: string | null } | null;
  deliveries: {
    items: MinuteDelivery[];
    total: number;
    delivered: number;
    acknowledged: number;
    failed: number;
  };
  carryForward: { carriedIn: number; maxCarryCount: number };
}

export interface SeriesDetail extends MeetingSeries {
  quorumRequired: number | null;
  occurrences: Meeting[];
  openActionItemCount: number;
}

export interface ActionsResponse extends Paginated<ActionItem> {
  /**
   * The job that keeps this list true, named by the API.
   *
   * The overdue sweep used to run as a side effect of this very read, which
   * meant a project nobody opened was never warned and the resulting signals
   * were ledgered against whoever happened to look — including read-only
   * members. The read is pure now; the scheduler does the work.
   */
  sweptBy: string;
}

export interface SeriesCarryForward {
  seriesId: string;
  seriesReference: string;
  seriesTitle: string;
  summary: {
    liveItems: number;
    carriedItems: number;
    maxCarryCount: number;
    averageCarryCount: number | null;
    reasons: string[];
  };
  items: Array<{
    id: string;
    title: string;
    category: string;
    status: string;
    carryCount: number;
    meetingId: string;
    firstRaisedMeetingId: string | null;
    carriedFromItemId: string | null;
  }>;
}

export interface ProjectCarryForward {
  summary: {
    liveItems: number;
    carriedItems: number;
    overThreshold: number;
    threshold: number;
  };
  bySeries: Array<{ seriesId: string | null; items: number; maxCarry: number }>;
  items: Array<{
    id: string;
    title: string;
    seriesId: string | null;
    meetingId: string;
    carryCount: number;
    firstRaisedMeetingId: string | null;
    status: string;
  }>;
}

export interface OverdueReport {
  asOf: string;
  sweep: { raised: number; scanned: number };
  summary: {
    openActions: number;
    overdue: number;
    promotedToObligations: number;
    unassigned: number;
    reasons: string[];
  };
  byOwner: Array<{ owner: string; count: number; worstDays: number }>;
  items: Array<{
    id: string;
    reference: string;
    title: string;
    status: string;
    priority: string;
    ownerId: string | null;
    ownerName: string | null;
    dueDate: string | null;
    originalDueDate: string | null;
    revisedCount: number;
    carryCount: number;
    meetingId: string | null;
    seriesId: string | null;
    signalId: string | null;
    obligationId: string | null;
  }>;
}

export interface GenerateResult {
  seriesId: string;
  count: number;
  created: Array<
    Meeting & { carriedForward: { carried: number; skipped: number; actionsCarried: number } }
  >;
}

export interface CarryForwardResult {
  meetingId: string;
  fromMeetingId: string;
  carried: number;
  skipped: number;
  actionsCarried: number;
  items: AgendaItem[];
}

export interface PromoteResult {
  actionItem: ActionItem;
  obligation: {
    id: string;
    sourceClause: string;
    trigger: string | null;
    deadline: string;
  };
  note: string;
}

/* ================================================================== */
/* Vocabulary                                                          */
/* ================================================================== */

export const MEETING_TYPES = [
  "owner_architect_contractor",
  "progress",
  "coordination",
  "subcontractor",
  "design",
  "safety",
  "commercial",
  "pre_construction",
  "kick_off",
  "pre_installation",
  "commissioning",
  "handover",
  "closeout",
  "board",
  "other",
] as const;

export const RECURRENCES = [
  "none",
  "daily",
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "custom",
] as const;

export const MEETING_STATUSES = [
  "scheduled",
  "in_progress",
  "held",
  "minutes_draft",
  "minutes_issued",
  "minutes_accepted",
  "cancelled",
] as const;

export const ATTENDANCE_STATES = [
  "present",
  "absent",
  "apologies",
  "late",
  "left_early",
  "delegate_attended",
  "remote",
] as const;

export const ATTENDEE_ROLES = [
  "chair",
  "minute_taker",
  "required",
  "optional",
  "presenter",
  "observer",
  "distribution_only",
] as const;

export const ITEM_CATEGORIES = [
  "safety",
  "quality",
  "progress",
  "programme",
  "design",
  "commercial",
  "procurement",
  "risk",
  "environmental",
  "logistics",
  "information",
  "other",
] as const;

export const AGENDA_STATUSES = [
  "open",
  "in_progress",
  "carried_forward",
  "deferred",
  "noted",
  "closed",
] as const;

export const ACTION_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "verified",
  "cancelled",
] as const;

export const ACTION_PRIORITIES = ["low", "medium", "high", "critical"] as const;

/** An item carried this many times has stopped being an agenda item. */
export const CARRY_THRESHOLD = 3;

export const MEETING_STATUS_TONE: Record<string, Tone> = {
  scheduled: "neutral",
  in_progress: "info",
  held: "info",
  minutes_draft: "warning",
  minutes_issued: "accent",
  minutes_accepted: "success",
  cancelled: "neutral",
};

export const SERIES_STATUS_TONE: Record<string, Tone> = {
  active: "success",
  paused: "warning",
  closed: "neutral",
};

export const AGENDA_STATUS_TONE: Record<string, Tone> = {
  open: "neutral",
  in_progress: "info",
  carried_forward: "warning",
  deferred: "warning",
  noted: "neutral",
  closed: "success",
};

export const ACTION_STATUS_TONE: Record<string, Tone> = {
  open: "neutral",
  in_progress: "info",
  blocked: "danger",
  completed: "accent",
  verified: "success",
  cancelled: "neutral",
};

export const PRIORITY_TONE: Record<string, Tone> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};

export const ATTENDANCE_TONE: Record<string, Tone> = {
  present: "success",
  remote: "success",
  late: "warning",
  left_early: "warning",
  delegate_attended: "info",
  apologies: "warning",
  absent: "danger",
};

export const DECISION_STATUS_TONE: Record<string, Tone> = {
  recorded: "info",
  ratified: "success",
  superseded: "neutral",
  rescinded: "neutral",
  disputed: "danger",
};

/** Attendance states that count towards a quorum (see recurrence.ts). */
export const QUORUM_COUNTING = new Set(["present", "late", "left_early", "remote", "delegate_attended"]);

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

export const EM_DASH = "—";

export function titleCase(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function count(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.floor(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000,
  );
}

/** Money in ONE currency, never summed with another. */
export function money(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return formatCurrency(value, { currency, precision: 2 });
}

/* ================================================================== */
/* Errors and refusals                                                 */
/* ================================================================== */

export interface Refusal {
  status: number;
  message: string;
  reasons: string[];
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

export function refusalFrom(err: unknown): Refusal {
  if (!(err instanceof ApiClientError)) {
    return {
      status: 0,
      message: err instanceof Error ? err.message : "The request failed.",
      reasons: [],
    };
  }
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const raw = detail["reasons"];
  return {
    status: err.status,
    message: err.message,
    reasons: Array.isArray(raw) ? raw.map((r) => String(r)) : [],
  };
}

/**
 * A refusal, printed verbatim. Every 403 out of this module is a segregation
 * control: the minute taker approving their own minutes, the person who made a
 * decision ratifying it, the person who completed an action verifying it. Each
 * one is the control working, and each one says so in its own sentence.
 */
export function RefusalPanel({
  refusal,
  title,
  onDismiss,
}: {
  refusal: Refusal | null;
  title?: string;
  onDismiss?: () => void;
}) {
  if (!refusal) return null;
  const segregation = refusal.status === 403;
  return (
    <Alert
      tone={segregation ? "warning" : "danger"}
      title={
        title ??
        (segregation
          ? "Segregation of duties — this control did its job"
          : refusal.status === 409
            ? "Refused: the record is already in that state"
            : refusal.status === 400
              ? "Refused: a precondition is not met"
              : "The server refused this")
      }
      {...(onDismiss ? { onDismiss } : {})}
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      <ReasonList reasons={refusal.reasons} className="mt-2" />
    </Alert>
  );
}

export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LoadError({
  message,
  onRetry,
  title = "This view could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

export function UnknowableValue({
  figure,
  render,
  className,
  showReasons = true,
}: {
  figure: Unknowable | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
  showReasons?: boolean;
}) {
  if (!figure) return <span className={className}>{EM_DASH}</span>;
  if (figure.value === null) {
    return (
      <span className={className}>
        <span className="italic text-content-subtle">not available</span>
        {showReasons && figure.reasons.length > 0 ? (
          <span className="mt-0.5 block text-2xs leading-snug text-content-subtle">
            {figure.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  return <span className={className}>{render(figure.value)}</span>;
}

/** A decision's money and time, side by side, each honest on its own terms. */
export function DecisionImpacts({ decision }: { decision: Decision }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <p className="text-label uppercase text-content-subtle">Cost impact</p>
        <div className="mt-0.5 text-sm font-semibold text-content">
          <UnknowableValue
            figure={decision.costImpact}
            render={(value) => (
              <span className="tabular-nums">{money(value, decision.currency)}</span>
            )}
          />
        </div>
      </div>
      <div>
        <p className="text-label uppercase text-content-subtle">Schedule impact</p>
        <div className="mt-0.5 text-sm font-semibold text-content">
          <UnknowableValue
            figure={decision.scheduleImpact}
            render={(value) => (
              <span className="tabular-nums">
                {value} day{value === 1 ? "" : "s"}
              </span>
            )}
          />
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* CARRY-FORWARD — surfaced hard                                       */
/* ================================================================== */

/**
 * The carry count, escalating.
 *
 * 0 renders nothing at all — a fresh item needs no chrome. From 1 it is a
 * visible chip; at the API's own threshold of 3 it goes solid red and says
 * what it means, because at that point the item has stopped being an agenda
 * item and become an undecided question.
 */
export function CarryBadge({
  carryCount,
  size = "xs",
}: {
  carryCount: number;
  size?: "xs" | "sm";
}) {
  if (carryCount <= 0) return null;
  const over = carryCount >= CARRY_THRESHOLD;
  return (
    <Tooltip
      content={
        over
          ? `Carried ${carryCount} times — it has appeared on ${carryCount + 1} consecutive occurrences without being closed. An item that survives this many meetings is not an agenda item, it is an undecided question: give it an owner and a date, escalate it, or record the decision not to decide it.`
          : `Carried forward ${carryCount} time${carryCount === 1 ? "" : "s"} from an earlier occurrence. The chain preserves where it was first raised.`
      }
    >
      <span>
        <Badge
          tone={over ? "danger" : carryCount === 2 ? "warning" : "neutral"}
          size={size}
          variant={over ? "solid" : "subtle"}
          icon={IconHistory}
        >
          Carried ×{carryCount}
        </Badge>
      </span>
    </Tooltip>
  );
}

/**
 * A due date that cannot be laundered.
 *
 * When an action has been re-dated, the original date is printed alongside the
 * current one with the number of moves. The API deliberately does not clear
 * the overdue signal when a date moves, and neither does this component clear
 * the visual: a moved date must not look clean.
 */
export function DueDate({
  dueDate,
  originalDueDate,
  revisedCount,
  overdue,
  className,
}: {
  dueDate: string | null;
  originalDueDate: string | null;
  revisedCount: number;
  overdue?: boolean;
  className?: string;
}) {
  const moved = revisedCount > 0 && originalDueDate !== null && originalDueDate !== dueDate;
  if (!dueDate) {
    return (
      <span className={cx("italic text-content-subtle", className)}>
        no date
        <span className="mt-0.5 block text-2xs">
          An action with no date cannot be overdue and cannot be promoted to an obligation.
        </span>
      </span>
    );
  }
  return (
    <span className={cx("min-w-0", className)}>
      <span
        className={cx(
          "tabular-nums",
          overdue ? "font-semibold text-danger-fg" : "text-content",
        )}
      >
        {isoDate(dueDate)}
      </span>
      {moved ? (
        <Tooltip
          content={`Originally due ${isoDate(originalDueDate)}. The date has been moved ${revisedCount} time${revisedCount === 1 ? "" : "s"}; the original survives in the record and the overdue signal raised against this action was never cleared by the move.`}
        >
          <span className="mt-0.5 block text-2xs text-warning-fg">
            was {isoDate(originalDueDate)} · moved ×{revisedCount}
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Says which job keeps this list true, and that the read itself wrote nothing. */
export function SweepNote({ sweptBy }: { sweptBy: string | undefined }) {
  if (!sweptBy) return null;
  return (
    <p className="text-2xs text-content-subtle">
      {sweptBy} A signal is keyed on the action, so however often the job runs it raises the same
      warning once and only once — and a promoted action is skipped, because its obligation owns
      the time bar from then on.
    </p>
  );
}

/** Quorum, reported rather than asserted. */
export function QuorumSummary({
  quorum,
  compact = false,
}: {
  quorum: QuorumResult;
  compact?: boolean;
}) {
  if (quorum.met === null) {
    return (
      <div className={compact ? "" : "rounded-lg border border-border bg-surface-raised p-3"}>
        <Badge tone="neutral" size="xs">
          Quorum not asserted
        </Badge>
        <ReasonList reasons={quorum.reasons} className="mt-1.5" />
      </div>
    );
  }
  const tone: Tone = quorum.met ? "success" : "danger";
  return (
    <div
      className={
        compact
          ? ""
          : cx(
              "rounded-lg border p-3",
              quorum.met ? "border-border bg-surface-raised" : "border-danger-border bg-danger-subtle",
            )
      }
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={tone} size="xs" variant={quorum.met ? "subtle" : "solid"} dot>
          {quorum.met ? "Quorum met" : "Quorum NOT met"}
        </Badge>
        <span className="text-meta text-content-muted">
          {count(quorum.counted)} counting of {count(quorum.required ?? 0)} required · present{" "}
          {count(quorum.present)} · apologies {count(quorum.apologies)} · absent{" "}
          {count(quorum.absent)}
        </span>
      </div>
      {!quorum.met && !compact ? (
        <p className="mt-1.5 text-meta text-content-muted">
          A decision taken without a quorum is still recorded — the platform does not delete it —
          but every decision minuted here carries whether the quorum was met at the moment it was
          made, because that is the first thing challenged later.
        </p>
      ) : null}
    </div>
  );
}

/** The objection window: silence with legal weight, never written as consent. */
export function ObjectionWindow({ window: w }: { window: MinutesWindow }) {
  if (w.closesAt === null) {
    return (
      <Alert tone="neutral" variant="subtle" size="sm" title="No objection period is running">
        <ReasonList reasons={w.reasons} />
      </Alert>
    );
  }
  const tone: Tone = w.openObjections > 0 ? "danger" : w.expired ? "success" : "warning";
  return (
    <Alert
      tone={tone}
      variant="subtle"
      size="sm"
      icon={w.openObjections > 0 ? IconWarning : undefined}
      title={
        w.openObjections > 0
          ? `${count(w.openObjections)} unresolved objection${w.openObjections === 1 ? "" : "s"} to these minutes`
          : w.expired
            ? "The objection period has closed"
            : `The objection period closes ${dateTime(w.closesAt)}`
      }
    >
      {w.deemedAccepted ? (
        <p>
          The period has run and no objection stands, so these minutes would be{" "}
          <strong>deemed accepted</strong> by anyone relying on silence. That is reported, not
          written: the status stays <em>minutes issued</em> until a person who neither wrote nor
          issued them signs them off, because silence has legal weight but it is not a signature.
        </p>
      ) : w.openObjections > 0 ? (
        <p>
          Objections must be settled — withdrawn, or accepted and the minutes corrected — before the
          minutes can be approved. An unresolved objection blocks sign-off.
        </p>
      ) : (
        <p>
          {count(w.objections)} objection{w.objections === 1 ? " has" : "s have"} been raised in
          total. Once the period closes, a disagreement has to be raised as a new agenda item at the
          next occurrence rather than by rewriting an accepted record.
        </p>
      )}
    </Alert>
  );
}

/* ================================================================== */
/* Data hooks                                                          */
/* ================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

export function useAction(): {
  busy: string | null;
  refusal: Refusal | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setRefusal(null);
    try {
      return await fn();
    } catch (err) {
      if (alive.current) setRefusal(refusalFrom(err));
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setRefusal(null), []);
  return { busy, refusal, clear, run };
}

const base = (projectId: string) => `/api/v1/projects/${projectId}`;

export function useSeries(projectId: string | undefined, version: number) {
  const path = useMemo(
    () =>
      projectId ? `${base(projectId)}/meeting-series?page=1&pageSize=200&_v=${version}` : null,
    [projectId, version],
  );
  return useResource<Paginated<MeetingSeries>>(path);
}

export function useSeriesDetail(
  projectId: string | undefined,
  seriesId: string | null,
  version: number,
) {
  const path = useMemo(
    () =>
      projectId && seriesId ? `${base(projectId)}/meeting-series/${seriesId}?_v=${version}` : null,
    [projectId, seriesId, version],
  );
  return useResource<SeriesDetail>(path);
}

export interface MeetingFilters {
  seriesId: string;
  status: string;
  meetingType: string;
}

export const EMPTY_MEETING_FILTERS: MeetingFilters = {
  seriesId: "",
  status: "",
  meetingType: "",
};

export function useMeetings(
  projectId: string | undefined,
  filters: MeetingFilters,
  version: number,
) {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200", _v: String(version) });
    if (filters.seriesId) params.set("seriesId", filters.seriesId);
    if (filters.status) params.set("status", filters.status);
    if (filters.meetingType) params.set("meetingType", filters.meetingType);
    return `${base(projectId)}/meetings?${params.toString()}`;
  }, [projectId, filters.seriesId, filters.status, filters.meetingType, version]);
  return useResource<Paginated<Meeting>>(path);
}

export function useMeetingDetail(
  projectId: string | undefined,
  meetingId: string | null,
  version: number,
) {
  const path = useMemo(
    () => (projectId && meetingId ? `${base(projectId)}/meetings/${meetingId}?_v=${version}` : null),
    [projectId, meetingId, version],
  );
  return useResource<MeetingDetail>(path);
}

export interface ActionFilters {
  status: string;
  priority: string;
  seriesId: string;
  overdue: string;
  promoted: string;
}

export const EMPTY_ACTION_FILTERS: ActionFilters = {
  status: "",
  priority: "",
  seriesId: "",
  overdue: "",
  promoted: "",
};

export function useActionItems(
  projectId: string | undefined,
  filters: ActionFilters,
  version: number,
) {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200", _v: String(version) });
    if (filters.status) params.set("status", filters.status);
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.seriesId) params.set("seriesId", filters.seriesId);
    if (filters.overdue) params.set("overdue", filters.overdue);
    if (filters.promoted) params.set("promoted", filters.promoted);
    return `${base(projectId)}/meeting-action-items?${params.toString()}`;
  }, [
    projectId,
    filters.status,
    filters.priority,
    filters.seriesId,
    filters.overdue,
    filters.promoted,
    version,
  ]);
  return useResource<ActionsResponse>(path);
}

export function useProjectCarryForward(projectId: string | undefined, version: number) {
  const path = useMemo(
    () => (projectId ? `${base(projectId)}/meeting-reports/carry-forward?_v=${version}` : null),
    [projectId, version],
  );
  return useResource<ProjectCarryForward>(path);
}

export function useSeriesCarryForward(
  projectId: string | undefined,
  seriesId: string | null,
  version: number,
) {
  const path = useMemo(
    () =>
      projectId && seriesId
        ? `${base(projectId)}/meeting-series/${seriesId}/carry-forward?_v=${version}`
        : null,
    [projectId, seriesId, version],
  );
  return useResource<SeriesCarryForward>(path);
}

export function useOverdueReport(projectId: string | undefined, version: number) {
  const path = useMemo(
    () => (projectId ? `${base(projectId)}/meeting-reports/overdue-actions?_v=${version}` : null),
    [projectId, version],
  );
  return useResource<OverdueReport>(path);
}
