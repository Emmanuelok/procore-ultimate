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
