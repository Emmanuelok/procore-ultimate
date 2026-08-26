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
 * SAFETY (spec Vol I §2.11, module M21).
 *
 * TWO AUDIENCES SHAPE THIS SCHEMA, and neither of them is the site team.
 *
 *   AN INSURER prices the loss. They ask for time of day, hours into shift,
 *   body part, nature of injury, treatment level, days lost, days on
 *   restricted duty, and the employment relationship of the injured person —
 *   because those, not the narrative, determine reserve and premium.
 *
 *   A REGULATOR asks two questions: was it reportable, and was it reported
 *   in time. Reportability is a CLASSIFICATION, not a boolean — RIDDOR
 *   "over-7-day incapacitation" starts a 15-day clock from the accident, an
 *   OSHA "days away" case must be on the 300 log, and a site with a foreign
 *   parent is answerable to both. `reportableRegimes` is therefore a list,
 *   the regime-specific classifications are separate columns, and
 *   `reportDueAt` is a stored deadline that `obligationId` can bind to the
 *   platform's time-bar machinery (ADR 0012).
 *
 * WHAT THE SITE TEAM GETS OUT OF IT is the corrective-action register:
 * `safety_corrective_actions` is fed by every register here AND by quality
 * NCRs (quality.ts) through `sourceType`, so a project has ONE overdue-actions
 * list rather than one per module. `hierarchyOfControl` on every action is
 * what makes a programme auditable: a register full of "brief the operatives"
 * is a register that will see the same incident again.
 *
 * WORKERS ARE NOT DUPLICATED HERE. `workerId` throughout references
 * `workers` (workforce.ts) — the same register that carries induction,
 * identity verification and site-access records. Only people who exist in no
 * register at all (a visitor, a member of the public) fall back to a name.
 */
