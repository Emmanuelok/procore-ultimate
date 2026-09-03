import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();

/**
 * MEETINGS (spec Vol I §2.9, module M20).
 *
 * The minutes are not the product. The ACTION ITEM is: an owner, a date, and
 * a state that survives from one occurrence to the next. Everything else in
 * this file exists to give an action item a defensible provenance — which
 * meeting, which agenda item, who was in the room, and what was decided.
 *
 *   meeting_series          the recurring meeting ("Weekly Progress")
 *     └ meetings            one occurrence, with its own minutes
 *         ├ meeting_attendees      present / absent / apologies
 *         ├ meeting_agenda_items   carried forward between occurrences
 *         ├ meeting_decisions      what was agreed, and who ratified it
 *         └ meeting_action_items   the part that matters
 *
 * ACTION ITEMS BECOME OBLIGATIONS. An action agreed in a meeting is often
 * something a contract already required — "issue the RFI response within 7
 * days" is not a favour, it is clause 3.2. `meeting_action_items` therefore
 * carries the full Obligation shape (ADR 0012: `sourceClause`, `obligorId`,
 * `obligeeId`, `deadline`, `warnDaysBefore`, `evidenceRequirement`) so
 * promotion is a copy rather than a re-keying, and `obligationId` holds the
 * resulting `obligations` row (assurance.ts). Until promoted, the same
 * columns still describe the action honestly; after promotion, the obligation
 * owns the time bar and the action item owns the conversation.
 *
 * CARRY-FORWARD is modelled as a chain, not a flag: `carriedFromItemId` links
 * an occurrence's item back to the one it continues, and `carryCount` is the
 * number that shames — an item carried five weeks running is a project
 * problem that a status column alone would never surface.
 */
export const meetingSeries = pgTable(
  "meeting_series",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    meetingType: text("meeting_type").default("progress").notNull(), // MeetingType
    recurrence: text("recurrence").default("weekly").notNull(), // MeetingRecurrence
    /** RFC 5545 RRULE when `recurrence` is custom */
    recurrenceRule: text("recurrence_rule"),
    /** 0 = Sunday … 6 = Saturday, for the simple recurrences */
    dayOfWeek: integer("day_of_week"),
    startTime: text("start_time"), // HH:MM local to `timezone`
    durationMinutes: integer("duration_minutes"),
    timezone: text("timezone"),
    defaultLocation: text("default_location"),
    defaultLocationId: text("default_location_id"),
    isVirtual: integer("is_virtual").default(0).notNull(),
    meetingUrl: text("meeting_url"),
    chairId: text("chair_id"),
    minuteTakerId: text("minute_taker_id"),
    /** standing invitees: [{ userId?, contactId?, vendorId?, role }] */
    defaultAttendees: jsonb("default_attendees").$type<unknown[]>().default([]).notNull(),
    /** standing agenda: [{ title, category, position, allocatedMinutes }] */
    agendaTemplate: jsonb("agenda_template").$type<unknown[]>().default([]).notNull(),
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    /** contractual requirement the series discharges, e.g. "NEC3 cl.16.2" */
    contractRequirement: text("contract_requirement"),
    contractId: text("contract_id"),
    status: text("status").default("active").notNull(), // MeetingSeriesStatus
    occurrenceCount: integer("occurrence_count").default(0).notNull(),
    nextOccurrenceAt: timestamp("next_occurrence_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_series_uq").on(t.projectId, t.number),
    index("meeting_series_project_idx").on(t.projectId, t.status),
    index("meeting_series_company_idx").on(t.companyId),
  ],
);

/**
 * One occurrence. `seriesId` is nullable — a one-off meeting is a real thing
 * and does not deserve a series of one. Minutes carry two distinct people:
 * the taker (who wrote them) and the approver (who signed them off), because
 * issued minutes are the record a party is deemed to have accepted.
 */
