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
 * TIMECARDS, CREWS & T&M TICKETS (module M24).
 *
 * Labour is the only major cost that is claimed, approved and paid before
 * anybody independently checks it. This module is therefore built around
 * three reconciliations rather than around a timesheet screen:
 *
 *   1. CLAIMED vs PRESENT. `timecards.siteAccessRecordId` points at the
 *      `site_access_records` row (workforce.ts) for the same worker and day,
 *      and `varianceHours` is the difference. That is the ghost-worker check
 *      (#669) applied to cost rather than to payroll: turnstile data is an
 *      independent evidence stream, a foreman's crew sheet is the claimant's
 *      own assertion, and ADR 0004 says a claim is only tested by evidence
 *      that did not come from the claimant.
 *
 *   2. HOURS vs BUDGET. `timecard_allocations.budgetLineItemId` is what makes
 *      labour land on a cost report at all. A timecard with no allocation is
 *      hours nobody can code, which is how labour overruns stay invisible
 *      until the month-end journal.
 *
 *   3. OUR HOURS vs THEIR SIGNATURE. `tm_tickets` are the hours the CLIENT's
 *      representative signed for, on site, on the day. `signedUnderProtest`
 *      exists because the single most litigated fact on a T&M ticket is
 *      whether the signature admitted liability or merely acknowledged that
 *      people were present.
 *
 * WORKERS ARE NOT DUPLICATED. Every `workerId` here references `workers`
 * (workforce.ts) — the register that already carries identity verification,
 * induction, employer (vendorId), agreed daily rate and demobilisation. This
 * module adds crews, hours and cost coding on top of it and creates no second
 * person table.
 *
 * APPROVAL IS SEGREGATED AND EXPLICIT. `timecard_approvals` is a trail of
 * acts, not a status column, and it stores `isSelfApproval` — which the API
 * refuses — so that a breach is provable after the fact rather than merely
 * prevented at the time.
 */
export const crews = pgTable(
  "crews",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    trade: text("trade"),
    /** workforce.workers.id — the foreman is a worker, not a separate record */
    foremanWorkerId: text("foreman_worker_id"),
    /** the salaried supervisor who approves the crew's hours */
    supervisorUserId: text("supervisor_user_id"),
    /** the employer, when the crew belongs to a subcontractor */
    vendorId: text("vendor_id"),
    defaultShift: text("default_shift").default("day").notNull(), // Shift
    standardHoursPerDay: doublePrecision("standard_hours_per_day"),
    /** hours per day beyond which overtime rates apply */
    overtimeThresholdHours: doublePrecision("overtime_threshold_hours"),
    defaultCostCodeId: text("default_cost_code_id"),
    defaultBudgetLineItemId: text("default_budget_line_item_id"),
    locationId: text("location_id"),
    status: text("status").default("active").notNull(), // CrewStatus
    headcountTarget: integer("headcount_target"),
    currentHeadcount: integer("current_headcount").default(0).notNull(),
    activeFrom: text("active_from"),
    activeTo: text("active_to"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("crews_uq").on(t.projectId, t.number),
    index("crews_project_idx").on(t.projectId, t.status),
    index("crews_vendor_idx").on(t.vendorId),
  ],
);

/** Membership is dated, not a flag: crews are re-formed constantly and "who
 *  was in this crew on the day of the incident" must stay answerable. */
export const crewMembers = pgTable(
  "crew_members",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    crewId: text("crew_id").notNull(),
    /** workforce.workers.id */
    workerId: text("worker_id").notNull(),
    roleInCrew: text("role_in_crew").default("operative").notNull(), // CrewRole
    fromDate: text("from_date").notNull(), // ISO date
    toDate: text("to_date"),
    isActive: integer("is_active").default(1).notNull(),
    /** overrides the crew default when this member codes elsewhere */
    defaultCostCodeId: text("default_cost_code_id"),
    /** labour classification for prevailing-wage regimes */
    classification: text("classification"),
    hourlyRate: doublePrecision("hourly_rate"),
    overtimeMultiplier: doublePrecision("overtime_multiplier"),
    doubleTimeMultiplier: doublePrecision("double_time_multiplier"),
    /** on-costs (insurance, pension, levies) as a multiplier on base */
    burdenRate: doublePrecision("burden_rate"),
    currency: text("currency").default("USD").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("crew_members_uq").on(t.crewId, t.workerId, t.fromDate),
    index("crew_members_crew_idx").on(t.crewId, t.isActive),
    index("crew_members_worker_idx").on(t.workerId),
  ],
);

/**
 * A weekly (or per-period) submission for a crew. Approval happens here in
 * practice — nobody signs off 40 individual day cards — so the batch carries
 * the totals and the individual cards carry the detail.
 */
