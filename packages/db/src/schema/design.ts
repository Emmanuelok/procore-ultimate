/**
 * DESIGN MANAGEMENT & UPSTREAM CHANGE CONTROL — schema
 * (spec Vol I §1.5 #249–255; Vol II Domain T #886–912).
 *
 * The upstream half of the delivery record. Construction records answer
 * "what was built"; these answer "what were we told to build, when did we
 * know it, who changed it and what did that cost".
 *
 *   design_stage_gates        the project's stage plan (RIBA/AIA/ISO 19650)
 *    └ design_packages        a coherent bundle of design for a discipline
 *        ├ design_reviews     one issue of that package out for comment
 *        │   ├ design_review_participants  who must return, and what code
 *        │   └ design_comments             what they said, and its closure
 *        ├ design_deliverables consultant deliverable schedule (TIDP/MIDP)
 *        ├ design_freezes     what is fixed, and from when
 *        └ design_change_notices  a change to something already fixed
 *            └ design_change_impacts   the assessed cost/time per discipline
 *   design_issues             the discipline-routed issue register
 *   design_decisions          the decision log (what was decided, and why)
 *   design_consultants        the appointed design team, incl. PI cover
 *   design_info_requirements  EIR / BEP / TIDP / MIDP information milestones
 *   design_readiness_snapshots  design-to-construction handover readiness
 *
 * Every table is company-scoped and, since design belongs to a project,
 * project-scoped. What this schema deliberately does NOT duplicate: drawing
 * sheets and revisions (drawings.*), models (bim.*), specification sections
 * (specifications.*), the money of a change (financials.change_events), the
 * programme (schedule.*), vendors (directory.vendors) or obligations and
 * signals (assurance.*). It links to all of them by id and reads what they
 * hold — cross-tool links go through `record_links`.
 */
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
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/* ------------------------------------------------------------------ */
/* Stage gates (#888, #889)                                            */
/* ------------------------------------------------------------------ */

/**
 * One row per stage the project intends to pass through. The stage library
 * itself is code-resident (modules/design/engines/stages.ts) so RIBA, AIA and
 * ISO 19650 vocabularies map onto one canonical key; this table holds the
 * project's dates, sign-off and gate criteria against that key.
 */