export const safetyObservations = pgTable(
  "safety_observations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** positive observations are recorded too — see SAFETY_OBSERVATION_KINDS */
    kind: text("kind").default("negative").notNull(), // SafetyObservationKind
    category: text("category").default("other").notNull(), // SafetyCategory
    severity: text("severity").default("low").notNull(), // SafetySeverity
    title: text("title").notNull(),
    description: text("description"),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    locationId: text("location_id"),
    locationText: text("location_text"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** the party observed — usually a subcontractor */
    vendorId: text("vendor_id"),
    trade: text("trade"),
    /** workforce.workers.id when the person observed is a registered worker */
    workerId: text("worker_id"),
    crewId: text("crew_id"),
    /** potential severity × likelihood, scored 1-5 each */
    riskLikelihood: integer("risk_likelihood"),
    riskSeverity: integer("risk_severity"),
    riskScore: integer("risk_score"),
    immediateActionTaken: text("immediate_action_taken"),
    /** work was stopped — the single fact an enforcement officer asks first */
    workStopped: integer("work_stopped").default(0).notNull(),
    workResumedAt: timestamp("work_resumed_at", { withTimezone: true, mode: "string" }),
    status: text("status").default("open").notNull(), // SafetyObservationStatus
    assigneeId: text("assignee_id"),
    dueDate: text("due_date"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** an observation that later turned out to precede an incident */
    relatedIncidentId: text("related_incident_id"),
    openActionCount: integer("open_action_count").default(0).notNull(),
    /** closure is a second act, never by the observer */
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_observations_uq").on(t.projectId, t.number),
    index("safety_observations_project_idx").on(t.projectId, t.status),
    index("safety_observations_vendor_idx").on(t.vendorId),
    index("safety_observations_observed_idx").on(t.projectId, t.observedAt),
  ],
);

/**
 * An incident. The column list is long on purpose: every field here is one an
 * insurer's claim form or a statutory notification form actually asks for,
 * and a field that has to be reconstructed from a narrative six months later
 * is a field that will be reconstructed wrongly.
 */
export const safetyIncidents = pgTable(
  "safety_incidents",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    incidentType: text("incident_type").notNull(), // IncidentType
    severity: text("severity").default("minor").notNull(), // IncidentSeverity
    title: text("title").notNull(),
    description: text("description").notNull(),
    /* --- when and where, to the precision an investigator needs --- */
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true, mode: "string" }),
    reportedAt: timestamp("reported_at", { withTimezone: true, mode: "string" }),
    /** delay between occurrence and report — late reporting is itself a finding */
    reportingDelayHours: doublePrecision("reporting_delay_hours"),
    /** fatigue analysis: how far into the shift the person was */
    hoursIntoShift: doublePrecision("hours_into_shift"),
    shift: text("shift"), // Shift
    locationId: text("location_id"),
    locationText: text("location_text"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    weatherConditions: text("weather_conditions"),
    lightingConditions: text("lighting_conditions"),
    activityAtTime: text("activity_at_time"),
    /* --- the person, referencing the workforce register --- */
    /** workforce.workers.id — never a second worker table */
    workerId: text("worker_id"),
    /** for visitors and members of the public who are in no register */
    injuredPersonName: text("injured_person_name"),
    injuredPersonType: text("injured_person_type"), // InjuredPersonType
    /** the injured person's employer */
    vendorId: text("vendor_id"),
    injuredPersonTrade: text("injured_person_trade"),
    injuredPersonAge: integer("injured_person_age"),
    yearsExperience: doublePrecision("years_experience"),
    daysSinceInduction: integer("days_since_induction"),
    /* --- the injury, in the vocabulary of the forms --- */
    treatmentLevel: text("treatment_level"), // InjuryTreatmentLevel
    bodyPart: text("body_part"), // BodyPart
    /** additional parts when more than one was injured */
    additionalBodyParts: jsonb("additional_body_parts").$type<string[]>().default([]).notNull(),
    injuryNature: text("injury_nature"), // InjuryNature
    mechanism: text("mechanism"), // IncidentMechanism
    treatmentProvider: text("treatment_provider"),
    hospitalName: text("hospital_name"),
    /** lost-time and restricted-duty days drive every published rate */
    isLostTime: integer("is_lost_time").default(0).notNull(),
    lostTimeDays: doublePrecision("lost_time_days"),
    restrictedDutyDays: doublePrecision("restricted_duty_days"),
    returnToWorkDate: text("return_to_work_date"),
    isFatality: integer("is_fatality").default(0).notNull(),
    /* --- property, environment and third parties --- */
    equipmentId: text("equipment_id"),
    propertyDamageDescription: text("property_damage_description"),
    environmentalReleaseDescription: text("environmental_release_description"),
    releaseQuantity: doublePrecision("release_quantity"),
    releaseUnit: text("release_unit"),
    thirdPartyInvolved: integer("third_party_involved").default(0).notNull(),
    thirdPartyDetail: text("third_party_detail"),
    /* --- immediate response --- */
    immediateCause: text("immediate_cause"),
    immediateActionTaken: text("immediate_action_taken"),
    workStopped: integer("work_stopped").default(0).notNull(),
    workResumedAt: timestamp("work_resumed_at", { withTimezone: true, mode: "string" }),
    emergencyServicesAttended: integer("emergency_services_attended").default(0).notNull(),
    /** [{ name, organisation, contact, statementFileId }] */
    witnesses: jsonb("witnesses").$type<unknown[]>().default([]).notNull(),
    witnessCount: integer("witness_count").default(0).notNull(),
    /* --- investigation --- */
    investigationStatus: text("investigation_status").default("not_started").notNull(), // IncidentInvestigationStatus
    /** the investigation lead — must not be the line manager of the injured */
    investigationLeadId: text("investigation_lead_id"),
    investigationDueDate: text("investigation_due_date"),
    investigationStartedAt: timestamp("investigation_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    investigationCompletedAt: timestamp("investigation_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    rootCauseMethod: text("root_cause_method").default("none").notNull(), // RootCauseMethod
    rootCause: text("root_cause"),
    /** [{ factor, category, note }] — organisational as well as immediate */
    contributingFactors: jsonb("contributing_factors").$type<unknown[]>().default([]).notNull(),
    investigationFindings: text("investigation_findings"),
    investigationReportFileId: text("investigation_report_file_id"),
    /* --- reportability: classification, clock, and proof of notification --- */
    isReportable: integer("is_reportable").default(0).notNull(),
    /** ReportableRegime[] — several may apply to one event */
    reportableRegimes: jsonb("reportable_regimes").$type<string[]>().default([]).notNull(),
    riddorCategory: text("riddor_category"), // RiddorCategory
    oshaCaseType: text("osha_case_type"), // OshaCaseType
    /** statutory deadline for notification, computed from the classification */
    reportDueAt: timestamp("report_due_at", { withTimezone: true, mode: "string" }),
    regulatorNotifiedAt: timestamp("regulator_notified_at", {
      withTimezone: true,
      mode: "string",
    }),
    regulatorNotifiedBy: text("regulator_notified_by"),
    regulatorReference: text("regulator_reference"),
    regulatorNotificationFileId: text("regulator_notification_file_id"),
    /** [{ regime, notifiedAt, reference, method }] for multi-regime events */
    notifications: jsonb("notifications").$type<unknown[]>().default([]).notNull(),
    regulatorVisitExpected: integer("regulator_visit_expected").default(0).notNull(),
    enforcementNoticeReceived: integer("enforcement_notice_received").default(0).notNull(),
    /* --- insurance --- */
    isInsurableClaim: integer("is_insurable_claim").default(0).notNull(),
    /** insurance.insurance_claims.id when notified */
    insuranceClaimId: text("insurance_claim_id"),
    insurerNotifiedAt: timestamp("insurer_notified_at", { withTimezone: true, mode: "string" }),
    /** notification period under the policy — a condition precedent */
    insurerNotificationDueAt: timestamp("insurer_notification_due_at", {
      withTimezone: true,
      mode: "string",
    }),
    estimatedCost: doublePrecision("estimated_cost"),
    actualCost: doublePrecision("actual_cost"),
    currency: text("currency").default("USD").notNull(),
    /* --- state and closure --- */
    status: text("status").default("reported").notNull(), // IncidentStatus
    openActionCount: integer("open_action_count").default(0).notNull(),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    /** statutory notification bound to the obligations register (ADR 0012) */
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    /** lesson raised from this incident (learning.ts) */
    lessonId: text("lesson_id"),
    /** confidentiality: names withheld from the general project audience */
    isConfidential: integer("is_confidential").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    reportedBy: text("reported_by"),
    /** sign-off on the investigation — never the investigation lead */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    reopenedCount: integer("reopened_count").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_incidents_uq").on(t.projectId, t.number),
    index("safety_incidents_project_idx").on(t.projectId, t.status),
    index("safety_incidents_occurred_idx").on(t.projectId, t.occurredAt),
    index("safety_incidents_reportable_idx").on(t.companyId, t.isReportable, t.reportDueAt),
    index("safety_incidents_worker_idx").on(t.workerId),
    index("safety_incidents_vendor_idx").on(t.vendorId),
  ],
);