export const timecardBatches = pgTable(
  "timecard_batches",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    crewId: text("crew_id"),
    vendorId: text("vendor_id"),
    periodStart: text("period_start").notNull(), // ISO date
    periodEnd: text("period_end").notNull(),
    weekEnding: text("week_ending"),
    status: text("status").default("draft").notNull(), // TimecardBatchStatus
    timecardCount: integer("timecard_count").default(0).notNull(),
    workerCount: integer("worker_count").default(0).notNull(),
    /* materialized rollups over the batch's timecards */
    regularHours: doublePrecision("regular_hours").default(0).notNull(),
    overtimeHours: doublePrecision("overtime_hours").default(0).notNull(),
    doubleTimeHours: doublePrecision("double_time_hours").default(0).notNull(),
    premiumHours: doublePrecision("premium_hours").default(0).notNull(),
    totalHours: doublePrecision("total_hours").default(0).notNull(),
    totalCost: doublePrecision("total_cost").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /** aggregate claimed-vs-access variance across the batch */
    varianceHours: doublePrecision("variance_hours"),
    exceptionCount: integer("exception_count").default(0).notNull(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    /** approval — never the submitter (see the file header) */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedReason: text("rejected_reason"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    exportedAt: timestamp("exported_at", { withTimezone: true, mode: "string" }),
    payrollBatchRef: text("payroll_batch_ref"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("timecard_batches_uq").on(t.projectId, t.number),
    index("timecard_batches_project_idx").on(t.projectId, t.status),
    index("timecard_batches_period_idx").on(t.projectId, t.periodEnd),
    index("timecard_batches_crew_idx").on(t.crewId),
  ],
);

/** One worker, one day, one shift. See the file header for the two
 *  reconciliations this row exists to make possible. */
export const timecards = pgTable(
  "timecards",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    batchId: text("batch_id"),
    /** workforce.workers.id — the register, never a second worker table */
    workerId: text("worker_id").notNull(),
    crewId: text("crew_id"),
    /** the worker's employer, denormalised for subcontractor rollups */
    vendorId: text("vendor_id"),
    workDate: text("work_date").notNull(), // ISO date
    shift: text("shift").default("day").notNull(), // Shift
    trade: text("trade"),
    /** prevailing-wage / collective-agreement classification */
    classification: text("classification"),
    startTime: text("start_time"), // HH:MM
    endTime: text("end_time"),
    breakMinutes: integer("break_minutes").default(0).notNull(),
    /* the hours, split by pay treatment */
    regularHours: doublePrecision("regular_hours").default(0).notNull(),
    overtimeHours: doublePrecision("overtime_hours").default(0).notNull(),
    doubleTimeHours: doublePrecision("double_time_hours").default(0).notNull(),
    premiumHours: doublePrecision("premium_hours").default(0).notNull(),
    premiumKind: text("premium_kind").default("none").notNull(), // PremiumKind
    totalHours: doublePrecision("total_hours").default(0).notNull(),
    /** hours lost to weather or waiting — recorded, not silently dropped */
    idleHours: doublePrecision("idle_hours").default(0).notNull(),
    idleReason: text("idle_reason"), // IdleReason
    /* rates and cost */
    hourlyRate: doublePrecision("hourly_rate"),
    overtimeRate: doublePrecision("overtime_rate"),
    doubleTimeRate: doublePrecision("double_time_rate"),
    premiumRate: doublePrecision("premium_rate"),
    burdenRate: doublePrecision("burden_rate"),
    totalCost: doublePrecision("total_cost"),
    currency: text("currency").default("USD").notNull(),
    isBillable: integer("is_billable").default(0).notNull(),
    /* --- reconciliation 1: claimed against independently recorded presence --- */
    source: text("source").default("manual").notNull(), // TimecardSource
    /** workforce.site_access_records.id for the same worker and date */
    siteAccessRecordId: text("site_access_record_id"),
    accessHoursOnSite: doublePrecision("access_hours_on_site"),
    /** claimed minus present — the ghost-worker signal */
    varianceHours: doublePrecision("variance_hours"),
    varianceExplanation: text("variance_explanation"),
    signalId: text("signal_id"),
    /** workforce.payroll_entries.id once the hours have been paid */
    payrollEntryId: text("payroll_entry_id"),
    /* --- state --- */
    status: text("status").default("draft").notNull(), // TimecardStatus
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    /** approval — never the submitter, never the worker */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedReason: text("rejected_reason"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    exportedAt: timestamp("exported_at", { withTimezone: true, mode: "string" }),
    payrollBatchRef: text("payroll_batch_ref"),
    /** the card this one corrects, when a locked card had to be reissued */
    revisesTimecardId: text("revises_timecard_id"),
    locationId: text("location_id"),
    weatherDelayHours: doublePrecision("weather_delay_hours"),
    dailyLogId: text("daily_log_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("timecards_uq").on(t.workerId, t.workDate, t.shift),
    uniqueIndex("timecards_number_uq").on(t.projectId, t.number),
    index("timecards_project_date_idx").on(t.projectId, t.workDate),
    index("timecards_batch_idx").on(t.batchId, t.status),
    index("timecards_worker_idx").on(t.workerId, t.workDate),
    index("timecards_crew_idx").on(t.crewId, t.workDate),
  ],
);

/**
 * How a card's hours are coded. A timecard may split across several cost
 * codes in a day — three hours on the slab, five on the columns — so the
 * allocation is a child row, not columns on the card. `budgetLineItemId` is
 * the join that puts labour on the cost report (financials.ts).
 */
export const timecardAllocations = pgTable(
  "timecard_allocations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    timecardId: text("timecard_id").notNull(),
    position: integer("position").default(0).notNull(),
    costCodeId: text("cost_code_id"),
    /** denormalised so a labour report sorts without a join */
    costCode: text("cost_code"),
    costType: text("cost_type").default("labour").notNull(), // CostType
    /** THE link that puts these hours on the budget (financials.ts) */
    budgetLineItemId: text("budget_line_item_id"),
    wbsPath: text("wbs_path"),
    subJob: text("sub_job"),
    locationId: text("location_id"),
    scheduleActivityId: text("schedule_activity_id"),
    commitmentId: text("commitment_id"),
    /** hours spent on a change — the origin of a T&M claim */
    changeEventId: text("change_event_id"),
    tmTicketId: text("tm_ticket_id"),
    equipmentId: text("equipment_id"),
    /* the hours, split the same way as the parent card */
    regularHours: doublePrecision("regular_hours").default(0).notNull(),
    overtimeHours: doublePrecision("overtime_hours").default(0).notNull(),
    doubleTimeHours: doublePrecision("double_time_hours").default(0).notNull(),
    premiumHours: doublePrecision("premium_hours").default(0).notNull(),
    totalHours: doublePrecision("total_hours").default(0).notNull(),
    hourlyRate: doublePrecision("hourly_rate"),
    cost: doublePrecision("cost"),
    currency: text("currency").default("USD").notNull(),
    /** production achieved against these hours, for unit-rate productivity */
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    isBillable: integer("is_billable").default(0).notNull(),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("timecard_allocations_timecard_idx").on(t.timecardId, t.position),
    index("timecard_allocations_budget_idx").on(t.budgetLineItemId),
    index("timecard_allocations_cost_code_idx").on(t.projectId, t.costCodeId),
    index("timecard_allocations_change_idx").on(t.changeEventId),
  ],
);

/**
 * One act in the approval trail. A trail rather than a status column because
 * approval is usually tiered (foreman → superintendent → payroll) and because
 * `isSelfApproval` must be RECORDED, not merely refused: a control that
 * silently prevents a breach leaves no evidence that the breach was attempted.
 */
export const timecardApprovals = pgTable(
  "timecard_approvals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** exactly one of these two is set */
    timecardId: text("timecard_id"),
    batchId: text("batch_id"),
    /** 1 = foreman, 2 = superintendent, 3 = payroll — tiers are configurable */
    level: integer("level").default(1).notNull(),
    approverId: text("approver_id").notNull(),
    approverRole: text("approver_role"),
    decision: text("decision").notNull(), // TimecardApprovalDecision
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }).notNull(),
    comment: text("comment"),
    /** the person whose hours these are, denormalised for the SoD check */
    subjectWorkerId: text("subject_worker_id"),
    /** 1 when approver and submitter are the same person — refused by the API */
    isSelfApproval: integer("is_self_approval").default(0).notNull(),
    /** set when the approver acted on someone else's behalf */
    delegatedFromId: text("delegated_from_id"),
    escalatedToId: text("escalated_to_id"),
    signatureFileId: text("signature_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("timecard_approvals_timecard_idx").on(t.timecardId, t.level),
    index("timecard_approvals_batch_idx").on(t.batchId, t.level),
    index("timecard_approvals_approver_idx").on(t.approverId, t.decidedAt),
  ],
);