export const meetings = pgTable(
  "meetings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    seriesId: text("series_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** position within the series, e.g. "Progress Meeting No. 14" */
    occurrenceNumber: integer("occurrence_number"),
    title: text("title").notNull(),
    meetingType: text("meeting_type").default("progress").notNull(), // MeetingType
    status: text("status").default("scheduled").notNull(), // MeetingStatus
    scheduledStart: timestamp("scheduled_start", { withTimezone: true, mode: "string" }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true, mode: "string" }),
    actualStart: timestamp("actual_start", { withTimezone: true, mode: "string" }),
    actualEnd: timestamp("actual_end", { withTimezone: true, mode: "string" }),
    location: text("location"),
    locationId: text("location_id"),
    isVirtual: integer("is_virtual").default(0).notNull(),
    meetingUrl: text("meeting_url"),
    chairId: text("chair_id"),
    minuteTakerId: text("minute_taker_id"),
    agendaFileId: text("agenda_file_id"),
    agendaIssuedAt: timestamp("agenda_issued_at", { withTimezone: true, mode: "string" }),
    /** the minutes themselves, as authored in the platform */
    minutesBody: text("minutes_body"),
    minutesFileId: text("minutes_file_id"),
    /**
     * The rendered minutes document is content-addressed: the hash is what
     * makes "these are the minutes that were issued" checkable a year later,
     * when the body text in the database has been corrected twice.
     */
    minutesSha256: text("minutes_sha256"),
    minutesRenderedAt: timestamp("minutes_rendered_at", { withTimezone: true, mode: "string" }),
    /** incremented on every re-issue after a correction (see meetings module) */
    minutesVersion: integer("minutes_version").default(0).notNull(),
    /**
     * Earliest recorded DELIVERY of the issued minutes. The objection period
     * runs from here when it is known: issuing is an act of the sender,
     * delivery is a fact about the recipient, and only the second can start a
     * clock that binds them.
     */
    minutesDeliveredAt: timestamp("minutes_delivered_at", { withTimezone: true, mode: "string" }),
    /** the agenda pack rendered before the meeting, same renderer */
    agendaPackFileId: text("agenda_pack_file_id"),
    agendaPackSha256: text("agenda_pack_sha256"),
    minutesIssuedAt: timestamp("minutes_issued_at", { withTimezone: true, mode: "string" }),
    minutesIssuedBy: text("minutes_issued_by"),
    /** days after issue within which objections must be raised */
    objectionPeriodDays: integer("objection_period_days"),
    /** sign-off on the minutes — deliberately not the minute taker */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    distribution: jsonb("distribution").$type<string[]>().default([]).notNull(),
    /** did enough of the required parties attend for decisions to bind */
    quorumRequired: integer("quorum_required"),
    quorumMet: integer("quorum_met").default(0).notNull(),
    attendeeCount: integer("attendee_count").default(0).notNull(),
    actionItemCount: integer("action_item_count").default(0).notNull(),
    openActionItemCount: integer("open_action_item_count").default(0).notNull(),
    previousMeetingId: text("previous_meeting_id"),
    cancelledReason: text("cancelled_reason"),
    recordingFileId: text("recording_file_id"),
    /** AI-drafted minutes flag, mirroring daily_logs.aiDrafted */
    aiDrafted: integer("ai_drafted").default(0).notNull(),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meetings_uq").on(t.projectId, t.number),
    index("meetings_project_idx").on(t.projectId, t.status),
    index("meetings_series_idx").on(t.seriesId, t.occurrenceNumber),
    index("meetings_scheduled_idx").on(t.projectId, t.scheduledStart),
    index("meetings_company_status_idx").on(t.companyId, t.status),
  ],
);

/**
 * Who was invited and who actually came. External parties may have no user
 * record at all, hence the name/organisation fallbacks — a client's solicitor
 * attends once and is never a platform user, but their presence is a fact
 * that matters.
 */
export const meetingAttendees = pgTable(
  "meeting_attendees",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    meetingId: text("meeting_id").notNull(),
    userId: text("user_id"),
    contactId: text("contact_id"),
    vendorId: text("vendor_id"),
    /** for attendees who exist in no register at all */
    name: text("name").notNull(),
    organisation: text("organisation"),
    email: text("email"),
    jobTitle: text("job_title"),
    role: text("role").default("required").notNull(), // MeetingAttendeeRole
    attendance: text("attendance").default("present").notNull(), // MeetingAttendanceState
    /** who came instead, when attendance is delegate_attended */
    delegateName: text("delegate_name"),
    delegateForUserId: text("delegate_for_user_id"),
    apologiesReceivedAt: timestamp("apologies_received_at", {
      withTimezone: true,
      mode: "string",
    }),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }),
    leftAt: timestamp("left_at", { withTimezone: true, mode: "string" }),
    /** sign-in sheet evidence */
    signedInAt: timestamp("signed_in_at", { withTimezone: true, mode: "string" }),
    signatureFileId: text("signature_file_id"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("meeting_attendees_meeting_idx").on(t.meetingId),
    index("meeting_attendees_user_idx").on(t.userId),
    index("meeting_attendees_project_idx").on(t.projectId),
  ],
);

/**
 * An agenda item, which is also a minute item: the same row carries the
 * heading discussed and the discussion recorded against it. Carry-forward is
 * a chain (see file header) so an item's whole life is one traversal.
 */
