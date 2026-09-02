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
 * QUALITY — ITPs, checklists, NCRs and commissioning (module M22).
 *
 * The chain, end to end, because the tables only make sense as one:
 *
 *   inspection_test_plans        what will be verified, agreed up front
 *     └ itp_activities           each verification, with its INTERVENTION
 *                                POINT — hold, witness, surveillance
 *         └ checklists           the record made when the point is reached
 *             └ checklist_responses   one row per typed question
 *                 └ non_conformance_reports   raised when a response fails
 *
 *   commissioning_systems        what is being handed over
 *     └ commissioning_test_records   pre-functional then functional
 *         └ turnover_packages    the artefacts an owner accepts
 *
 * HOLD POINTS ARE THE POINT OF AN ITP. Work may not proceed past a hold point
 * until the named party releases it; proceeding anyway is a breach and a
 * covering-up allegation. A witness point invites the party but permits work
 * to continue if they do not attend within the notice period — which is why
 * `noticePeriodHours` and `notifiedAt` are stored on the activity. The
 * argument is never about whether they attended; it is about whether notice
 * was given, and this schema answers that from data.
 *
 * NCR DISPOSITION IS A SEGREGATED ACT. `use_as_is` and `repair` leave
 * non-conforming work permanently in the building. `dispositionProposedBy`
 * and `dispositionApprovedBy` are separate columns for the same reason the
 * financial suite separates requester from approver: the party who caused the
 * non-conformance must not be the party who decides it is acceptable.
 *
 * COMMISSIONING HANDS OVER INTO THE TWIN. twin.ts already holds the asset
 * register (`assets`) and its binding to BIM elements by IFC GUID
 * (`asset_element_links`). Commissioning does not duplicate any of that: a
 * system carries `assetId`, a test record carries `assetId`, and a turnover
 * package carries `assetIds` plus `ifcGlobalIds` so the handover writes INTO
 * the existing register rather than beside it.
 *
 * CORRECTIVE ACTIONS ARE NOT DUPLICATED EITHER. An NCR's actions are rows in
 * `safety_corrective_actions` (safety.ts) with `sourceType = "ncr"`, so the
 * project has one overdue-actions list. Only the disposition and the closeout
 * evidence — which are quality judgements, not tasks — live on the NCR.
 */
export const inspectionTestPlans = pgTable(
  "inspection_test_plans",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    scopeOfWork: text("scope_of_work"),
    discipline: text("discipline"),
    /** the spec section the plan verifies (specifications.ts) */
    specSectionId: text("spec_section_id"),
    specSectionCode: text("spec_section_code"),
    workPackage: text("work_package"),
    /** the party who will execute the work being verified */
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    locationId: text("location_id"),
    revision: integer("revision").default(0).notNull(),
    status: text("status").default("draft").notNull(), // ItpStatus
    /** codes and standards the acceptance criteria are drawn from */
    standardsReferences: jsonb("standards_references").$type<string[]>().default([]).notNull(),
    activityCount: integer("activity_count").default(0).notNull(),
    holdPointCount: integer("hold_point_count").default(0).notNull(),
    witnessPointCount: integer("witness_point_count").default(0).notNull(),
    openHoldPointCount: integer("open_hold_point_count").default(0).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    submittedBy: text("submitted_by"),
    /** the engineer's/client's approval of the plan — never the author */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    approvalAuthority: text("approval_authority"),
    approvalComments: text("approval_comments"),
    effectiveFrom: text("effective_from"),
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    documentFileId: text("document_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inspection_test_plans_uq").on(t.projectId, t.number),
    index("inspection_test_plans_project_idx").on(t.projectId, t.status),
    index("inspection_test_plans_spec_idx").on(t.specSectionId),
    index("inspection_test_plans_vendor_idx").on(t.vendorId),
  ],
);

/** One row of an ITP: an activity, its acceptance criteria, and the point at
 *  which somebody else gets to look. See the file header on hold points. */
export const itpActivities = pgTable(
  "itp_activities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    itpId: text("itp_id").notNull(),
    position: integer("position").default(0).notNull(),
    activityCode: text("activity_code"),
    activity: text("activity").notNull(),
    description: text("description"),
    specReference: text("spec_reference"),
    specSectionId: text("spec_section_id"),
    drawingReference: text("drawing_reference"),
    drawingSheetId: text("drawing_sheet_id"),
    acceptanceCriteria: text("acceptance_criteria"),
    testMethod: text("test_method"),
    frequency: text("frequency"),
    /** the document the activity must produce */
    recordRequired: text("record_required"),
    responsibleParty: text("responsible_party").default("contractor").notNull(), // ItpResponsibleParty
    interventionPoint: text("intervention_point").default("surveillance_point").notNull(), // InterventionPoint
    /** notice the verifying party is contractually owed before the point */
    noticePeriodHours: integer("notice_period_hours"),
    /** [{ party, interventionPoint, vendorId?, userId? }] — several may verify */
    verifyingParties: jsonb("verifying_parties").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("pending").notNull(), // ItpActivityStatus
    plannedDate: text("planned_date"),
    /** when notice was actually served — the fact disputes turn on */
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "string" }),
    notifiedBy: text("notified_by"),
    notificationMethod: text("notification_method"),
    actualDate: text("actual_date"),
    /** release of a hold point — never the party who requested it */
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
    releaseNote: text("release_note"),
    /** a waived point is a different fact from an attended one */
    waivedBy: text("waived_by"),
    waivedAt: timestamp("waived_at", { withTimezone: true, mode: "string" }),
    waiverReason: text("waiver_reason"),
    /** the checklist instance that recorded the verification */
    checklistId: text("checklist_id"),
    testRecordId: text("test_record_id"),
    ncrId: text("ncr_id"),
    scheduleActivityId: text("schedule_activity_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("itp_activities_itp_idx").on(t.itpId, t.position),
    index("itp_activities_status_idx").on(t.projectId, t.status),
    index("itp_activities_intervention_idx").on(t.projectId, t.interventionPoint, t.status),
  ],
);

/** A reusable checklist form. `projectId` nullable: company standards are the
 *  norm, project forms the exception. Shared with safety inspections through
 *  the ChecklistItemType vocabulary. */
export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company standard usable on every project */
    projectId: text("project_id"),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").default("quality").notNull(), // ChecklistCategory
    version: integer("version").default(1).notNull(),
    status: text("status").default("draft").notNull(), // TemplateStatus
    itemCount: integer("item_count").default(0).notNull(),
    scoringMethod: text("scoring_method").default("pass_fail").notNull(), // InspectionScoringMethod
    passThreshold: doublePrecision("pass_threshold"),
    /** the spec section this form verifies, when it is section-specific */
    specSectionId: text("spec_section_id"),
    specSectionCode: text("spec_section_code"),
    appliesToTrades: jsonb("applies_to_trades").$type<string[]>().default([]).notNull(),
    isStatutory: integer("is_statutory").default(0).notNull(),
    regulatoryBasis: text("regulatory_basis"),
    /** signature blocks the completed form must carry */
    requiredSignatures: jsonb("required_signatures").$type<unknown[]>().default([]).notNull(),
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
    uniqueIndex("checklist_templates_uq").on(t.companyId, t.reference, t.version),
    index("checklist_templates_company_idx").on(t.companyId, t.status),
    index("checklist_templates_project_idx").on(t.projectId),
  ],
);

/**
 * A typed question on a template. A real table rather than a jsonb array
 * because the type carries arithmetic: a `measurement` item with a target and
 * a tolerance can be judged pass/fail by the platform, and that judgement
 * needs the bounds to be columns, not keys in a blob.
 */