/**
 * ONE corrective-action register for the whole platform's safety and quality
 * findings. `sourceType`/`sourceId` is the discriminator (see
 * CORRECTIVE_ACTION_SOURCES — it includes `ncr`, so quality.ts feeds this
 * table rather than growing its own). Effectiveness is checked LATER than
 * closure and by a different person: an action closed on evidence of
 * completion has not yet been shown to have worked.
 */
export const safetyCorrectiveActions = pgTable(
  "safety_corrective_actions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    sourceType: text("source_type").notNull(), // CorrectiveActionSource
    sourceId: text("source_id").notNull(),
    /** denormalised so the register renders without a polymorphic join */
    sourceReference: text("source_reference"),
    title: text("title").notNull(),
    description: text("description"),
    actionKind: text("action_kind").default("corrective").notNull(), // CorrectiveActionKind
    /** how durable the fix is — see HIERARCHY_OF_CONTROLS */
    hierarchyOfControl: text("hierarchy_of_control"), // HierarchyOfControl
    category: text("category"), // SafetyCategory
    priority: text("priority").default("medium").notNull(), // ActionItemPriority
    status: text("status").default("open").notNull(), // CorrectiveActionStatus
    ownerId: text("owner_id"),
    ownerVendorId: text("owner_vendor_id"),
    ownerName: text("owner_name"),
    dueDate: text("due_date").notNull(),
    originalDueDate: text("original_due_date"),
    revisedCount: integer("revised_count").default(0).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    completedBy: text("completed_by"),
    completionNote: text("completion_note"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    /** verification of completion — never the person who completed it */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verificationMethod: text("verification_method"),
    /** the later, separate judgement that the fix actually worked */
    effectivenessCheckDate: text("effectiveness_check_date"),
    effectivenessVerdict: text("effectiveness_verdict").default("pending").notNull(), // ActionEffectivenessVerdict
    effectivenessCheckedBy: text("effectiveness_checked_by"),
    effectivenessNote: text("effectiveness_note"),
    escalatedToId: text("escalated_to_id"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true, mode: "string" }),
    costToImplement: doublePrecision("cost_to_implement"),
    currency: text("currency"),
    /** bound to the obligations register when the fix is contractually owed */
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_corrective_actions_uq").on(t.projectId, t.number),
    index("safety_corrective_actions_source_idx").on(t.sourceType, t.sourceId),
    index("safety_corrective_actions_owner_idx").on(t.ownerId, t.status),
    index("safety_corrective_actions_due_idx").on(t.projectId, t.status, t.dueDate),
  ],
);

/**
 * A reusable inspection template. `projectId` is nullable: most safety
 * templates are company standards issued once and used everywhere, and a
 * project-level row is the exception (a client's bespoke form).
 */