export const meetingAgendaItems = pgTable(
  "meeting_agenda_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    meetingId: text("meeting_id").notNull(),
    seriesId: text("series_id"),
    /** hierarchical label as minuted, e.g. "3.2" */
    itemNumber: text("item_number"),
    position: integer("position").default(0).notNull(),
    parentItemId: text("parent_item_id"),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").default("other").notNull(), // MeetingItemCategory
    status: text("status").default("open").notNull(), // MeetingAgendaItemStatus
    presenterId: text("presenter_id"),
    allocatedMinutes: integer("allocated_minutes"),
    /** what was actually said — the minute text for this item */
    discussion: text("discussion"),
    /** the occurrence where this item was first raised */
    firstRaisedMeetingId: text("first_raised_meeting_id"),
    /** the item in the previous occurrence this one continues */
    carriedFromItemId: text("carried_from_item_id"),
    carriedForwardToItemId: text("carried_forward_to_item_id"),
    /** how many occurrences this item has now survived */
    carryCount: integer("carry_count").default(0).notNull(),
    /** the record that put this on the agenda (rfi, risk, ncr, …) */
    originType: text("origin_type"),
    originId: text("origin_id"),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("meeting_agenda_items_meeting_idx").on(t.meetingId, t.position),
    index("meeting_agenda_items_series_idx").on(t.seriesId, t.status),
    index("meeting_agenda_items_carry_idx").on(t.carriedFromItemId),
    index("meeting_agenda_items_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * A decision taken in the room. Separated from the agenda item because a
 * decision outlives the meeting that made it and is cited afterwards: a
 * change order's justification is frequently "as agreed at progress meeting
 * 14, item 3.2". `ratifiedBy` is a second act by someone who was not
 * necessarily present — a decision with cost consequences must not be
 * self-authorised in the minutes by the person who proposed it.
 */
export const meetingDecisions = pgTable(
  "meeting_decisions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    meetingId: text("meeting_id").notNull(),
    agendaItemId: text("agenda_item_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    /** who in the room made the call (a user, not the minute taker) */
    decidedById: text("decided_by_id"),
    decidedByName: text("decided_by_name"),
    decisionDate: text("decision_date"),
    status: text("status").default("recorded").notNull(), // MeetingDecisionStatus
    /** independent ratification — never the same person as decidedById */
    ratifiedBy: text("ratified_by"),
    ratifiedAt: timestamp("ratified_at", { withTimezone: true, mode: "string" }),
    impactsCost: integer("impacts_cost").default(0).notNull(),
    estimatedCostImpact: doublePrecision("estimated_cost_impact"),
    currency: text("currency"),
    impactsSchedule: integer("impacts_schedule").default(0).notNull(),
    estimatedScheduleImpactDays: doublePrecision("estimated_schedule_impact_days"),
    /** the record this decision produced (change_event, variation, …) */
    resultingRecordType: text("resulting_record_type"),
    resultingRecordId: text("resulting_record_id"),
    supersedesDecisionId: text("supersedes_decision_id"),
    supersededByDecisionId: text("superseded_by_decision_id"),
    disputedBy: text("disputed_by"),
    disputedAt: timestamp("disputed_at", { withTimezone: true, mode: "string" }),
    disputeNote: text("dispute_note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_decisions_uq").on(t.projectId, t.number),
    index("meeting_decisions_meeting_idx").on(t.meetingId),
    index("meeting_decisions_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * THE table this module exists for. An action item is an owner plus a date
 * plus a state — and, when what was agreed is something a contract already
 * required, an Obligation waiting to be promoted (see the file header for the
 * full argument and the column mapping).
 */
export const meetingActionItems = pgTable(
  "meeting_action_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    meetingId: text("meeting_id"),
    seriesId: text("series_id"),
    agendaItemId: text("agenda_item_id"),
    decisionId: text("decision_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").default("other").notNull(), // MeetingItemCategory
    status: text("status").default("open").notNull(), // ActionItemStatus
    priority: text("priority").default("medium").notNull(), // ActionItemPriority
    /* --- owner: a user, or a contact at another organisation --- */
    ownerId: text("owner_id"),
    ownerContactId: text("owner_contact_id"),
    ownerVendorId: text("owner_vendor_id"),
    ownerName: text("owner_name"),
    dueDate: text("due_date"), // ISO date
    /* --- Obligation shape (assurance.ts), carried so promotion is a copy --- */
    /** the clause the action discharges, if any — e.g. "NEC3 cl.61.3" */
    sourceClause: text("source_clause"),
    /** party who owes the action (entity or user id) */
    obligorId: text("obligor_id"),
    /** party owed it */
    obligeeId: text("obligee_id"),
    /** hard deadline when the action is time-barred, not merely late */
    deadline: timestamp("deadline", { withTimezone: true, mode: "string" }),
    /** days before the deadline to raise a warning signal */
    warnDaysBefore: doublePrecision("warn_days_before"),
    /** what would prove the action was done */
    evidenceRequirement: text("evidence_requirement"),
    /** set once promoted — the obligations row now owns the time bar */
    obligationId: text("obligation_id"),
    promotedAt: timestamp("promoted_at", { withTimezone: true, mode: "string" }),
    promotedBy: text("promoted_by"),
    /* --- completion, with segregation of duties on verification --- */
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    completedBy: text("completed_by"),
    closureNote: text("closure_note"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    /** verification by someone other than the person who completed it */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    /* --- carry-forward and escalation --- */
    carriedFromActionId: text("carried_from_action_id"),
    carryCount: integer("carry_count").default(0).notNull(),
    /** original date, kept when the due date is moved — slippage is evidence */
    originalDueDate: text("original_due_date"),
    revisedCount: integer("revised_count").default(0).notNull(),
    escalatedToId: text("escalated_to_id"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    blockedReason: text("blocked_reason"),
    /** the record the action produced or relates to */
    linkedRecordType: text("linked_record_type"),
    linkedRecordId: text("linked_record_id"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("meeting_action_items_uq").on(t.projectId, t.number),
    index("meeting_action_items_meeting_idx").on(t.meetingId),
    index("meeting_action_items_owner_idx").on(t.ownerId, t.status),
    index("meeting_action_items_due_idx").on(t.projectId, t.status, t.dueDate),
    index("meeting_action_items_obligation_idx").on(t.obligationId),
    /*
     * The company-wide overdue sweep and `GET /meeting-action-items/overdue`
     * filter on (company_id, status, due_date) and had no index that started
     * with company_id — every call was a sequential scan of the tenant's whole
     * action table. Now the scheduler runs the sweep, but the company reports
     * still ask the same question.
     */
    index("meeting_action_items_company_due_idx").on(t.companyId, t.status, t.dueDate),
  ],
);

/**
 * A COMPANY-LEVEL standing agenda library (#416). A progress meeting's agenda
 * is an organisational standard, not a per-series invention: the same eight
 * headings appear on every job, and typing them again per series is how the
 * eighth ("safety moment") quietly stops appearing.
 *
 * A template is applied to a series (copied into `meeting_series.agenda_template`)
 * or straight onto one occurrence. Copying rather than referencing is
 * deliberate: minutes must not change retroactively because someone edited
 * the library afterwards.
 */
export const meetingAgendaTemplates = pgTable(
  "meeting_agenda_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = available to every project in the company */
    projectId: text("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    /** the meeting type this library entry is the standard for */
    meetingType: text("meeting_type").default("progress").notNull(),
    /** [{ title, category, position, allocatedMinutes, itemNumber }] */
    items: jsonb("items").$type<unknown[]>().default([]).notNull(),
    /** standing invitees to seed a series with: same shape as defaultAttendees */
    defaultAttendees: jsonb("default_attendees").$type<unknown[]>().default([]).notNull(),
    /** the contractual requirement this standard discharges, e.g. "NEC4 cl.31" */
    contractRequirement: text("contract_requirement"),
    isDefault: integer("is_default").default(0).notNull(),
    status: text("status").default("active").notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("meeting_agenda_templates_company_idx").on(t.companyId, t.status),
    index("meeting_agenda_templates_type_idx").on(t.companyId, t.meetingType),
  ],
);

/**
 * WHO ACTUALLY RECEIVED THE MINUTES (#422, #425).
 *
 * Deemed acceptance is the sharpest thing in this module: after the objection
 * period, silence becomes agreement. A clock that starts when the sender
 * clicks "issue" is therefore indefensible — the recipient may never have got
 * the document. One row per recipient per issue, with the channel, the
 * address, the delivery result and the hash of the document that was sent, is
 * what makes the deeming survive challenge.
 */
export const meetingMinuteDeliveries = pgTable(
  "meeting_minute_deliveries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    meetingId: text("meeting_id").notNull(),
    /** which issue of the minutes this delivery belongs to */
    minutesVersion: integer("minutes_version").default(1).notNull(),
    userId: text("user_id"),
    contactId: text("contact_id"),
    attendeeId: text("attendee_id"),
    recipientName: text("recipient_name").notNull(),
    email: text("email"),
    channel: text("channel").default("platform").notNull(), // MinuteDeliveryChannel
    status: text("status").default("pending").notNull(), // MinuteDeliveryStatus
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "string" }),
    failureReason: text("failure_reason"),
    /** the document actually sent, so a later dispute compares hashes */
    documentSha256: text("document_sha256"),
    createdAt: createdAt(),
  },
  (t) => [
    index("meeting_minute_deliveries_meeting_idx").on(t.meetingId, t.minutesVersion),
    index("meeting_minute_deliveries_company_idx").on(t.companyId),
    uniqueIndex("meeting_minute_deliveries_uq").on(
      t.meetingId,
      t.minutesVersion,
      t.recipientName,
      t.channel,
    ),
  ],
);