export const designStageGates = pgTable(
  "design_stage_gates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** canonical RIBA 2020 key: stage_0 … stage_7 (DesignStageKey) */
    stageKey: text("stage_key").notNull(),
    /** the vocabulary this project speaks, for display (DesignStageFramework) */
    framework: text("framework").default("riba_2020").notNull(),
    /** overridden display name, e.g. "Design Development" on an AIA job */
    label: text("label"),
    plannedStart: text("planned_start"), // ISO date
    plannedEnd: text("planned_end"),
    actualStart: text("actual_start"),
    actualEnd: text("actual_end"),
    status: text("status").default("planned").notNull(), // DesignGateStatus
    /** what must be true to pass the gate; each entry is checked off */
    criteria: jsonb("criteria")
      .$type<Array<{ key: string; label: string; met: boolean; note?: string }>>()
      .default([])
      .notNull(),
    signedOffBy: text("signed_off_by"),
    signedOffAt: ts("signed_off_at"),
    signOffNotes: text("sign_off_notes"),
    rejectedReason: text("rejected_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_stage_gates_uq").on(t.projectId, t.stageKey),
    index("design_stage_gates_project_idx").on(t.projectId, t.status),
    index("design_stage_gates_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Packages (#253, #886)                                               */
/* ------------------------------------------------------------------ */

/**
 * A design package: the unit that is issued, reviewed, frozen and handed
 * over. `stageKey` ties it to the gate it belongs to; `leadVendorId` is the
 * consultant accountable for it.
 */
export const designPackages = pgTable(
  "design_packages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DP-001
    name: text("name").notNull(),
    description: text("description"),
    discipline: text("discipline").default("multi_discipline").notNull(), // DesignDiscipline
    stageKey: text("stage_key"), // DesignStageKey
    status: text("status").default("planned").notNull(), // DesignPackageStatus
    leadVendorId: text("lead_vendor_id"), // directory.vendors.id
    leadUserId: text("lead_user_id"),
    /** the design_consultants row responsible, when one is appointed */
    consultantId: text("consultant_id"),
    plannedIssueDate: text("planned_issue_date"),
    actualIssueDate: text("actual_issue_date"),
    plannedApprovalDate: text("planned_approval_date"),
    approvedAt: ts("approved_at"),
    approvedBy: text("approved_by"),
    /** current revision label as issued, e.g. "P02", "C1" */
    revision: text("revision"),
    /** set by a freeze; a change after this is post-freeze (#896) */
    frozenAt: ts("frozen_at"),
    frozenBy: text("frozen_by"),
    freezeId: text("freeze_id"),
    supersededById: text("superseded_by_id"),
    /** counters kept in step by the routes so the register reads in one query */
    reviewCount: integer("review_count").default(0).notNull(),
    openIssueCount: integer("open_issue_count").default(0).notNull(),
    openCommentCount: integer("open_comment_count").default(0).notNull(),
    dcnCount: integer("dcn_count").default(0).notNull(),
    postFreezeDcnCount: integer("post_freeze_dcn_count").default(0).notNull(),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_packages_uq").on(t.projectId, t.number),
    index("design_packages_project_idx").on(t.projectId, t.status),
    index("design_packages_stage_idx").on(t.projectId, t.stageKey),
    index("design_packages_discipline_idx").on(t.projectId, t.discipline),
    index("design_packages_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Review cycles (#249, #897–#900)                                     */
/* ------------------------------------------------------------------ */

/**
 * One issue of a package out for review. The cycle's `consolidatedCode` is
 * NEVER typed: it is the worst code any reviewer returned (D beats C beats B
 * beats A), computed by the engine when the cycle closes.
 */
export const designReviews = pgTable(
  "design_reviews",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DR-001
    title: text("title").notNull(),
    /** which revision of the package went out */
    revision: text("revision"),
    /** 1 for the first issue, 2 for the resubmission, … (#899) */
    cycleNumber: integer("cycle_number").default(1).notNull(),
    /** the cycle this one resubmits after a C/D */
    previousReviewId: text("previous_review_id"),
    issuedAt: ts("issued_at"),
    dueAt: ts("due_at"),
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    status: text("status").default("open").notNull(), // DesignReviewStatus
    /** engine output: worst reviewer code (DesignReviewCode) */
    consolidatedCode: text("consolidated_code"),
    consolidationBasis: text("consolidation_basis"),
    /** turnaround in days, stamped at close so analytics never recompute it */
    turnaroundDays: doublePrecision("turnaround_days"),
    reviewerCount: integer("reviewer_count").default(0).notNull(),
    returnedCount: integer("returned_count").default(0).notNull(),
    commentCount: integer("comment_count").default(0).notNull(),
    openCommentCount: integer("open_comment_count").default(0).notNull(),
    /** raised once when the cycle passed its due date */
    overdueSignalId: text("overdue_signal_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_reviews_uq").on(t.projectId, t.number),
    index("design_reviews_package_idx").on(t.packageId, t.status),
    index("design_reviews_project_idx").on(t.projectId, t.status),
    index("design_reviews_due_idx").on(t.status, t.dueAt),
    index("design_reviews_company_idx").on(t.companyId),
  ],
);

/** A reviewer on a cycle: an internal user or an external consultant. */
export const designReviewParticipants = pgTable(
  "design_review_participants",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reviewId: text("review_id").notNull(),
    /** exactly one of these two is set */
    userId: text("user_id"),
    vendorId: text("vendor_id"),
    /** free text for an external named reviewer without a user account */
    displayName: text("display_name"),
    discipline: text("discipline").default("multi_discipline").notNull(), // DesignDiscipline
    /** a required reviewer blocks consolidation until they return */
    isRequired: integer("is_required").default(1).notNull(),
    dueAt: ts("due_at"),
    status: text("status").default("pending").notNull(), // DesignReviewerStatus
    returnedCode: text("returned_code"), // DesignReviewCode
    returnedAt: ts("returned_at"),
    returnedBy: text("returned_by"),
    declineReason: text("decline_reason"),
    summary: text("summary"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("design_review_participants_review_idx").on(t.reviewId, t.status),
    index("design_review_participants_user_idx").on(t.userId),
    index("design_review_participants_project_idx").on(t.projectId),
  ],
);

/**
 * A single comment on a review. Segregation of duties: the person who raised
 * a comment may not be the person who responds to it, and only the raiser (or
 * a design lead with admin) may close it — a designer cannot mark their own
 * answer accepted.
 */
export const designComments = pgTable(
  "design_comments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    reviewId: text("review_id").notNull(),
    packageId: text("package_id").notNull(),
    participantId: text("participant_id"),
    sequence: integer("sequence").default(1).notNull(),
    category: text("category").default("other").notNull(), // DesignCommentCategory
    priority: text("priority").default("medium").notNull(), // DesignIssuePriority
    discipline: text("discipline").default("multi_discipline").notNull(),
    body: text("body").notNull(),
    /** where on the design: a sheet number, a spec code, a grid reference */
    locationRef: text("location_ref"),
    drawingSheetId: text("drawing_sheet_id"),
    specSectionId: text("spec_section_id"),
    bimModelId: text("bim_model_id"),
    /** the code the reviewer attached to this individual comment */
    code: text("code"), // DesignReviewCode
    status: text("status").default("open").notNull(), // DesignCommentStatus
    response: text("response"),
    respondedBy: text("responded_by"),
    respondedAt: ts("responded_at"),
    closedBy: text("closed_by"),
    closedAt: ts("closed_at"),
    closeNote: text("close_note"),
    /** set when the comment was escalated into the issue register */
    issueId: text("issue_id"),
    raisedBy: text("raised_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("design_comments_review_idx").on(t.reviewId, t.status),
    index("design_comments_package_idx").on(t.packageId, t.status),
    index("design_comments_project_idx").on(t.projectId, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Issue register (#250, #901–#903)                                    */
/* ------------------------------------------------------------------ */

/**
 * The design issue register with discipline routing. An issue is owned by a
 * discipline first and a person second — that is what makes "who is holding
 * the co-ordination" answerable when the assignee changes.
 */
export const designIssues = pgTable(
  "design_issues",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DI-001
    title: text("title").notNull(),
    description: text("description"),
    issueType: text("issue_type").default("coordination").notNull(), // DesignIssueType
    priority: text("priority").default("medium").notNull(), // DesignIssuePriority
    status: text("status").default("open").notNull(), // DesignIssueStatus
    /** the discipline the issue is routed to (owner of the answer) */
    discipline: text("discipline").default("multi_discipline").notNull(),
    /** disciplines that must contribute before it can close */
    affectedDisciplines: jsonb("affected_disciplines").$type<string[]>().default([]).notNull(),
    packageId: text("package_id"),
    reviewId: text("review_id"),
    commentId: text("comment_id"),
    assignedToUserId: text("assigned_to_user_id"),
    assignedToVendorId: text("assigned_to_vendor_id"),
    assignedAt: ts("assigned_at"),
    dueDate: text("due_date"), // ISO date
    raisedBy: text("raised_by").notNull(),
    raisedAt: ts("raised_at").defaultNow().notNull(),
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
    resolvedAt: ts("resolved_at"),
    closedBy: text("closed_by"),
    closedAt: ts("closed_at"),
    voidReason: text("void_reason"),
    /** what it became: an RFI, a DCN, a change event */
    rfiId: text("rfi_id"),
    changeNoticeId: text("change_notice_id"),
    changeEventId: text("change_event_id"),
    decisionId: text("decision_id"),
    drawingSheetId: text("drawing_sheet_id"),
    specSectionId: text("spec_section_id"),
    bimModelId: text("bim_model_id"),
    locationRef: text("location_ref"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** the stale-issue signal, raised once */
    staleSignalId: text("stale_signal_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_issues_uq").on(t.projectId, t.number),
    index("design_issues_project_idx").on(t.projectId, t.status),
    index("design_issues_discipline_idx").on(t.projectId, t.discipline, t.status),
    index("design_issues_assignee_idx").on(t.assignedToUserId, t.status),
    index("design_issues_due_idx").on(t.status, t.dueDate),
    index("design_issues_package_idx").on(t.packageId),
    index("design_issues_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Decision log (#251, #904–#905)                                      */
/* ------------------------------------------------------------------ */

/**
 * The design decision log: the question, the options considered, what was
 * decided, by whom, on what basis — and what it superseded. A decision is
 * proposed by one person and decided by another (segregation).
 */
export const designDecisions = pgTable(
  "design_decisions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DD-001
    title: text("title").notNull(),
    question: text("question").notNull(),
    background: text("background"),
    discipline: text("discipline").default("multi_discipline").notNull(),
    stageKey: text("stage_key"),
    packageId: text("package_id"),
    issueId: text("issue_id"),
    options: jsonb("options")
      .$type<Array<{ key: string; label: string; costImpact?: number | null; timeImpactDays?: number | null; note?: string }>>()
      .default([])
      .notNull(),
    status: text("status").default("proposed").notNull(), // DesignDecisionStatus
    decision: text("decision"),
    chosenOptionKey: text("chosen_option_key"),
    rationale: text("rationale"),
    /** the authority level that took it (DcnAuthorisationLevel) */
    authorisationLevel: text("authorisation_level"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    /** cost/time consequences as recorded at the decision */
    costImpact: doublePrecision("cost_impact"),
    currency: text("currency").default("USD").notNull(),
    timeImpactDays: integer("time_impact_days"),
    /** the earlier decision this replaces, and the one that replaced this */
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    reversedReason: text("reversed_reason"),
    changeNoticeId: text("change_notice_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    proposedBy: text("proposed_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_decisions_uq").on(t.projectId, t.number),
    index("design_decisions_project_idx").on(t.projectId, t.status),
    index("design_decisions_package_idx").on(t.packageId),
    index("design_decisions_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Consultants and deliverables (#254, #887, #909–#912)                */
/* ------------------------------------------------------------------ */

/**
 * An appointed design consultant. Professional indemnity cover is held here
 * because #912 makes its adequacy a live check, not a filing exercise: cover
 * below the appointment's requirement, or expiring inside the liability
 * period, raises a signal.
 */
export const designConsultants = pgTable(
  "design_consultants",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    vendorId: text("vendor_id"), // directory.vendors.id when known
    name: text("name").notNull(),
    discipline: text("discipline").default("multi_discipline").notNull(),
    role: text("role"), // "lead designer", "delegated design", …
    appointmentRef: text("appointment_ref"),
    commitmentId: text("commitment_id"), // financials.commitments.id
    status: text("status").default("appointed").notNull(), // DesignConsultantStatus
    appointedAt: text("appointed_at"), // ISO date
    completedAt: text("completed_at"),
    /** novation (#910): who they were novated to, and when */
    novatedToVendorId: text("novated_to_vendor_id"),
    novatedAt: text("novated_at"),
    feeValue: doublePrecision("fee_value"),
    currency: text("currency").default("USD").notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    /** professional indemnity (#912) */
    piRequiredAmount: doublePrecision("pi_required_amount"),
    piCoverAmount: doublePrecision("pi_cover_amount"),
    piCurrency: text("pi_currency"),
    piExpiresOn: text("pi_expires_on"), // ISO date
    piInsurerName: text("pi_insurer_name"),
    piPolicyNumber: text("pi_policy_number"),
    piVerifiedBy: text("pi_verified_by"),
    piVerifiedAt: ts("pi_verified_at"),
    piSignalId: text("pi_signal_id"),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("design_consultants_project_idx").on(t.projectId, t.status),
    index("design_consultants_vendor_idx").on(t.vendorId),
    index("design_consultants_company_idx").on(t.companyId),
  ],
);

/**
 * The consultant deliverable schedule (TIDP rows rolled into the MIDP). A
 * late deliverable is not a note in a spreadsheet: it opens an obligation and
 * raises a signal, because it is the most common upstream cause of a
 * downstream delay claim.
 */
export const designDeliverables = pgTable(
  "design_deliverables",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DLV-001
    title: text("title").notNull(),
    description: text("description"),
    deliverableType: text("deliverable_type").default("drawing").notNull(), // DesignDeliverableType
    discipline: text("discipline").default("multi_discipline").notNull(),
    packageId: text("package_id"),
    consultantId: text("consultant_id"),
    vendorId: text("vendor_id"),
    stageKey: text("stage_key"),
    /** which information requirement this satisfies, when it satisfies one */
    infoRequirementId: text("info_requirement_id"),
    /** the construction task that cannot start without it */
    scheduleTaskId: text("schedule_task_id"),
    requiredOnSite: text("required_on_site"), // ISO date
    plannedIssueDate: text("planned_issue_date"),
    forecastIssueDate: text("forecast_issue_date"),
    actualIssueDate: text("actual_issue_date"),
    acceptedAt: ts("accepted_at"),
    acceptedBy: text("accepted_by"),
    rejectedAt: ts("rejected_at"),
    rejectedReason: text("rejected_reason"),
    revision: text("revision"),
    status: text("status").default("planned").notNull(), // DesignDeliverableStatus
    /* engine output, refreshed on every write and by the sweep */
    slippageLevel: text("slippage_level").default("not_assessable").notNull(), // DesignSlippageLevel
    slippageDays: integer("slippage_days"),
    slippageReasons: jsonb("slippage_reasons").$type<string[]>().default([]).notNull(),
    assessedAt: ts("assessed_at"),
    /** the obligation opened for the planned issue date */
    obligationId: text("obligation_id"),
    lateSignalId: text("late_signal_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    drawingSheetIds: jsonb("drawing_sheet_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_deliverables_uq").on(t.projectId, t.number),
    index("design_deliverables_project_idx").on(t.projectId, t.status),
    index("design_deliverables_planned_idx").on(t.projectId, t.plannedIssueDate),
    index("design_deliverables_slippage_idx").on(t.projectId, t.slippageLevel),
    index("design_deliverables_package_idx").on(t.packageId),
    index("design_deliverables_consultant_idx").on(t.consultantId),
    index("design_deliverables_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Freeze and change control (#255, #890–#896)                         */
/* ------------------------------------------------------------------ */

/**
 * A design freeze. Scope is project-, stage- or package-wide; anything
 * changed after `effectiveFrom` inside that scope is a post-freeze change and
 * needs the elevated authorisation the engine computes.
 */
export const designFreezes = pgTable(
  "design_freezes",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    scope: text("scope").default("package").notNull(), // "project" | "stage" | "package"
    packageId: text("package_id"),
    stageKey: text("stage_key"),
    title: text("title").notNull(),
    reason: text("reason"),
    effectiveFrom: ts("effective_from").notNull(),
    status: text("status").default("active").notNull(), // DesignFreezeStatus
    /** the authorisation level a post-freeze change needs while this holds */
    requiredAuthorisation: text("required_authorisation").default("client").notNull(),
    declaredBy: text("declared_by").notNull(),
    liftedBy: text("lifted_by"),
    liftedAt: ts("lifted_at"),
    liftReason: text("lift_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("design_freezes_project_idx").on(t.projectId, t.status),
    index("design_freezes_package_idx").on(t.packageId, t.status),
    index("design_freezes_company_idx").on(t.companyId),
  ],
);

/**
 * A design change notice. The classification (#894) decides entitlement:
 * `design_development` is the design maturing inside its stage and carries
 * none; `design_change` alters something already fixed and does. The
 * originator (#895) decides who carries the cost.
 */
export const designChangeNotices = pgTable(
  "design_change_notices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // DCN-001
    title: text("title").notNull(),
    description: text("description"),
    packageId: text("package_id"),
    stageKey: text("stage_key"),
    discipline: text("discipline").default("multi_discipline").notNull(),
    classification: text("classification").default("design_change").notNull(), // DcnClassification
    originator: text("originator").default("client").notNull(), // DcnOriginator
    originatorVendorId: text("originator_vendor_id"),
    status: text("status").default("draft").notNull(), // DcnStatus
    /* freeze position, stamped at submission and never recomputed after */
    isPostFreeze: integer("is_post_freeze").default(0).notNull(),
    freezeId: text("freeze_id"),
    postFreezeSignalId: text("post_freeze_signal_id"),
    /* authorisation (#892) */
    requiredAuthorisation: text("required_authorisation").default("design_lead").notNull(),
    authorisationBasis: text("authorisation_basis"),
    /* the engine's roll-up of design_change_impacts */
    assessedCost: doublePrecision("assessed_cost"),
    currency: text("currency").default("USD").notNull(),
    assessedTimeDays: integer("assessed_time_days"),
    assessedReworkHours: doublePrecision("assessed_rework_hours"),
    impactCount: integer("impact_count").default(0).notNull(),
    impactCurrencies: jsonb("impact_currencies").$type<string[]>().default([]).notNull(),
    /* downstream links */
    changeEventId: text("change_event_id"), // financials.change_events.id
    scheduleTaskId: text("schedule_task_id"),
    decisionId: text("decision_id"),
    issueId: text("issue_id"),
    /* lifecycle */
    requestedBy: text("requested_by").notNull(),
    requestedAt: ts("requested_at"),
    submittedBy: text("submitted_by"),
    submittedAt: ts("submitted_at"),
    approvedBy: text("approved_by"),
    approvedAt: ts("approved_at"),
    rejectedBy: text("rejected_by"),
    rejectedAt: ts("rejected_at"),
    rejectionReason: text("rejection_reason"),
    implementedBy: text("implemented_by"),
    implementedAt: ts("implemented_at"),
    withdrawnAt: ts("withdrawn_at"),
    withdrawnReason: text("withdrawn_reason"),
    needByDate: text("need_by_date"), // ISO date
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_change_notices_uq").on(t.projectId, t.number),
    index("design_change_notices_project_idx").on(t.projectId, t.status),
    index("design_change_notices_package_idx").on(t.packageId, t.status),
    index("design_change_notices_class_idx").on(t.projectId, t.classification),
    index("design_change_notices_company_idx").on(t.companyId),
  ],
);

/** One discipline's assessed impact of a DCN (#891). */
export const designChangeImpacts = pgTable(
  "design_change_impacts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    changeNoticeId: text("change_notice_id").notNull(),
    discipline: text("discipline").default("multi_discipline").notNull(),
    packageId: text("package_id"),
    consultantId: text("consultant_id"),
    summary: text("summary").notNull(),
    costImpact: doublePrecision("cost_impact"),
    currency: text("currency").default("USD").notNull(),
    timeImpactDays: integer("time_impact_days"),
    reworkHours: doublePrecision("rework_hours"),
    /** knock-on effects on other packages, by id */
    affectedPackageIds: jsonb("affected_package_ids").$type<string[]>().default([]).notNull(),
    riskNote: text("risk_note"),
    assessedBy: text("assessed_by").notNull(),
    assessedAt: ts("assessed_at").defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("design_change_impacts_dcn_idx").on(t.changeNoticeId),
    index("design_change_impacts_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Information requirements (ISO 19650 — EIR/BEP/TIDP/MIDP)            */
/* ------------------------------------------------------------------ */

/**
 * An information requirement milestone: the EIR issued to the market, the
 * BEP returned, the CDE stood up, the TIDP agreed. Each has an owner and a
 * date, and an overdue one opens an obligation — an information requirement
 * nobody delivered is the quiet start of most design disputes.
 */
export const designInfoRequirements = pgTable(
  "design_info_requirements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(), // IR-001
    kind: text("kind").default("eir").notNull(), // DesignInfoRequirementKind
    title: text("title").notNull(),
    requirement: text("requirement"),
    stageKey: text("stage_key"),
    packageId: text("package_id"),
    consultantId: text("consultant_id"),
    responsibleUserId: text("responsible_user_id"),
    responsibleVendorId: text("responsible_vendor_id"),
    dueDate: text("due_date"), // ISO date
    status: text("status").default("planned").notNull(), // DesignInfoRequirementStatus
    deliveredAt: ts("delivered_at"),
    deliveredBy: text("delivered_by"),
    /** verification is a different actor from delivery */
    verifiedAt: ts("verified_at"),
    verifiedBy: text("verified_by"),
    verificationNote: text("verification_note"),
    waivedAt: ts("waived_at"),
    waivedBy: text("waived_by"),
    waiveReason: text("waive_reason"),
    obligationId: text("obligation_id"),
    overdueSignalId: text("overdue_signal_id"),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("design_info_requirements_uq").on(t.projectId, t.number),
    index("design_info_requirements_project_idx").on(t.projectId, t.status),
    index("design_info_requirements_due_idx").on(t.status, t.dueDate),
    index("design_info_requirements_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Handover readiness                                                  */
/* ------------------------------------------------------------------ */

/**
 * A snapshot of design-to-construction handover readiness. The score is a
 * weighted roll-up of dimensions the engine can evidence; a dimension with no
 * inputs scores `null` and lowers the confidence rather than being counted as
 * zero. Snapshots are written only when the verdict moves.
 */
export const designReadinessSnapshots = pgTable(
  "design_readiness_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    /** null = whole project; otherwise the package assessed */
    packageId: text("package_id"),
    computedAt: ts("computed_at").defaultNow().notNull(),
    score: doublePrecision("score"),
    level: text("level").default("not_assessable").notNull(), // DesignReadinessLevel
    confidence: doublePrecision("confidence").default(0).notNull(),
    dimensions: jsonb("dimensions")
      .$type<
        Array<{
          key: string;
          label: string;
          score: number | null;
          weight: number;
          basis: string;
          inputs: Record<string, number | null>;
          reasons: string[];
        }>
      >()
      .default([])
      .notNull(),
    blockers: jsonb("blockers").$type<string[]>().default([]).notNull(),
    reasons: jsonb("reasons").$type<string[]>().default([]).notNull(),
    computedBy: text("computed_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("design_readiness_project_idx").on(t.projectId, t.computedAt),
    index("design_readiness_package_idx").on(t.packageId, t.computedAt),
    index("design_readiness_company_idx").on(t.companyId),
  ],
);