export const safetyInspectionTemplates = pgTable(
  "safety_inspection_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company standard usable on every project */
    projectId: text("project_id"),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inspectionType: text("inspection_type").default("general_site").notNull(), // SafetyInspectionType
    version: integer("version").default(1).notNull(),
    status: text("status").default("draft").notNull(), // TemplateStatus
    /**
     * Typed items: [{ id, section, position, text, itemType, required,
     * options, guidance, weight, isCritical, photoRequired }] — itemType is a
     * ChecklistItemType, shared with quality checklists so one renderer and
     * one scorer serve both.
     */
    items: jsonb("items").$type<unknown[]>().default([]).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    scoringMethod: text("scoring_method").default("percentage").notNull(), // InspectionScoringMethod
    passThreshold: doublePrecision("pass_threshold"),
    frequency: text("frequency").default("ad_hoc").notNull(), // InspectionFrequency
    /** the regulation or standard the form discharges, e.g. "Work at Height Regs 2005" */
    regulatoryBasis: text("regulatory_basis"),
    isStatutory: integer("is_statutory").default(0).notNull(),
    appliesToTrades: jsonb("applies_to_trades").$type<string[]>().default([]).notNull(),
    supersedesId: text("supersedes_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** template approval — never the author */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_inspection_templates_uq").on(t.companyId, t.reference, t.version),
    index("safety_inspection_templates_company_idx").on(t.companyId, t.status),
  ],
);

/** A performed inspection. `templateVersion` is stamped so a form that was
 *  later revised does not silently rewrite what was inspected last year. */
export const safetyInspections = pgTable(
  "safety_inspections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    title: text("title").notNull(),
    inspectionType: text("inspection_type").default("general_site").notNull(), // SafetyInspectionType
    status: text("status").default("scheduled").notNull(), // SafetyInspectionStatus
    scheduledFor: text("scheduled_for"),
    performedAt: timestamp("performed_at", { withTimezone: true, mode: "string" }),
    locationId: text("location_id"),
    locationText: text("location_text"),
    /** the party being inspected */
    vendorId: text("vendor_id"),
    equipmentId: text("equipment_id"),
    inspectorId: text("inspector_id"),
    inspectorName: text("inspector_name"),
    /** [{ userId?, name, organisation }] — who walked with the inspector */
    accompaniedBy: jsonb("accompanied_by").$type<unknown[]>().default([]).notNull(),
    /**
     * Answers: [{ itemId, response, numericValue, isPass, note,
     * photoFileIds, actionId }] — keyed to the template item ids.
     */
    responses: jsonb("responses").$type<unknown[]>().default([]).notNull(),
    score: doublePrecision("score"),
    maxScore: doublePrecision("max_score"),
    scorePercent: doublePrecision("score_percent"),
    result: text("result"), // InspectionResult
    defectCount: integer("defect_count").default(0).notNull(),
    criticalDefectCount: integer("critical_defect_count").default(0).notNull(),
    openActionCount: integer("open_action_count").default(0).notNull(),
    /** statutory inspections carry a fixed re-inspection interval */
    isStatutory: integer("is_statutory").default(0).notNull(),
    nextDueDate: text("next_due_date"),
    signatureFileId: text("signature_file_id"),
    reportFileId: text("report_file_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    /** review of the inspection — never the inspector */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_inspections_uq").on(t.projectId, t.number),
    index("safety_inspections_project_idx").on(t.projectId, t.status),
    index("safety_inspections_template_idx").on(t.templateId),
    index("safety_inspections_due_idx").on(t.projectId, t.nextDueDate),
  ],
);

/** A toolbox talk / pre-task briefing. `relatedIncidentId` closes the loop:
 *  the briefing given BECAUSE of last week's incident is the evidence that a
 *  lesson was actually pushed to the people it concerned. */
