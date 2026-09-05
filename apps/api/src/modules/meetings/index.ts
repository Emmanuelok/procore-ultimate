import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  changeEvents,
  companies,
  companyMemberships,
  contacts,
  files,
  meetingActionItems,
  meetingAgendaItems,
  meetingAgendaTemplates,
  meetingAttendees,
  meetingDecisions,
  meetingMinuteDeliveries,
  meetingSeries,
  meetings,
  obligations,
  projects,
  recordLinks,
  rfis,
  risks,
  signals,
  users,
} from "@constructos/db";
import {
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
  MEETING_AGENDA_ITEM_STATUSES,
  MEETING_ATTENDANCE_STATES,
  MEETING_ATTENDEE_ROLES,
  MEETING_ITEM_CATEGORIES,
  MEETING_RAISE_TARGETS,
  MEETING_DOCUMENT_KINDS,
  MEETING_RECURRENCES,
  MEETING_SERIES_STATUSES,
  MEETING_STATUSES,
  MEETING_TYPES,
  MINUTE_DELIVERY_CHANNELS,
  MINUTE_DELIVERY_STATUSES,
} from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import { resolveEmailTransport, type EmailTransport } from "../../lib/email.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  checkQuorum,
  planOccurrences,
  ruleForRecurrence,
  UnsupportedRecurrenceRule,
} from "./recurrence.js";
import {
  computeObjectionWindow,
  renderMeetingDocument,
  type MinutesAction,
  type MinutesAgendaItem,
  type MinutesAttendee,
  type MinutesDecision,
  type MinutesModel,
} from "./minutes.js";
import {
  companyScopeOf,
  companyToolGate,
  scopeAllows,
  scopeProjects,
  scopeProjectsOrCompanyWide,
} from "./scope.js";

/**
 * MEETINGS (M20, spec Vol I §2.9) — tool key `meetings`.
 *
 * The minutes are not the product. The ACTION ITEM is, and everything else
 * here exists to give one a defensible provenance: which meeting, which
 * agenda item, who was in the room, what was decided, and — when the action
 * discharges something a contract already required — the OBLIGATION it was
 * promoted into.
 *
 * Four ideas carry the module:
 *
 *  1. CARRY-FORWARD IS A CHAIN, NOT A FLAG. An unclosed item on occurrence N
 *     becomes a NEW row on N+1 with `carriedFromItemId` pointing back,
 *     `firstRaisedMeetingId` preserved from the original, and `carryCount`
 *     incremented. Five weeks of "ongoing" is then a number, not a feeling —
 *     and the number is exposed by its own report, because a count nobody can
 *     query shames nobody.
 *  2. PROMOTION IS A COPY, NOT A RE-KEYING. `meeting_action_items` carries the
 *     full Obligation column shape (ADR 0012), so `/promote` copies
 *     sourceClause / obligor / obligee / deadline / warnDaysBefore /
 *     evidenceRequirement into a real `obligations` row (assurance.ts) and
 *     records `obligationId`. It REFUSES to invent the two things an
 *     obligation cannot exist without — the clause it discharges and the date
 *     it bites — because a fabricated time bar is worse than no time bar.
 *  3. OVERDUE IS FOUND ON READ, NEVER BY A CRON. The list endpoints run an
 *     idempotent lazy sweep (the platform pattern: payments deemed liability,
 *     contract time bars, insurance expiry). A signal is keyed on the action
 *     id, so re-reading the list a hundred times raises it once. A PROMOTED
 *     action is skipped: the obligation owns its time bar from then on, and
 *     two systems warning about one deadline is how a warning gets ignored.
 *  4. SEGREGATION AT EVERY SIGN-OFF. Minutes are not approved by the person
 *     who wrote or issued them; a decision is not ratified by the person who
 *     made it; an action is not verified by the person who completed it.
 */

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const attendeeTemplateSchema = z.object({
  userId: z.string().max(64).nullable().optional(),
  contactId: z.string().max(64).nullable().optional(),
  vendorId: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(200),
  organisation: z.string().max(200).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  role: z.enum(MEETING_ATTENDEE_ROLES).optional(),
});

const agendaTemplateSchema = z.object({
  title: z.string().min(1).max(300),
  category: z.enum(MEETING_ITEM_CATEGORIES).optional(),
  position: z.number().int().min(0).max(1000).optional(),
  allocatedMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  itemNumber: z.string().max(20).nullable().optional(),
});

const seriesCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  meetingType: z.enum(MEETING_TYPES).optional(),
  recurrence: z.enum(MEETING_RECURRENCES).optional(),
  recurrenceRule: z.string().max(500).nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
    .nullable()
    .optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  defaultLocation: z.string().max(300).nullable().optional(),
  defaultLocationId: z.string().max(64).nullable().optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: z.string().max(1000).nullable().optional(),
  chairId: z.string().max(64).nullable().optional(),
  minuteTakerId: z.string().max(64).nullable().optional(),
  defaultAttendees: z.array(attendeeTemplateSchema).max(200).optional(),
  agendaTemplate: z.array(agendaTemplateSchema).max(200).optional(),
  distribution: z.array(z.string().max(64)).max(200).optional(),
  contractRequirement: z.string().max(300).nullable().optional(),
  contractId: z.string().max(64).nullable().optional(),
  /** decisions only bind when this many counting attendees are in the room */
  quorumRequired: z.number().int().min(1).max(200).nullable().optional(),
});

const seriesPatchSchema = seriesCreateSchema.partial().extend({
  status: z.enum(MEETING_SERIES_STATUSES).optional(),
});

const meetingCreateSchema = z.object({
  title: z.string().min(1).max(300),
  seriesId: z.string().max(64).nullable().optional(),
  meetingType: z.enum(MEETING_TYPES).optional(),
  scheduledStart: isoTimestamp.nullable().optional(),
  scheduledEnd: isoTimestamp.nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  isVirtual: z.boolean().optional(),
  meetingUrl: z.string().max(1000).nullable().optional(),
  chairId: z.string().max(64).nullable().optional(),
  minuteTakerId: z.string().max(64).nullable().optional(),
  distribution: z.array(z.string().max(64)).max(200).optional(),
  quorumRequired: z.number().int().min(1).max(200).nullable().optional(),
  objectionPeriodDays: z.number().int().min(0).max(90).nullable().optional(),
});

/*
 * NO `status` HERE, AND THAT IS THE POINT.
 *
 * Every meeting transition has a dedicated route that enforces something:
 * /hold settles quorum from the attendance, /minutes/issue stamps who issued
 * them, /minutes/approve refuses the minute taker and the issuer, /cancel
 * refuses an issued meeting. A generic PATCH that accepted `status` let a
 * standard user write `minutes_accepted` with no approver, no objection check
 * and no segregation — the audit control the module is built around,
 * circumvented by choosing a different URL. `minuteTakerId` and `chairId` are
 * accepted only while the minutes are still unwritten (see the route).
 */
const meetingPatchSchema = meetingCreateSchema.partial().extend({
  actualStart: isoTimestamp.nullable().optional(),
  actualEnd: isoTimestamp.nullable().optional(),
  agendaFileId: z.string().max(64).nullable().optional(),
  recordingFileId: z.string().max(64).nullable().optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(100).optional(),
});

const meetingsListQuery = pageQuerySchema.extend({
  seriesId: z.string().max(64).optional(),
  status: z.enum(MEETING_STATUSES).optional(),
  meetingType: z.enum(MEETING_TYPES).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

const attendeesCreateSchema = z.object({
  attendees: z.array(attendeeTemplateSchema).min(1).max(200),
});

const attendeePatchSchema = z.object({
  attendance: z.enum(MEETING_ATTENDANCE_STATES).optional(),
  role: z.enum(MEETING_ATTENDEE_ROLES).optional(),
  delegateName: z.string().max(200).nullable().optional(),
  delegateForUserId: z.string().max(64).nullable().optional(),
  joinedAt: isoTimestamp.nullable().optional(),
  leftAt: isoTimestamp.nullable().optional(),
  signedInAt: isoTimestamp.nullable().optional(),
  signatureFileId: z.string().max(64).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const agendaItemCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  category: z.enum(MEETING_ITEM_CATEGORIES).optional(),
  itemNumber: z.string().max(20).nullable().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  parentItemId: z.string().max(64).nullable().optional(),
  presenterId: z.string().max(64).nullable().optional(),
  allocatedMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  discussion: z.string().max(50_000).nullable().optional(),
  originType: z.string().max(60).nullable().optional(),
  originId: z.string().max(64).nullable().optional(),
  attachmentFileIds: z.array(z.string().max(64)).max(100).optional(),
});

const agendaItemPatchSchema = agendaItemCreateSchema.partial().extend({
  status: z.enum(MEETING_AGENDA_ITEM_STATUSES).optional(),
});

const decisionCreateSchema = z.object({
  title: z.string().min(1).max(300),
  decision: z.string().min(1).max(20_000),
  rationale: z.string().max(20_000).nullable().optional(),
  agendaItemId: z.string().max(64).nullable().optional(),
  decidedById: z.string().max(64).nullable().optional(),
  decidedByName: z.string().max(200).nullable().optional(),
  decisionDate: isoDateSchema.nullable().optional(),
  impactsCost: z.boolean().optional(),
  estimatedCostImpact: z.number().finite().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  impactsSchedule: z.boolean().optional(),
  estimatedScheduleImpactDays: z.number().finite().nullable().optional(),
  resultingRecordType: z.string().max(60).nullable().optional(),
  resultingRecordId: z.string().max(64).nullable().optional(),
});

const decisionPatchSchema = decisionCreateSchema.partial();

const actionCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  meetingId: z.string().max(64).nullable().optional(),
  agendaItemId: z.string().max(64).nullable().optional(),
  decisionId: z.string().max(64).nullable().optional(),
  category: z.enum(MEETING_ITEM_CATEGORIES).optional(),
  priority: z.enum(ACTION_ITEM_PRIORITIES).optional(),
  ownerId: z.string().max(64).nullable().optional(),
  ownerContactId: z.string().max(64).nullable().optional(),
  ownerVendorId: z.string().max(64).nullable().optional(),
  ownerName: z.string().max(200).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  /* Obligation shape, carried from the start so promotion is a copy */
  sourceClause: z.string().max(300).nullable().optional(),
  obligorId: z.string().max(64).nullable().optional(),
  obligeeId: z.string().max(64).nullable().optional(),
  deadline: isoTimestamp.nullable().optional(),
  warnDaysBefore: z.number().finite().min(0).max(365).nullable().optional(),
  evidenceRequirement: z.string().max(2000).nullable().optional(),
  linkedRecordType: z.string().max(60).nullable().optional(),
  linkedRecordId: z.string().max(64).nullable().optional(),
});

/*
 * Again no `status`: /complete records who completed it, /verify refuses that
 * same person, /cancel refuses a promoted action and /block refuses a
 * completed one. `PATCH { status: "verified" }` skipped all four and wrote no
 * state_change to the ledger, so an action could be certified as verified by
 * the person who did it, with nothing in the chain to show it.
 */
const actionPatchSchema = actionCreateSchema.partial();

/**
 * Once an action has been promoted, these columns are the obligation's terms,
 * copied here so the two rows tell one story. Editing them on the action
 * afterwards makes the action and the obligation disagree about what is owed,
 * to whom and by when — and the obligation is the one with the time bar.
 */
const PROMOTED_LOCKED_FIELDS = [
  "sourceClause",
  "obligorId",
  "obligeeId",
  "deadline",
  "warnDaysBefore",
  "evidenceRequirement",
] as const;

const actionsListQuery = pageQuerySchema.extend({
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
  ownerId: z.string().max(64).optional(),
  meetingId: z.string().max(64).optional(),
  seriesId: z.string().max(64).optional(),
  priority: z.enum(ACTION_ITEM_PRIORITIES).optional(),
  overdue: z.enum(["0", "1"]).optional(),
  promoted: z.enum(["0", "1"]).optional(),
});

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const OVERDUE_DETECTOR = "meeting_action_overdue";
const CARRY_DETECTOR = "meeting_item_carried_repeatedly";
/** An item carried this many times has stopped being an agenda item. */
const CARRY_SIGNAL_THRESHOLD = 3;
/** Agenda item states that do NOT carry forward. */
const CLOSED_ITEM_STATES = ["closed", "noted"] as const;
const OPEN_ACTION_STATES = ["open", "in_progress", "blocked"] as const;
/** A meeting can only be *held* from these — see the /hold route. */
const HOLDABLE_STATES = ["scheduled", "in_progress"] as const;
/** Action states from which cancel / block / escalate are meaningful. */
const CANCELLABLE_ACTION_STATES = ["open", "in_progress", "blocked"] as const;
const BLOCKABLE_ACTION_STATES = ["open", "in_progress"] as const;
/** How many days before the objection period closes the platform warns. */
const OBJECTION_WARN_DAYS = 2;
const OBJECTION_DETECTOR = "meeting_minutes_objection_closing";

/** Printed on read routes that used to sweep, so the change is visible. */
const SWEEP_NOTE =
  "scheduler job meetings.overdue-actions (system actor) — this read performs no writes";

/**
 * A list boundary the caller gave us. `from=2026-06-01` is a date, not an
 * instant; parsing it here (rather than in a post-filter) is what lets the
 * predicate go into the WHERE clause where pagination can see it.
 */
function parseBoundary(raw: string, which: "from" | "to"): string {
  const ms = Date.parse(raw.length === 10 ? `${raw}T${which === "from" ? "00:00:00" : "23:59:59"}.000Z` : raw);
  if (Number.isNaN(ms)) throw badRequest(`"${which}" is not a date or instant this platform can read`);
  return new Date(ms).toISOString();
}