export const checklistTemplateItems = pgTable(
  "checklist_template_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    templateId: text("template_id").notNull(),
    section: text("section"),
    position: integer("position").default(0).notNull(),
    itemNumber: text("item_number"),
    text: text("text").notNull(),
    itemType: text("item_type").default("pass_fail").notNull(), // ChecklistItemType
    required: integer("required").default(1).notNull(),
    /** choices for single_select / multi_select */
    options: jsonb("options").$type<string[]>().default([]).notNull(),
    /* numeric / measurement bounds — the arithmetic acceptance criteria */
    targetValue: doublePrecision("target_value"),
    minValue: doublePrecision("min_value"),
    maxValue: doublePrecision("max_value"),
    tolerancePlus: doublePrecision("tolerance_plus"),
    toleranceMinus: doublePrecision("tolerance_minus"),
    unit: text("unit"),
    acceptanceCriteria: text("acceptance_criteria"),
    guidance: text("guidance"),
    specReference: text("spec_reference"),
    photoRequired: integer("photo_required").default(0).notNull(),
    weight: doublePrecision("weight").default(1).notNull(),
    /** a critical item failing fails the whole checklist regardless of score */
    isCritical: integer("is_critical").default(0).notNull(),
    /** the item corresponds to an ITP hold point */
    isHoldPoint: integer("is_hold_point").default(0).notNull(),
    /** raise an NCR automatically when this item fails */
    raisesNcrOnFail: integer("raises_ncr_on_fail").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("checklist_template_items_template_idx").on(t.templateId, t.position),
    index("checklist_template_items_company_idx").on(t.companyId),
  ],
);

/** A completed (or in-progress) checklist instance. */
export const checklists = pgTable(
  "checklists",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    templateId: text("template_id"),
    /** stamped so a later template revision cannot rewrite the past */
    templateVersion: integer("template_version"),
    title: text("title").notNull(),
    category: text("category").default("quality").notNull(), // ChecklistCategory
    status: text("status").default("draft").notNull(), // ChecklistStatus
    /* what was inspected */
    locationId: text("location_id"),
    locationText: text("location_text"),
    /** twin.assets.id — the physical thing this record attaches to */
    assetId: text("asset_id"),
    equipmentId: text("equipment_id"),
    itpId: text("itp_id"),
    itpActivityId: text("itp_activity_id"),
    specSectionId: text("spec_section_id"),
    drawingSheetId: text("drawing_sheet_id"),
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    scheduledFor: text("scheduled_for"),
    performedAt: timestamp("performed_at", { withTimezone: true, mode: "string" }),
    performedBy: text("performed_by"),
    performedByName: text("performed_by_name"),
    /* results */
    result: text("result"), // InspectionResult
    score: doublePrecision("score"),
    maxScore: doublePrecision("max_score"),
    scorePercent: doublePrecision("score_percent"),
    answeredItemCount: integer("answered_item_count").default(0).notNull(),
    failedItemCount: integer("failed_item_count").default(0).notNull(),
    criticalFailureCount: integer("critical_failure_count").default(0).notNull(),
    ncrCount: integer("ncr_count").default(0).notNull(),
    /* sign-off: the witness is a second party, the reviewer a third */
    witnessedBy: text("witnessed_by"),
    witnessedByName: text("witnessed_by_name"),
    witnessedAt: timestamp("witnessed_at", { withTimezone: true, mode: "string" }),
    signatureFileId: text("signature_file_id"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    reportFileId: text("report_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("checklists_uq").on(t.projectId, t.number),
    index("checklists_project_idx").on(t.projectId, t.status),
    index("checklists_template_idx").on(t.templateId),
    index("checklists_asset_idx").on(t.assetId),
    index("checklists_itp_activity_idx").on(t.itpActivityId),
  ],
);

/**
 * One answer. `questionText` and `itemType` are SNAPSHOTS of the template item
 * as it stood when the answer was given — a checklist is evidence, and
 * evidence that silently re-reads its question from a mutable template is not
 * evidence at all.
 */
export const checklistResponses = pgTable(
  "checklist_responses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    checklistId: text("checklist_id").notNull(),
    templateItemId: text("template_item_id"),
    itemNumber: text("item_number"),
    position: integer("position").default(0).notNull(),
    /** the question exactly as asked at the time */
    questionText: text("question_text").notNull(),
    itemType: text("item_type").default("pass_fail").notNull(), // ChecklistItemType
    response: text("response"),
    numericValue: doublePrecision("numeric_value"),
    selectedOptions: jsonb("selected_options").$type<string[]>().default([]).notNull(),
    unit: text("unit"),
    isPass: integer("is_pass"),
    isNotApplicable: integer("is_not_applicable").default(0).notNull(),
    naReason: text("na_reason"),
    note: text("note"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** calibrated instrument used, where a reading needs traceability */
    instrumentId: text("instrument_id"),
    instrumentSerial: text("instrument_serial"),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "string" }),
    score: doublePrecision("score"),
    maxScore: doublePrecision("max_score"),
    /** the NCR this failed answer raised */
    ncrId: text("ncr_id"),
    punchItemId: text("punch_item_id"),
    respondedBy: text("responded_by"),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("checklist_responses_uq").on(t.checklistId, t.templateItemId),
    index("checklist_responses_checklist_idx").on(t.checklistId, t.position),
    index("checklist_responses_ncr_idx").on(t.ncrId),
  ],
);

/** A non-conformance report. See the file header on why disposition is a
 *  segregated act and where its corrective actions live. */
