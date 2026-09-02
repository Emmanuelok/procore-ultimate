import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import {
  meetingActionItems,
  meetingAgendaItems,
  meetingAttendees,
  meetingDecisions,
  meetingSeries,
  meetings,
  obligations,
  signals,
} from "@constructos/db";
import {
  ACTION_ITEM_PRIORITIES,
  ACTION_ITEM_STATUSES,
  MEETING_AGENDA_ITEM_STATUSES,
  MEETING_ATTENDANCE_STATES,
  MEETING_ATTENDEE_ROLES,
  MEETING_ITEM_CATEGORIES,
  MEETING_RECURRENCES,
  MEETING_SERIES_STATUSES,
  MEETING_STATUSES,
  MEETING_TYPES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { pushNotifications } from "../notifications/service.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  checkQuorum,
  planOccurrences,
  ruleForRecurrence,
  UnsupportedRecurrenceRule,
} from "./recurrence.js";

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

const meetingPatchSchema = meetingCreateSchema.partial().extend({
  status: z.enum(MEETING_STATUSES).optional(),
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

const actionPatchSchema = actionCreateSchema.partial().extend({
  status: z.enum(ACTION_ITEM_STATUSES).optional(),
});

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

export const meetingsModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("meetings", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("meetings", "standard"),
  ];
  const adminGate = [app.authenticate, app.requireCompany, app.requireTool("meetings", "admin")];
  const companyRead = [app.authenticate, app.requireCompany];

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

  /** The objection period, and whether silence has run its course. */
  function minutesWindow(row: typeof meetings.$inferSelect) {
    const objections = (detailOf(row)["objections"] as unknown[] | undefined) ?? [];
    const openObjections = objections.filter(
      (o) => (o as { resolvedAt?: unknown } | null)?.resolvedAt == null,
    ).length;
    if (!row.minutesIssuedAt || row.objectionPeriodDays == null) {
      return {
        closesAt: null,
        expired: null,
        objections: objections.length,
        openObjections,
        deemedAccepted: null,
        reasons: [
          row.minutesIssuedAt
            ? "No objection period is recorded on this meeting, so nothing is deemed accepted."
            : "Minutes have not been issued, so no objection period is running.",
        ],
      };
    }
    const closesAt = new Date(
      Date.parse(row.minutesIssuedAt) + row.objectionPeriodDays * 86_400_000,
    ).toISOString();
    const expired = Date.now() > Date.parse(closesAt);
    return {
      closesAt,
      expired,
      objections: objections.length,
      openObjections,
      /*
       * "Deemed accepted" is REPORTED, never written: the status stays
       * minutes_issued until a human signs the minutes off. Silence has legal
       * weight, but it is not a signature and the record must not pretend it
       * is one.
       */
      deemedAccepted: expired && openObjections === 0 && row.approvedAt == null,
      reasons: [],
    };
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

  /** Signal keys already raised for a detector in this company (idempotence). */
  async function alreadySignalled(companyId: string, detector: string): Promise<Set<string>> {
    const rows = await app.db
      .select({ refs: signals.evidenceRefs })
      .from(signals)
      .where(and(eq(signals.companyId, companyId), eq(signals.detector, detector)));
    const keys = new Set<string>();
    for (const row of rows) {
      const refs = row.refs as { key?: unknown } | null;
      if (typeof refs?.key === "string") keys.add(refs.key);
    }
    return keys;
  }

  /* ---------------------------------------------------------------- */
  /* THE LAZY OVERDUE SWEEP                                            */
  /*                                                                   */
  /* Runs on action-item and report reads. Never a cron: an action     */
  /* nobody looks at harms nobody, and the read is the moment the      */
  /* answer has to be true. Idempotent twice over — the signal is      */
  /* keyed on the action id AND the action row records `signalId`.     */
  /* ---------------------------------------------------------------- */

  async function sweepOverdueActions(
    companyId: string,
    projectId: string | null,
    actorId: string,
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

    const seen = await alreadySignalled(companyId, OVERDUE_DETECTOR);
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
    projectId: string,
    actorId: string,
  ): Promise<{ raised: number }> {
    const rows = await app.db
      .select()
      .from(meetingAgendaItems)
      .where(
        and(
          eq(meetingAgendaItems.companyId, companyId),
          eq(meetingAgendaItems.projectId, projectId),
          isNull(meetingAgendaItems.carriedForwardToItemId),
          ne(meetingAgendaItems.status, "closed"),
        ),
      );
    const overCarried = rows.filter((r) => r.carryCount >= CARRY_SIGNAL_THRESHOLD);
    if (overCarried.length === 0) return { raised: 0 };
    const seen = await alreadySignalled(companyId, CARRY_DETECTOR);
    let raised = 0;
    for (const item of overCarried) {
      const rootId = (detailOf(item)["rootItemId"] as string | undefined) ?? item.id;
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      const signalId = newId("sig");
      await app.db.insert(signals).values({
        id: signalId,
        companyId,
        projectId,
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
        projectId,
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

        // Standing agenda first, so carried items land beneath it.
        const template = (series.agendaTemplate as unknown[]) ?? [];
        let position = 0;
        for (const raw of template) {
          const parsed = agendaTemplateSchema.safeParse(raw);
          if (!parsed.success) continue;
          const itemId = newId("magi");
          await app.db.insert(meetingAgendaItems).values({
            id: itemId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            meetingId,
            seriesId,
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
        }

        // Standing invitees.
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
            // Nobody has attended a meeting that has not happened. Invitees
            // start as `absent` and are marked present when they turn up.
            attendance: "absent",
          });
        }

        const [meetingRow] = await app.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .limit(1);
        let carry = { carried: 0, skipped: 0, actionsCarried: 0 };
        if (previousMeetingId && meetingRow) {
          carry = await carryForwardInto(req, meetingRow, previousMeetingId);
        }
        await refreshMeetingCounts(meetingId);
        const [finalRow] = await app.db
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .limit(1);
        created.push({ ...finalRow, carriedForward: carry });

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
    const [row] = await app.db.select().from(meetings).where(eq(meetings.id, id)).limit(1);
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/meetings", { preHandler: readGate }, async (req) => {
    const q = meetingsListQuery.parse(req.query);
    const where = and(
      eq(meetings.companyId, req.companyId!),
      eq(meetings.projectId, req.projectId!),
      q.seriesId ? eq(meetings.seriesId, q.seriesId) : undefined,
      q.status ? eq(meetings.status, q.status) : undefined,
      q.meetingType ? eq(meetings.meetingType, q.meetingType) : undefined,
    );
    const [totalRow] = await app.db.select({ n: count() }).from(meetings).where(where);
    const items = await app.db
      .select()
      .from(meetings)
      .where(where)
      .orderBy(desc(meetings.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const filtered = items.filter((m) => {
      if (q.from && m.scheduledStart && Date.parse(m.scheduledStart) < Date.parse(q.from)) {
        return false;
      }
      if (q.to && m.scheduledStart && Date.parse(m.scheduledStart) > Date.parse(q.to)) return false;
      return true;
    });
    return paginate(filtered, Number(totalRow?.n ?? 0), q);
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
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      if (k === "seriesId") continue; // a meeting never changes series
      set[k] = k === "isVirtual" ? (v ? 1 : 0) : v;
    }
    await app.db.update(meetings).set(set).where(eq(meetings.id, meetingId));
    await ledger("update", "meeting", meetingId, req, { changed: Object.keys(body) });
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
      if (meeting.status === "cancelled") throw badRequest("A cancelled meeting cannot be held");
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

  app.post(
    "/projects/:projectId/meetings/:meetingId/minutes/issue",
    { preHandler: standardGate },
    async (req) => {
      const { meetingId } = req.params as { meetingId: string };
      const body = z
        .object({ objectionPeriodDays: z.number().int().min(0).max(90).optional() })
        .parse(req.body ?? {});
      const meeting = await fetchMeeting(req, meetingId);
      if (!meeting.minutesBody && !meeting.minutesFileId) {
        throw badRequest("There are no minutes to issue — draft them first");
      }
      if (meeting.minutesIssuedAt) throw conflict("These minutes have already been issued");
      const now = new Date().toISOString();
      await app.db
        .update(meetings)
        .set({
          status: "minutes_issued",
          minutesIssuedAt: now,
          minutesIssuedBy: req.user!.id,
          objectionPeriodDays: body.objectionPeriodDays ?? meeting.objectionPeriodDays,
          updatedAt: now,
        })
        .where(eq(meetings.id, meetingId));
      await ledger("state_change", "meeting", meetingId, req, {
        from: meeting.status,
        to: "minutes_issued",
        issuedBy: req.user!.id,
        objectionPeriodDays: body.objectionPeriodDays ?? meeting.objectionPeriodDays,
      });
      const distribution = (meeting.distribution as string[]) ?? [];
      await pushNotifications(
        app.db,
        distribution.map((userId) => ({
          companyId: req.companyId!,
          userId,
          projectId: req.projectId!,
          kind: "status_change" as const,
          title: `Minutes issued for ${meeting.reference}: ${meeting.title}`,
          body:
            meeting.objectionPeriodDays != null
              ? `Objections must be raised within ${meeting.objectionPeriodDays} days.`
              : null,
          recordType: "meeting",
          recordId: meetingId,
        })),
      );
      const issued = await fetchMeeting(req, meetingId);
      return { ...issued, minutesObjectionWindow: minutesWindow(issued) };
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
      let approvedAtMeetingId: string | null = body.atMeetingId ?? null;
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
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        set[k] = k === "impactsCost" || k === "impactsSchedule" ? (v ? 1 : 0) : v;
      }
      await app.db.update(meetingDecisions).set(set).where(eq(meetingDecisions.id, decisionId));
      await ledger("update", "meeting_decision", decisionId, req, { changed: Object.keys(body) });
      return withImpacts(await fetchDecision(req, decisionId));
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
    // Lazy sweep on the read path (see the module header).
    const swept = await sweepOverdueActions(req.companyId!, req.projectId!, req.user!.id);
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
      sweep: swept,
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
      if (row.status === "completed" || row.status === "verified") {
        throw badRequest("A completed action cannot be blocked");
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
      await sweepCarriedItems(req.companyId!, req.projectId!, req.user!.id);
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
      await sweepCarriedItems(req.companyId!, req.projectId!, req.user!.id);
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
      const swept = await sweepOverdueActions(req.companyId!, req.projectId!, req.user!.id);
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
        sweep: swept,
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
    // Company-wide sweep: the same idempotent pass, unscoped by project.
    const swept = await sweepOverdueActions(req.companyId!, null, req.user!.id);
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
      sweep: swept,
    };
  });

  /** Company-level view: every overdue action across the tenant. */
  app.get("/meeting-action-items/overdue", { preHandler: companyRead }, async (req) => {
    const swept = await sweepOverdueActions(req.companyId!, null, req.user!.id);
    const today = todayISO();
    const rows = await app.db
      .select()
      .from(meetingActionItems)
      .where(
        and(
          eq(meetingActionItems.companyId, req.companyId!),
          inArray(meetingActionItems.status, [...OPEN_ACTION_STATES]),
          lt(meetingActionItems.dueDate, today),
        ),
      )
      .orderBy(asc(meetingActionItems.dueDate));
    const byProject = new Map<string, number>();
    for (const r of rows) byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
    return {
      asOf: today,
      sweep: swept,
      total: rows.length,
      byProject: [...byProject.entries()].map(([projectId, overdue]) => ({ projectId, overdue })),
      items: rows,
    };
  });
};