export const toolboxTalks = pgTable(
  "toolbox_talks",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    topic: text("topic"),
    category: text("category").default("other").notNull(), // SafetyCategory
    talkDate: text("talk_date").notNull(), // ISO date
    startTime: text("start_time"), // HH:MM
    durationMinutes: integer("duration_minutes"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    presenterId: text("presenter_id"),
    presenterName: text("presenter_name"),
    /** the subcontractor whose crew was briefed */
    vendorId: text("vendor_id"),
    crewId: text("crew_id"),
    contentSummary: text("content_summary"),
    contentFileId: text("content_file_id"),
    /** the language the talk was actually delivered in (#674 parity) */
    language: text("language"),
    /** interpreter used — a comprehension question an inspector will ask */
    interpreterUsed: integer("interpreter_used").default(0).notNull(),
    attendeeCount: integer("attendee_count").default(0).notNull(),
    expectedAttendeeCount: integer("expected_attendee_count"),
    /** the incident or observation that prompted this talk */
    relatedIncidentId: text("related_incident_id"),
    relatedObservationId: text("related_observation_id"),
    lessonId: text("lesson_id"),
    status: text("status").default("planned").notNull(), // ToolboxTalkStatus
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    signatureSheetFileId: text("signature_sheet_file_id"),
    /** verification that the talk happened — never the presenter */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("toolbox_talks_uq").on(t.projectId, t.number),
    index("toolbox_talks_project_idx").on(t.projectId, t.talkDate),
    index("toolbox_talks_vendor_idx").on(t.vendorId),
  ],
);

/**
 * Attendance at a talk, one row per person. A separate table rather than a
 * jsonb array because the query that matters is the inverse one — "has this
 * worker been briefed on confined spaces this month" — and it is asked about
 * a worker, not about a talk.
 */
export const toolboxTalkAttendees = pgTable(
  "toolbox_talk_attendees",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    talkId: text("talk_id").notNull(),
    /** workforce.workers.id — the same register site access uses */
    workerId: text("worker_id"),
    userId: text("user_id"),
    /** fallback for attendees not in the worker register */
    name: text("name").notNull(),
    vendorId: text("vendor_id"),
    trade: text("trade"),
    acknowledgementMethod: text("acknowledgement_method")
      .default("wet_signature")
      .notNull(), // AcknowledgementMethod
    signedAt: timestamp("signed_at", { withTimezone: true, mode: "string" }),
    signatureFileId: text("signature_file_id"),
    /** whether comprehension was checked, not merely attendance */
    comprehensionChecked: integer("comprehension_checked").default(0).notNull(),
    comprehensionNote: text("comprehension_note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("toolbox_talk_attendees_uq").on(t.talkId, t.workerId),
    index("toolbox_talk_attendees_talk_idx").on(t.talkId),
    index("toolbox_talk_attendees_worker_idx").on(t.workerId),
  ],
);

/**
 * The documentary spine of the safety programme — policies, RAMS, permits,
 * training matrices, competency cards, statutory registers. They share one
 * table because they share the only thing that matters operationally: they
 * EXPIRE, and something must be watching the date. `projectId` is nullable
 * for company-level records (the policy, the training matrix).
 */
export const safetyProgrammeRecords = pgTable(
  "safety_programme_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-level record applying across projects */
    projectId: text("project_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    recordKind: text("record_kind").notNull(), // SafetyProgrammeRecordKind
    title: text("title").notNull(),
    description: text("description"),
    version: text("version"),
    status: text("status").default("draft").notNull(), // SafetyProgrammeRecordStatus
    documentFileId: text("document_file_id"),
    documentSha256: text("document_sha256"),
    effectiveFrom: text("effective_from"),
    /** the date the record stops being valid — the reason this table exists */
    expiresAt: text("expires_at"),
    reviewDueDate: text("review_due_date"),
    reviewIntervalMonths: integer("review_interval_months"),
    ownerId: text("owner_id"),
    /** the party the record belongs to (a sub's RAMS, our policy) */
    vendorId: text("vendor_id"),
    /** workforce.workers.id when the record is personal (a competency card) */
    workerId: text("worker_id"),
    appliesToTrades: jsonb("applies_to_trades").$type<string[]>().default([]).notNull(),
    appliesToLocationIds: jsonb("applies_to_location_ids").$type<string[]>().default([]).notNull(),
    /** the regulation the record discharges */
    regulatoryReference: text("regulatory_reference"),
    /** related hazard categories, for "show me all working-at-height RAMS" */
    categories: jsonb("categories").$type<string[]>().default([]).notNull(),
    /** [{ userId|workerId, acknowledgedAt, method }] */
    acknowledgements: jsonb("acknowledgements").$type<unknown[]>().default([]).notNull(),
    acknowledgementCount: integer("acknowledgement_count").default(0).notNull(),
    requiredAcknowledgementCount: integer("required_acknowledgement_count"),
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    /** renewal bound to the obligations register (ADR 0012) */
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** approval of the record — never the author */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("safety_programme_records_uq").on(t.companyId, t.number),
    index("safety_programme_records_project_idx").on(t.projectId, t.status),
    index("safety_programme_records_expiry_idx").on(t.companyId, t.expiresAt),
    index("safety_programme_records_worker_idx").on(t.workerId),
    index("safety_programme_records_vendor_idx").on(t.vendorId),
  ],
);