export const nonConformanceReports = pgTable(
  "non_conformance_reports",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: text("category").default("workmanship").notNull(), // NcrCategory
    severity: text("severity").default("minor").notNull(), // NcrSeverity
    status: text("status").default("open").notNull(), // NcrStatus
    /* where it came from */
    sourceType: text("source_type").default("self_identified").notNull(), // NcrSource
    sourceId: text("source_id"),
    checklistId: text("checklist_id"),
    checklistResponseId: text("checklist_response_id"),
    itpActivityId: text("itp_activity_id"),
    testRecordId: text("test_record_id"),
    deliveryId: text("delivery_id"),
    /* what it is against */
    /** the subcontractor or supplier responsible */
    raisedAgainstVendorId: text("raised_against_vendor_id"),
    commitmentId: text("commitment_id"),
    /** the organisation that raised it — a client NCR is a different animal */
    raisedByOrganisation: text("raised_by_organisation"),
    specSectionId: text("spec_section_id"),
    specClauseRef: text("spec_clause_ref"),
    drawingSheetId: text("drawing_sheet_id"),
    drawingReference: text("drawing_reference"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    /** twin.assets.id when the non-conformance is against installed plant */
    assetId: text("asset_id"),
    materialItemId: text("material_item_id"),
    quantityAffected: doublePrecision("quantity_affected"),
    unit: text("unit"),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "string" }),
    responseDueDate: text("response_due_date"),
    /* disposition — the quality judgement, segregated */
    disposition: text("disposition").default("pending").notNull(), // NcrDisposition
    dispositionJustification: text("disposition_justification"),
    dispositionProposedBy: text("disposition_proposed_by"),
    dispositionProposedAt: timestamp("disposition_proposed_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** designer/engineer acceptance — never the party who caused the NCR */
    dispositionApprovedBy: text("disposition_approved_by"),
    dispositionApprovedAt: timestamp("disposition_approved_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** concession/waiver reference when work is accepted as-is or repaired */
    concessionReference: text("concession_reference"),
    concessionFileId: text("concession_file_id"),
    /* cause and cure */
    rootCause: text("root_cause"),
    rootCauseMethod: text("root_cause_method").default("none").notNull(), // RootCauseMethod
    correctiveActionSummary: text("corrective_action_summary"),
    preventiveActionSummary: text("preventive_action_summary"),
    /** actions live in safety_corrective_actions with sourceType = "ncr" */
    openActionCount: integer("open_action_count").default(0).notNull(),
    /* commercial consequence */
    costImpact: doublePrecision("cost_impact"),
    currency: text("currency").default("USD").notNull(),
    scheduleImpactDays: doublePrecision("schedule_impact_days"),
    /** whether the cost is being recovered from the responsible party */
    isBackcharged: integer("is_backcharged").default(0).notNull(),
    backchargeReference: text("backcharge_reference"),
    changeEventId: text("change_event_id"),
    /* closeout evidence — the part that makes closure defensible */
    closeoutEvidenceDescription: text("closeout_evidence_description"),
    closeoutEvidenceFileIds: jsonb("closeout_evidence_file_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    /** the re-inspection that proved the fix */
    verificationChecklistId: text("verification_checklist_id"),
    verificationMethod: text("verification_method"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    reopenedCount: integer("reopened_count").default(0).notNull(),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    lessonId: text("lesson_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("non_conformance_reports_uq").on(t.projectId, t.number),
    index("non_conformance_reports_project_idx").on(t.projectId, t.status),
    index("non_conformance_reports_vendor_idx").on(t.raisedAgainstVendorId, t.status),
    index("non_conformance_reports_spec_idx").on(t.specSectionId),
    index("non_conformance_reports_source_idx").on(t.sourceType, t.sourceId),
  ],
);

/**
 * A commissionable system or subsystem. Self-referencing through `parentId`
 * so "AHU-01" hangs under "HVAC — Level 3" under "HVAC", and `level` says
 * which is which. `assetId` binds a commissioned system to the twin's asset
 * register rather than to a second one (see the file header).
 */
export const commissioningSystems = pgTable(
  "commissioning_systems",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    /** the site-facing code, e.g. "HVAC-L3-AHU01" */
    systemCode: text("system_code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    discipline: text("discipline"),
    level: text("level").default("system").notNull(), // CommissioningLevel
    parentId: text("parent_id"),
    /** materialized path of ids for subtree queries, as core.locations does */
    path: text("path"),
    locationId: text("location_id"),
    /** twin.assets.id — the register this system is handed over into */
    assetId: text("asset_id"),
    /** IFC GUIDs when the system maps to model elements (twin.asset_element_links) */
    ifcGlobalIds: jsonb("ifc_global_ids").$type<string[]>().default([]).notNull(),
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    /** the commissioning authority / Cx agent responsible */
    cxAgentId: text("cx_agent_id"),
    status: text("status").default("not_started").notNull(), // CommissioningStatus
    percentComplete: doublePrecision("percent_complete").default(0).notNull(),
    plannedStaticCompletion: text("planned_static_completion"),
    plannedEnergisation: text("planned_energisation"),
    plannedFunctionalTest: text("planned_functional_test"),
    plannedCompletionDate: text("planned_completion_date"),
    actualStaticCompletion: text("actual_static_completion"),
    actualEnergisation: text("actual_energisation"),
    actualCompletionDate: text("actual_completion_date"),
    prefunctionalTestCount: integer("prefunctional_test_count").default(0).notNull(),
    functionalTestCount: integer("functional_test_count").default(0).notNull(),
    openDeficiencyCount: integer("open_deficiency_count").default(0).notNull(),
    /** seasonal testing deferred to the opposite season */
    seasonalTestDueDate: text("seasonal_test_due_date"),
    turnoverPackageId: text("turnover_package_id"),
    /** owner acceptance of the system — never the Cx agent who tested it */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    beneficialUseDate: text("beneficial_use_date"),
    warrantyStartDate: text("warranty_start_date"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commissioning_systems_uq").on(t.projectId, t.systemCode),
    index("commissioning_systems_project_idx").on(t.projectId, t.status),
    index("commissioning_systems_parent_idx").on(t.parentId),
    index("commissioning_systems_asset_idx").on(t.assetId),
  ],
);

/**
 * Pre-functional and functional tests in ONE table with `testKind` as the
 * discriminator — they share every column that matters (system, witness,
 * instruments, readings, result) and every rollup treats them identically.
 * `instruments` is recorded because a reading taken with an out-of-calibration
 * meter is not a reading, and that is the first thing an auditor checks.
 */
export const commissioningTestRecords = pgTable(
  "commissioning_test_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    systemId: text("system_id").notNull(),
    testKind: text("test_kind").notNull(), // CommissioningTestKind
    title: text("title").notNull(),
    description: text("description"),
    testProcedureRef: text("test_procedure_ref"),
    procedureFileId: text("procedure_file_id"),
    /** the checklist instance carrying the itemised results */
    checklistId: text("checklist_id"),
    checklistTemplateId: text("checklist_template_id"),
    /** twin.assets.id — the equipment actually under test */
    assetId: text("asset_id"),
    equipmentId: text("equipment_id"),
    locationId: text("location_id"),
    status: text("status").default("scheduled").notNull(), // CommissioningTestStatus
    scheduledFor: text("scheduled_for"),
    performedAt: timestamp("performed_at", { withTimezone: true, mode: "string" }),
    performedBy: text("performed_by"),
    performedByName: text("performed_by_name"),
    vendorId: text("vendor_id"),
    contractorRepName: text("contractor_rep_name"),
    /** the client's or Cx agent's witness — a second party, always */
    witnessedBy: text("witnessed_by"),
    witnessedByName: text("witnessed_by_name"),
    witnessedByOrganisation: text("witnessed_by_organisation"),
    witnessedAt: timestamp("witnessed_at", { withTimezone: true, mode: "string" }),
    thirdPartyWitness: text("third_party_witness"),
    /** ambient conditions at test time — a test is only valid within them */
    ambientConditions: jsonb("ambient_conditions").$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    /** [{ instrumentId, serial, calibrationDueDate, certificateFileId }] */
    instruments: jsonb("instruments").$type<unknown[]>().default([]).notNull(),
    /** [{ point, expected, measured, unit, tolerance, pass }] */
    readings: jsonb("readings").$type<unknown[]>().default([]).notNull(),
    result: text("result"), // TestResult
    deficiencyCount: integer("deficiency_count").default(0).notNull(),
    /** deficiencies raised as punch items or NCRs, not held inline */
    deficiencyRecordIds: jsonb("deficiency_record_ids").$type<string[]>().default([]).notNull(),
    ncrId: text("ncr_id"),
    /** the record this retests, when a failure was retested */
    retestOfId: text("retest_of_id"),
    retestCount: integer("retest_count").default(0).notNull(),
    /** owner acceptance of the test — never the performer */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    certificateFileId: text("certificate_file_id"),
    reportFileId: text("report_file_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("commissioning_test_records_uq").on(t.projectId, t.number),
    index("commissioning_test_records_system_idx").on(t.systemId, t.testKind),
    index("commissioning_test_records_project_idx").on(t.projectId, t.status),
    index("commissioning_test_records_asset_idx").on(t.assetId),
  ],
);

/**
 * The bundle an owner accepts. `contents` is a checklist of required artefact
 * kinds with a present/absent flag, so "the O&Ms are missing" is a query
 * rather than a conversation. The twin columns (`assetIds`, `ifcGlobalIds`,
 * `cobieFileId`) are the actual handover: acceptance of a package is the
 * moment the asset register stops being a construction artefact and starts
 * being an operations one.
 */
export const turnoverPackages = pgTable(
  "turnover_packages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    packageType: text("package_type").default("system").notNull(), // TurnoverPackageType
    status: text("status").default("draft").notNull(), // TurnoverStatus
    /** primary system, with the full set in `systemIds` */
    systemId: text("system_id"),
    systemIds: jsonb("system_ids").$type<string[]>().default([]).notNull(),
    locationId: text("location_id"),
    vendorId: text("vendor_id"),
    /**
     * Required artefacts: [{ kind: TurnoverArtefactKind, required, present,
     * fileId?, note? }] — the acceptance gate, itemised.
     */
    contents: jsonb("contents").$type<unknown[]>().default([]).notNull(),
    requiredArtefactCount: integer("required_artefact_count").default(0).notNull(),
    presentArtefactCount: integer("present_artefact_count").default(0).notNull(),
    asBuiltFileIds: jsonb("as_built_file_ids").$type<string[]>().default([]).notNull(),
    oAndMFileIds: jsonb("o_and_m_file_ids").$type<string[]>().default([]).notNull(),
    testRecordIds: jsonb("test_record_ids").$type<string[]>().default([]).notNull(),
    certificateFileIds: jsonb("certificate_file_ids").$type<string[]>().default([]).notNull(),
    /** twin.warranties.id */
    warrantyIds: jsonb("warranty_ids").$type<string[]>().default([]).notNull(),
    trainingRecordIds: jsonb("training_record_ids").$type<string[]>().default([]).notNull(),
    sparePartsListFileId: text("spare_parts_list_file_id"),
    /* --- the handover INTO the twin (twin.ts assets + asset_element_links) --- */
    /** twin.assets.id registered under this package */
    assetIds: jsonb("asset_ids").$type<string[]>().default([]).notNull(),
    assetCount: integer("asset_count").default(0).notNull(),
    /** IFC GUIDs the handed-over assets are bound to */
    ifcGlobalIds: jsonb("ifc_global_ids").$type<string[]>().default([]).notNull(),
    cobieFileId: text("cobie_file_id"),
    assetHandoverCompletedAt: timestamp("asset_handover_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    /* --- review and acceptance --- */
    openPunchItemCount: integer("open_punch_item_count").default(0).notNull(),
    openNcrCount: integer("open_ncr_count").default(0).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    submittedBy: text("submitted_by"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewComments: text("review_comments"),
    resubmissionCount: integer("resubmission_count").default(0).notNull(),
    /** owner acceptance — never the submitter */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    rejectionReason: text("rejection_reason"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true, mode: "string" }),
    beneficialUseDate: text("beneficial_use_date"),
    warrantyStartDate: text("warranty_start_date"),
    warrantyEndDate: text("warranty_end_date"),
    packageFileId: text("package_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("turnover_packages_uq").on(t.projectId, t.number),
    index("turnover_packages_project_idx").on(t.projectId, t.status),
    index("turnover_packages_system_idx").on(t.systemId),
  ],
);

/* ================================================================== */
/* WP-QUAL — Domain V depth and Domain Z quality registers            */
/*                                                                     */
/* Everything below hangs off the four tables above rather than        */
/* restating them. The rule the whole section obeys: a quality record  */
/* is only worth keeping if it can answer a challenge years later, so  */
/* every register stores WHO said it, WHEN, against WHICH criterion,   */
/* and WHICH document proves it — never just a status.                 */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Sequential sign-off on an intervention point (#1092–1094)           */
/* ------------------------------------------------------------------ */

/**
 * One nominated party's leg of a hold or witness point.
 *
 * A hold point in a real ITP is almost never released by one signature: the
 * contractor's own QC signs first, then the engineer, then the client or a
 * third-party surveillance body (a notified body, an insurer's engineer, a
 * certifying authority). Holding the chain as rows rather than as a jsonb bag
 * on the activity buys three things the bag cannot: an ORDER that can be
 * enforced, a per-party release that is separately ledgered and separately
 * attributable, and a place to put the surveillance report the third party
 * actually issued.
 *
 * `required` distinguishes the parties whose signature the point waits for
 * from the ones who are merely invited. `position` is the sequence: a party
 * may not sign before every required party ahead of it has.
 */
export const itpActivityReleases = pgTable(
  "itp_activity_releases",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    itpId: text("itp_id").notNull(),
    activityId: text("activity_id").notNull(),
    /** order in the chain: contractor QC 1, engineer 2, third party 3 */
    position: integer("position").default(0).notNull(),
    party: text("party").notNull(), // ItpResponsibleParty
    /** 1 = the point waits for this party; 0 = invited, does not block */
    required: integer("required").default(1).notNull(),
    /** the platform user nominated, where the verifier has an account */
    userId: text("user_id"),
    vendorId: text("vendor_id"),
    organisation: text("organisation"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    /** third-party surveillance body accreditation, e.g. "UKAS 0086" */
    accreditation: text("accreditation"),
    status: text("status").default("pending").notNull(), // ReleasePartyStatus
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "string" }),
    notifiedBy: text("notified_by"),
    /** attendance is a different fact from a signature */
    attendedAt: timestamp("attended_at", { withTimezone: true, mode: "string" }),
    attendedByName: text("attended_by_name"),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "string" }),
    releasedByName: text("released_by_name"),
    note: text("note"),
    /** the surveillance report the third party issued for its visit */
    reportFileId: text("report_file_id"),
    signatureFileId: text("signature_file_id"),
    /** a leg released against a concession names it */
    concessionId: text("concession_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("itp_activity_releases_activity_idx").on(t.activityId, t.position),
    index("itp_activity_releases_project_idx").on(t.projectId, t.status),
    index("itp_activity_releases_user_idx").on(t.userId, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Concessions, deviation permits and waivers (#1091)                  */
/* ------------------------------------------------------------------ */

/**
 * The register of departures somebody agreed to.
 *
 * `use_as_is` and `repair` dispositions leave non-conforming work in the
 * building; both are only defensible if the DESIGNER accepted them, and that
 * acceptance is a document with an author, a date, conditions and — very
 * often — an expiry or a quantity limit. Holding it as a register rather than
 * as a text field on the NCR is what makes "how many concessions have we
 * given this subcontractor" and "which concessions expire before handover"
 * answerable at all.
 */
export const qualityConcessions = pgTable(
  "quality_concessions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    kind: text("kind").default("concession").notNull(), // ConcessionKind
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** the departure from the specified requirement, stated as a departure */
    departureFromRequirement: text("departure_from_requirement"),
    justification: text("justification"),
    status: text("status").default("draft").notNull(), // ConcessionStatus
    /* what it covers */
    ncrId: text("ncr_id"),
    itpActivityId: text("itp_activity_id"),
    checklistId: text("checklist_id"),
    testRecordId: text("test_record_id"),
    weldId: text("weld_id"),
    pourId: text("pour_id"),
    certificateId: text("certificate_id"),
    specSectionId: text("spec_section_id"),
    specClauseRef: text("spec_clause_ref"),
    drawingSheetId: text("drawing_sheet_id"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    assetId: text("asset_id"),
    vendorId: text("vendor_id"),
    commitmentId: text("commitment_id"),
    /* the limits that make it a concession rather than a rewrite of the spec */
    quantityLimit: doublePrecision("quantity_limit"),
    unit: text("unit"),
    conditions: text("conditions"),
    expiryDate: text("expiry_date"),
    /* who decided */
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    designerOrganisation: text("designer_organisation"),
    designerContact: text("designer_contact"),
    /** the designer's/client's acceptance — never the party who requested it */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    approvalAuthority: text("approval_authority"),
    approvalComments: text("approval_comments"),
    rejectionReason: text("rejection_reason"),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    /* commercial consequence of accepting non-conforming work */
    valueImpact: doublePrecision("value_impact"),
    currency: text("currency").default("USD").notNull(),
    changeEventId: text("change_event_id"),
    documentFileId: text("document_file_id"),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("quality_concessions_uq").on(t.projectId, t.number),
    index("quality_concessions_project_idx").on(t.projectId, t.status),
    index("quality_concessions_ncr_idx").on(t.ncrId),
    index("quality_concessions_expiry_idx").on(t.projectId, t.expiryDate),
    index("quality_concessions_vendor_idx").on(t.vendorId, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Concrete pours and specimen statistics (#1085–1086)                 */
/* ------------------------------------------------------------------ */

/**
 * A pour is the single most irreversible act on a construction site: once it
 * has gone off, every question about it is answered from records made in the
 * two hours around it or not at all. The columns are those questions —
 * which mix, from which plant, on which tickets, at what slump and what
 * temperature, cured how, with which pre-pour checklist released by whom.
 */
export const concretePours = pgTable(
  "concrete_pours",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    pourName: text("pour_name").notNull(),
    elementType: text("element_type"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    drawingSheetId: text("drawing_sheet_id"),
    drawingReference: text("drawing_reference"),
    status: text("status").default("planned").notNull(), // PourStatus
    plannedDate: text("planned_date"),
    pouredAt: timestamp("poured_at", { withTimezone: true, mode: "string" }),
    /* the mix and its provenance */
    mixReference: text("mix_reference"),
    specifiedGrade: text("specified_grade"),
    /** the characteristic strength the grade names, in MPa */
    specifiedStrengthMpa: doublePrecision("specified_strength_mpa"),
    testAgeDays: integer("test_age_days").default(28).notNull(),
    acceptanceCode: text("acceptance_code").default("specified_only").notNull(), // ConcreteAcceptanceCode
    volumeM3: doublePrecision("volume_m3"),
    supplierVendorId: text("supplier_vendor_id"),
    batchPlant: text("batch_plant"),
    /** [{ ticketNumber, batchedAt, volumeM3, batchNumber?, truck? }] */
    deliveryTickets: jsonb("delivery_tickets").$type<unknown[]>().default([]).notNull(),
    batchNumbers: jsonb("batch_numbers").$type<string[]>().default([]).notNull(),
    /** heat/batch traceability into the certificate register */
    materialCertificateIds: jsonb("material_certificate_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    /* fresh-concrete tests, taken at the truck */
    slumpMm: doublePrecision("slump_mm"),
    slumpSpecMin: doublePrecision("slump_spec_min"),
    slumpSpecMax: doublePrecision("slump_spec_max"),
    airContentPct: doublePrecision("air_content_pct"),
    concreteTempC: doublePrecision("concrete_temp_c"),
    ambientTempC: doublePrecision("ambient_temp_c"),
    curingMethod: text("curing_method"),
    curingStartedAt: timestamp("curing_started_at", { withTimezone: true, mode: "string" }),
    /* the controls */
    itpActivityId: text("itp_activity_id"),
    /** the pre-pour checklist; a pour without one released is a signal */
    prePourChecklistId: text("pre_pour_checklist_id"),
    holdPointReleasedAt: timestamp("hold_point_released_at", {
      withTimezone: true,
      mode: "string",
    }),
    holdPointReleasedBy: text("hold_point_released_by"),
    pouredByVendorId: text("poured_by_vendor_id"),
    supervisedBy: text("supervised_by"),
    /* specimen rollup — recomputed from the specimen rows, never typed in */
    specimenCount: integer("specimen_count").default(0).notNull(),
    testedSpecimenCount: integer("tested_specimen_count").default(0).notNull(),
    failedSpecimenCount: integer("failed_specimen_count").default(0).notNull(),
    meanStrengthMpa: doublePrecision("mean_strength_mpa"),
    minStrengthMpa: doublePrecision("min_strength_mpa"),
    standardDeviationMpa: doublePrecision("standard_deviation_mpa"),
    /** the acceptance verdict and the reasoning behind it, as computed */
    acceptanceVerdict: text("acceptance_verdict"),
    acceptanceReasons: jsonb("acceptance_reasons").$type<string[]>().default([]).notNull(),
    ncrId: text("ncr_id"),
    concessionId: text("concession_id"),
    signalId: text("signal_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("concrete_pours_uq").on(t.projectId, t.number),
    index("concrete_pours_project_idx").on(t.projectId, t.status),
    index("concrete_pours_date_idx").on(t.projectId, t.plannedDate),
    index("concrete_pours_supplier_idx").on(t.supplierVendorId),
  ],
);

/** One cube, cylinder or core, and what the lab said about it. */
export const concreteTestSpecimens = pgTable(
  "concrete_test_specimens",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    pourId: text("pour_id").notNull(),
    specimenRef: text("specimen_ref").notNull(),
    specimenType: text("specimen_type").default("cube").notNull(), // SpecimenType
    castAt: text("cast_at"),
    testAgeDays: integer("test_age_days").default(28).notNull(),
    testDate: text("test_date"),
    strengthMpa: doublePrecision("strength_mpa"),
    densityKgM3: doublePrecision("density_kg_m3"),
    result: text("result").default("pending").notNull(), // SpecimenResult
    failureMode: text("failure_mode"),
    labName: text("lab_name"),
    labAccreditation: text("lab_accreditation"),
    certificateNumber: text("certificate_number"),
    certificateFileId: text("certificate_file_id"),
    /** a specimen voided for a stated reason is not a specimen that failed */
    voidReason: text("void_reason"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("concrete_test_specimens_uq").on(t.pourId, t.specimenRef),
    index("concrete_test_specimens_pour_idx").on(t.pourId, t.testAgeDays),
    index("concrete_test_specimens_project_idx").on(t.projectId, t.result),
  ],
);

/* ------------------------------------------------------------------ */
/* Welding: procedures, welders, welds, NDT (#1087–1088)               */
/* ------------------------------------------------------------------ */

/** A welding procedure specification, and the PQR that qualified it. */
export const weldingProcedures = pgTable(
  "welding_procedures",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    wpsNumber: text("wps_number").notNull(),
    title: text("title").notNull(),
    revision: text("revision"),
    standard: text("standard"),
    process: text("process").default("smaw").notNull(), // WeldProcess
    secondaryProcess: text("secondary_process"),
    jointTypes: jsonb("joint_types").$type<string[]>().default([]).notNull(),
    positions: jsonb("positions").$type<string[]>().default([]).notNull(),
    baseMaterialGroup: text("base_material_group"),
    fillerMaterial: text("filler_material"),
    thicknessMinMm: doublePrecision("thickness_min_mm"),
    thicknessMaxMm: doublePrecision("thickness_max_mm"),
    diameterMinMm: doublePrecision("diameter_min_mm"),
    diameterMaxMm: doublePrecision("diameter_max_mm"),
    preheatMinC: doublePrecision("preheat_min_c"),
    interpassMaxC: doublePrecision("interpass_max_c"),
    pwhtRequired: integer("pwht_required").default(0).notNull(),
    pqrReference: text("pqr_reference"),
    vendorId: text("vendor_id"),
    status: text("status").default("draft").notNull(), // WpsStatus
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    documentFileId: text("document_file_id"),
    supersedesId: text("supersedes_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("welding_procedures_uq").on(t.projectId, t.wpsNumber),
    index("welding_procedures_project_idx").on(t.projectId, t.status),
    index("welding_procedures_vendor_idx").on(t.vendorId),
  ],
);

/**
 * A welder's qualification. Two things end one: the certificate's expiry
 * date, and CONTINUITY — most standards void a qualification when the welder
 * has not used the process for six months, which is why
 * `continuityConfirmedAt` is a column rather than an assumption.
 */
export const welderQualifications = pgTable(
  "welder_qualifications",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    welderName: text("welder_name").notNull(),
    /** the stamp mark that appears on the joint itself */
    welderStamp: text("welder_stamp"),
    workerId: text("worker_id"),
    vendorId: text("vendor_id"),
    certificateNumber: text("certificate_number"),
    qualificationStandard: text("qualification_standard"),
    processes: jsonb("processes").$type<string[]>().default([]).notNull(),
    positions: jsonb("positions").$type<string[]>().default([]).notNull(),
    materialGroups: jsonb("material_groups").$type<string[]>().default([]).notNull(),
    thicknessMinMm: doublePrecision("thickness_min_mm"),
    thicknessMaxMm: doublePrecision("thickness_max_mm"),
    diameterMinMm: doublePrecision("diameter_min_mm"),
    diameterMaxMm: doublePrecision("diameter_max_mm"),
    qualifiedFrom: text("qualified_from"),
    expiryDate: text("expiry_date"),
    /** last confirmation the welder is still working the process */
    continuityConfirmedAt: text("continuity_confirmed_at"),
    continuityMonths: integer("continuity_months").default(6).notNull(),
    status: text("status").default("valid").notNull(), // WelderQualificationStatus
    suspensionReason: text("suspension_reason"),
    certificateFileId: text("certificate_file_id"),
    wpsIds: jsonb("wps_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("welder_qualifications_project_idx").on(t.projectId, t.status),
    index("welder_qualifications_expiry_idx").on(t.projectId, t.expiryDate),
    index("welder_qualifications_stamp_idx").on(t.projectId, t.welderStamp),
    index("welder_qualifications_vendor_idx").on(t.vendorId),
  ],
);

/**
 * The weld map. One row per joint, naming the procedure it was welded to and
 * the welder who made it — which is the whole point: when an NDT report
 * rejects a joint, the question that follows is "what else did that welder
 * make to that procedure", and this table answers it in one query.
 */
export const welds = pgTable(
  "welds",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    weldMapRef: text("weld_map_ref"),
    jointReference: text("joint_reference"),
    jointType: text("joint_type"),
    description: text("description"),
    drawingSheetId: text("drawing_sheet_id"),
    drawingReference: text("drawing_reference"),
    isometricRef: text("isometric_ref"),
    lineOrElementRef: text("line_or_element_ref"),
    systemId: text("system_id"),
    assetId: text("asset_id"),
    locationId: text("location_id"),
    materialSpec: text("material_spec"),
    thicknessMm: doublePrecision("thickness_mm"),
    diameterMm: doublePrecision("diameter_mm"),
    /** the heats that met at this joint — traceability both ways */
    heatNumbers: jsonb("heat_numbers").$type<string[]>().default([]).notNull(),
    materialCertificateIds: jsonb("material_certificate_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    wpsId: text("wps_id"),
    welderQualificationId: text("welder_qualification_id"),
    welderStamp: text("welder_stamp"),
    weldedAt: text("welded_at"),
    vendorId: text("vendor_id"),
    status: text("status").default("planned").notNull(), // WeldStatus
    visualResult: text("visual_result"),
    visualInspectedBy: text("visual_inspected_by"),
    visualInspectedAt: timestamp("visual_inspected_at", { withTimezone: true, mode: "string" }),
    /** the percentage of joints in this class the spec requires be examined */
    ndtRequiredPercent: doublePrecision("ndt_required_percent"),
    ndtMethodsRequired: jsonb("ndt_methods_required").$type<string[]>().default([]).notNull(),
    ndtRecordCount: integer("ndt_record_count").default(0).notNull(),
    ndtAcceptCount: integer("ndt_accept_count").default(0).notNull(),
    ndtRejectCount: integer("ndt_reject_count").default(0).notNull(),
    repairCount: integer("repair_count").default(0).notNull(),
    pwhtCompletedAt: text("pwht_completed_at"),
    ncrId: text("ncr_id"),
    concessionId: text("concession_id"),
    itpActivityId: text("itp_activity_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("welds_uq").on(t.projectId, t.number),
    index("welds_project_idx").on(t.projectId, t.status),
    index("welds_welder_idx").on(t.projectId, t.welderQualificationId),
    index("welds_wps_idx").on(t.wpsId),
    index("welds_system_idx").on(t.systemId),
  ],
);

/** A non-destructive examination of a weld, and the report that carries it. */
export const ndtRecords = pgTable(
  "ndt_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    weldId: text("weld_id").notNull(),
    method: text("method").notNull(), // NdtMethod
    techniqueRef: text("technique_ref"),
    procedureRef: text("procedure_ref"),
    acceptanceStandard: text("acceptance_standard"),
    coverageDescription: text("coverage_description"),
    coveragePercent: doublePrecision("coverage_percent"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }),
    requestedBy: text("requested_by"),
    performedAt: timestamp("performed_at", { withTimezone: true, mode: "string" }),
    /** the inspection body — almost never the contractor */
    performedByOrganisation: text("performed_by_organisation"),
    technicianName: text("technician_name"),
    /** the level the standard requires for interpretation, e.g. "II" */
    technicianLevel: text("technician_level"),
    technicianCertNumber: text("technician_cert_number"),
    result: text("result").default("pending").notNull(), // NdtResult
    defectType: text("defect_type"),
    defectLengthMm: doublePrecision("defect_length_mm"),
    defectLocation: text("defect_location"),
    reportNumber: text("report_number"),
    reportFileId: text("report_file_id"),
    /** the record this re-examines after a repair */
    retestOfId: text("retest_of_id"),
    ncrId: text("ncr_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ndt_records_uq").on(t.projectId, t.number),
    index("ndt_records_weld_idx").on(t.weldId, t.method),
    index("ndt_records_project_idx").on(t.projectId, t.result),
  ],
);

/* ------------------------------------------------------------------ */
/* Material test certificates (#1089)                                  */
/* ------------------------------------------------------------------ */

/**
 * The certificate itself, and whether its numbers meet the specification.
 *
 * The supply-chain module holds the traceability CHAIN (heat → delivery →
 * installed location, supplychain.material_trace_records); this register
 * holds the TEST CERTIFICATE and the verification of it, which is a quality
 * act rather than a logistics one: somebody has to read the yield strength on
 * the mill certificate and compare it with the one the spec demanded. That
 * comparison is stored as measured-against-required rows so the verification
 * can be re-read years later without the certificate PDF.
 */
export const materialTestCertificates = pgTable(
  "material_test_certificates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    certificateNumber: text("certificate_number").notNull(),
    certificateType: text("certificate_type").default("en_10204_3_1").notNull(), // CertificateType
    materialDescription: text("material_description").notNull(),
    materialType: text("material_type"),
    materialGrade: text("material_grade"),
    standard: text("standard"),
    /* traceability */
    heatNumber: text("heat_number"),
    batchNumber: text("batch_number"),
    castNumber: text("cast_number"),
    lotNumber: text("lot_number"),
    serialNumbers: jsonb("serial_numbers").$type<string[]>().default([]).notNull(),
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    /* provenance */
    manufacturer: text("manufacturer"),
    millName: text("mill_name"),
    supplierVendorId: text("supplier_vendor_id"),
    originCountry: text("origin_country"),
    issuedAt: text("issued_at"),
    receivedAt: text("received_at"),
    /* links into the registers that already exist */
    materialTraceRecordId: text("material_trace_record_id"),
    materialItemId: text("material_item_id"),
    deliveryId: text("delivery_id"),
    specSectionId: text("spec_section_id"),
    specClauseRef: text("spec_clause_ref"),
    submittalId: text("submittal_id"),
    /* the verification */
    /** [{ property, required{min,max,value,operator}, measured, unit, pass, reason }] */
    requiredProperties: jsonb("required_properties").$type<unknown[]>().default([]).notNull(),
    measuredProperties: jsonb("measured_properties").$type<unknown[]>().default([]).notNull(),
    verificationStatus: text("verification_status").default("unverified").notNull(),
    verificationReasons: jsonb("verification_reasons").$type<string[]>().default([]).notNull(),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verificationNotes: text("verification_notes"),
    ncrId: text("ncr_id"),
    concessionId: text("concession_id"),
    documentFileId: text("document_file_id"),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    /** where the material went — the other half of traceability */
    installedLocationIds: jsonb("installed_location_ids").$type<string[]>().default([]).notNull(),
    installedDescription: text("installed_description"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("material_test_certificates_uq").on(t.projectId, t.number),
    index("material_test_certificates_project_idx").on(t.projectId, t.verificationStatus),
    index("material_test_certificates_heat_idx").on(t.companyId, t.heatNumber),
    index("material_test_certificates_batch_idx").on(t.companyId, t.batchNumber),
    index("material_test_certificates_supplier_idx").on(t.supplierVendorId),
  ],
);

/* ------------------------------------------------------------------ */
/* Calibration register (#1097)                                        */
/* ------------------------------------------------------------------ */

/**
 * Every instrument whose reading is used as evidence.
 *
 * Commissioning test records already refuse a pass taken on an
 * out-of-calibration meter; that refusal is only as good as the calibration
 * dates it is given, which is why the register exists and why the test route
 * can be pointed at an instrument id rather than at a typed-in date.
 */
export const calibratedInstruments = pgTable(
  "calibrated_instruments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    instrumentType: text("instrument_type"),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number").notNull(),
    assetTag: text("asset_tag"),
    equipmentId: text("equipment_id"),
    ownerVendorId: text("owner_vendor_id"),
    ownerName: text("owner_name"),
    custodian: text("custodian"),
    storageLocation: text("storage_location"),
    rangeMin: doublePrecision("range_min"),
    rangeMax: doublePrecision("range_max"),
    rangeUnit: text("range_unit"),
    accuracy: text("accuracy"),
    calibrationStandard: text("calibration_standard"),
    calibrationIntervalMonths: integer("calibration_interval_months").default(12).notNull(),
    lastCalibratedAt: text("last_calibrated_at"),
    calibrationDueDate: text("calibration_due_date"),
    certificateNumber: text("certificate_number"),
    certificateFileId: text("certificate_file_id"),
    calibratedByOrganisation: text("calibrated_by_organisation"),
    /** the accreditation that makes the certificate traceable to a standard */
    calibrationAccreditation: text("calibration_accreditation"),
    status: text("status").default("in_service").notNull(), // InstrumentStatus
    outOfServiceReason: text("out_of_service_reason"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calibrated_instruments_uq").on(t.projectId, t.number),
    uniqueIndex("calibrated_instruments_serial_uq").on(t.projectId, t.serialNumber),
    index("calibrated_instruments_project_idx").on(t.projectId, t.status),
    index("calibrated_instruments_due_idx").on(t.projectId, t.calibrationDueDate),
  ],
);

/** One calibration event. History matters: an instrument found out of
 *  tolerance casts doubt on every reading taken since its last pass. */
export const calibrationRecords = pgTable(
  "calibration_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    instrumentId: text("instrument_id").notNull(),
    calibratedAt: text("calibrated_at").notNull(),
    calibrationDueDate: text("calibration_due_date"),
    result: text("result").default("pass").notNull(), // CalibrationResult
    /** the condition the instrument arrived in — the audit-critical field */
    asFoundCondition: text("as_found_condition"),
    asLeftCondition: text("as_left_condition"),
    deviationFound: doublePrecision("deviation_found"),
    certificateNumber: text("certificate_number"),
    certificateFileId: text("certificate_file_id"),
    calibratedByOrganisation: text("calibrated_by_organisation"),
    technicianName: text("technician_name"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("calibration_records_instrument_idx").on(t.instrumentId, t.calibratedAt),
    index("calibration_records_project_idx").on(t.projectId, t.result),
  ],
);

/* ------------------------------------------------------------------ */
/* Rework register (#1098) and the cost of quality (#1099–1100)        */
/* ------------------------------------------------------------------ */

/**
 * What it cost to do it twice, and why it had to be done twice.
 *
 * The cause taxonomy is the point. "Rework" as one number is a rounding
 * error in a monthly report; rework split by cause is a management decision —
 * late information is a client problem, workmanship is a subcontract problem,
 * and design error is a professional-indemnity problem. `discoveryPhase`
 * carries the second half of the story: the same defect caught at inspection
 * and caught after handover are not the same cost, and the cost-of-quality
 * model depends on the difference.
 */
export const reworkItems = pgTable(
  "rework_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("identified").notNull(), // ReworkStatus
    sourceType: text("source_type").default("self_identified").notNull(),
    sourceId: text("source_id"),
    ncrId: text("ncr_id"),
    punchItemId: text("punch_item_id"),
    checklistId: text("checklist_id"),
    testRecordId: text("test_record_id"),
    auditFindingId: text("audit_finding_id"),
    causeCategory: text("cause_category").default("workmanship").notNull(), // ReworkCause
    causeDescription: text("cause_description"),
    discoveryPhase: text("discovery_phase").default("during_works").notNull(),
    discoveredAt: text("discovered_at"),
    responsibleVendorId: text("responsible_vendor_id"),
    responsibleParty: text("responsible_party"),
    trade: text("trade"),
    locationId: text("location_id"),
    locationText: text("location_text"),
    systemId: text("system_id"),
    /* the cost, itemised so the total can be defended */
    labourHours: doublePrecision("labour_hours"),
    labourCost: doublePrecision("labour_cost"),
    materialCost: doublePrecision("material_cost"),
    plantCost: doublePrecision("plant_cost"),
    subcontractorCost: doublePrecision("subcontractor_cost"),
    otherCost: doublePrecision("other_cost"),
    totalCost: doublePrecision("total_cost"),
    currency: text("currency").default("USD").notNull(),
    costBasis: text("cost_basis").default("estimated").notNull(), // ReworkCostBasis
    scheduleImpactDays: doublePrecision("schedule_impact_days"),
    quantityAffected: doublePrecision("quantity_affected"),
    unit: text("unit"),
    isBackcharged: integer("is_backcharged").default(0).notNull(),
    changeEventId: text("change_event_id"),
    /** whether a control existed that should have caught it */
    preventable: integer("preventable").default(1).notNull(),
    lessonId: text("lesson_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    verificationChecklistId: text("verification_checklist_id"),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("rework_items_uq").on(t.projectId, t.number),
    index("rework_items_project_idx").on(t.projectId, t.status),
    index("rework_items_cause_idx").on(t.projectId, t.causeCategory),
    index("rework_items_vendor_idx").on(t.responsibleVendorId, t.status),
    index("rework_items_trade_idx").on(t.projectId, t.trade),
  ],
);

/* ------------------------------------------------------------------ */
/* Quality audits and ISO 9001 evidence (#1095–1096)                   */
/* ------------------------------------------------------------------ */

export const qualityAudits = pgTable(
  "quality_audits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    auditType: text("audit_type").default("internal").notNull(), // QualityAuditType
    standard: text("standard"),
    scope: text("scope"),
    objectives: text("objectives"),
    clauseReferences: jsonb("clause_references").$type<string[]>().default([]).notNull(),
    auditedVendorId: text("audited_vendor_id"),
    auditedFunction: text("audited_function"),
    /** the lead auditor — independent of the area audited, by definition */
    leadAuditorId: text("lead_auditor_id"),
    leadAuditorName: text("lead_auditor_name"),
    leadAuditorOrganisation: text("lead_auditor_organisation"),
    auditTeam: jsonb("audit_team").$type<unknown[]>().default([]).notNull(),
    status: text("status").default("planned").notNull(), // QualityAuditStatus
    plannedDate: text("planned_date"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    reportIssuedAt: text("report_issued_at"),
    responseDueDate: text("response_due_date"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    reportFileId: text("report_file_id"),
    /* findings rollup, recomputed from the finding rows */
    findingCount: integer("finding_count").default(0).notNull(),
    majorFindingCount: integer("major_finding_count").default(0).notNull(),
    minorFindingCount: integer("minor_finding_count").default(0).notNull(),
    observationCount: integer("observation_count").default(0).notNull(),
    openFindingCount: integer("open_finding_count").default(0).notNull(),
    conformityPercent: doublePrecision("conformity_percent"),
    nextAuditDueDate: text("next_audit_due_date"),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("quality_audits_uq").on(t.projectId, t.number),
    index("quality_audits_project_idx").on(t.projectId, t.status),
    index("quality_audits_vendor_idx").on(t.auditedVendorId),
    index("quality_audits_date_idx").on(t.projectId, t.plannedDate),
  ],
);

export const qualityAuditFindings = pgTable(
  "quality_audit_findings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    auditId: text("audit_id").notNull(),
    position: integer("position").default(0).notNull(),
    reference: text("reference").notNull(),
    findingType: text("finding_type").default("observation").notNull(), // AuditFindingType
    clauseReference: text("clause_reference"),
    /** what the requirement actually says — quoted, not paraphrased */
    requirement: text("requirement"),
    /** what was seen; the evidence for the finding, not the conclusion */
    evidence: text("evidence"),
    description: text("description").notNull(),
    status: text("status").default("open").notNull(), // AuditFindingStatus
    responsibleUserId: text("responsible_user_id"),
    responsibleVendorId: text("responsible_vendor_id"),
    responseDueDate: text("response_due_date"),
    dueDate: text("due_date"),
    response: text("response"),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    rootCause: text("root_cause"),
    correctiveActionId: text("corrective_action_id"),
    ncrId: text("ncr_id"),
    reworkItemId: text("rework_item_id"),
    verificationEvidence: text("verification_evidence"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("quality_audit_findings_uq").on(t.auditId, t.reference),
    index("quality_audit_findings_audit_idx").on(t.auditId, t.position),
    index("quality_audit_findings_project_idx").on(t.projectId, t.status),
    index("quality_audit_findings_due_idx").on(t.projectId, t.dueDate),
  ],
);

/* ------------------------------------------------------------------ */
/* Closeout: DLP, guarantees, training, spares, POE (Domain V)         */
/* ------------------------------------------------------------------ */

/**
 * A defects liability period. It starts when something is handed over and it
 * ends on a date somebody has to be told about, which is exactly what an
 * Obligation is for — `makeGoodObligationId` points at the row in the
 * assurance register rather than at a reminder this module invents.
 */
export const defectsLiabilityPeriods = pgTable(
  "defects_liability_periods",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    scopeDescription: text("scope_description"),
    turnoverPackageId: text("turnover_package_id"),
    systemId: text("system_id"),
    assetId: text("asset_id"),
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    contractClause: text("contract_clause"),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    durationMonths: integer("duration_months"),
    status: text("status").default("not_started").notNull(), // DlpStatus
    /** obligations.id — the deadline lives in the assurance register */
    makeGoodObligationId: text("make_good_obligation_id"),
    extendedToDate: text("extended_to_date"),
    extensionReason: text("extension_reason"),
    retentionReleaseDate: text("retention_release_date"),
    retentionAmount: doublePrecision("retention_amount"),
    currency: text("currency").default("USD").notNull(),
    finalCertificateDate: text("final_certificate_date"),
    finalCertificateFileId: text("final_certificate_file_id"),
    defectCount: integer("defect_count").default(0).notNull(),
    openDefectCount: integer("open_defect_count").default(0).notNull(),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    signalId: text("signal_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("defects_liability_periods_uq").on(t.projectId, t.number),
    index("defects_liability_periods_project_idx").on(t.projectId, t.status),
    index("defects_liability_periods_end_idx").on(t.projectId, t.endDate),
    index("defects_liability_periods_package_idx").on(t.turnoverPackageId),
  ],
);

/** A defect reported during a liability period, and whether it was made good. */
export const dlpDefects = pgTable(
  "dlp_defects",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    dlpId: text("dlp_id").notNull(),
    position: integer("position").default(0).notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    reportedAt: text("reported_at"),
    reportedByName: text("reported_by_name"),
    reportedByOrganisation: text("reported_by_organisation"),
    severity: text("severity").default("minor").notNull(), // NcrSeverity
    locationId: text("location_id"),
    locationText: text("location_text"),
    assetId: text("asset_id"),
    systemId: text("system_id"),
    responsibleVendorId: text("responsible_vendor_id"),
    status: text("status").default("reported").notNull(), // DlpDefectStatus
    /** the register entries this defect became, where it became one */
    ncrId: text("ncr_id"),
    punchItemId: text("punch_item_id"),
    warrantyClaimId: text("warranty_claim_id"),
    reworkItemId: text("rework_item_id"),
    targetRectificationDate: text("target_rectification_date"),
    rectifiedAt: text("rectified_at"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    disputeReason: text("dispute_reason"),
    cost: doublePrecision("cost"),
    currency: text("currency").default("USD").notNull(),
    photoFileIds: jsonb("photo_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("dlp_defects_uq").on(t.dlpId, t.reference),
    index("dlp_defects_dlp_idx").on(t.dlpId, t.status),
    index("dlp_defects_project_idx").on(t.projectId, t.status),
  ],
);

/**
 * A performance guarantee on a system, and what the test actually measured.
 *
 * The shortfall is the commercial event: contracts price under-performance in
 * liquidated damages per unit of shortfall, so the register stores the rate
 * and computes the exposure with its basis written out. Where the rate is not
 * held the exposure is `null` with a reason — never zero, which would read as
 * "no exposure" rather than "nobody told us the rate".
 */
export const performanceGuarantees = pgTable(
  "performance_guarantees",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    systemId: text("system_id"),
    assetId: text("asset_id"),
    turnoverPackageId: text("turnover_package_id"),
    commitmentId: text("commitment_id"),
    vendorId: text("vendor_id"),
    contractClause: text("contract_clause"),
    parameter: text("parameter").notNull(),
    operator: text("operator").default("at_least").notNull(), // GuaranteeOperator
    guaranteedValue: doublePrecision("guaranteed_value"),
    guaranteedMin: doublePrecision("guaranteed_min"),
    guaranteedMax: doublePrecision("guaranteed_max"),
    unit: text("unit"),
    tolerancePercent: doublePrecision("tolerance_percent"),
    measurementMethod: text("measurement_method"),
    testRecordId: text("test_record_id"),
    measuredValue: doublePrecision("measured_value"),
    measuredAt: timestamp("measured_at", { withTimezone: true, mode: "string" }),
    measuredBy: text("measured_by"),
    /** independent verification of the measurement — never the performer */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    status: text("status").default("declared").notNull(), // GuaranteeStatus
    shortfall: doublePrecision("shortfall"),
    shortfallPercent: doublePrecision("shortfall_percent"),
    /* liquidated damages for shortfall */
    ldRatePerUnit: doublePrecision("ld_rate_per_unit"),
    ldRateUnit: text("ld_rate_unit"),
    ldCapAmount: doublePrecision("ld_cap_amount"),
    ldAmount: doublePrecision("ld_amount"),
    ldBasis: text("ld_basis"),
    currency: text("currency").default("USD").notNull(),
    ncrId: text("ncr_id"),
    concessionId: text("concession_id"),
    waivedBy: text("waived_by"),
    waivedAt: timestamp("waived_at", { withTimezone: true, mode: "string" }),
    waiverReason: text("waiver_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("performance_guarantees_uq").on(t.projectId, t.number),
    index("performance_guarantees_project_idx").on(t.projectId, t.status),
    index("performance_guarantees_system_idx").on(t.systemId),
  ],
);

/** Operator and maintainer training delivered as part of handover. */
export const operatorTrainingRecords = pgTable(
  "operator_training_records",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    trainingKind: text("training_kind").default("hands_on").notNull(), // TrainingKind
    systemId: text("system_id"),
    assetId: text("asset_id"),
    turnoverPackageId: text("turnover_package_id"),
    vendorId: text("vendor_id"),
    trainerName: text("trainer_name"),
    trainerOrganisation: text("trainer_organisation"),
    status: text("status").default("planned").notNull(), // TrainingStatus
    scheduledFor: text("scheduled_for"),
    deliveredAt: text("delivered_at"),
    durationHours: doublePrecision("duration_hours"),
    /** [{ name, organisation, role, userId?, signedAt? }] */
    attendees: jsonb("attendees").$type<unknown[]>().default([]).notNull(),
    attendeeCount: integer("attendee_count").default(0).notNull(),
    competencyAssessed: integer("competency_assessed").default(0).notNull(),
    materialsFileIds: jsonb("materials_file_ids").$type<string[]>().default([]).notNull(),
    recordingFileId: text("recording_file_id"),
    attendanceSheetFileId: text("attendance_sheet_file_id"),
    /** the owner's acceptance that the training was adequate */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    acceptanceNote: text("acceptance_note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("operator_training_records_uq").on(t.projectId, t.number),
    index("operator_training_records_project_idx").on(t.projectId, t.status),
    index("operator_training_records_system_idx").on(t.systemId),
    index("operator_training_records_package_idx").on(t.turnoverPackageId),
  ],
);

/** Spares and special tools an owner is contractually owed at handover. */
export const spareParts = pgTable(
  "spare_parts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    description: text("description").notNull(),
    category: text("category").default("operational_spare").notNull(), // SparePartCategory
    partNumber: text("part_number"),
    manufacturer: text("manufacturer"),
    supplierVendorId: text("supplier_vendor_id"),
    systemId: text("system_id"),
    assetId: text("asset_id"),
    turnoverPackageId: text("turnover_package_id"),
    materialItemId: text("material_item_id"),
    quantityRequired: doublePrecision("quantity_required"),
    quantityDelivered: doublePrecision("quantity_delivered").default(0).notNull(),
    unit: text("unit"),
    unitCost: doublePrecision("unit_cost"),
    currency: text("currency").default("USD").notNull(),
    leadTimeWeeks: doublePrecision("lead_time_weeks"),
    status: text("status").default("specified").notNull(), // SparePartStatus
    orderedAt: text("ordered_at"),
    deliveredAt: text("delivered_at"),
    storageLocation: text("storage_location"),
    receivedBy: text("received_by"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true, mode: "string" }),
    handoverNote: text("handover_note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spare_parts_uq").on(t.projectId, t.number),
    index("spare_parts_project_idx").on(t.projectId, t.status),
    index("spare_parts_system_idx").on(t.systemId),
    index("spare_parts_package_idx").on(t.turnoverPackageId),
  ],
);

/**
 * Post-occupancy evaluation and soft landings (#973–975).
 *
 * The building's performance in use is the only test of whether the design
 * intent survived construction, and it is measured months after everyone has
 * left. Energy actuals against design is stored as two numbers plus the unit,
 * so the gap is computed rather than asserted; where either is missing the
 * variance is null with a reason.
 */
export const postOccupancyEvaluations = pgTable(
  "post_occupancy_evaluations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    poeKind: text("poe_kind").default("soft_landings_review").notNull(), // PoeKind
    turnoverPackageId: text("turnover_package_id"),
    systemId: text("system_id"),
    status: text("status").default("planned").notNull(), // PoeStatus
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    scheduledFor: text("scheduled_for"),
    completedAt: text("completed_at"),
    conductedBy: text("conducted_by"),
    conductedByOrganisation: text("conducted_by_organisation"),
    /* occupant satisfaction */
    surveyResponseCount: integer("survey_response_count"),
    surveyInviteCount: integer("survey_invite_count"),
    satisfactionScore: doublePrecision("satisfaction_score"),
    satisfactionScale: text("satisfaction_scale"),
    /* energy in use against design */
    energyDesignValue: doublePrecision("energy_design_value"),
    energyActualValue: doublePrecision("energy_actual_value"),
    energyUnit: text("energy_unit"),
    /* what the first year actually produced */
    defectsRaisedCount: integer("defects_raised_count"),
    warrantyClaimCount: integer("warranty_claim_count"),
    findings: text("findings"),
    recommendations: text("recommendations"),
    lessonId: text("lesson_id"),
    reportFileId: text("report_file_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("post_occupancy_evaluations_uq").on(t.projectId, t.number),
    index("post_occupancy_evaluations_project_idx").on(t.projectId, t.status),
    index("post_occupancy_evaluations_package_idx").on(t.turnoverPackageId),
  ],
);