export const meetingsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("meetings", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("meetings", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("meetings", "admin")];
  /*
   * One transport per app instance. `resolveEmailTransport` builds a NEW one
   * per call and the default records into memory, so calling it per request
   * would throw away the log the no-op transport exists to keep — and, under
   * test, make "was it sent?" unanswerable.
   */
  let transport: EmailTransport | null = null;
  const emailTransport = (): EmailTransport => {
    transport ??= resolveEmailTransport(app.appConfig);
    return transport;
  };

  const companyRead = [app.authenticate, app.requireCompany];
  /*
   * A route with no `:projectId` cannot be gated by `requireTool`, so the
   * company-level routes ran on [authenticate, requireCompany] alone — and
   * COMPANY_ROLES includes `guest`. Any company member could read every
   * project's overdue actions. `companyToolGate` resolves the caller's
   * visibility once and every handler filters by it (see scope.ts).
   */
  const companyScopedRead = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "meetings", "read"),
  ];
  const companyTemplateAdmin = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "meetings", "admin"),
  ];

  /* ---------------------------------------------------------------- */
  /* Fetchers + shared helpers                                         */
  /* ---------------------------------------------------------------- */

  async function fetchSeries(req: FastifyRequest, seriesId: string) {
    const rows = await app.db
      .select()
      .from(meetingSeries)
      .where(
        and(
          eq(meetingSeries.id, seriesId),
          eq(meetingSeries.companyId, req.companyId!),
          eq(meetingSeries.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Meeting series not found");
    return rows[0];
  }

  async function fetchMeeting(req: FastifyRequest, meetingId: string) {
    const rows = await app.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.companyId, req.companyId!),
          eq(meetings.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Meeting not found");
    return rows[0];
  }

  async function fetchAgendaItem(req: FastifyRequest, itemId: string) {
    const rows = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(
        and(
          eq(meetingAgendaItems.id, itemId),
          eq(meetingAgendaItems.companyId, req.companyId!),
          eq(meetingAgendaItems.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Agenda item not found");
    return rows[0];
  }

  async function fetchDecision(req: FastifyRequest, decisionId: string) {
    const rows = await app.db
      .select()
      .from(meetingDecisions)
      .where(
        and(
          eq(meetingDecisions.id, decisionId),
          eq(meetingDecisions.companyId, req.companyId!),
          eq(meetingDecisions.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Decision not found");
    return rows[0];
  }

  async function fetchAction(req: FastifyRequest, actionId: string) {
    const rows = await app.db
      .select()
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.id, actionId),
          eq(meetingActionItems.companyId, req.companyId!),
          eq(meetingActionItems.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Action item not found");
    return rows[0];
  }

  async function fetchAttendee(req: FastifyRequest, attendeeId: string) {
    const rows = await app.db
      .select()
      .from(meetingAttendees)
      .where(
        and(
          eq(meetingAttendees.id, attendeeId),
          eq(meetingAttendees.companyId, req.companyId!),
          eq(meetingAttendees.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Attendee not found");
    return rows[0];
  }

  function ledger(
    action: "create" | "update" | "delete" | "state_change",
    objectType: string,
    objectId: string,
    req: FastifyRequest,
    payload: unknown,
    storePayload = false,
  ) {
    return appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action,
      objectType,
      objectId,
      payload,
      storePayload,
      projectId: req.projectId ?? null,
    });
  }

  const detailOf = (row: { detail: Record<string, unknown> }): Record<string, unknown> =>
    (row.detail as Record<string, unknown> | null) ?? {};

  /**
   * A decision's money and time, never fabricated. A decision flagged as
   * cost-impacting whose estimate nobody recorded returns null with the
   * reason — the platform-wide shape (see modules/benchmarks/metrics.ts).
   */
  function decisionImpacts(row: typeof meetingDecisions.$inferSelect) {
    const costReasons: string[] = [];
    if (row.impactsCost !== 1) costReasons.push("This decision is not flagged as cost-impacting.");
    else if (row.estimatedCostImpact == null) {
      costReasons.push(
        "Flagged as cost-impacting, but no estimate was recorded — the figure is not held " +
          "and must not be inferred.",
      );
    }
    const scheduleReasons: string[] = [];
    if (row.impactsSchedule !== 1) {
      scheduleReasons.push("This decision is not flagged as schedule-impacting.");
    } else if (row.estimatedScheduleImpactDays == null) {
      scheduleReasons.push(
        "Flagged as schedule-impacting, but no day estimate was recorded — the figure is " +
          "not held and must not be inferred.",
      );
    }
    return {
      costImpact: {
        value: costReasons.length === 0 ? row.estimatedCostImpact : null,
        unit: row.currency ?? "unknown_currency",
        inputs: { impactsCost: row.impactsCost === 1, currency: row.currency },
        reasons: costReasons,
      },
      scheduleImpact: {
        value: scheduleReasons.length === 0 ? row.estimatedScheduleImpactDays : null,
        unit: "days",
        inputs: { impactsSchedule: row.impactsSchedule === 1 },
        reasons: scheduleReasons,
      },
    };
  }

  function withImpacts(row: typeof meetingDecisions.$inferSelect) {
    return { ...row, ...decisionImpacts(row) };
  }

  /**
   * The objection period, and whether silence has run its course.
   *
   * Delegated to a pure function (minutes.ts) so the arithmetic — including
   * the rule that the clock runs from DELIVERY when one is recorded and only
   * falls back to issue when it is not — is unit-tested without a database.
   */
  function minutesWindow(row: typeof meetings.$inferSelect) {
    const objections =
      (detailOf(row)["objections"] as Array<{ resolvedAt?: unknown }> | undefined) ?? [];
    return computeObjectionWindow({
      minutesIssuedAt: row.minutesIssuedAt,
      minutesDeliveredAt: row.minutesDeliveredAt,
      objectionPeriodDays: row.objectionPeriodDays,
      approvedAt: row.approvedAt,
      objections,
      nowMs: Date.now(),
    });
  }

  async function loadAttendees(meetingId: string) {
    return app.db
      .select()
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, meetingId))
      .orderBy(asc(meetingAttendees.name));
  }

  async function quorumFor(row: typeof meetings.$inferSelect) {
    const attendees = await loadAttendees(row.id);
    return checkQuorum(
      attendees.map((a) => ({ role: a.role, attendance: a.attendance })),
      row.quorumRequired,
    );
  }

  async function refreshMeetingCounts(meetingId: string) {
    const [attendeeRow] = await app.db
      .select({ n: count() })
      .from(meetingAttendees)
      .where(eq(meetingAttendees.meetingId, meetingId));
    const [actionRow] = await app.db
      .select({ n: count() })
      .from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, meetingId));
    const [openRow] = await app.db
      .select({ n: count() })
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.meetingId, meetingId),
          inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
        ),
      );
    await app.db
      .update(meetings)
      .set({
        attendeeCount: Number(attendeeRow?.n ?? 0),
        actionItemCount: Number(actionRow?.n ?? 0),
        openActionItemCount: Number(openRow?.n ?? 0),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(meetings.id, meetingId));
  }

  /**
   * Signal keys already raised for a detector in this company (idempotence).
   *
   * `candidateKeys` narrows the query to the keys actually being considered:
   * the previous version loaded every signal row for the detector into a Set
   * on every list read, which grows without bound. `signals` has no index on
   * (company_id, detector) and belongs to another package, so the honest fix
   * available here is to ask a bounded question.
   */
  async function alreadySignalled(
    companyId: string,
    detector: string,
    candidateKeys?: readonly string[],
  ): Promise<Set<string>> {
    if (candidateKeys && candidateKeys.length === 0) return new Set();
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          eq(signals.detector, detector),
          candidateKeys
            ? sql`${signals.evidenceRefs} ->> 'key' in ${candidateKeys}`
            : undefined,
        ),
      );
    const keys = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { key?: unknown } | null;
      if (typeof refs?.key === "string") keys.add(refs.key);
    }
    return keys;
  }

  /* ---------------------------------------------------------------- */
  /* THE OVERDUE SWEEP — now a scheduled job, not a read side effect   */
  /*                                                                   */
  /* It used to run on every action-item and report read. That was     */
  /* wrong twice over: a project nobody opened was never warned about  */
  /* (the deadline does not wait for a browser tab), and the ledger    */
  /* attributed the resulting signals to whoever happened to open the  */
  /* list — including read-only users and assurance grantees who hold  */
  /* no write permission at all. It now runs under the platform        */
  /* scheduler with a null (system) actor; reads are pure.             */
  /*                                                                   */
  /* Idempotent twice over — the signal is keyed on the action id AND  */
  /* the action row records `signalId`.                                */
  /* ---------------------------------------------------------------- */

  async function sweepOverdueActions(
    companyId: string,
    projectId: string | null,
    actorId: string | null,
  ): Promise<{ raised: number; scanned: number }> {
    const today = todayISO();
    const nowIso = new Date().toISOString();
    const candidates = await app.db
      .select()
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.companyId, companyId),
          projectId ? eq(meetingActionItems.projectId, projectId) : undefined,
          inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          isNull(meetingActionItems.signalId),
          // A promoted action's time bar belongs to its obligation now.
          isNull(meetingActionItems.obligationId),
          or(lt(meetingActionItems.dueDate, today), lt(meetingActionItems.deadline, nowIso)),
        ),
      );
    if (candidates.length === 0) return { raised: 0, scanned: 0 };

    const seen = await alreadySignalled(
      companyId,
      OVERDUE_DETECTOR,
      candidates.map((c) => c.id),
    );
    let raised = 0;
    for (const item of candidates) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const dueIso = item.deadline ?? (item.dueDate ? `${item.dueDate}T23:59:59.000Z` : null);
      const daysOverdue = dueIso
        ? Math.floor((Date.now() - Date.parse(dueIso)) / 86_400_000)
        : 0;
      const severity =
        item.priority === "critical" || daysOverdue >= 28
          ? "high"
          : item.priority === "high" || daysOverdue >= 14
            ? "medium"
            : "low";
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId: item.projectId,
        detector: OVERDUE_DETECTOR,
        severity,
        confidence: 1,
        title: `Action ${item.reference} is ${daysOverdue} day(s) overdue: ${item.title}`,
        explanation:
          `Action item ${item.reference} ("${item.title}") was due ${item.dueDate ?? dueIso} and ` +
          `is still ${item.status}. It was agreed in a meeting and its owner is ` +
          `${item.ownerName ?? item.ownerId ?? "unrecorded"}. An action that slips without being ` +
          `re-dated or closed is how a project loses the thread of what it agreed: either close ` +
          `it, re-date it (which is recorded as slippage), or promote it to an obligation so the ` +
          `time bar is enforced.`,
        evidenceRefs: {
          key: item.id,
          actionItemId: item.id,
          reference: item.reference,
          meetingId: item.meetingId,
          seriesId: item.seriesId,
          dueDate: item.dueDate,
          deadline: item.deadline,
          daysOverdue,
          carryCount: item.carryCount,
        },
      });
      await app.db
        .update(meetingActionItems)
        .set({ signalId, updatedAt: nowIso })
        .where(eq(meetingActionItems.id, item.id));
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "signal",
        objectId: signalId,
        payload: { detector: OVERDUE_DETECTOR, actionItemId: item.id, daysOverdue },
        projectId: item.projectId,
      });
      raised += 1;
    }
    return { raised, scanned: candidates.length };
  }

  /** Carried-too-often agenda items, keyed on the ROOT item so a chain signals once. */
  async function sweepCarriedItems(
    companyId: string,
    projectId: string | null,
    actorId: string | null,
  ): Promise<{ raised: number }> {
    const rows = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(
        and(
          eq(meetingAgendaItems.companyId, companyId),
          projectId ? eq(meetingAgendaItems.projectId, projectId) : undefined,
          isNull(meetingAgendaItems.carriedForwardToItemId),
          ne(meetingAgendaItems.status, "closed"),
          gte(meetingAgendaItems.carryCount, CARRY_SIGNAL_THRESHOLD),
        ),
      );
    const overCarried = rows.filter((r) => r.carryCount >= CARRY_SIGNAL_THRESHOLD);
    if (overCarried.length === 0) return { raised: 0 };
    const seen = await alreadySignalled(
      companyId,
      CARRY_DETECTOR,
      overCarried.map((i) => (detailOf(i)["rootItemId"] as string | undefined) ?? i.id),
    );
    let raised = 0;
    for (const item of overCarried) {
      const rootId = (detailOf(item)["rootItemId"] as string | undefined) ?? item.id;
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId: item.projectId,
        detector: CARRY_DETECTOR,
        severity: item.carryCount >= 6 ? "high" : "medium",
        confidence: 1,
        title: `Agenda item carried ${item.carryCount} times: ${item.title}`,
        explanation:
          `"${item.title}" has now appeared on ${item.carryCount + 1} consecutive occurrences ` +
          `without being closed. An item that survives this many meetings is not an agenda ` +
          `item, it is an undecided question: give it an owner and a date, escalate it, or ` +
          `record the decision not to decide it.`,
        evidenceRefs: {
          key: rootId,
          rootItemId: rootId,
          agendaItemId: item.id,
          meetingId: item.meetingId,
          seriesId: item.seriesId,
          carryCount: item.carryCount,
        },
      });
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "signal",
        objectId: signalId,
        payload: { detector: CARRY_DETECTOR, agendaItemId: item.id, carryCount: item.carryCount },
        projectId: item.projectId,
      });
      raised += 1;
    }
    return { raised };
  }

  /* ---------------------------------------------------------------- */
  /* CARRY-FORWARD                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Carry every unclosed agenda item from `fromMeetingId` into `toMeeting`.
   *
   * Idempotent: a source item that already has `carriedForwardToItemId` is
   * skipped, so re-running the carry (or generating the occurrence twice) can
   * never double an item or double a count. `firstRaisedMeetingId` is
   * PRESERVED down the chain — the whole point of the chain is being able to
   * say "this was first raised on 4 March and has been open ever since".
   */
  async function carryForwardInto(
    req: FastifyRequest,
    toMeeting: typeof meetings.$inferSelect,
    fromMeetingId: string,
  ): Promise<{ carried: number; skipped: number; actionsCarried: number }> {
    const sources = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(
        and(
          eq(meetingAgendaItems.meetingId, fromMeetingId),
          eq(meetingAgendaItems.companyId, req.companyId!),
        ),
      )
      .orderBy(asc(meetingAgendaItems.position));

    const [maxPosRow] = await app.db
      .select({ n: count() })
      .from(meetingAgendaItems)
      .where(eq(meetingAgendaItems.meetingId, toMeeting.id));
    let position = Number(maxPosRow?.n ?? 0);

    let carried = 0;
    let skipped = 0;
    let actionsCarried = 0;
    const now = new Date().toISOString();

    for (const source of sources) {
      if (CLOSED_ITEM_STATES.includes(source.status as (typeof CLOSED_ITEM_STATES)[number])) {
        skipped += 1;
        continue;
      }
      if (source.carriedForwardToItemId) {
        skipped += 1;
        continue;
      }
      const newItemId = newId("magi");
      const rootItemId = (detailOf(source)["rootItemId"] as string | undefined) ?? source.id;
      await app.db.insert(meetingAgendaItems).values({
        id: newItemId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId: toMeeting.id,
        seriesId: toMeeting.seriesId,
        itemNumber: source.itemNumber,
        position: position++,
        title: source.title,
        description: source.description,
        category: source.category,
        status: "open",
        presenterId: source.presenterId,
        allocatedMinutes: source.allocatedMinutes,
        firstRaisedMeetingId: source.firstRaisedMeetingId ?? source.meetingId,
        carriedFromItemId: source.id,
        carryCount: source.carryCount + 1,
        originType: source.originType,
        originId: source.originId,
        attachmentFileIds: source.attachmentFileIds,
        detail: { ...detailOf(source), rootItemId },
        createdBy: req.user!.id,
      });
      await app.db
        .update(meetingAgendaItems)
        .set({
          status: "carried_forward",
          carriedForwardToItemId: newItemId,
          detail: { ...detailOf(source), rootItemId },
          updatedAt: now,
        })
        .where(eq(meetingAgendaItems.id, source.id));
      await ledger("create", "meeting_agenda_item", newItemId, req, {
        carriedFromItemId: source.id,
        carryCount: source.carryCount + 1,
        firstRaisedMeetingId: source.firstRaisedMeetingId ?? source.meetingId,
        meetingId: toMeeting.id,
      });
      carried += 1;

      /*
       * Open actions hanging off the carried item are NOT duplicated — two
       * open rows for one promise is how an action gets closed twice and done
       * never. What does move is the count: "this action has now been
       * discussed at four meetings" is the fact worth surfacing, and
       * `detail.carriedInto` keeps the increment idempotent.
       */
      const actions = await app.db
        .select()
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.agendaItemId, source.id),
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          ),
        );
      for (const action of actions) {
        const carriedInto = (detailOf(action)["carriedInto"] as string[] | undefined) ?? [];
        if (carriedInto.includes(toMeeting.id)) continue;
        await app.db
          .update(meetingActionItems)
          .set({
            carryCount: action.carryCount + 1,
            detail: { ...detailOf(action), carriedInto: [...carriedInto, toMeeting.id] },
            updatedAt: now,
          })
          .where(eq(meetingActionItems.id, action.id));
        await ledger("update", "meeting_action_item", action.id, req, {
          carryCount: action.carryCount + 1,
          carriedIntoMeetingId: toMeeting.id,
        });
        actionsCarried += 1;
      }
    }
    return { carried, skipped, actionsCarried };
  }

  /**
   * APPLY THE SERIES STANDARDS TO ONE OCCURRENCE.
   *
   * Standing agenda first (so carried items land beneath it), then the
   * standing invitees as `absent` — nobody has attended a meeting that has
   * not happened yet — then the previous occurrence's unclosed items.
   *
   * Factored out of `generate-occurrences` because `POST /meetings` with a
   * seriesId did none of it: it copied the location and the quorum and left
   * the occurrence with no agenda, no roll and nothing carried, while the UI
   * told the user the opposite in as many words. A series whose standards
   * apply only when you press one particular button is not a series.
   */
  async function applySeriesStandards(
    req: FastifyRequest,
    meetingId: string,
    series: typeof meetingSeries.$inferSelect,
    previousMeetingId: string | null,
  ): Promise<{
    agendaItemsCreated: number;
    inviteesCreated: number;
    carriedForward: { carried: number; skipped: number; actionsCarried: number };
  }> {
    let agendaItemsCreated = 0;
    let position = 0;
    for (const raw of (series.agendaTemplate as unknown[]) ?? []) {
      const parsed = agendaTemplateSchema.safeParse(raw);
      if (!parsed.success) continue;
      await app.db.insert(meetingAgendaItems).values({
        id: newId("magi"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId,
        seriesId: series.id,
        itemNumber: parsed.data.itemNumber ?? null,
        position: parsed.data.position ?? position,
        title: parsed.data.title,
        category: parsed.data.category ?? "other",
        status: "open",
        allocatedMinutes: parsed.data.allocatedMinutes ?? null,
        firstRaisedMeetingId: meetingId,
        detail: { fromTemplate: true },
        createdBy: req.user!.id,
      });
      position += 1;
      agendaItemsCreated += 1;
    }

    let inviteesCreated = 0;
    for (const raw of (series.defaultAttendees as unknown[]) ?? []) {
      const parsed = attendeeTemplateSchema.safeParse(raw);
      if (!parsed.success) continue;
      await app.db.insert(meetingAttendees).values({
        id: newId("matt"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId,
        userId: parsed.data.userId ?? null,
        contactId: parsed.data.contactId ?? null,
        vendorId: parsed.data.vendorId ?? null,
        name: parsed.data.name,
        organisation: parsed.data.organisation ?? null,
        email: parsed.data.email ?? null,
        jobTitle: parsed.data.jobTitle ?? null,
        role: parsed.data.role ?? "required",
        attendance: "absent",
      });
      inviteesCreated += 1;
    }

    const [meetingRow] = await app.db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1);
    let carriedForward = { carried: 0, skipped: 0, actionsCarried: 0 };
    if (previousMeetingId && meetingRow) {
      carriedForward = await carryForwardInto(req, meetingRow, previousMeetingId);
    }
    await refreshMeetingCounts(meetingId);
    return { agendaItemsCreated, inviteesCreated, carriedForward };
  }

  /* ================================================================ */
  /* 1. Series                                                         */
  /* ================================================================ */

  app.post("/projects/:projectId/meeting-series", { preHandler: standardGate }, async (req, reply) => {
    const body = seriesCreateSchema.parse(req.body);
    if (body.recurrence === "custom" && !body.recurrenceRule) {
      throw badRequest("A custom recurrence needs a recurrenceRule (RFC 5545 RRULE)");
    }
    if (body.recurrenceRule) {
      try {
        ruleForRecurrence("custom", body.recurrenceRule, body.dayOfWeek ?? null);
      } catch (err) {
        throw badRequest(
          err instanceof UnsupportedRecurrenceRule
            ? err.message
            : "recurrenceRule could not be parsed",
        );
      }
    }
    const number = await nextRecordNumber(app.db, req.projectId!, "meeting_series");
    const id = newId("mser");
    await app.db.insert(meetingSeries).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      reference: `MS-${String(number).padStart(3, "0")}`,
      title: body.title,
      description: body.description ?? null,
      meetingType: body.meetingType ?? "progress",
      recurrence: body.recurrence ?? "weekly",
      recurrenceRule: body.recurrenceRule ?? null,
      dayOfWeek: body.dayOfWeek ?? null,
      startTime: body.startTime ?? null,
      durationMinutes: body.durationMinutes ?? null,
      timezone: body.timezone ?? null,
      defaultLocation: body.defaultLocation ?? null,
      defaultLocationId: body.defaultLocationId ?? null,
      isVirtual: body.isVirtual ? 1 : 0,
      meetingUrl: body.meetingUrl ?? null,
      chairId: body.chairId ?? null,
      minuteTakerId: body.minuteTakerId ?? null,
      defaultAttendees: body.defaultAttendees ?? [],
      agendaTemplate: body.agendaTemplate ?? [],
      distribution: body.distribution ?? [],
      contractRequirement: body.contractRequirement ?? null,
      contractId: body.contractId ?? null,
      status: "active",
      // meeting_series has no quorum column: the requirement is a property of
      // the series that every occurrence inherits, so it lives in detail and
      // is copied onto each meeting where it is actually checked.
      detail: body.quorumRequired != null ? { quorumRequired: body.quorumRequired } : {},
      createdBy: req.user!.id,
    });
    await ledger("create", "meeting_series", id, req, {
      title: body.title,
      recurrence: body.recurrence ?? "weekly",
      contractRequirement: body.contractRequirement ?? null,
    });
    const [row] = await app.db.select().from(meetingSeries).where(eq(meetingSeries.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/meeting-series", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        status: z.enum(MEETING_SERIES_STATUSES).optional(),
        meetingType: z.enum(MEETING_TYPES).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(meetingSeries.companyId, req.companyId!),
      eq(meetingSeries.projectId, req.projectId!),
      q.status ? eq(meetingSeries.status, q.status) : undefined,
      q.meetingType ? eq(meetingSeries.meetingType, q.meetingType) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetingSeries).where(where);
    const items = await app.db
      .select()
      .from(meetingSeries)
      .where(where)
      .orderBy(desc(meetingSeries.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/meeting-series/:seriesId", { preHandler: readGate }, async (req) => {
    const { seriesId } = req.params as { seriesId: string };
    const series = await fetchSeries(req, seriesId);
    const occurrences = await app.db
      .select()
      .from(meetings)
      .where(eq(meetings.seriesId, seriesId))
      .orderBy(asc(meetings.occurrenceNumber));
    const openActions = await app.db
      .select({ n: count() })
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.seriesId, seriesId),
          inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
        ),
      );
    return {
      ...series,
      quorumRequired: (detailOf(series)["quorumRequired"] as number | undefined) ?? null,
      occurrences,
      openActionItemCount: Number(openActions[0]?.n ?? 0),
    };
  });

  app.patch(
    "/projects/:projectId/meeting-series/:seriesId",
    { preHandler: standardGate },
    async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const body = seriesPatchSchema.parse(req.body);
      const series = await fetchSeries(req, seriesId);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (k === "quorumRequired") continue;
        if (k === "isVirtual") set[k] = v ? 1 : 0;
        else set[k] = v;
      }
      if (body.quorumRequired !== undefined) {
        set["detail"] = { ...detailOf(series), quorumRequired: body.quorumRequired };
      }
      await app.db.update(meetingSeries).set(set).where(eq(meetingSeries.id, seriesId));
      await ledger("update", "meeting_series", seriesId, req, { changed: Object.keys(body) });
      return fetchSeries(req, seriesId);
    },
  );

  /** Closing a series stops it generating occurrences; history stays readable. */
  app.post(
    "/projects/:projectId/meeting-series/:seriesId/close",
    { preHandler: adminGate },
    async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
      const series = await fetchSeries(req, seriesId);
      if (series.status === "closed") throw conflict("This series is already closed");
      const open = await app.db
        .select({ n: count() })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.seriesId, seriesId),
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          ),
        );
      const now = new Date().toISOString();
      await app.db
        .update(meetingSeries)
        .set({
          status: "closed",
          detail: { ...detailOf(series), closedReason: body.reason ?? null, closedAt: now },
          updatedAt: now,
        })
        .where(eq(meetingSeries.id, seriesId));
      await ledger("state_change", "meeting_series", seriesId, req, {
        from: series.status,
        to: "closed",
        reason: body.reason ?? null,
        openActionItemsLeftBehind: Number(open[0]?.n ?? 0),
      });
      return {
        ...(await fetchSeries(req, seriesId)),
        openActionItemsLeftBehind: Number(open[0]?.n ?? 0),
      };
    },
  );

  /**
   * Generate the next occurrences from the recurrence rule.
   *
   * Occurrences are created ONE AT A TIME in date order and each one carries
   * forward from the one before it, so generating three at once produces the
   * same carry chain as three weeks of clicking "hold meeting" would.
   */
  app.post(
    "/projects/:projectId/meeting-series/:seriesId/generate-occurrences",
    { preHandler: standardGate },
    async (req, reply) => {
      const { seriesId } = req.params as { seriesId: string };
      const body = z
        .object({
          count: z.number().int().min(1).max(52).default(1),
          from: isoDateSchema.optional(),
        })
        .parse(req.body ?? {});
      const series = await fetchSeries(req, seriesId);
      if (series.status !== "active") {
        throw badRequest(`A ${series.status} series does not generate occurrences`);
      }

      let rule;
      try {
        rule = ruleForRecurrence(
          series.recurrence as Parameters<typeof ruleForRecurrence>[0],
          series.recurrenceRule,
          series.dayOfWeek,
        );
      } catch (err) {
        throw badRequest(
          err instanceof UnsupportedRecurrenceRule ? err.message : "Unsupported recurrence",
        );
      }

      const existing = await app.db
        .select()
        .from(meetings)
        .where(eq(meetings.seriesId, seriesId))
        .orderBy(desc(meetings.occurrenceNumber));
      const last = existing[0] ?? null;
      const from =
        body.from ??
        (last?.scheduledStart
          ? new Date(Date.parse(last.scheduledStart) + 86_400_000).toISOString().slice(0, 10)
          : todayISO());

      const plans = planOccurrences({
        rule,
        from,
        count: body.count,
        startTime: series.startTime,
        durationMinutes: series.durationMinutes,
        timezone: series.timezone,
      });

      const created: unknown[] = [];
      let previousMeetingId = last?.id ?? null;
      let occurrenceNumber = (last?.occurrenceNumber ?? 0) + 1;
      const seriesDetail = detailOf(series);

      for (const plan of plans) {
        const number = await nextRecordNumber(app.db, req.projectId!, "meeting");
        const meetingId = newId("mtg");
        await app.db.insert(meetings).values({
          id: meetingId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          seriesId,
          number,
          reference: `MTG-${String(number).padStart(3, "0")}`,
          occurrenceNumber,
          title: `${series.title} No. ${occurrenceNumber}`,
          meetingType: series.meetingType,
          status: "scheduled",
          scheduledStart: plan.scheduledStart,
          scheduledEnd: plan.scheduledEnd,
          location: series.defaultLocation,
          locationId: series.defaultLocationId,
          isVirtual: series.isVirtual,
          meetingUrl: series.meetingUrl,
          chairId: series.chairId,
          minuteTakerId: series.minuteTakerId,
          distribution: series.distribution,
          quorumRequired: (seriesDetail["quorumRequired"] as number | undefined) ?? null,
          previousMeetingId,
          detail: { generatedFromSeries: true, occurrenceDate: plan.date },
          createdBy: req.user!.id,
        });
        await ledger("create", "meeting", meetingId, req, {
          seriesId,
          occurrenceNumber,
          scheduledStart: plan.scheduledStart,
          generated: true,
        });

        const applied = await applySeriesStandards(req, meetingId, series, previousMeetingId);
        const [finalRow] = await app.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .limit(1);
        created.push({ ...finalRow, ...applied });

        previousMeetingId = meetingId;
        occurrenceNumber += 1;
      }

      const now = new Date().toISOString();
      await app.db
        .update(meetingSeries)
        .set({
          occurrenceCount: existing.length + plans.length,
          // The NEXT occurrence is the earliest one still ahead of us, not
          // simply the last one generated — a batch generated into the past
          // must not advertise itself as upcoming.
          nextOccurrenceAt:
            plans.find((p) => Date.parse(p.scheduledStart) > Date.now())?.scheduledStart ??
            series.nextOccurrenceAt,
          updatedAt: now,
        })
        .where(eq(meetingSeries.id, seriesId));

      return reply.status(201).send({ seriesId, created, count: created.length });
    },
  );

  /* ================================================================ */
  /* 2. Occurrences                                                    */
  /* ================================================================ */

  app.post("/projects/:projectId/meetings", { preHandler: standardGate }, async (req, reply) => {
    const body = meetingCreateSchema.parse(req.body);
    let series: Awaited<ReturnType<typeof fetchSeries>> | null = null;
    if (body.seriesId) series = await fetchSeries(req, body.seriesId);

    const number = await nextRecordNumber(app.db, req.projectId!, "meeting");
    const id = newId("mtg");
    let occurrenceNumber: number | null = null;
    let previousMeetingId: string | null = null;
    if (series) {
      const existing = await app.db
        .select({ id: meetings.id, occurrenceNumber: meetings.occurrenceNumber })
        .from(meetings)
        .where(eq(meetings.seriesId, series.id))
        .orderBy(desc(meetings.occurrenceNumber));
      occurrenceNumber = (existing[0]?.occurrenceNumber ?? 0) + 1;
      previousMeetingId = existing[0]?.id ?? null;
    }
    await app.db.insert(meetings).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      seriesId: series?.id ?? null,
      number,
      reference: `MTG-${String(number).padStart(3, "0")}`,
      occurrenceNumber,
      title: body.title,
      meetingType: body.meetingType ?? series?.meetingType ?? "progress",
      status: "scheduled",
      scheduledStart: body.scheduledStart ?? null,
      scheduledEnd: body.scheduledEnd ?? null,
      location: body.location ?? series?.defaultLocation ?? null,
      locationId: body.locationId ?? series?.defaultLocationId ?? null,
      isVirtual: body.isVirtual ? 1 : (series?.isVirtual ?? 0),
      meetingUrl: body.meetingUrl ?? series?.meetingUrl ?? null,
      chairId: body.chairId ?? series?.chairId ?? null,
      minuteTakerId: body.minuteTakerId ?? series?.minuteTakerId ?? null,
      distribution: body.distribution ?? (series?.distribution as string[] | undefined) ?? [],
      quorumRequired:
        body.quorumRequired ??
        (series ? ((detailOf(series)["quorumRequired"] as number | undefined) ?? null) : null),
      objectionPeriodDays: body.objectionPeriodDays ?? null,
      previousMeetingId,
      createdBy: req.user!.id,
    });
    await ledger("create", "meeting", id, req, {
      title: body.title,
      seriesId: series?.id ?? null,
      occurrenceNumber,
    });
    // A meeting created into a series inherits the series' standards, exactly
    // as a generated occurrence does.
    const applied = series
      ? await applySeriesStandards(req, id, series, previousMeetingId)
      : null;
    const [row] = await app.db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
    return reply.status(201).send(applied ? { ...row, ...applied } : row);
  });

  app.get("/projects/:projectId/meetings", { preHandler: readGate }, async (req) => {
    const q = meetingsListQuery.parse(req.query);
    /*
     * The date filter belongs in the WHERE, not in a post-LIMIT array filter.
     * Filtering after pagination made `total` count rows the page had already
     * dropped: with 300 meetings and from=2026-06-01 the first page could come
     * back empty while total said 300, and the matching rows sat on page 4.
     */
    const from = q.from ? parseBoundary(q.from, "from") : null;
    const to = q.to ? parseBoundary(q.to, "to") : null;
    const where = and(
      eq(meetings.companyId, req.companyId!),
      eq(meetings.projectId, req.projectId!),
      q.seriesId ? eq(meetings.seriesId, q.seriesId) : undefined,
      q.status ? eq(meetings.status, q.status) : undefined,
      q.meetingType ? eq(meetings.meetingType, q.meetingType) : undefined,
      from ? gte(meetings.scheduledStart, from) : undefined,
      to ? lte(meetings.scheduledStart, to) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetings).where(where);
    const items = await app.db
      .select()
      .from(meetings)
      .where(where)
      .orderBy(desc(meetings.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/meetings/:meetingId", { preHandler: readGate }, async (req) => {
    const { meetingId } = req.params as { meetingId: string };
    const meeting = await fetchMeeting(req, meetingId);
    const attendees = await loadAttendees(meetingId);
    const agendaItems = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(eq(meetingAgendaItems.meetingId, meetingId))
      .orderBy(asc(meetingAgendaItems.position));
    const decisions = await app.db
      .select()
      .from(meetingDecisions)
      .where(eq(meetingDecisions.meetingId, meetingId))
      .orderBy(asc(meetingDecisions.number));
    const actionItems = await app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, meetingId))
      .orderBy(asc(meetingActionItems.number));
    return {
      ...meeting,
      attendees,
      agendaItems,
      decisions: decisions.map(withImpacts),
      actionItems,
      quorum: checkQuorum(
        attendees.map((a) => ({ role: a.role, attendance: a.attendance })),
        meeting.quorumRequired,
      ),
      minutesObjectionWindow: minutesWindow(meeting),
      carryForward: {
        carriedIn: agendaItems.filter((i) => i.carriedFromItemId != null).length,
        maxCarryCount: agendaItems.reduce((m, i) => Math.max(m, i.carryCount), 0),
      },
    };
  });

  app.patch("/projects/:projectId/meetings/:meetingId", { preHandler: standardGate }, async (req) => {
    const { meetingId } = req.params as { meetingId: string };
    const body = meetingPatchSchema.parse(req.body);
    const meeting = await fetchMeeting(req, meetingId);
    if (meeting.status === "cancelled") throw badRequest("A cancelled meeting cannot be edited");

    /*
     * The two identities the minutes approval rests on. `approve` refuses the
     * minute taker and the issuer; swapping the minute taker afterwards let
     * the author of the minutes sign off their own. Once the minutes exist,
     * these are historical facts, not settings.
     */
    const minutesExist = Boolean(meeting.minutesBody || meeting.minutesFileId || meeting.minutesIssuedAt);
    for (const key of ["minuteTakerId", "chairId"] as const) {
      const next = body[key];
      if (next === undefined || next === meeting[key]) continue;
      if (minutesExist) {
        throw conflict(
          `The ${key === "chairId" ? "chair" : "minute taker"} cannot be changed once minutes ` +
            "exist for this meeting: approval is refused to whoever wrote or issued them, so " +
            "reassigning the role after the fact would defeat that check. Correct the minutes " +
            "instead, or record the change as an agenda item at the next occurrence.",
        );
      }
    }

    const identityChanges: Record<string, unknown> = {};
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "seriesId") continue; // a meeting never changes series
      set[k] = k === "isVirtual" ? (v ? 1 : 0) : v;
      if (k === "minuteTakerId" || k === "chairId") {
        identityChanges[k] = { from: meeting[k as "minuteTakerId" | "chairId"], to: v };
      }
    }
    await app.db.update(meetings).set(set).where(eq(meetings.id, meetingId));
    await ledger("update", "meeting", meetingId, req, { changed: Object.keys(body) });
    if (Object.keys(identityChanges).length > 0) {
      // Who chairs and who holds the pen decides who may sign the minutes off,
      // so a change of either is a state change, not a field edit.
      await ledger("state_change", "meeting", meetingId, req, { identity: identityChanges });
    }
    return fetchMeeting(req, meetingId);
  });

  /** Hold the meeting: stamp the times and settle quorum from the attendance. */
  app.post(
    "/projects/:projectId/meetings/:meetingId/hold",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({
          actualStart: isoTimestamp.optional(),
          actualEnd: isoTimestamp.nullable().optional(),
        })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      /*
       * Hold moves a meeting FORWARD. Allowing it from minutes_draft upward
       * rewrote an issued or accepted meeting back to "held", hiding the
       * objection window and the acceptance from every list view and putting a
       * backwards state_change in the ledger.
       */
      if (!HOLDABLE_STATES.includes(meeting.status as (typeof HOLDABLE_STATES)[number])) {
        throw conflict(
          `A meeting can only be held from scheduled or in_progress (this one is ` +
            `"${meeting.status}"). Holding it again would rewind its minutes.`,
        );
      }
      const quorum = await quorumFor(meeting);
      const now = new Date().toISOString();
      await app.db
        .update(meetings)
        .set({
          status: "held",
          actualStart: body.actualStart ?? meeting.actualStart ?? meeting.scheduledStart ?? now,
          actualEnd: body.actualEnd ?? meeting.actualEnd ?? null,
          quorumMet: quorum.met === true ? 1 : 0,
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "held",
        quorum,
      });
      return { ...(await fetchMeeting(req, meetingId)), quorum };
    },
  );

  app.post(
    "/projects/:projectId/meetings/:meetingId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (meeting.status === "minutes_issued" || meeting.status === "minutes_accepted") {
        throw badRequest("A meeting whose minutes have been issued cannot be cancelled");
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetings)
        .set({ status: "cancelled", cancelledReason: body.reason, updatedAt: now })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "cancelled",
        reason: body.reason,
      });
      return fetchMeeting(req, meetingId);
    },
  );

  app.get(
    "/projects/:projectId/meetings/:meetingId/quorum",
    { preHandler: readGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const meeting = await fetchMeeting(req, meetingId);
      return { meetingId, ...(await quorumFor(meeting)) };
    },
  );

  /* ================================================================ */
  /* 3. Attendees                                                      */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/meetings/:meetingId/attendees",
    { preHandler: standardGate },
    async (req, reply) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = attendeesCreateSchema.parse(req.body);
      await fetchMeeting(req, meetingId);
      const rows = body.attendees.map((a) => ({
        id: newId("matt"),
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId,
        userId: a.userId ?? null,
        contactId: a.contactId ?? null,
        vendorId: a.vendorId ?? null,
        name: a.name,
        organisation: a.organisation ?? null,
        email: a.email ?? null,
        jobTitle: a.jobTitle ?? null,
        role: a.role ?? "required",
        attendance: "absent",
      }));
      await app.db.insert(meetingAttendees).values(rows);
      await refreshMeetingCounts(meetingId);
      await ledger("update", "meeting", meetingId, req, {
        attendeesAdded: rows.map((r) => ({ id: r.id, name: r.name, role: r.role })),
      });
      return reply.status(201).send({ items: rows, total: rows.length });
    },
  );

  app.get(
    "/projects/:projectId/meetings/:meetingId/attendees",
    { preHandler: readGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      await fetchMeeting(req, meetingId);
      const items = await loadAttendees(meetingId);
      return { items, total: items.length };
    },
  );

  app.patch(
    "/projects/:projectId/meeting-attendees/:attendeeId",
    { preHandler: standardGate },
    async (req) => {
      const { attendeeId } = req.params as { attendeeId: string };
      const body = attendeePatchSchema.parse(req.body);
      const attendee = await fetchAttendee(req, attendeeId);
      if (body.attendance === "delegate_attended" && !body.delegateName && !attendee.delegateName) {
        throw badRequest(
          "Recording a delegate attendance needs the delegate's name — 'someone came instead' " +
            "is not a record of who was in the room.",
        );
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      if (body.attendance === "apologies" && !attendee.apologiesReceivedAt) {
        set["apologiesReceivedAt"] = new Date().toISOString();
      }
      await app.db.update(meetingAttendees).set(set).where(eq(meetingAttendees.id, attendeeId));
      await ledger("update", "meeting_attendee", attendeeId, req, {
        meetingId: attendee.meetingId,
        changed: Object.keys(body),
      });
      // Attendance drives quorum, so the meeting's flag is recomputed here
      // rather than left to whoever remembers to press "hold" again.
      const meeting = await fetchMeeting(req, attendee.meetingId);
      const quorum = await quorumFor(meeting);
      if ((quorum.met === true ? 1 : 0) !== meeting.quorumMet) {
        await app.db
          .update(meetings)
          .set({ quorumMet: quorum.met === true ? 1 : 0 })
          .where(eq(meetings.id, meeting.id));
      }
      return { ...(await fetchAttendee(req, attendeeId)), quorum };
    },
  );

  app.delete(
    "/projects/:projectId/meeting-attendees/:attendeeId",
    { preHandler: standardGate },
    async (req) => {
      const { attendeeId } = req.params as { attendeeId: string };
      const attendee = await fetchAttendee(req, attendeeId);
      await app.db.delete(meetingAttendees).where(eq(meetingAttendees.id, attendeeId));
      await refreshMeetingCounts(attendee.meetingId);
      await ledger("delete", "meeting_attendee", attendeeId, req, {
        meetingId: attendee.meetingId,
      });
      return { ok: true };
    },
  );

  /* ================================================================ */
  /* 4. Agenda items and carry-forward                                 */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/meetings/:meetingId/agenda-items",
    { preHandler: standardGate },
    async (req, reply) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = agendaItemCreateSchema.parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      const [countRow] = await app.db
        .select({ n: count() })
        .from(meetingAgendaItems)
        .where(eq(meetingAgendaItems.meetingId, meetingId));
      const id = newId("magi");
      await app.db.insert(meetingAgendaItems).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId,
        seriesId: meeting.seriesId,
        itemNumber: body.itemNumber ?? null,
        position: body.position ?? Number(countRow?.n ?? 0),
        parentItemId: body.parentItemId ?? null,
        title: body.title,
        description: body.description ?? null,
        category: body.category ?? "other",
        status: "open",
        presenterId: body.presenterId ?? null,
        allocatedMinutes: body.allocatedMinutes ?? null,
        discussion: body.discussion ?? null,
        firstRaisedMeetingId: meetingId,
        originType: body.originType ?? null,
        originId: body.originId ?? null,
        attachmentFileIds: body.attachmentFileIds ?? [],
        createdBy: req.user!.id,
      });
      await ledger("create", "meeting_agenda_item", id, req, {
        meetingId,
        title: body.title,
        category: body.category ?? "other",
      });
      const row = await fetchAgendaItem(req, id);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/meetings/:meetingId/agenda-items",
    { preHandler: readGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      await fetchMeeting(req, meetingId);
      const items = await app.db
        .select()
        .from(meetingAgendaItems)
        .where(eq(meetingAgendaItems.meetingId, meetingId))
        .orderBy(asc(meetingAgendaItems.position));
      return { items, total: items.length };
    },
  );

  app.patch(
    "/projects/:projectId/meeting-agenda-items/:itemId",
    { preHandler: standardGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const body = agendaItemPatchSchema.parse(req.body);
      const item = await fetchAgendaItem(req, itemId);
      if (item.carriedForwardToItemId) {
        throw badRequest(
          "This item has already been carried forward — edit the item on the later occurrence, " +
            "which is the live one.",
        );
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { updatedAt: now };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      if (body.status === "closed" && item.status !== "closed") {
        set["closedAt"] = now;
        set["closedBy"] = req.user!.id;
      }
      await app.db.update(meetingAgendaItems).set(set).where(eq(meetingAgendaItems.id, itemId));
      await ledger(body.status ? "state_change" : "update", "meeting_agenda_item", itemId, req, {
        changed: Object.keys(body),
        status: body.status ?? item.status,
      });
      return fetchAgendaItem(req, itemId);
    },
  );

  app.post(
    "/projects/:projectId/meeting-agenda-items/:itemId/close",
    { preHandler: standardGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const body = z.object({ discussion: z.string().max(50_000).optional() }).parse(req.body ?? {});
      const item = await fetchAgendaItem(req, itemId);
      if (item.status === "closed") throw conflict("This item is already closed");
      const now = new Date().toISOString();
      await app.db
        .update(meetingAgendaItems)
        .set({
          status: "closed",
          closedAt: now,
          closedBy: req.user!.id,
          discussion: body.discussion ?? item.discussion,
          updatedAt: now,
        })
        .where(eq(meetingAgendaItems.id, itemId));
      await ledger("state_change", "meeting_agenda_item", itemId, req, {
        from: item.status,
        to: "closed",
        carryCount: item.carryCount,
      });
      return fetchAgendaItem(req, itemId);
    },
  );

  /**
   * Carry the unclosed items of the previous occurrence into this one.
   * Idempotent, so pressing it twice is harmless — and generating the
   * occurrence already ran it.
   */
  app.post(
    "/projects/:projectId/meetings/:meetingId/carry-forward",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({ fromMeetingId: z.string().max(64).optional() })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      const fromId = body.fromMeetingId ?? meeting.previousMeetingId;
      if (!fromId) {
        throw badRequest(
          "There is no previous occurrence to carry from — pass fromMeetingId, or this is the " +
            "first meeting of the series.",
        );
      }
      if (fromId === meetingId) throw badRequest("A meeting cannot carry forward from itself");
      await fetchMeeting(req, fromId);
      const result = await carryForwardInto(req, meeting, fromId);
      const items = await app.db
        .select()
        .from(meetingAgendaItems)
        .where(eq(meetingAgendaItems.meetingId, meetingId))
        .orderBy(asc(meetingAgendaItems.position));
      return { meetingId, fromMeetingId: fromId, ...result, items };
    },
  );

  /* ================================================================ */
  /* 5. Minutes                                                        */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({
          minutesBody: z.string().min(1).max(500_000),
          minutesFileId: z.string().max(64).nullable().optional(),
          objectionPeriodDays: z.number().int().min(0).max(90).nullable().optional(),
          distribution: z.array(z.string().max(64)).max(200).optional(),
          aiDrafted: z.boolean().optional(),
        })
        .parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (meeting.status === "cancelled") throw badRequest("A cancelled meeting has no minutes");
      if (meeting.approvedAt) throw conflict("Approved minutes cannot be redrafted");
      /*
       * THE DEADLOCK THIS PREVENTS.
       *
       * Saving a draft over ISSUED minutes used to set the status back to
       * minutes_draft while minutesIssuedAt stayed set. /minutes/approve then
       * refused (status is not minutes_issued) and /minutes/issue refused
       * (already issued), so the meeting could never reach minutes_accepted —
       * the core workflow, wedged, with no route out of it. Correction after
       * issue is a deliberate, ledgered act with its own route: it withdraws
       * the issued version, bumps the version number and lets the redraft
       * proceed, so recipients can see that what they received was replaced.
       */
      if (meeting.minutesIssuedAt) {
        throw conflict(
          "These minutes have been issued and cannot be silently redrafted: recipients are " +
            "relying on the version they received, and the objection period is running against " +
            "it. Withdraw them first with POST /minutes/correct (which records why and bumps " +
            "the version), then redraft and re-issue.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetings)
        .set({
          minutesBody: body.minutesBody,
          minutesFileId: body.minutesFileId ?? meeting.minutesFileId,
          objectionPeriodDays: body.objectionPeriodDays ?? meeting.objectionPeriodDays,
          distribution: body.distribution ?? (meeting.distribution as string[]),
          aiDrafted: body.aiDrafted ? 1 : meeting.aiDrafted,
          minuteTakerId: meeting.minuteTakerId ?? req.user!.id,
          status: "minutes_draft",
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "minutes_draft",
        aiDrafted: body.aiDrafted === true,
        minuteTakerId: meeting.minuteTakerId ?? req.user!.id,
      });
      const drafted = await fetchMeeting(req, meetingId);
      return { ...drafted, minutesObjectionWindow: minutesWindow(drafted) };
    },
  );

  /**
   * ISSUE THE MINUTES: render the document, hash it, deliver it, and start
   * the clock from DELIVERY.
   *
   * Everything before the notification loop is what makes the deeming
   * defensible. The bytes are rendered and content-addressed, one delivery row
   * is written per recipient (platform users through the notification centre,
   * external attendees by email), the email transport's own verdict is
   * recorded per recipient rather than assumed, and `minutesDeliveredAt` — the
   * timestamp the objection window actually runs from — is set from the
   * earliest delivery that really happened. Where nothing could be delivered,
   * the window falls back to issue and SAYS SO.
   */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/issue",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({
          objectionPeriodDays: z.number().int().min(0).max(90).optional(),
          /** false when minutes are handed over on paper and logged manually */
          sendEmail: z.boolean().default(true),
        })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      if (!meeting.minutesBody && !meeting.minutesFileId) {
        throw badRequest("There are no minutes to issue — draft them first");
      }
      if (meeting.minutesIssuedAt) throw conflict("These minutes have already been issued");
      if (meeting.status === "cancelled") throw badRequest("A cancelled meeting has no minutes");

      const version = Math.max(1, meeting.minutesVersion);
      const now = new Date().toISOString();
      const objectionPeriodDays = body.objectionPeriodDays ?? meeting.objectionPeriodDays;

      /* Version the meeting FIRST so the rendered document carries the number
         it will be filed under, then render: the hash covers the version. */
      if (meeting.minutesVersion < 1) {
        await app.db
          .update(meetings)
          .set({ minutesVersion: 1, updatedAt: now })
          .where(eq(meetings.id, meetingId));
      }
      const forRender = await fetchMeeting(req, meetingId);
      const document = await renderAndStore(req, forRender, "minutes");

      await app.db
        .update(meetings)
        .set({
          status: "minutes_issued",
          minutesIssuedAt: now,
          minutesIssuedBy: req.user!.id,
          objectionPeriodDays,
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "minutes_issued",
        issuedBy: req.user!.id,
        objectionPeriodDays,
        minutesVersion: version,
        minutesSha256: document.sha256,
        minutesFileId: document.fileId,
      });

      /* ---- who receives it -------------------------------------- */
      const distribution = [...new Set(((meeting.distribution as string[]) ?? []).filter(Boolean))];
      const distUsers = distribution.length
        ? await app.db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
            .where(
              and(
                eq(companyMemberships.companyId, req.companyId!),
                inArray(users.id, distribution),
              ),
            )
        : [];
      const attendeeRows = await loadAttendees(meetingId);

      type Recipient = {
        userId: string | null;
        contactId: string | null;
        attendeeId: string | null;
        name: string;
        email: string | null;
        channel: (typeof MINUTE_DELIVERY_CHANNELS)[number];
      };
      const recipients: Recipient[] = [];
      const seenUsers = new Set<string>();
      for (const u of distUsers) {
        seenUsers.add(u.id);
        recipients.push({
          userId: u.id,
          contactId: null,
          attendeeId: null,
          name: u.name ?? u.email,
          email: u.email,
          channel: "platform",
        });
      }
      for (const a of attendeeRows) {
        if (a.userId && seenUsers.has(a.userId)) continue;
        if (a.userId) {
          seenUsers.add(a.userId);
          recipients.push({
            userId: a.userId,
            contactId: a.contactId,
            attendeeId: a.id,
            name: a.name,
            email: a.email,
            channel: "platform",
          });
          continue;
        }
        if (!a.email) continue; // an external attendee with no address cannot be served
        recipients.push({
          userId: null,
          contactId: a.contactId,
          attendeeId: a.id,
          name: a.name,
          email: a.email,
          channel: "email",
        });
      }

      /* ---- deliver ---------------------------------------------- */
      const transport = emailTransport();
      const emailReasons = new Set<string>();
      let earliestDelivery: string | null = null;
      const delivered: string[] = [];
      const pending: string[] = [];
      for (const r of recipients) {
        let status: (typeof MINUTE_DELIVERY_STATUSES)[number] = "pending";
        let deliveredAt: string | null = null;
        let failureReason: string | null = null;

        if (r.channel === "platform") {
          /* The notification centre IS the delivery: the recipient holds an
             account on this platform and the document is in front of them. */
          status = "delivered";
          deliveredAt = now;
        } else if (!body.sendEmail) {
          failureReason = "Email was not requested for this issue; record delivery manually.";
        } else if (!r.email) {
          failureReason = "No email address is recorded for this recipient.";
        } else {
          const result = await transport.send({
            to: { email: r.email, name: r.name },
            subject: `Minutes issued — ${meeting.reference}: ${meeting.title}`,
            text:
              `The minutes of ${meeting.reference} ("${meeting.title}") have been issued.\n\n` +
              (objectionPeriodDays != null
                ? `Objections must be raised within ${objectionPeriodDays} day(s) of delivery. ` +
                  `After that, items not objected to are taken as an accurate record.\n\n`
                : "No objection period is recorded for these minutes.\n\n") +
              `Document sha256: ${document.sha256}\n`,
            html: document.html,
          });
          if (result.dispatched) {
            status = "delivered";
            deliveredAt = result.at ?? now;
          } else {
            status = "failed";
            failureReason = result.reasons.join(" ") || "The email transport did not dispatch.";
            for (const reason of result.reasons) emailReasons.add(reason);
          }
        }

        if (deliveredAt && (!earliestDelivery || deliveredAt < earliestDelivery)) {
          earliestDelivery = deliveredAt;
        }
        if (status === "delivered") delivered.push(r.name);
        else pending.push(r.name);

        await app.db
          .insert(meetingMinuteDeliveries)
          .values({
            id: newId("mmd"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            meetingId,
            minutesVersion: version,
            userId: r.userId,
            contactId: r.contactId,
            attendeeId: r.attendeeId,
            recipientName: r.name,
            email: r.email,
            channel: r.channel,
            status,
            deliveredAt,
            failureReason,
            documentSha256: document.sha256,
          })
          .onConflictDoNothing();
      }

      if (earliestDelivery) {
        await app.db
          .update(meetings)
          .set({ minutesDeliveredAt: earliestDelivery, updatedAt: now })
          .where(eq(meetings.id, meetingId));
      }

      await pushNotifications(
        app.db,
        recipients
          .filter((r) => r.userId)
          .map((r) => ({
            companyId: req.companyId!,
            userId: r.userId!,
            projectId: req.projectId!,
            kind: "status_change" as const,
            title: `Minutes issued for ${meeting.reference}: ${meeting.title}`,
            body:
              objectionPeriodDays != null
                ? `Objections must be raised within ${objectionPeriodDays} days of delivery.`
                : null,
            recordType: "meeting",
            recordId: meetingId,
          })),
      );

      const issued = await fetchMeeting(req, meetingId);
      return {
        ...issued,
        minutesObjectionWindow: minutesWindow(issued),
        document: {
          fileId: document.fileId,
          sha256: document.sha256,
          sizeBytes: document.sizeBytes,
          minutesVersion: version,
        },
        distributionReport: {
          recipients: recipients.length,
          delivered: delivered.length,
          undelivered: pending.length,
          transport: transport.describe(),
          reasons: [
            ...emailReasons,
            ...(recipients.length === 0
              ? [
                  "Nobody is on the distribution and no attendee has an email address, so these " +
                    "minutes have been issued to no one. The objection period will run from " +
                    "issue, which a recipient can displace.",
                ]
              : []),
          ],
        },
      };
    },
  );

  /** An objection inside the period. After it closes, silence has done its work. */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/object",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({
          note: z.string().min(1).max(5000),
          agendaItemId: z.string().max(64).nullable().optional(),
        })
        .parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (!meeting.minutesIssuedAt) throw badRequest("The minutes have not been issued yet");
      if (meeting.approvedAt) throw conflict("These minutes have already been approved");
      const window = minutesWindow(meeting);
      if (window.expired === true) {
        throw badRequest(
          `The objection period closed on ${window.closesAt}. Raise the disagreement as a new ` +
            `agenda item at the next occurrence rather than rewriting an accepted record.`,
        );
      }
      const now = new Date().toISOString();
      const objections = (detailOf(meeting)["objections"] as unknown[] | undefined) ?? [];
      const objection = {
        id: newId("mobj"),
        by: req.user!.id,
        at: now,
        note: body.note,
        agendaItemId: body.agendaItemId ?? null,
        resolvedAt: null,
      };
      await app.db
        .update(meetings)
        .set({
          detail: { ...detailOf(meeting), objections: [...objections, objection] },
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("update", "meeting", meetingId, req, {
        objectionRaised: objection,
        status: meeting.status,
      });
      const updated = await fetchMeeting(req, meetingId);
      return { ...updated, minutesObjectionWindow: minutesWindow(updated) };
    },
  );

  /** Settle an objection: withdrawn, or accepted and the minutes corrected. */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/objections/:objectionId/resolve",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId, objectionId } = req.params as {
        meetingId: string;
        objectionId: string;
      };
      const body = z
        .object({ resolutionNote: z.string().min(1).max(5000) })
        .parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      const objections = (detailOf(meeting)["objections"] as Record<string, unknown>[] | undefined) ?? [];
      const target = objections.find((o) => o["id"] === objectionId);
      if (!target) throw notFound("Objection not found on this meeting");
      if (target["resolvedAt"] != null) throw conflict("This objection is already settled");
      const now = new Date().toISOString();
      const updated = objections.map((o) =>
        o["id"] === objectionId
          ? { ...o, resolvedAt: now, resolvedBy: req.user!.id, resolutionNote: body.resolutionNote }
          : o,
      );
      await app.db
        .update(meetings)
        .set({ detail: { ...detailOf(meeting), objections: updated }, updatedAt: now })
        .where(eq(meetings.id, meetingId));
      await ledger("update", "meeting", meetingId, req, {
        objectionResolved: objectionId,
        resolutionNote: body.resolutionNote,
      });
      const after = await fetchMeeting(req, meetingId);
      return { ...after, minutesObjectionWindow: minutesWindow(after) };
    },
  );

  /**
   * Approve the minutes — at the NEXT occurrence, by someone who neither
   * wrote nor issued them. Issued minutes are the record a party is deemed to
   * have accepted, so the signature on them must not be the author's.
   */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/approve",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({ atMeetingId: z.string().max(64).optional() })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      if (meeting.status !== "minutes_issued") {
        throw badRequest(
          `Minutes can only be approved once issued (this meeting is "${meeting.status}")`,
        );
      }
      if (meeting.approvedAt) throw conflict("These minutes have already been approved");
      if (meeting.minutesIssuedBy === req.user!.id) {
        throw forbidden(
          "The person who issued the minutes may not approve them. Approval is the other " +
            "party's act — that is what makes issued minutes binding.",
        );
      }
      if (meeting.minuteTakerId === req.user!.id) {
        throw forbidden(
          "The minute taker may not approve their own minutes — ask the chair or another " +
            "attendee to sign them off.",
        );
      }
      const window = minutesWindow(meeting);
      if (window.openObjections > 0) {
        throw conflict(
          `${window.openObjections} objection(s) to these minutes are unresolved — settle them ` +
            `before the minutes are signed off.`,
        );
      }

      // Approval happens AT a meeting: the next occurrence of the series.
      // Whatever the caller passes must be a real meeting in this project —
      // an unvalidated string was previously persisted and ledgered as the
      // place the minutes were tabled, including another tenant's id.
      let approvedAtMeetingId: string | null = body.atMeetingId ?? null;
      if (approvedAtMeetingId) {
        if (approvedAtMeetingId === meetingId) {
          throw badRequest("Minutes are not approved at the meeting whose minutes they are");
        }
        await fetchMeeting(req, approvedAtMeetingId);
      }
      if (meeting.seriesId) {
        const later = await app.db
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.seriesId, meeting.seriesId),
              eq(meetings.companyId, req.companyId!),
              ne(meetings.id, meetingId),
            ),
          )
          .orderBy(asc(meetings.occurrenceNumber));
        const candidates = later.filter(
          (m) =>
            (m.occurrenceNumber ?? 0) > (meeting.occurrenceNumber ?? 0) &&
            m.status !== "cancelled" &&
            m.status !== "scheduled",
        );
        if (approvedAtMeetingId) {
          const chosen = candidates.find((m) => m.id === approvedAtMeetingId);
          if (!chosen) {
            throw badRequest(
              "atMeetingId must be a later occurrence of the same series that has been held",
            );
          }
        } else {
          const next = candidates[0];
          if (!next) {
            throw badRequest(
              "Minutes of a recurring meeting are approved at the NEXT occurrence — hold it " +
                "first, or pass atMeetingId for the meeting where they were tabled.",
            );
          }
          approvedAtMeetingId = next.id;
        }
      }

      const now = new Date().toISOString();
      await app.db
        .update(meetings)
        .set({
          status: "minutes_accepted",
          approvedBy: req.user!.id,
          approvedAt: now,
          detail: { ...detailOf(meeting), approvedAtMeetingId },
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: "minutes_issued",
        to: "minutes_accepted",
        approvedBy: req.user!.id,
        issuedBy: meeting.minutesIssuedBy,
        minuteTakerId: meeting.minuteTakerId,
        approvedAtMeetingId,
      });
      const approved = await fetchMeeting(req, meetingId);
      return { ...approved, approvedAtMeetingId, minutesObjectionWindow: minutesWindow(approved) };
    },
  );

  /* ================================================================ */
  /* 6. Decisions                                                      */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/meetings/:meetingId/decisions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = decisionCreateSchema.parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (body.agendaItemId) await fetchAgendaItem(req, body.agendaItemId);
      const number = await nextRecordNumber(app.db, req.projectId!, "meeting_decision");
      const id = newId("mdec");
      await app.db.insert(meetingDecisions).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId,
        agendaItemId: body.agendaItemId ?? null,
        number,
        reference: `DEC-${String(number).padStart(3, "0")}`,
        title: body.title,
        decision: body.decision,
        rationale: body.rationale ?? null,
        decidedById: body.decidedById ?? null,
        decidedByName: body.decidedByName ?? null,
        decisionDate: body.decisionDate ?? todayISO(),
        status: "recorded",
        impactsCost: body.impactsCost ? 1 : 0,
        estimatedCostImpact: body.estimatedCostImpact ?? null,
        currency: body.currency ?? null,
        impactsSchedule: body.impactsSchedule ? 1 : 0,
        estimatedScheduleImpactDays: body.estimatedScheduleImpactDays ?? null,
        resultingRecordType: body.resultingRecordType ?? null,
        resultingRecordId: body.resultingRecordId ?? null,
        detail: { quorumMetAtDecision: meeting.quorumMet === 1 },
        createdBy: req.user!.id,
      });
      await ledger("create", "meeting_decision", id, req, {
        meetingId,
        number,
        title: body.title,
        impactsCost: body.impactsCost === true,
        estimatedCostImpact: body.estimatedCostImpact ?? null,
        quorumMetAtDecision: meeting.quorumMet === 1,
      });
      const row = await fetchDecision(req, id);
      return reply.status(201).send(withImpacts(row));
    },
  );

  app.get("/projects/:projectId/meeting-decisions", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({
        meetingId: z.string().max(64).optional(),
        status: z.string().max(40).optional(),
        impactsCost: z.enum(["0", "1"]).optional(),
      })
      .parse(req.query);
    const where = and(
      eq(meetingDecisions.companyId, req.companyId!),
      eq(meetingDecisions.projectId, req.projectId!),
      q.meetingId ? eq(meetingDecisions.meetingId, q.meetingId) : undefined,
      q.status ? eq(meetingDecisions.status, q.status) : undefined,
      q.impactsCost ? eq(meetingDecisions.impactsCost, Number(q.impactsCost)) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetingDecisions).where(where);
    const items = await app.db
      .select()
      .from(meetingDecisions)
      .where(where)
      .orderBy(desc(meetingDecisions.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items.map(withImpacts), Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/meeting-decisions/:decisionId",
    { preHandler: readGate },
    async (req) => {
      const { decisionId } = req.params as { decisionId: string };
      return withImpacts(await fetchDecision(req, decisionId));
    },
  );

  app.patch(
    "/projects/:projectId/meeting-decisions/:decisionId",
    { preHandler: standardGate },
    async (req) => {
      const { decisionId } = req.params as { decisionId: string };
      const body = decisionPatchSchema.parse(req.body);
      const row = await fetchDecision(req, decisionId);
      if (row.status === "superseded" || row.status === "rescinded") {
        throw badRequest(`A ${row.status} decision cannot be edited`);
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const changed: string[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        set[k] = k === "impactsCost" || k === "impactsSchedule" ? (v ? 1 : 0) : v;
        changed.push(k);
      }
      /*
       * A RATIFIED DECISION IS CERTIFIED CONTENT.
       *
       * Ratification is an independent check by someone who is not the person
       * who made the call. Editing the decision text, its cost impact or who
       * made it while the row still says "ratified" makes that check certify
       * words it never saw. Editing is allowed — minutes get corrected — but
       * it costs the ratification, which must then be given again against the
       * new text.
       */
      let unratified = false;
      if (row.status === "ratified" && changed.length > 0) {
        set["status"] = "recorded";
        set["ratifiedBy"] = null;
        set["ratifiedAt"] = null;
        unratified = true;
      }
      await app.db.update(meetingDecisions).set(set).where(eq(meetingDecisions.id, decisionId));
      await ledger("update", "meeting_decision", decisionId, req, { changed });
      if (unratified) {
        await ledger("state_change", "meeting_decision", decisionId, req, {
          from: "ratified",
          to: "recorded",
          reason: "The decision was edited after ratification; the ratification does not carry.",
          previouslyRatifiedBy: row.ratifiedBy,
          previouslyRatifiedAt: row.ratifiedAt,
          changed,
        });
      }
      return {
        ...withImpacts(await fetchDecision(req, decisionId)),
        unratifiedByEdit: unratified,
      };
    },
  );

  /** Independent ratification — never the person who made the call. */
  app.post(
    "/projects/:projectId/meeting-decisions/:decisionId/ratify",
    { preHandler: standardGate },
    async (req) => {
      const { decisionId } = req.params as { decisionId: string };
      const row = await fetchDecision(req, decisionId);
      if (row.status !== "recorded") {
        throw badRequest(`Only a recorded decision can be ratified (this one is "${row.status}")`);
      }
      if (row.decidedById && row.decidedById === req.user!.id) {
        throw forbidden(
          "A decision may not be ratified by the person who made it. Ratification is the " +
            "independent check that stops a decision with cost consequences being " +
            "self-authorised in the minutes.",
        );
      }
      if (row.createdBy === req.user!.id) {
        throw forbidden(
          "The person who minuted a decision may not ratify it — ask someone who was not " +
            "holding the pen.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetingDecisions)
        .set({ status: "ratified", ratifiedBy: req.user!.id, ratifiedAt: now, updatedAt: now })
        .where(eq(meetingDecisions.id, decisionId));
      await ledger("state_change", "meeting_decision", decisionId, req, {
        from: "recorded",
        to: "ratified",
        ratifiedBy: req.user!.id,
        decidedById: row.decidedById,
        minutedBy: row.createdBy,
      });
      return withImpacts(await fetchDecision(req, decisionId));
    },
  );

  app.post(
    "/projects/:projectId/meeting-decisions/:decisionId/dispute",
    { preHandler: standardGate },
    async (req) => {
      const { decisionId } = req.params as { decisionId: string };
      const body = z.object({ note: z.string().min(1).max(5000) }).parse(req.body);
      const row = await fetchDecision(req, decisionId);
      const now = new Date().toISOString();
      await app.db
        .update(meetingDecisions)
        .set({
          status: "disputed",
          disputedBy: req.user!.id,
          disputedAt: now,
          disputeNote: body.note,
          updatedAt: now,
        })
        .where(eq(meetingDecisions.id, decisionId));
      await ledger("state_change", "meeting_decision", decisionId, req, {
        from: row.status,
        to: "disputed",
        note: body.note,
      });
      return withImpacts(await fetchDecision(req, decisionId));
    },
  );

  /** Supersede a decision with a new one — recorded in both directions. */
  app.post(
    "/projects/:projectId/meeting-decisions/:decisionId/supersede",
    { preHandler: standardGate },
    async (req, reply) => {
      const { decisionId } = req.params as { decisionId: string };
      const body = decisionCreateSchema
        .extend({ meetingId: z.string().min(1).max(64) })
        .parse(req.body);
      const old = await fetchDecision(req, decisionId);
      if (old.status === "superseded") throw conflict("This decision is already superseded");
      const meeting = await fetchMeeting(req, body.meetingId);
      const number = await nextRecordNumber(app.db, req.projectId!, "meeting_decision");
      const id = newId("mdec");
      const now = new Date().toISOString();
      await app.db.insert(meetingDecisions).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId: meeting.id,
        agendaItemId: body.agendaItemId ?? null,
        number,
        reference: `DEC-${String(number).padStart(3, "0")}`,
        title: body.title,
        decision: body.decision,
        rationale: body.rationale ?? null,
        decidedById: body.decidedById ?? null,
        decidedByName: body.decidedByName ?? null,
        decisionDate: body.decisionDate ?? todayISO(),
        status: "recorded",
        impactsCost: body.impactsCost ? 1 : 0,
        estimatedCostImpact: body.estimatedCostImpact ?? null,
        currency: body.currency ?? null,
        impactsSchedule: body.impactsSchedule ? 1 : 0,
        estimatedScheduleImpactDays: body.estimatedScheduleImpactDays ?? null,
        supersedesDecisionId: old.id,
        detail: { supersedes: old.reference },
        createdBy: req.user!.id,
      });
      await app.db
        .update(meetingDecisions)
        .set({ status: "superseded", supersededByDecisionId: id, updatedAt: now })
        .where(eq(meetingDecisions.id, decisionId));
      await ledger("create", "meeting_decision", id, req, {
        supersedesDecisionId: old.id,
        meetingId: meeting.id,
      });
      await ledger("state_change", "meeting_decision", old.id, req, {
        from: old.status,
        to: "superseded",
        supersededByDecisionId: id,
      });
      return reply.status(201).send({
        decision: withImpacts(await fetchDecision(req, id)),
        superseded: withImpacts(await fetchDecision(req, decisionId)),
      });
    },
  );

  /* ================================================================ */
  /* 7. Action items — the part that matters                           */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/meeting-action-items",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = actionCreateSchema.parse(req.body);
      let seriesId: string | null = null;
      if (body.meetingId) {
        const meeting = await fetchMeeting(req, body.meetingId);
        seriesId = meeting.seriesId;
      }
      if (body.agendaItemId) await fetchAgendaItem(req, body.agendaItemId);
      if (body.decisionId) await fetchDecision(req, body.decisionId);
      if (!body.ownerId && !body.ownerContactId && !body.ownerVendorId && !body.ownerName) {
        throw badRequest(
          "An action item needs an owner — a name at minimum. An action nobody owns is a wish.",
        );
      }
      const number = await nextRecordNumber(app.db, req.projectId!, "meeting_action_item");
      const id = newId("mact");
      await app.db.insert(meetingActionItems).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        meetingId: body.meetingId ?? null,
        seriesId,
        agendaItemId: body.agendaItemId ?? null,
        decisionId: body.decisionId ?? null,
        number,
        reference: `ACT-${String(number).padStart(3, "0")}`,
        title: body.title,
        description: body.description ?? null,
        category: body.category ?? "other",
        status: "open",
        priority: body.priority ?? "medium",
        ownerId: body.ownerId ?? null,
        ownerContactId: body.ownerContactId ?? null,
        ownerVendorId: body.ownerVendorId ?? null,
        ownerName: body.ownerName ?? null,
        dueDate: body.dueDate ?? null,
        originalDueDate: body.dueDate ?? null,
        sourceClause: body.sourceClause ?? null,
        obligorId: body.obligorId ?? null,
        obligeeId: body.obligeeId ?? null,
        deadline: body.deadline ?? null,
        warnDaysBefore: body.warnDaysBefore ?? null,
        evidenceRequirement: body.evidenceRequirement ?? null,
        linkedRecordType: body.linkedRecordType ?? null,
        linkedRecordId: body.linkedRecordId ?? null,
        createdBy: req.user!.id,
      });
      if (body.meetingId) await refreshMeetingCounts(body.meetingId);
      await ledger("create", "meeting_action_item", id, req, {
        number,
        title: body.title,
        ownerId: body.ownerId ?? null,
        dueDate: body.dueDate ?? null,
        meetingId: body.meetingId ?? null,
      });
      if (body.ownerId) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: body.ownerId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `Action ACT-${String(number).padStart(3, "0")} assigned to you: ${body.title}`,
            body: body.dueDate ? `Due ${body.dueDate}.` : null,
            recordType: "meeting_action_item",
            recordId: id,
          },
        ]);
      }
      return reply.status(201).send(await fetchAction(req, id));
    },
  );

  app.get("/projects/:projectId/meeting-action-items", { preHandler: readGate }, async (req) => {
    const q = actionsListQuery.parse(req.query);
    // No sweep here: reads are pure (see the sweep's own comment). The
    // overdue signals are raised by the scheduler under a system actor.
    const today = todayISO();
    const where = and(
      eq(meetingActionItems.companyId, req.companyId!),
      eq(meetingActionItems.projectId, req.projectId!),
      q.status ? eq(meetingActionItems.status, q.status) : undefined,
      q.ownerId ? eq(meetingActionItems.ownerId, q.ownerId) : undefined,
      q.meetingId ? eq(meetingActionItems.meetingId, q.meetingId) : undefined,
      q.seriesId ? eq(meetingActionItems.seriesId, q.seriesId) : undefined,
      q.priority ? eq(meetingActionItems.priority, q.priority) : undefined,
      q.promoted === "1" ? isNotNull(meetingActionItems.obligationId) : undefined,
      q.promoted === "0" ? isNull(meetingActionItems.obligationId) : undefined,
      q.overdue === "1"
        ? and(
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
            lt(meetingActionItems.dueDate, today),
          )
        : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetingActionItems).where(where);
    const items = await app.db
      .select()
      .from(meetingActionItems)
      .where(where)
      .orderBy(asc(meetingActionItems.dueDate), desc(meetingActionItems.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return {
      ...paginate(
        items.map((i) => ({
          ...i,
          isOverdue:
            OPEN_ACTION_STATES.includes(i.status as (typeof OPEN_ACTION_STATES)[number]) &&
            i.dueDate != null &&
            i.dueDate < today,
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      sweptBy: SWEEP_NOTE,
    };
  });

  app.get(
    "/projects/:projectId/meeting-action-items/:actionId",
    { preHandler: readGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const row = await fetchAction(req, actionId);
      const obligation = row.obligationId
        ? ((
            await app.db
              .select()
              .from(obligations)
              .where(eq(obligations.id, row.obligationId))
              .limit(1)
          )[0] ?? null)
        : null;
      return { ...row, obligation };
    },
  );

  app.patch(
    "/projects/:projectId/meeting-action-items/:actionId",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = actionPatchSchema.parse(req.body);
      const row = await fetchAction(req, actionId);
      if (row.status === "cancelled") {
        throw conflict("A cancelled action cannot be edited — raise a new one.");
      }
      /*
       * After promotion these columns are the OBLIGATION's terms, copied here
       * so the two rows tell one story. Editing them on the action afterwards
       * made the action and the obligation disagree about what is owed, to
       * whom, and by when — while /promote's own comment claimed they could
       * not drift.
       */
      if (row.obligationId) {
        const locked = PROMOTED_LOCKED_FIELDS.filter(
          (f) => body[f] !== undefined && body[f] !== row[f],
        );
        if (locked.length > 0) {
          throw conflict(
            `This action was promoted to obligation ${row.obligationId}; ${locked.join(", ")} ` +
              "now belong to the obligation and cannot be changed here. Amend the obligation, " +
              "which is what carries the time bar.",
          );
        }
      }
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { updatedAt: now };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        set[k] = v;
      }
      /*
       * Moving a due date is SLIPPAGE and is kept as evidence: the original
       * date survives in `originalDueDate` and every move increments
       * `revisedCount`, so "it was always due next month" cannot be asserted.
       */
      if (body.dueDate !== undefined && body.dueDate !== row.dueDate) {
        set["originalDueDate"] = row.originalDueDate ?? row.dueDate;
        set["revisedCount"] = row.revisedCount + 1;
        /*
         * The overdue signal is NOT cleared. One signal per action, forever —
         * the same key rule the rest of the platform's sweeps use. Re-dating
         * an action must not be a way to make the warning about it disappear;
         * the slippage is now on the record twice, in revisedCount and in the
         * signal that is still open.
         */
      }
      await app.db.update(meetingActionItems).set(set).where(eq(meetingActionItems.id, actionId));
      if (row.meetingId) await refreshMeetingCounts(row.meetingId);
      await ledger("update", "meeting_action_item", actionId, req, {
        changed: Object.keys(body),
        ...(body.dueDate !== undefined && body.dueDate !== row.dueDate
          ? { dueDateMovedFrom: row.dueDate, dueDateMovedTo: body.dueDate }
          : {}),
      });
      return fetchAction(req, actionId);
    },
  );

  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z
        .object({
          closureNote: z.string().max(5000).optional(),
          evidenceFileIds: z.array(z.string().max(64)).max(100).optional(),
        })
        .parse(req.body ?? {});
      const row = await fetchAction(req, actionId);
      if (row.status === "completed" || row.status === "verified") {
        throw conflict(`This action is already ${row.status}`);
      }
      if (row.status === "cancelled") throw badRequest("A cancelled action cannot be completed");
      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({
          status: "completed",
          completedAt: now,
          completedBy: req.user!.id,
          closureNote: body.closureNote ?? null,
          evidenceFileIds: body.evidenceFileIds ?? row.evidenceFileIds,
          updatedAt: now,
        })
        .where(eq(meetingActionItems.id, actionId));
      if (row.meetingId) await refreshMeetingCounts(row.meetingId);
      await ledger("state_change", "meeting_action_item", actionId, req, {
        from: row.status,
        to: "completed",
        completedBy: req.user!.id,
        evidenceFileIds: body.evidenceFileIds ?? row.evidenceFileIds,
      });
      return fetchAction(req, actionId);
    },
  );

  /** Verification is a second pair of eyes — never the completer's own. */
  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/verify",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const row = await fetchAction(req, actionId);
      if (row.status !== "completed") {
        throw badRequest(`Only a completed action can be verified (this one is "${row.status}")`);
      }
      if (row.completedBy === req.user!.id) {
        throw forbidden(
          "The person who completed an action may not verify it. Self-verification is the " +
            "absence of verification — ask someone else to confirm it was actually done.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({ status: "verified", verifiedBy: req.user!.id, verifiedAt: now, updatedAt: now })
        .where(eq(meetingActionItems.id, actionId));
      if (row.meetingId) await refreshMeetingCounts(row.meetingId);
      await ledger("state_change", "meeting_action_item", actionId, req, {
        from: "completed",
        to: "verified",
        verifiedBy: req.user!.id,
        completedBy: row.completedBy,
      });
      return fetchAction(req, actionId);
    },
  );

  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/block",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const row = await fetchAction(req, actionId);
      // Blocking is something that happens to LIVE work. Blocking a cancelled
      // action resurrected it; blocking a completed one erased the completion.
      if (!BLOCKABLE_ACTION_STATES.includes(row.status as (typeof BLOCKABLE_ACTION_STATES)[number])) {
        throw conflict(
          `Only an open or in-progress action can be blocked (this one is "${row.status}").`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({ status: "blocked", blockedReason: body.reason, updatedAt: now })
        .where(eq(meetingActionItems.id, actionId));
      await ledger("state_change", "meeting_action_item", actionId, req, {
        from: row.status,
        to: "blocked",
        reason: body.reason,
      });
      return fetchAction(req, actionId);
    },
  );

  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/escalate",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z
        .object({ escalatedToId: z.string().min(1).max(64), note: z.string().max(2000).optional() })
        .parse(req.body);
      const row = await fetchAction(req, actionId);
      // Escalating a finished action tells someone senior to chase work that
      // is done, cancelled or already verified. Nothing good follows.
      if (!CANCELLABLE_ACTION_STATES.includes(row.status as (typeof CANCELLABLE_ACTION_STATES)[number])) {
        throw conflict(
          `Only an open, in-progress or blocked action can be escalated (this one is ` +
            `"${row.status}").`,
        );
      }
      const escalatee = await app.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
        .where(
          and(
            eq(users.id, body.escalatedToId),
            eq(companyMemberships.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!escalatee[0]) {
        throw badRequest("escalatedToId is not a user in this company");
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({ escalatedToId: body.escalatedToId, escalatedAt: now, updatedAt: now })
        .where(eq(meetingActionItems.id, actionId));
      await ledger("update", "meeting_action_item", actionId, req, {
        escalatedToId: body.escalatedToId,
        note: body.note ?? null,
        carryCount: row.carryCount,
      });
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: body.escalatedToId,
          projectId: req.projectId!,
          kind: "assignment",
          title: `Action ${row.reference} escalated to you: ${row.title}`,
          body: body.note ?? null,
          recordType: "meeting_action_item",
          recordId: actionId,
        },
      ]);
      return fetchAction(req, actionId);
    },
  );

  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/cancel",
    { preHandler: standardGate },
    async (req) => {
      const { actionId } = req.params as { actionId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const row = await fetchAction(req, actionId);
      if (row.obligationId) {
        throw badRequest(
          "This action has been promoted to an obligation — cancel or waive the obligation " +
            "instead; the time bar no longer lives here.",
        );
      }
      // Cancelling a verified action overwrote its closure note with the
      // cancellation reason and erased the verification. Whatever the reason
      // for wanting that, it is not a cancellation.
      if (!CANCELLABLE_ACTION_STATES.includes(row.status as (typeof CANCELLABLE_ACTION_STATES)[number])) {
        throw conflict(
          `Only an open, in-progress or blocked action can be cancelled (this one is ` +
            `"${row.status}"). A completed or verified action is history.`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({ status: "cancelled", closureNote: body.reason, updatedAt: now })
        .where(eq(meetingActionItems.id, actionId));
      if (row.meetingId) await refreshMeetingCounts(row.meetingId);
      await ledger("state_change", "meeting_action_item", actionId, req, {
        from: row.status,
        to: "cancelled",
        reason: body.reason,
      });
      return fetchAction(req, actionId);
    },
  );

  /**
   * PROMOTE an action item to an Obligation (ADR 0012).
   *
   * The action item already carries the Obligation column shape, so this is a
   * copy rather than a re-keying. It refuses to invent the two things an
   * obligation cannot exist without: the clause it discharges and the date it
   * bites. A guessed time bar is worse than none — someone would rely on it.
   */
  app.post(
    "/projects/:projectId/meeting-action-items/:actionId/promote",
    { preHandler: standardGate },
    async (req, reply) => {
      const { actionId } = req.params as { actionId: string };
      const body = z
        .object({
          sourceClause: z.string().max(300).optional(),
          trigger: z.string().max(300).optional(),
          obligorId: z.string().max(64).nullable().optional(),
          obligeeId: z.string().max(64).nullable().optional(),
          deadline: isoTimestamp.optional(),
          warnDaysBefore: z.number().finite().min(0).max(365).nullable().optional(),
          evidenceRequirement: z.string().max(2000).nullable().optional(),
        })
        .parse(req.body ?? {});
      const row = await fetchAction(req, actionId);
      if (row.obligationId) {
        throw conflict(
          `This action was already promoted to obligation ${row.obligationId}`,
        );
      }
      if (row.status === "cancelled") throw badRequest("A cancelled action cannot be promoted");

      const sourceClause = body.sourceClause ?? row.sourceClause;
      if (!sourceClause) {
        throw badRequest(
          "An obligation must name the clause it discharges. Record sourceClause on the action " +
            "(or pass it here) — this platform will not invent a contractual basis for a duty.",
        );
      }
      const deadline =
        body.deadline ?? row.deadline ?? (row.dueDate ? `${row.dueDate}T23:59:59.000Z` : null);
      if (!deadline) {
        throw badRequest(
          "An obligation must have a date it bites. Give the action a dueDate or a deadline " +
            "first — a time bar this platform guessed would be worse than none at all.",
        );
      }

      const meeting = row.meetingId
        ? ((
            await app.db.select().from(meetings).where(eq(meetings.id, row.meetingId)).limit(1)
          )[0] ?? null)
        : null;
      const trigger =
        body.trigger ??
        (meeting
          ? `Agreed at ${meeting.reference} (${meeting.title}) — action ${row.reference}`
          : `Agreed as meeting action ${row.reference}`);

      const obligationId = newId("obl");
      const obligationRow = {
        id: obligationId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        sourceClause,
        obligorId: body.obligorId ?? row.obligorId ?? row.ownerId ?? null,
        obligeeId: body.obligeeId ?? row.obligeeId ?? null,
        trigger,
        deadline,
        warnDaysBefore: body.warnDaysBefore ?? row.warnDaysBefore ?? null,
        evidenceRequirement: body.evidenceRequirement ?? row.evidenceRequirement ?? null,
        status: "open",
        createdBy: req.user!.id,
      };
      await app.db.insert(obligations).values(obligationRow);

      const now = new Date().toISOString();
      await app.db
        .update(meetingActionItems)
        .set({
          obligationId,
          promotedAt: now,
          promotedBy: req.user!.id,
          // The action now states exactly what was promoted, so the two rows
          // cannot drift into telling different stories.
          sourceClause,
          deadline,
          obligorId: obligationRow.obligorId,
          obligeeId: obligationRow.obligeeId,
          warnDaysBefore: obligationRow.warnDaysBefore,
          evidenceRequirement: obligationRow.evidenceRequirement,
          updatedAt: now,
        })
        .where(eq(meetingActionItems.id, actionId));

      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "obligation",
        objectId: obligationId,
        payload: { ...obligationRow, promotedFromActionItemId: actionId },
        storePayload: true,
        projectId: req.projectId!,
      });
      await ledger("state_change", "meeting_action_item", actionId, req, {
        promoted: true,
        obligationId,
        sourceClause,
        deadline,
        promotedBy: req.user!.id,
      });

      return reply.status(201).send({
        actionItem: await fetchAction(req, actionId),
        obligation: obligationRow,
        note:
          "The obligation now owns the time bar for this action; the action item owns the " +
          "conversation. Overdue warnings come from the obligations sweep from here on.",
      });
    },
  );

  /* ================================================================ */
  /* 8. Reports — carry-forward and overdue                            */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/meeting-series/:seriesId/carry-forward",
    { preHandler: readGate },
    async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const series = await fetchSeries(req, seriesId);
      const items = await app.db
        .select()
        .from(meetingAgendaItems)
        .where(
          and(
            eq(meetingAgendaItems.seriesId, seriesId),
            isNull(meetingAgendaItems.carriedForwardToItemId),
          ),
        )
        .orderBy(desc(meetingAgendaItems.carryCount));
      const live = items.filter((i) => i.status !== "closed");
      const carried = live.filter((i) => i.carryCount > 0);
      const carryCounts = live.map((i) => i.carryCount);
      return {
        seriesId,
        seriesReference: series.reference,
        seriesTitle: series.title,
        summary: {
          liveItems: live.length,
          carriedItems: carried.length,
          maxCarryCount: carryCounts.length ? Math.max(...carryCounts) : 0,
          averageCarryCount:
            carryCounts.length === 0
              ? null
              : Math.round(
                  (carryCounts.reduce((a, b) => a + b, 0) / carryCounts.length) * 100,
                ) / 100,
          reasons:
            carryCounts.length === 0
              ? ["This series has no live agenda items, so there is no carry rate to report."]
              : [],
        },
        items: carried.map((i) => ({
          id: i.id,
          title: i.title,
          category: i.category,
          status: i.status,
          carryCount: i.carryCount,
          meetingId: i.meetingId,
          firstRaisedMeetingId: i.firstRaisedMeetingId,
          carriedFromItemId: i.carriedFromItemId,
        })),
      };
    },
  );

  app.get(
    "/projects/:projectId/meeting-reports/carry-forward",
    { preHandler: readGate },
    async (req) => {
      const items = await app.db
        .select()
        .from(meetingAgendaItems)
        .where(
          and(
            eq(meetingAgendaItems.companyId, req.companyId!),
            eq(meetingAgendaItems.projectId, req.projectId!),
            isNull(meetingAgendaItems.carriedForwardToItemId),
            ne(meetingAgendaItems.status, "closed"),
          ),
        )
        .orderBy(desc(meetingAgendaItems.carryCount));
      const bySeries = new Map<string, { seriesId: string | null; items: number; maxCarry: number }>();
      for (const i of items) {
        const key = i.seriesId ?? "__one_off__";
        const entry = bySeries.get(key) ?? { seriesId: i.seriesId, items: 0, maxCarry: 0 };
        entry.items += 1;
        entry.maxCarry = Math.max(entry.maxCarry, i.carryCount);
        bySeries.set(key, entry);
      }
      const carried = items.filter((i) => i.carryCount > 0);
      return {
        summary: {
          liveItems: items.length,
          carriedItems: carried.length,
          overThreshold: carried.filter((i) => i.carryCount >= CARRY_SIGNAL_THRESHOLD).length,
          threshold: CARRY_SIGNAL_THRESHOLD,
        },
        bySeries: [...bySeries.values()],
        items: carried.map((i) => ({
          id: i.id,
          title: i.title,
          seriesId: i.seriesId,
          meetingId: i.meetingId,
          carryCount: i.carryCount,
          firstRaisedMeetingId: i.firstRaisedMeetingId,
          status: i.status,
        })),
      };
    },
  );

  app.get(
    "/projects/:projectId/meeting-reports/overdue-actions",
    { preHandler: readGate },
    async (req) => {
      const today = todayISO();
      const rows = await app.db
        .select()
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.companyId, req.companyId!),
            eq(meetingActionItems.projectId, req.projectId!),
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          ),
        )
        .orderBy(asc(meetingActionItems.dueDate));
      const overdue = rows.filter((r) => r.dueDate != null && r.dueDate < today);
      const byOwner = new Map<string, { owner: string; count: number; worstDays: number }>();
      for (const r of overdue) {
        const owner = r.ownerId ?? r.ownerName ?? "unassigned";
        const days = r.dueDate
          ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.dueDate}T00:00:00Z`)) / 86_400_000)
          : 0;
        const entry = byOwner.get(owner) ?? { owner, count: 0, worstDays: 0 };
        entry.count += 1;
        entry.worstDays = Math.max(entry.worstDays, days);
        byOwner.set(owner, entry);
      }
      return {
        asOf: today,
        sweptBy: SWEEP_NOTE,
        summary: {
          openActions: rows.length,
          overdue: overdue.length,
          promotedToObligations: rows.filter((r) => r.obligationId != null).length,
          unassigned: overdue.filter((r) => !r.ownerId && !r.ownerName).length,
          reasons:
            rows.length === 0
              ? ["No open action items on this project — there is nothing to be overdue."]
              : [],
        },
        byOwner: [...byOwner.values()].sort((a, b) => b.count - a.count),
        items: overdue.map((r) => ({
          id: r.id,
          reference: r.reference,
          title: r.title,
          status: r.status,
          priority: r.priority,
          ownerId: r.ownerId,
          ownerName: r.ownerName,
          dueDate: r.dueDate,
          originalDueDate: r.originalDueDate,
          revisedCount: r.revisedCount,
          carryCount: r.carryCount,
          meetingId: r.meetingId,
          seriesId: r.seriesId,
          signalId: r.signalId,
          obligationId: r.obligationId,
        })),
      };
    },
  );

  /* ================================================================ */
  /* 9. Company-level: my actions across every project                 */
  /* ================================================================ */

  app.get("/meeting-action-items/mine", { preHandler: companyRead }, async (req) => {
    const q = pageQuerySchema
      .extend({ includeClosed: z.enum(["0", "1"]).default("0") })
      .parse(req.query);
    const today = todayISO();
    const where = and(
      eq(meetingActionItems.companyId, req.companyId!),
      eq(meetingActionItems.ownerId, req.user!.id),
      q.includeClosed === "1"
        ? undefined
        : inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetingActionItems).where(where);
    const items = await app.db
      .select()
      .from(meetingActionItems)
      .where(where)
      .orderBy(asc(meetingActionItems.dueDate))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return {
      ...paginate(
        items.map((i) => ({
          ...i,
          isOverdue:
            OPEN_ACTION_STATES.includes(i.status as (typeof OPEN_ACTION_STATES)[number]) &&
            i.dueDate != null &&
            i.dueDate < today,
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      asOf: today,
      sweptBy: SWEEP_NOTE,
    };
  });

  /** Company-level view: every overdue action across the tenant. */
  app.get("/meeting-action-items/overdue", { preHandler: companyScopedRead }, async (req) => {
    const scope = companyScopeOf(req, "meetings");
    const today = todayISO();
    const rows = await app.db
      .select()
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.companyId, req.companyId!),
          scopeProjects(scope, meetingActionItems.projectId),
          inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          lt(meetingActionItems.dueDate, today),
        ),
      )
      .orderBy(asc(meetingActionItems.dueDate));
    const byProject = new Map<string, number>();
    for (const r of rows) byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
    return {
      asOf: today,
      sweptBy: SWEEP_NOTE,
      scope: scope.all ? "all_projects" : `${scope.projectIds.length} project(s) you hold meetings on`,
      total: rows.length,
      byProject: [...byProject.entries()].map(([projectId, overdue]) => ({ projectId, overdue })),
      items: rows,
    };
  });

  /* ================================================================ */
  /* 10. The agenda template library (#416)                            */
  /*                                                                   */
  /* A progress meeting's agenda is an ORGANISATIONAL standard, not a   */
  /* per-series invention. Before this, `agendaTemplate` could only be  */
  /* typed into one series through the API — the web app never sent it  */
  /* — so every generated occurrence started empty and the standing     */
  /* eighth item ("safety moment") quietly stopped appearing.           */
  /*                                                                   */
  /* Applying a template COPIES it. Referencing it would let a later    */
  /* edit of the library change minutes that were issued last March.    */
  /* ================================================================ */

  const templateItemsSchema = z.array(agendaTemplateSchema).max(200);

  const templateCreateSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    meetingType: z.enum(MEETING_TYPES).optional(),
    projectId: z.string().max(64).nullable().optional(),
    items: templateItemsSchema.optional(),
    defaultAttendees: z.array(attendeeTemplateSchema).max(200).optional(),
    contractRequirement: z.string().max(300).nullable().optional(),
    isDefault: z.boolean().optional(),
  });

  const templatePatchSchema = templateCreateSchema.partial().extend({
    status: z.enum(["active", "archived"]).optional(),
  });

  async function fetchTemplate(req: FastifyRequest, templateId: string) {
    const rows = await app.db
      .select()
      .from(meetingAgendaTemplates)
      .where(
        and(
          eq(meetingAgendaTemplates.id, templateId),
          eq(meetingAgendaTemplates.companyId, req.companyId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Agenda template not found");
    return rows[0];
  }

  app.get("/meeting-agenda-templates", { preHandler: companyScopedRead }, async (req) => {
    const q = pageQuerySchema
      .extend({
        meetingType: z.enum(MEETING_TYPES).optional(),
        status: z.enum(["active", "archived"]).optional(),
        projectId: z.string().max(64).optional(),
      })
      .parse(req.query);
    const scope = companyScopeOf(req, "meetings");
    const where = and(
      eq(meetingAgendaTemplates.companyId, req.companyId!),
      q.meetingType ? eq(meetingAgendaTemplates.meetingType, q.meetingType) : undefined,
      eq(meetingAgendaTemplates.status, q.status ?? "active"),
      q.projectId ? eq(meetingAgendaTemplates.projectId, q.projectId) : undefined,
      /* Company-wide templates (projectId null) are tenant assets and stay
         visible to anyone who holds the tool anywhere; a project-scoped one
         is project data and obeys the caller's project scope. */
      scopeProjectsOrCompanyWide(scope, meetingAgendaTemplates.projectId),
    );
    const [totalRow] = await app.db
      .select({ n: count() })
      .from(meetingAgendaTemplates)
      .where(where);
    const items = await app.db
      .select()
      .from(meetingAgendaTemplates)
      .where(where)
      .orderBy(desc(meetingAgendaTemplates.isDefault), asc(meetingAgendaTemplates.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      items.map((t) => ({
        ...t,
        itemCount: ((t.items as unknown[]) ?? []).length,
        inviteeCount: ((t.defaultAttendees as unknown[]) ?? []).length,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.post("/meeting-agenda-templates", { preHandler: companyTemplateAdmin }, async (req, reply) => {
    const body = templateCreateSchema.parse(req.body);
    if (body.projectId) {
      const scope = companyScopeOf(req, "meetings");
      if (!scopeAllows(scope, body.projectId)) {
        throw forbidden("You do not hold meetings admin on that project");
      }
      const [p] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!p) throw badRequest("projectId is not a project in this company");
    }
    const id = newId("magt");
    await app.db.insert(meetingAgendaTemplates).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
      description: body.description ?? null,
      meetingType: body.meetingType ?? "progress",
      items: body.items ?? [],
      defaultAttendees: body.defaultAttendees ?? [],
      contractRequirement: body.contractRequirement ?? null,
      isDefault: body.isDefault ? 1 : 0,
      status: "active",
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "meeting_agenda_template",
      objectId: id,
      payload: { name: body.name, meetingType: body.meetingType ?? "progress", items: (body.items ?? []).length },
      projectId: body.projectId ?? null,
    });
    return reply.status(201).send(await fetchTemplate(req, id));
  });

  app.patch(
    "/meeting-agenda-templates/:templateId",
    { preHandler: companyTemplateAdmin },
    async (req) => {
      const { templateId } = req.params as { templateId: string };
      const body = templatePatchSchema.parse(req.body);
      const row = await fetchTemplate(req, templateId);
      const scope = companyScopeOf(req, "meetings");
      if (!scopeAllows(scope, row.projectId)) {
        throw forbidden("You do not hold meetings admin on that project");
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        set[k] = k === "isDefault" ? (v ? 1 : 0) : v;
      }
      await app.db
        .update(meetingAgendaTemplates)
        .set(set)
        .where(eq(meetingAgendaTemplates.id, templateId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "meeting_agenda_template",
        objectId: templateId,
        payload: { changed: Object.keys(body) },
        projectId: row.projectId,
      });
      return fetchTemplate(req, templateId);
    },
  );

  /**
   * Copy a library template onto a SERIES: its standing agenda and its
   * standing invitees become the series' own, so every occurrence generated
   * from then on carries them. `mode: "replace" | "append"` because a series
   * that already has a bespoke tail should not silently lose it.
   */
  app.post(
    "/projects/:projectId/meeting-series/:seriesId/apply-template",
    { preHandler: standardGate },
    async (req) => {
      const { seriesId } = req.params as { seriesId: string };
      const body = z
        .object({
          templateId: z.string().min(1).max(64),
          mode: z.enum(["replace", "append"]).default("replace"),
          includeAttendees: z.boolean().default(true),
        })
        .parse(req.body);
      const series = await fetchSeries(req, seriesId);
      const template = await fetchTemplate(req, body.templateId);
      if (template.projectId && template.projectId !== req.projectId) {
        throw badRequest("That template belongs to a different project");
      }
      if (template.status !== "active") throw conflict("That template is archived");

      const parsedItems = templateItemsSchema.safeParse(template.items);
      if (!parsedItems.success) {
        throw badRequest(
          "This template's items are not a readable agenda — it was written by an older " +
            "version and must be re-saved before it can be applied.",
        );
      }
      const existing = body.mode === "append" ? ((series.agendaTemplate as unknown[]) ?? []) : [];
      const merged = [...existing, ...parsedItems.data].map((raw, i) => {
        const item = raw as Record<string, unknown>;
        return { ...item, position: i };
      });
      const attendees =
        body.includeAttendees && ((template.defaultAttendees as unknown[]) ?? []).length > 0
          ? body.mode === "append"
            ? [...((series.defaultAttendees as unknown[]) ?? []), ...((template.defaultAttendees as unknown[]) ?? [])]
            : ((template.defaultAttendees as unknown[]) ?? [])
          : ((series.defaultAttendees as unknown[]) ?? []);

      await app.db
        .update(meetingSeries)
        .set({
          agendaTemplate: merged,
          defaultAttendees: attendees,
          contractRequirement: series.contractRequirement ?? template.contractRequirement,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(meetingSeries.id, seriesId));
      await app.db
        .update(meetingAgendaTemplates)
        .set({ usageCount: template.usageCount + 1 })
        .where(eq(meetingAgendaTemplates.id, template.id));
      await ledger("update", "meeting_series", seriesId, req, {
        appliedTemplateId: template.id,
        templateName: template.name,
        mode: body.mode,
        agendaItems: merged.length,
        invitees: attendees.length,
      });
      return {
        ...(await fetchSeries(req, seriesId)),
        appliedTemplate: { id: template.id, name: template.name, items: merged.length },
      };
    },
  );

  /** Copy a template's items straight onto ONE occurrence. */
  app.post(
    "/projects/:projectId/meetings/:meetingId/apply-template",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z.object({ templateId: z.string().min(1).max(64) }).parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (meeting.minutesIssuedAt) {
        throw conflict("The agenda of a meeting whose minutes are issued is history, not a plan");
      }
      const template = await fetchTemplate(req, body.templateId);
      if (template.projectId && template.projectId !== req.projectId) {
        throw badRequest("That template belongs to a different project");
      }
      const parsedItems = templateItemsSchema.safeParse(template.items);
      if (!parsedItems.success) throw badRequest("This template's items are not a readable agenda");
      const [countRow] = await app.db
        .select({ n: count() })
        .from(meetingAgendaItems)
        .where(eq(meetingAgendaItems.meetingId, meetingId));
      let position = Number(countRow?.n ?? 0);
      const created: string[] = [];
      for (const item of parsedItems.data) {
        const id = newId("magi");
        await app.db.insert(meetingAgendaItems).values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          meetingId,
          seriesId: meeting.seriesId,
          itemNumber: item.itemNumber ?? null,
          position: position++,
          title: item.title,
          category: item.category ?? "other",
          status: "open",
          allocatedMinutes: item.allocatedMinutes ?? null,
          firstRaisedMeetingId: meetingId,
          detail: { fromTemplate: true, templateId: template.id },
          createdBy: req.user!.id,
        });
        created.push(id);
      }
      await app.db
        .update(meetingAgendaTemplates)
        .set({ usageCount: template.usageCount + 1 })
        .where(eq(meetingAgendaTemplates.id, template.id));
      await ledger("update", "meeting", meetingId, req, {
        appliedTemplateId: template.id,
        agendaItemsCreated: created.length,
      });
      return { meetingId, templateId: template.id, created: created.length, itemIds: created };
    },
  );

  /* ================================================================ */
  /* 11. THE MINUTES AS A DOCUMENT (#422, #425)                        */
  /*                                                                   */
  /* Deemed acceptance is the sharpest rule in this module: after the   */
  /* objection period, silence becomes agreement. A clock that starts   */
  /* when the sender clicks a button, against a body of text that can   */
  /* be edited afterwards, is indefensible. So the minutes are RENDERED */
  /* into a self-contained document, CONTENT-ADDRESSED (sha256 on the   */
  /* meeting and in the ledger), DELIVERED to a recorded list of        */
  /* recipients, and the objection window runs from the earliest        */
  /* delivery — falling back to issue only where no delivery is known,  */
  /* and saying so.                                                    */
  /* ================================================================ */

  /**
   * Assemble the structural model the renderer needs. Kept out of the route
   * so both documents (the agenda pack before, the minutes after) come from
   * one place and cannot drift apart.
   */
  async function buildDocumentModel(
    req: FastifyRequest,
    meeting: typeof meetings.$inferSelect,
    kind: "agenda_pack" | "minutes",
    renderedAt: string,
  ): Promise<MinutesModel> {
    const [project] = await app.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, meeting.projectId))
      .limit(1);
    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, meeting.companyId))
      .limit(1);
    const series = meeting.seriesId
      ? (
          await app.db
            .select({ title: meetingSeries.title })
            .from(meetingSeries)
            .where(eq(meetingSeries.id, meeting.seriesId))
            .limit(1)
        )[0]
      : undefined;

    const attendeeRows = await loadAttendees(meeting.id);
    const agendaRows = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(eq(meetingAgendaItems.meetingId, meeting.id))
      .orderBy(asc(meetingAgendaItems.position));
    const decisionRows =
      kind === "minutes"
        ? await app.db
            .select()
            .from(meetingDecisions)
            .where(eq(meetingDecisions.meetingId, meeting.id))
            .orderBy(asc(meetingDecisions.number))
        : [];
    const actionRows = await app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.meetingId, meeting.id))
      .orderBy(asc(meetingActionItems.number));

    const idsNeeded = [
      meeting.chairId,
      meeting.minuteTakerId,
      req.user!.id,
      ...agendaRows.map((a) => a.presenterId),
      ...decisionRows.map((d) => d.decidedById),
      ...decisionRows.map((d) => d.ratifiedBy),
      ...actionRows.map((a) => a.ownerId),
      ...((meeting.distribution as string[]) ?? []),
    ];
    const wanted = [...new Set(idsNeeded.filter((v): v is string => Boolean(v)))];
    const nameRows = wanted.length
      ? await app.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
          .where(
            and(
              eq(companyMemberships.companyId, meeting.companyId),
              inArray(users.id, wanted),
            ),
          )
      : [];
    const names = new Map(nameRows.map((r) => [r.id, r.name ?? r.email]));
    const nameOf = (id: string | null): string | null => (id ? (names.get(id) ?? id) : null);

    const attendees: MinutesAttendee[] = attendeeRows.map((a) => ({
      name: a.name,
      organisation: a.organisation,
      role: a.role,
      attendance: a.attendance,
      delegateName: a.delegateName,
    }));
    const agendaItems: MinutesAgendaItem[] = agendaRows.map((a) => ({
      itemNumber: a.itemNumber,
      position: a.position,
      title: a.title,
      category: a.category,
      status: a.status,
      description: a.description,
      discussion: kind === "minutes" ? a.discussion : null,
      carryCount: a.carryCount,
      allocatedMinutes: a.allocatedMinutes,
      presenterName: nameOf(a.presenterId),
      linkLabel: a.originType && a.originId ? `${a.originType} ${a.originId}` : null,
    }));
    const decisions: MinutesDecision[] = decisionRows.map((d) => ({
      reference: d.reference,
      title: d.title,
      decision: d.decision,
      rationale: d.rationale,
      decidedByName: d.decidedByName ?? nameOf(d.decidedById),
      status: d.status,
      ratifiedByName: nameOf(d.ratifiedBy),
      impactsCost: d.impactsCost,
      estimatedCostImpact: d.estimatedCostImpact,
      currency: d.currency,
      impactsSchedule: d.impactsSchedule,
      estimatedScheduleImpactDays: d.estimatedScheduleImpactDays,
    }));
    const actions: MinutesAction[] = actionRows.map((a) => ({
      reference: a.reference,
      title: a.title,
      ownerLabel: a.ownerName ?? nameOf(a.ownerId) ?? "not assigned",
      dueDate: a.dueDate,
      originalDueDate: a.originalDueDate,
      status: a.status,
      priority: a.priority,
      carryCount: a.carryCount,
      revisedCount: a.revisedCount,
      obligationId: a.obligationId,
      sourceClause: a.sourceClause,
    }));

    const quorum = checkQuorum(
      attendeeRows.map((a) => ({ role: a.role, attendance: a.attendance })),
      meeting.quorumRequired,
    );

    return {
      kind,
      projectName: project?.name ?? null,
      companyName: company?.name ?? null,
      seriesTitle: series?.title ?? null,
      meeting: {
        reference: meeting.reference,
        title: meeting.title,
        meetingType: meeting.meetingType,
        status: meeting.status,
        occurrenceNumber: meeting.occurrenceNumber,
        scheduledStart: meeting.scheduledStart,
        actualStart: meeting.actualStart,
        actualEnd: meeting.actualEnd,
        location: meeting.location,
        isVirtual: meeting.isVirtual,
        chairName: nameOf(meeting.chairId),
        minuteTakerName: nameOf(meeting.minuteTakerId),
        quorumRequired: meeting.quorumRequired,
        minutesBody: kind === "minutes" ? meeting.minutesBody : null,
        objectionPeriodDays: meeting.objectionPeriodDays,
        minutesVersion: Math.max(1, meeting.minutesVersion),
      },
      attendees,
      agendaItems,
      decisions,
      actions,
      quorum: {
        met: quorum.met,
        required: quorum.required,
        counted: quorum.counted,
        reasons: quorum.reasons,
      },
      renderedAt,
      renderedByName: nameOf(req.user!.id),
      recipients: ((meeting.distribution as string[]) ?? []).map((id) => nameOf(id) ?? id),
    };
  }

  /**
   * Render, hash and store one document. Returns the file row id and the
   * sha256 — the address that makes "these are the minutes that were issued"
   * checkable a year later.
   */
  async function renderAndStore(
    req: FastifyRequest,
    meeting: typeof meetings.$inferSelect,
    kind: "agenda_pack" | "minutes",
  ) {
    const renderedAt = new Date().toISOString();
    const model = await buildDocumentModel(req, meeting, kind, renderedAt);
    const { html, contentType } = renderMeetingDocument(model);
    const buf = Buffer.from(html, "utf8");
    const saved = await app.storage.saveBuffer(req.companyId!, buf);
    const version = kind === "minutes" ? Math.max(1, meeting.minutesVersion) : meeting.minutesVersion;
    const fileId = newId("fil");
    await app.db.insert(files).values({
      id: fileId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      folderId: null,
      name:
        kind === "minutes"
          ? `${meeting.reference}-minutes-v${version}.html`
          : `${meeting.reference}-agenda.html`,
      contentType,
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
      documentType: "meeting",
      metadata: { meetingId: meeting.id, kind, minutesVersion: version, renderedAt },
      uploadedBy: req.user!.id,
    });
    const set: Record<string, unknown> =
      kind === "minutes"
        ? {
            minutesFileId: fileId,
            minutesSha256: saved.sha256,
            minutesRenderedAt: renderedAt,
            updatedAt: renderedAt,
          }
        : { agendaPackFileId: fileId, agendaPackSha256: saved.sha256, updatedAt: renderedAt };
    await app.db.update(meetings).set(set).where(eq(meetings.id, meeting.id));
    await ledger("create", "meeting_document", fileId, req, {
      meetingId: meeting.id,
      kind,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes,
      minutesVersion: version,
      /* The hash is ledgered because the ledger is hash-chained: a later copy
         that differs in a single byte will not match this entry. */
    });
    return { fileId, sha256: saved.sha256, sizeBytes: saved.sizeBytes, contentType, renderedAt, html };
  }

  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/render",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({ kind: z.enum(MEETING_DOCUMENT_KINDS).default("minutes") })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      if (meeting.status === "cancelled") throw badRequest("A cancelled meeting has no document");
      if (body.kind === "minutes" && !meeting.minutesBody && !meeting.minutesFileId) {
        throw badRequest(
          "There are no minutes to render yet — draft them first. An empty document with a " +
            "hash on it is still an empty document.",
        );
      }
      const out = await renderAndStore(req, meeting, body.kind);
      return {
        meetingId,
        kind: body.kind,
        fileId: out.fileId,
        sha256: out.sha256,
        sizeBytes: out.sizeBytes,
        contentType: out.contentType,
        renderedAt: out.renderedAt,
        minutesVersion: Math.max(1, meeting.minutesVersion),
      };
    },
  );

  /** The rendered document itself, for preview and printing. */
  app.get(
    "/projects/:projectId/meetings/:meetingId/minutes/document",
    { preHandler: readGate },
    async (req, reply) => {
      const { meetingId } = req.params as { meetingId: string };
      const q = z
        .object({ kind: z.enum(MEETING_DOCUMENT_KINDS).default("minutes") })
        .parse(req.query ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      const fileId = q.kind === "minutes" ? meeting.minutesFileId : meeting.agendaPackFileId;
      if (!fileId) {
        throw notFound(
          `No ${q.kind === "minutes" ? "minutes" : "agenda pack"} has been rendered for this ` +
            "meeting. Render it first — this route returns the stored bytes, never a fresh " +
            "render, so what it serves is what was hashed.",
        );
      }
      const [file] = await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.companyId, req.companyId!)))
        .limit(1);
      if (!file) throw notFound("The stored document is missing from the file register");
      const chunks: Buffer[] = [];
      for await (const chunk of app.storage.readStream(file.storageKey)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return reply
        .header("content-type", file.contentType)
        .header("x-document-sha256", file.sha256)
        .send(Buffer.concat(chunks).toString("utf8"));
    },
  );

  /** Who the issued minutes went to, and what happened to each copy. */
  app.get(
    "/projects/:projectId/meetings/:meetingId/minutes/deliveries",
    { preHandler: readGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const meeting = await fetchMeeting(req, meetingId);
      const rows = await app.db
        .select()
        .from(meetingMinuteDeliveries)
        .where(eq(meetingMinuteDeliveries.meetingId, meetingId))
        .orderBy(desc(meetingMinuteDeliveries.minutesVersion), asc(meetingMinuteDeliveries.recipientName));
      const delivered = rows.filter((r) => r.status === "delivered" || r.status === "acknowledged");
      return {
        items: rows,
        total: rows.length,
        minutesVersion: meeting.minutesVersion,
        minutesSha256: meeting.minutesSha256,
        deliveredCount: delivered.length,
        acknowledgedCount: rows.filter((r) => r.status === "acknowledged").length,
        failedCount: rows.filter((r) => r.status === "failed").length,
        pendingCount: rows.filter((r) => r.status === "pending").length,
        objectionWindow: minutesWindow(meeting),
      };
    },
  );

  /** A recipient confirms receipt — the strongest form of delivery evidence. */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/deliveries/:deliveryId/acknowledge",
    { preHandler: readGate },
    async (req) => {
      const { meetingId, deliveryId } = req.params as { meetingId: string; deliveryId: string };
      const meeting = await fetchMeeting(req, meetingId);
      const [row] = await app.db
        .select()
        .from(meetingMinuteDeliveries)
        .where(
          and(
            eq(meetingMinuteDeliveries.id, deliveryId),
            eq(meetingMinuteDeliveries.meetingId, meetingId),
            eq(meetingMinuteDeliveries.companyId, req.companyId!),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Delivery record not found");
      if (row.userId && row.userId !== req.user!.id) {
        throw forbidden(
          "Only the recipient can acknowledge their own copy — an acknowledgement someone " +
            "else pressed is not evidence of anything.",
        );
      }
      if (row.status === "acknowledged") return row;
      const now = new Date().toISOString();
      await app.db
        .update(meetingMinuteDeliveries)
        .set({ status: "acknowledged", acknowledgedAt: now, deliveredAt: row.deliveredAt ?? now })
        .where(eq(meetingMinuteDeliveries.id, deliveryId));
      if (!meeting.minutesDeliveredAt) {
        await app.db
          .update(meetings)
          .set({ minutesDeliveredAt: row.deliveredAt ?? now, updatedAt: now })
          .where(eq(meetings.id, meetingId));
      }
      await ledger("update", "meeting", meetingId, req, {
        minutesAcknowledgedBy: req.user!.id,
        deliveryId,
        minutesVersion: row.minutesVersion,
      });
      const [after] = await app.db
        .select()
        .from(meetingMinuteDeliveries)
        .where(eq(meetingMinuteDeliveries.id, deliveryId))
        .limit(1);
      return after ?? row;
    },
  );

  /**
   * WITHDRAW ISSUED MINUTES SO THEY CAN BE CORRECTED.
   *
   * The deadlock this route resolves: saving a draft over issued minutes used
   * to regress the status while `minutesIssuedAt` stayed set, after which
   * neither /issue nor /approve would accept the meeting and it could never
   * reach `minutes_accepted`. Correction is now an explicit, ledgered act: it
   * bumps the version, clears the issue stamps, moves the live objections into
   * the history, and tells the previous recipients that what they received has
   * been withdrawn. A correction nobody is told about is a rewrite.
   */
  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/correct",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z.object({ reason: z.string().min(1).max(5000) }).parse(req.body);
      const meeting = await fetchMeeting(req, meetingId);
      if (!meeting.minutesIssuedAt) {
        throw badRequest("These minutes have not been issued, so there is nothing to withdraw");
      }
      if (meeting.approvedAt) {
        throw conflict(
          "These minutes have been signed off. A signed record is corrected by a decision at " +
            "the next occurrence, not by rewriting it.",
        );
      }
      const now = new Date().toISOString();
      const detail = detailOf(meeting);
      const live = (detail["objections"] as unknown[] | undefined) ?? [];
      const history = (detail["objectionHistory"] as unknown[] | undefined) ?? [];
      const version = Math.max(1, meeting.minutesVersion);
      await app.db
        .update(meetings)
        .set({
          status: "minutes_draft",
          minutesIssuedAt: null,
          minutesIssuedBy: null,
          minutesDeliveredAt: null,
          minutesVersion: version + 1,
          detail: {
            ...detail,
            objections: [],
            objectionHistory: [
              ...history,
              { version, withdrawnAt: now, withdrawnBy: req.user!.id, reason: body.reason, objections: live },
            ],
          },
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "minutes_draft",
        withdrawnVersion: version,
        newVersion: version + 1,
        reason: body.reason,
        previouslyIssuedBy: meeting.minutesIssuedBy,
        previouslyIssuedAt: meeting.minutesIssuedAt,
        objectionsCarriedToHistory: live.length,
      });
      const previous = await app.db
        .select({ userId: meetingMinuteDeliveries.userId })
        .from(meetingMinuteDeliveries)
        .where(
          and(
            eq(meetingMinuteDeliveries.meetingId, meetingId),
            eq(meetingMinuteDeliveries.minutesVersion, version),
            isNotNull(meetingMinuteDeliveries.userId),
          ),
        );
      await pushNotifications(
        app.db,
        [...new Set(previous.map((p) => p.userId).filter((v): v is string => Boolean(v)))].map(
          (userId) => ({
            companyId: req.companyId!,
            userId,
            projectId: req.projectId!,
            kind: "status_change" as const,
            title: `Minutes withdrawn for correction: ${meeting.reference}`,
            body: body.reason,
            recordType: "meeting",
            recordId: meetingId,
          }),
        ),
      );
      const after = await fetchMeeting(req, meetingId);
      return { ...after, minutesObjectionWindow: minutesWindow(after) };
    },
  );

  /* ================================================================ */
  /* 12. RAISING A REAL RECORD FROM AN AGENDA ITEM (#424)               */
  /*                                                                   */
  /* `originType`/`originId` were free text: a note that looks like a   */
  /* link and that nothing downstream can verify or follow. Raising an  */
  /* RFI, a change event or a risk from an item now creates the record, */
  /* writes a `record_links` edge both ways, and shows the target's     */
  /* LIVE status on the agenda row — so an item whose RFI has been      */
  /* answered stops being carried forward out of habit.                */
  /* ================================================================ */

  const RAISE_TARGET_TABLES = {
    rfi: { type: "rfi", label: "RFI" },
    change_event: { type: "change_event", label: "change event" },
    risk: { type: "risk", label: "risk" },
  } as const;

  /** The live state of a linked record, whatever kind it is. */
  async function resolveLinkedRecord(
    companyId: string,
    projectId: string,
    type: string,
    id: string,
  ): Promise<{ type: string; id: string; reference: string; title: string; status: string } | null> {
    if (type === "rfi") {
      const [r] = await app.db
        .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, status: rfis.status })
        .from(rfis)
        .where(and(eq(rfis.id, id), eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)))
        .limit(1);
      return r
        ? { type, id: r.id, reference: `RFI-${String(r.number).padStart(3, "0")}`, title: r.subject, status: r.status }
        : null;
    }
    if (type === "change_event") {
      const [r] = await app.db
        .select({
          id: changeEvents.id,
          reference: changeEvents.reference,
          title: changeEvents.title,
          status: changeEvents.status,
        })
        .from(changeEvents)
        .where(
          and(
            eq(changeEvents.id, id),
            eq(changeEvents.companyId, companyId),
            eq(changeEvents.projectId, projectId),
          ),
        )
        .limit(1);
      return r ? { type, id: r.id, reference: r.reference, title: r.title, status: r.status } : null;
    }
    if (type === "risk") {
      const [r] = await app.db
        .select({ id: risks.id, number: risks.number, title: risks.title, status: risks.status })
        .from(risks)
        .where(and(eq(risks.id, id), eq(risks.companyId, companyId), eq(risks.projectId, projectId)))
        .limit(1);
      return r
        ? { type, id: r.id, reference: `RSK-${String(r.number).padStart(3, "0")}`, title: r.title, status: r.status }
        : null;
    }
    return null;
  }

  async function linkRecords(
    req: FastifyRequest,
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    linkKind: string,
  ) {
    const existing = await app.db
      .select({ id: recordLinks.id })
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, req.companyId!),
          eq(recordLinks.fromType, fromType),
          eq(recordLinks.fromId, fromId),
          eq(recordLinks.toType, toType),
          eq(recordLinks.toId, toId),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;
    const id = newId("rlk");
    await app.db.insert(recordLinks).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      fromType,
      fromId,
      toType,
      toId,
      linkKind,
      createdBy: req.user!.id,
    });
    return id;
  }

  app.post(
    "/projects/:projectId/meeting-agenda-items/:itemId/raise",
    { preHandler: standardGate },
    async (req, reply) => {
      const { itemId } = req.params as { itemId: string };
      const body = z
        .object({
          target: z.enum(MEETING_RAISE_TARGETS),
          title: z.string().min(1).max(300).optional(),
          detail: z.string().max(20_000).optional(),
          dueDate: isoDateSchema.nullable().optional(),
          assigneeId: z.string().max(64).nullable().optional(),
          category: z.string().max(60).optional(),
          closeItem: z.boolean().default(false),
        })
        .parse(req.body);
      const item = await fetchAgendaItem(req, itemId);
      if (item.carriedForwardToItemId) {
        throw badRequest("Raise from the live occurrence of this item, not the carried copy");
      }
      const title = body.title ?? item.title;
      const description = body.detail ?? item.discussion ?? item.description ?? null;
      const meta = RAISE_TARGET_TABLES[body.target];
      let createdId: string;
      let reference: string;

      if (body.target === "rfi") {
        if (body.assigneeId) {
          const [u] = await app.db
            .select({ id: users.id })
            .from(users)
            .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
            .where(
              and(
                eq(users.id, body.assigneeId),
                eq(companyMemberships.companyId, req.companyId!),
              ),
            )
            .limit(1);
          if (!u) throw badRequest("assigneeId is not a user in this company");
        }
        const number = await nextRecordNumber(app.db, req.projectId!, "rfi");
        createdId = newId("rfi");
        reference = `RFI-${String(number).padStart(3, "0")}`;
        await app.db.insert(rfis).values({
          id: createdId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          subject: title,
          question:
            description ??
            `Raised from meeting agenda item "${item.title}". The question was not written down ` +
              `at the meeting and must be completed before this RFI is issued.`,
          status: "draft",
          assigneeId: body.assigneeId ?? null,
          ballInCourtId: body.assigneeId ?? null,
          dueDate: body.dueDate ?? null,
          source: "manual",
          sourceMeta: { raisedFrom: "meeting_agenda_item", agendaItemId: item.id, meetingId: item.meetingId },
          createdBy: req.user!.id,
        });
      } else if (body.target === "change_event") {
        const number = await nextRecordNumber(app.db, req.projectId!, "change_event");
        createdId = newId("ce");
        reference = `CE-${String(number).padStart(3, "0")}`;
        await app.db.insert(changeEvents).values({
          id: createdId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          reference,
          title,
          description,
          status: "open",
          eventType: "other",
          scope: "tbd",
          originType: "meeting",
          originId: item.meetingId,
          dueDate: body.dueDate ?? null,
          detail: { agendaItemId: item.id },
          createdBy: req.user!.id,
        });
      } else {
        const number = await nextRecordNumber(app.db, req.projectId!, "risk");
        createdId = newId("risk");
        reference = `RSK-${String(number).padStart(3, "0")}`;
        await app.db.insert(risks).values({
          id: createdId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          title,
          description,
          category: "other",
          status: "open",
          ownerId: body.assigneeId ?? null,
          createdBy: req.user!.id,
        });
      }

      await linkRecords(req, "meeting_agenda_item", item.id, meta.type, createdId, "raised_from");
      await linkRecords(req, meta.type, createdId, "meeting_agenda_item", item.id, "tabled_at");
      if (item.meetingId) {
        await linkRecords(req, meta.type, createdId, "meeting", item.meetingId, "tabled_at");
      }

      const now = new Date().toISOString();
      const raised = ((detailOf(item)["raised"] as unknown[] | undefined) ?? []).concat([
        { type: meta.type, id: createdId, reference, at: now, by: req.user!.id },
      ]);
      await app.db
        .update(meetingAgendaItems)
        .set({
          detail: { ...detailOf(item), raised },
          originType: item.originType ?? meta.type,
          originId: item.originId ?? createdId,
          status: body.closeItem ? "closed" : item.status,
          closedAt: body.closeItem ? now : item.closedAt,
          closedBy: body.closeItem ? req.user!.id : item.closedBy,
          updatedAt: now,
        })
        .where(eq(meetingAgendaItems.id, item.id));

      await ledger("create", meta.type, createdId, req, {
        raisedFromAgendaItemId: item.id,
        meetingId: item.meetingId,
        reference,
        title,
      });
      await ledger("update", "meeting_agenda_item", item.id, req, {
        raised: { type: meta.type, id: createdId, reference },
        closed: body.closeItem === true,
      });
      return reply.status(201).send({
        agendaItemId: item.id,
        raised: { type: meta.type, id: createdId, reference, label: meta.label },
        itemStatus: body.closeItem ? "closed" : item.status,
      });
    },
  );

  /** Every record this agenda item is linked to, with its LIVE status. */
  app.get(
    "/projects/:projectId/meeting-agenda-items/:itemId/links",
    { preHandler: readGate },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const item = await fetchAgendaItem(req, itemId);
      const edges = await app.db
        .select()
        .from(recordLinks)
        .where(
          and(
            eq(recordLinks.companyId, req.companyId!),
            eq(recordLinks.projectId, req.projectId!),
            eq(recordLinks.fromType, "meeting_agenda_item"),
            eq(recordLinks.fromId, itemId),
          ),
        );
      const items: Array<Record<string, unknown>> = [];
      const unresolved: Array<Record<string, unknown>> = [];
      for (const edge of edges) {
        const live = await resolveLinkedRecord(req.companyId!, req.projectId!, edge.toType, edge.toId);
        if (live) items.push({ ...live, linkKind: edge.linkKind, linkedAt: edge.createdAt });
        else {
          unresolved.push({
            type: edge.toType,
            id: edge.toId,
            linkKind: edge.linkKind,
            reason:
              "The linked record could not be read — either this platform does not resolve that " +
              "type yet, or the record has been deleted. It is shown rather than hidden.",
          });
        }
      }
      return { agendaItemId: item.id, items, unresolved, total: items.length + unresolved.length };
    },
  );

  /**
   * THE REVERSE VIEW: which meetings tabled this record. An RFI's own page
   * can ask "where was this discussed?" and get an answer, which is the half
   * of #424 a one-way link never provides.
   */
  app.get("/projects/:projectId/meeting-links", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ recordType: z.string().min(1).max(60), recordId: z.string().min(1).max(64) })
      .parse(req.query);
    const edges = await app.db
      .select()
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, req.companyId!),
          eq(recordLinks.projectId, req.projectId!),
          eq(recordLinks.fromType, q.recordType),
          eq(recordLinks.fromId, q.recordId),
          inArray(recordLinks.toType, ["meeting", "meeting_agenda_item"]),
        ),
      );
    const meetingIds = new Set<string>();
    for (const e of edges) {
      if (e.toType === "meeting") meetingIds.add(e.toId);
    }
    const itemIds = edges.filter((e) => e.toType === "meeting_agenda_item").map((e) => e.toId);
    const itemRows = itemIds.length
      ? await app.db
          .select()
          .from(meetingAgendaItems)
          .where(
            and(
              eq(meetingAgendaItems.companyId, req.companyId!),
              inArray(meetingAgendaItems.id, itemIds),
            ),
          )
      : [];
    for (const i of itemRows) meetingIds.add(i.meetingId);
    const meetingRows = meetingIds.size
      ? await app.db
          .select({
            id: meetings.id,
            reference: meetings.reference,
            title: meetings.title,
            status: meetings.status,
            scheduledStart: meetings.scheduledStart,
            occurrenceNumber: meetings.occurrenceNumber,
          })
          .from(meetings)
          .where(
            and(eq(meetings.companyId, req.companyId!), inArray(meetings.id, [...meetingIds])),
          )
          .orderBy(desc(meetings.scheduledStart))
      : [];
    return {
      recordType: q.recordType,
      recordId: q.recordId,
      meetings: meetingRows,
      agendaItems: itemRows.map((i) => ({
        id: i.id,
        meetingId: i.meetingId,
        title: i.title,
        status: i.status,
        carryCount: i.carryCount,
      })),
      total: meetingRows.length,
    };
  });

  /* ================================================================ */
  /* 13. Health inputs (contract 3.5)                                  */
  /* ================================================================ */

  app.get(
    "/projects/:projectId/meetings/health-inputs",
    { preHandler: readGate },
    async (req) => {
      const today = todayISO();
      const reasons: string[] = [];
      const [openRow] = await app.db
        .select({ n: count() })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.companyId, req.companyId!),
            eq(meetingActionItems.projectId, req.projectId!),
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          ),
        );
      const [overdueRow] = await app.db
        .select({ n: count() })
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.companyId, req.companyId!),
            eq(meetingActionItems.projectId, req.projectId!),
            inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
            lt(meetingActionItems.dueDate, today),
          ),
        );
      const [carriedRow] = await app.db
        .select({ n: count() })
        .from(meetingAgendaItems)
        .where(
          and(
            eq(meetingAgendaItems.companyId, req.companyId!),
            eq(meetingAgendaItems.projectId, req.projectId!),
            isNull(meetingAgendaItems.carriedForwardToItemId),
            ne(meetingAgendaItems.status, "closed"),
            gte(meetingAgendaItems.carryCount, CARRY_SIGNAL_THRESHOLD),
          ),
        );
      const [unissuedRow] = await app.db
        .select({ n: count() })
        .from(meetings)
        .where(
          and(
            eq(meetings.companyId, req.companyId!),
            eq(meetings.projectId, req.projectId!),
            eq(meetings.status, "held"),
            isNull(meetings.minutesIssuedAt),
          ),
        );
      const open = Number(openRow?.n ?? 0);
      const overdue = Number(overdueRow?.n ?? 0);
      if (open === 0) {
        reasons.push(
          "No open action items on this project — the overdue ratio is not a meaningful number " +
            "and is returned as null rather than 0%.",
        );
      }
      return {
        metrics: {
          openActionItems: open,
          overdueActionItems: overdue,
          overdueActionRatio: open === 0 ? null : Math.round((overdue / open) * 1000) / 1000,
          itemsCarriedOverThreshold: Number(carriedRow?.n ?? 0),
          heldMeetingsWithNoMinutesIssued: Number(unissuedRow?.n ?? 0),
        },
        reasons,
        asOf: today,
      };
    },
  );

  /* ================================================================ */
  /* 14. SCHEDULED SWEEPS                                              */
  /*                                                                   */
  /* These used to run as a side effect of somebody opening a list. A  */
  /* project nobody looked at was never warned, and the ledger         */
  /* attributed the resulting signals to whichever reader happened to  */
  /* trigger them — including read-only users. They run here, under    */
  /* the platform scheduler, with a null (system) actor.               */
  /* ================================================================ */

  /**
   * Warn BEFORE the objection window closes, not after it has.
   *
   * `warnDaysBefore` exists all over this platform and almost nothing emits
   * anything before a deadline. Deemed acceptance is the one clock where the
   * warning has to arrive early: once it runs out, silence has already done
   * its work and the record is settled.
   */
  async function sweepObjectionWindows(
    companyId: string,
    nowMs: number,
  ): Promise<{ warned: number; scanned: number }> {
    const candidates = await app.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.companyId, companyId),
          eq(meetings.status, "minutes_issued"),
          isNotNull(meetings.minutesIssuedAt),
          isNotNull(meetings.objectionPeriodDays),
          isNull(meetings.approvedAt),
        ),
      );
    if (candidates.length === 0) return { warned: 0, scanned: 0 };
    const keyOf = (m: typeof meetings.$inferSelect) => `${m.id}:v${Math.max(1, m.minutesVersion)}`;
    const seen = await alreadySignalled(companyId, OBJECTION_DETECTOR, candidates.map(keyOf));
    let warned = 0;
    for (const meeting of candidates) {
      const key = keyOf(meeting);
      if (seen.has(key)) continue;
      const window = computeObjectionWindow({
        minutesIssuedAt: meeting.minutesIssuedAt,
        minutesDeliveredAt: meeting.minutesDeliveredAt,
        objectionPeriodDays: meeting.objectionPeriodDays,
        approvedAt: meeting.approvedAt,
        objections:
          ((meeting.detail as Record<string, unknown> | null)?.["objections"] as
            | Array<{ resolvedAt?: unknown }>
            | undefined) ?? [],
        nowMs,
      });
      if (!window.closesAt || window.expired === true) continue;
      const msLeft = Date.parse(window.closesAt) - nowMs;
      if (msLeft > OBJECTION_WARN_DAYS * 86_400_000) continue;
      seen.add(key);
      const daysLeft = Math.max(0, Math.ceil(msLeft / 86_400_000));
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId: meeting.projectId,
        detector: OBJECTION_DETECTOR,
        severity: "medium",
        confidence: 1,
        title: `Objection period for ${meeting.reference} closes in ${daysLeft} day(s)`,
        explanation:
          `The minutes of "${meeting.title}" were issued on ${meeting.minutesIssuedAt} with a ` +
          `${meeting.objectionPeriodDays}-day objection period, measured from ` +
          `${window.runsFrom === "delivery" ? "delivery" : "issue"}. It closes on ` +
          `${window.closesAt}. After that, items not objected to are taken as an accurate ` +
          `record — so a disagreement raised afterwards is a new agenda item, not a correction. ` +
          `This warning exists because a deeming clock that only reports itself once it has run ` +
          `out has told you nothing you could act on.`,
        evidenceRefs: {
          key,
          meetingId: meeting.id,
          reference: meeting.reference,
          minutesVersion: Math.max(1, meeting.minutesVersion),
          closesAt: window.closesAt,
          runsFrom: window.runsFrom,
          openObjections: window.openObjections,
        },
      });
      await appendLedger(app.db, {
        companyId,
        actorId: null,
        action: "create",
        objectType: "signal",
        objectId: signalId,
        payload: { detector: OBJECTION_DETECTOR, meetingId: meeting.id, daysLeft },
        projectId: meeting.projectId,
      });
      await pushNotifications(
        app.db,
        [...new Set(((meeting.distribution as string[]) ?? []).concat(
          meeting.minuteTakerId ? [meeting.minuteTakerId] : [],
        ))].map((userId) => ({
          companyId,
          userId,
          projectId: meeting.projectId,
          kind: "due_soon" as const,
          title: `Objection period closes in ${daysLeft} day(s): ${meeting.reference}`,
          body: `After ${window.closesAt} the minutes are taken as an accurate record.`,
          recordType: "meeting",
          recordId: meeting.id,
        })),
      );
      warned += 1;
    }
    return { warned, scanned: candidates.length };
  }

  app.scheduler.register({
    name: "meetings.overdue-actions",
    description:
      "Raise a signal for every meeting action past its date that has not been promoted to an obligation — the sweep that used to run only when somebody opened the action list",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) =>
      forEachCompany(db, (companyId) => sweepOverdueActions(companyId, null, null)),
  });

  app.scheduler.register({
    name: "meetings.carried-items",
    description:
      "Signal agenda items that have survived three or more consecutive occurrences without being closed: an item carried that often is an undecided question, not an agenda item",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db }) => forEachCompany(db, (companyId) => sweepCarriedItems(companyId, null, null)),
  });

  app.scheduler.register({
    name: "meetings.objection-window",
    description:
      "Warn the distribution before an issued set of minutes is deemed accepted by silence, rather than reporting the deeming after it has happened",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) => sweepObjectionWindows(companyId, now.getTime())),
  });

  /**
   * Run the sweeps for one project on demand. Admin-gated because it WRITES:
   * the whole point of moving them off the read path was that a reader must
   * not create obligations and signals by opening a page.
   */
  app.post(
    "/projects/:projectId/meeting-reports/sweep",
    { preHandler: adminGate },
    async (req) => {
      const overdue = await sweepOverdueActions(req.companyId!, req.projectId!, req.user!.id);
      const carried = await sweepCarriedItems(req.companyId!, req.projectId!, req.user!.id);
      return {
        overdue,
        carried,
        note:
          "This is the manual trigger for the scheduled jobs meetings.overdue-actions and " +
          "meetings.carried-items. Signals are keyed on the record, so running it repeatedly " +
          "raises nothing twice.",
      };
    },
  );

};