/**
 * A time-and-materials (daywork) ticket: work done outside the contract
 * scope, priced on time, and — critically — SIGNED ON SITE ON THE DAY by the
 * client's representative. The signature block is the most important part of
 * the record, which is why it is nine columns rather than a boolean:
 * `signedUnderProtest` and `protestNote` capture the "signed for hours only,
 * without prejudice to liability" endorsement that decides whether the ticket
 * is worth anything when the change is finally priced.
 */
export const tmTickets = pgTable(
  "tm_tickets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    ticketDate: text("ticket_date").notNull(), // ISO date
    title: text("title").notNull(),
    description: text("description"),
    scopeOfWork: text("scope_of_work"),
    /** who told us to do it, and under what instruction */
    instructedByName: text("instructed_by_name"),
    instructionRef: text("instruction_ref"),
    instructionDate: text("instruction_date"),
    /** verbal instructions are the norm and the problem — flagged as such */
    wasVerbalInstruction: integer("was_verbal_instruction").default(0).notNull(),
    /** the change this ticket feeds (financials.change_events) */
    changeEventId: text("change_event_id"),
    commitmentId: text("commitment_id"),
    /** the sub whose people did the work */
    vendorId: text("vendor_id"),
    crewId: text("crew_id"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    /* pricing */
    rateBasis: text("rate_basis").default("to_be_agreed").notNull(), // TmRateBasis
    markupPercent: doublePrecision("markup_percent"),
    labourTotal: doublePrecision("labour_total").default(0).notNull(),
    equipmentTotal: doublePrecision("equipment_total").default(0).notNull(),
    materialTotal: doublePrecision("material_total").default(0).notNull(),
    subcontractTotal: doublePrecision("subcontract_total").default(0).notNull(),
    markupTotal: doublePrecision("markup_total").default(0).notNull(),
    total: doublePrecision("total").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    totalLabourHours: doublePrecision("total_labour_hours").default(0).notNull(),
    lineCount: integer("line_count").default(0).notNull(),
    status: text("status").default("draft").notNull(), // TmTicketStatus
    /* --- the site signature: the whole point of the document --- */
    signedByName: text("signed_by_name"),
    signedByRole: text("signed_by_role"),
    signedByOrganisation: text("signed_by_organisation"),
    signedByContactId: text("signed_by_contact_id"),
    signedByUserId: text("signed_by_user_id"),
    signedAt: timestamp("signed_at", { withTimezone: true, mode: "string" }),
    signatureMethod: text("signature_method").default("none").notNull(), // SignatureMethod
    signatureFileId: text("signature_file_id"),
    /** captured with the signature — proves it was signed on site, that day */
    signatureLatitude: doublePrecision("signature_latitude"),
    signatureLongitude: doublePrecision("signature_longitude"),
    signatureDeviceId: text("signature_device_id"),
    /** "signed for record of hours only" — see the doc comment above */
    signedUnderProtest: integer("signed_under_protest").default(0).notNull(),
    protestNote: text("protest_note"),
    refusedToSign: integer("refused_to_sign").default(0).notNull(),
    refusalNote: text("refusal_note"),
    /* --- our own workflow, separate from theirs --- */
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    /** internal approval — never the person who raised the ticket */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    disputedReason: text("disputed_reason"),
    /** the change order that finally absorbed it */
    incorporatedChangeOrderId: text("incorporated_change_order_id"),
    incorporatedAt: timestamp("incorporated_at", { withTimezone: true, mode: "string" }),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tm_tickets_uq").on(t.projectId, t.number),
    index("tm_tickets_project_idx").on(t.projectId, t.status),
    index("tm_tickets_change_idx").on(t.changeEventId),
    index("tm_tickets_date_idx").on(t.projectId, t.ticketDate),
    index("tm_tickets_vendor_idx").on(t.vendorId),
  ],
);

/** A priced line on a T&M ticket. `timecardId` is the join between what we
 *  paid a worker and what we billed the client for that same hour — without
 *  it, a ticket is an assertion with nothing behind it. */
export const tmTicketLines = pgTable(
  "tm_ticket_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    ticketId: text("ticket_id").notNull(),
    position: integer("position").default(0).notNull(),
    lineKind: text("line_kind").default("labour").notNull(), // TmLineKind
    description: text("description").notNull(),
    /* what the line is about — exactly one is normally set */
    /** workforce.workers.id */
    workerId: text("worker_id"),
    crewId: text("crew_id"),
    equipmentId: text("equipment_id"),
    materialItemId: text("material_item_id"),
    /** the timecard row these hours were paid under */
    timecardId: text("timecard_id"),
    timecardAllocationId: text("timecard_allocation_id"),
    deliveryLineId: text("delivery_line_id"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    /* the arithmetic */
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    hours: doublePrecision("hours"),
    rate: doublePrecision("rate"),
    amount: doublePrecision("amount").default(0).notNull(),
    currency: text("currency").default("USD").notNull(),
    /** the client accepted the ticket but struck this line */
    isDisputed: integer("is_disputed").default(0).notNull(),
    disputeNote: text("dispute_note"),
    agreedAmount: doublePrecision("agreed_amount"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tm_ticket_lines_ticket_idx").on(t.ticketId, t.position),
    index("tm_ticket_lines_timecard_idx").on(t.timecardId),
    index("tm_ticket_lines_project_idx").on(t.projectId, t.lineKind),
  ],
);
