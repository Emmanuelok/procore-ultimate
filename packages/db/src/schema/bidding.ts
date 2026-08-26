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
 * BIDDING, TENDERING & PREQUALIFICATION (module M25).
 *
 * TWO BIDS ARE NEVER COMPARABLE AS SUBMITTED. One excludes the scaffold, one
 * prices a provisional sum the others left out, a third corrects a quantity
 * it thinks is wrong, and the cheapest headline number belongs to whoever
 * read the scope least carefully. LEVELLING is what this module is actually
 * for, and it is modelled as a real structure rather than a spreadsheet:
 *
 *   bid_levelling_items      a neutral scope row per package — the SAME row
 *                            for every bidder, including `exclusion_check`
 *                            rows that carry no price and exist only to force
 *                            an in-or-out answer
 *     └ bid_levelling_entries    one per (item x submission): as-bid amount,
 *                                an adjustment, a STATED REASON for the
 *                                adjustment, and the levelled amount that
 *                                results. Without the reason, levelling is an
 *                                opinion and a losing bidder's challenge
 *                                succeeds.
 *
 * SEALED BIDS ARE A REAL CONTROL. `bid_packages.isSealed` + `sealedUntil`,
 * and `bid_submissions.sealedFileId` + `sealedSha256`, exist so that "nobody
 * saw a price before the deadline" is provable: the hash fixes the content at
 * submission, `openedAt`/`openedBy` records who broke the seal, and the
 * package's `witnessedBy` records who watched them do it.
 *
 * AWARD RECORDS WHY THE LOWEST BID WAS NOT TAKEN. `bid_awards.isLowestBid`
 * and `notLowestJustification` are the two columns every procurement audit
 * asks for, and `recommendedBy` is always separate from `approvedBy` —
 * evaluating and awarding are different acts by different people.
 *
 * PREQUALIFICATION IS COMPANY-LEVEL. A questionnaire, its responses and a
 * bidder's financial screening are properties of the SUPPLY CHAIN, not of one
 * project, so `projectId` is genuinely nullable on those tables and the
 * unique keys are company-scoped. Prequalification EXPIRES (`expiresAt`), and
 * `obligationId` binds the renewal to the platform's time-bar machinery
 * (ADR 0012) so a lapsed approval is a Signal before it is an invitation
 * mistakenly sent.
 *
 * HANDOFF OUT: an executed award creates a `commitments` row (financials.ts)
 * — `bid_awards.commitmentId` is the seam between procurement and the money
 * spine, and the bidder is always a `vendors` row (directory.ts), never a
 * second company register.
 */
export const bidPackages = pgTable(
  "bid_packages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    scopeDescription: text("scope_description"),
    packageKind: text("package_kind").default("subcontract").notNull(), // BidPackageKind
    procurementRoute: text("procurement_route").default("selective_tender").notNull(), // ProcurementRoute
    tradeCode: text("trade_code"),
    csiDivision: text("csi_division"),
    /** scope defined by spec sections (specifications.ts), not by prose */
    specSectionIds: jsonb("spec_section_ids").$type<string[]>().default([]).notNull(),
    drawingSheetIds: jsonb("drawing_sheet_ids").$type<string[]>().default([]).notNull(),
    /** the budget the award will be charged against (financials.ts) */
    budgetLineItemIds: jsonb("budget_line_item_ids").$type<string[]>().default([]).notNull(),
    estimatedValue: doublePrecision("estimated_value"),
    /** the pre-tender estimate, kept to measure the market against */
    engineersEstimate: doublePrecision("engineers_estimate"),
    currency: text("currency").default("USD").notNull(),
    status: text("status").default("draft").notNull(), // BidPackageStatus
    /* --- the tender timetable --- */
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "string" }),
    questionsDueAt: timestamp("questions_due_at", { withTimezone: true, mode: "string" }),
    /** the moment that decides whether a bid is late — always with timezone */
    bidDueAt: timestamp("bid_due_at", { withTimezone: true, mode: "string" }),
    bidValidityDays: integer("bid_validity_days"),
    siteVisitAt: timestamp("site_visit_at", { withTimezone: true, mode: "string" }),
    isSiteVisitMandatory: integer("is_site_visit_mandatory").default(0).notNull(),
    anticipatedAwardDate: text("anticipated_award_date"),
    anticipatedStartDate: text("anticipated_start_date"),
    anticipatedCompletionDate: text("anticipated_completion_date"),
    addendaCount: integer("addenda_count").default(0).notNull(),
    /* --- requirements placed on bidders --- */
    /** [{ bondType, percent, required }] */
    requiredBonds: jsonb("required_bonds").$type<unknown[]>().default([]).notNull(),
    /** [{ policyType, limit, currency }] — tested against insurance.ts certs */
    insuranceRequirements: jsonb("insurance_requirements").$type<unknown[]>().default([]).notNull(),
    prequalificationRequired: integer("prequalification_required").default(0).notNull(),
    prequalificationQuestionnaireId: text("prequalification_questionnaire_id"),
    retentionPercent: doublePrecision("retention_percent"),
    paymentTermsDays: integer("payment_terms_days"),
    /* --- how the winner will be chosen, declared BEFORE bids open --- */
    evaluationMethod: text("evaluation_method").default("lowest_price").notNull(), // BidEvaluationMethod
    /** [{ key, label, weight, kind }] */
    evaluationCriteria: jsonb("evaluation_criteria").$type<unknown[]>().default([]).notNull(),
    priceWeight: doublePrecision("price_weight"),
    qualityWeight: doublePrecision("quality_weight"),
    /* --- sealed-bid control (see the file header) --- */
    isSealed: integer("is_sealed").default(0).notNull(),
    sealedUntil: timestamp("sealed_until", { withTimezone: true, mode: "string" }),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "string" }),
    openedBy: text("opened_by"),
    /** who witnessed the opening — a second person, always */
    witnessedBy: text("witnessed_by"),
    /* --- rollups --- */
    invitationCount: integer("invitation_count").default(0).notNull(),
    submissionCount: integer("submission_count").default(0).notNull(),
    declineCount: integer("decline_count").default(0).notNull(),
    documentFileIds: jsonb("document_file_ids").$type<string[]>().default([]).notNull(),
    /* --- award (the decision itself lives in bid_awards) --- */
    awardedSubmissionId: text("awarded_submission_id"),
    awardedVendorId: text("awarded_vendor_id"),
    awardedAmount: doublePrecision("awarded_amount"),
    awardedAt: timestamp("awarded_at", { withTimezone: true, mode: "string" }),
    cancelledReason: text("cancelled_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** approval to go out to tender — never the person who wrote the package */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bid_packages_uq").on(t.projectId, t.number),
    index("bid_packages_project_idx").on(t.projectId, t.status),
    index("bid_packages_due_idx").on(t.companyId, t.bidDueAt),
  ],
);

/**
 * An invitation to one bidder, and everything that happened to it. The
 * engagement states (`viewed`, `downloaded`, silent) are what a tender manager
 * chases on; `declineReason` matters in aggregate, because a package where
 * everyone cites `insufficient_time` is a procurement failure on our side.
 */
export const bidInvitations = pgTable(
  "bid_invitations",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    /** directory.vendors.id — never a second company register */
    vendorId: text("vendor_id").notNull(),
    contactId: text("contact_id"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    status: text("status").default("draft").notNull(), // BidInvitationStatus
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "string" }),
    bounceReason: text("bounce_reason"),
    viewedAt: timestamp("viewed_at", { withTimezone: true, mode: "string" }),
    firstDownloadAt: timestamp("first_download_at", { withTimezone: true, mode: "string" }),
    downloadCount: integer("download_count").default(0).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "string" }),
    intentToBid: integer("intent_to_bid").default(0).notNull(),
    declineReason: text("decline_reason"), // BidDeclineReason
    declineNote: text("decline_note"),
    remindersSent: integer("reminders_sent").default(0).notNull(),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true, mode: "string" }),
    /* prequalification gate */
    isPrequalified: integer("is_prequalified").default(0).notNull(),
    prequalificationSubmissionId: text("prequalification_submission_id"),
    prequalificationExpiresAt: text("prequalification_expires_at"),
    /* bidder portal access — only the hash is stored, as api_tokens does */
    portalTokenHash: text("portal_token_hash"),
    portalLastAccessAt: timestamp("portal_last_access_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** addenda the bidder has acknowledged: [{ addendumRef, acknowledgedAt }] */
    addendaAcknowledged: jsonb("addenda_acknowledged").$type<unknown[]>().default([]).notNull(),
    questionsAsked: integer("questions_asked").default(0).notNull(),
    attendedSiteVisit: integer("attended_site_visit").default(0).notNull(),
    submissionId: text("submission_id"),
    disqualifiedReason: text("disqualified_reason"),
    disqualifiedBy: text("disqualified_by"),
    disqualifiedAt: timestamp("disqualified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bid_invitations_uq").on(t.packageId, t.vendorId),
    index("bid_invitations_package_idx").on(t.packageId, t.status),
    index("bid_invitations_vendor_idx").on(t.vendorId),
    index("bid_invitations_project_idx").on(t.projectId),
  ],
);

/**
 * What a bidder actually submitted. `qualifications` and `exclusions` are
 * free text on purpose — they are where the risk hides and they are read by
 * humans — but `isLate`, `complianceStatus` and `normalisedAmount` are
 * columns because they are what the comparison is built on.
 */
export const bidSubmissions = pgTable(
  "bid_submissions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    invitationId: text("invitation_id"),
    vendorId: text("vendor_id").notNull(),
    reference: text("reference").notNull(),
    revision: integer("revision").default(0).notNull(),
    status: text("status").default("draft").notNull(), // BidSubmissionStatus
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }),
    /** measured against the package's bidDueAt, and never inferred later */
    isLate: integer("is_late").default(0).notNull(),
    lateByMinutes: integer("late_by_minutes"),
    lateAcceptedBy: text("late_accepted_by"),
    lateAcceptanceReason: text("late_acceptance_reason"),
    /* the money */
    baseBidAmount: doublePrecision("base_bid_amount"),
    alternatesTotal: doublePrecision("alternates_total"),
    allowancesTotal: doublePrecision("allowances_total"),
    provisionalSumsTotal: doublePrecision("provisional_sums_total"),
    totalAmount: doublePrecision("total_amount"),
    currency: text("currency").default("USD").notNull(),
    /* the words that change what the money means */
    exclusions: text("exclusions"),
    qualifications: text("qualifications"),
    assumptions: text("assumptions"),
    clarificationsRequested: text("clarifications_requested"),
    clarificationResponse: text("clarification_response"),
    /* programme and terms */
    proposedProgrammeWeeks: doublePrecision("proposed_programme_weeks"),
    proposedStartDate: text("proposed_start_date"),
    proposedCompletionDate: text("proposed_completion_date"),
    validUntil: text("valid_until"),
    paymentTermsDays: integer("payment_terms_days"),
    retentionPercent: doublePrecision("retention_percent"),
    /** [{ bondType, offered, provider, cost }] */
    bondsOffered: jsonb("bonds_offered").$type<unknown[]>().default([]).notNull(),
    /** insurance.insurance_certificates.id evidencing required cover */
    insuranceCertificateIds: jsonb("insurance_certificate_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    addendaAcknowledged: jsonb("addenda_acknowledged").$type<string[]>().default([]).notNull(),
    /** [{ label, description, amount, accepted }] */
    alternates: jsonb("alternates").$type<unknown[]>().default([]).notNull(),
    /** [{ description, saving, risk }] — priced ideas, tracked separately */
    valueEngineering: jsonb("value_engineering").$type<unknown[]>().default([]).notNull(),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    /* sealed-bid integrity (see the file header) */
    sealedFileId: text("sealed_file_id"),
    sealedSha256: text("sealed_sha256"),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "string" }),
    openedBy: text("opened_by"),
    /* evaluation */
    complianceStatus: text("compliance_status").default("pending_review").notNull(), // BidComplianceStatus
    nonComplianceNote: text("non_compliance_note"),
    commercialScore: doublePrecision("commercial_score"),
    technicalScore: doublePrecision("technical_score"),
    totalScore: doublePrecision("total_score"),
    rank: integer("rank"),
    /** the levelled, like-for-like figure — the only comparable number */
    normalisedAmount: doublePrecision("normalised_amount"),
    levellingCompletedAt: timestamp("levelling_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** the evaluator — deliberately not the person who awards (bid_awards) */
    evaluatedBy: text("evaluated_by"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true, mode: "string" }),
    evaluationNote: text("evaluation_note"),
    unsuccessfulNotifiedAt: timestamp("unsuccessful_notified_at", {
      withTimezone: true,
      mode: "string",
    }),
    lineCount: integer("line_count").default(0).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bid_submissions_uq").on(t.packageId, t.vendorId, t.revision),
    index("bid_submissions_package_idx").on(t.packageId, t.status),
    index("bid_submissions_vendor_idx").on(t.vendorId),
    index("bid_submissions_project_idx").on(t.projectId),
  ],
);

/** A priced line as the bidder submitted it. `isExcluded` is the field
 *  levelling exists to catch: a zero on a line is not the same as a scope the
 *  bidder never intended to carry. */
export const bidSubmissionLines = pgTable(
  "bid_submission_lines",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    submissionId: text("submission_id").notNull(),
    packageId: text("package_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    /** the neutral scope row this line was mapped onto */
    levellingItemId: text("levelling_item_id"),
    position: integer("position").default(0).notNull(),
    itemCode: text("item_code"),
    description: text("description").notNull(),
    specSectionCode: text("spec_section_code"),
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    amount: doublePrecision("amount"),
    currency: text("currency").default("USD").notNull(),
    isProvisionalSum: integer("is_provisional_sum").default(0).notNull(),
    isAllowance: integer("is_allowance").default(0).notNull(),
    isAlternate: integer("is_alternate").default(0).notNull(),
    alternateLabel: text("alternate_label"),
    /** the bidder says this scope is NOT in their price */
    isExcluded: integer("is_excluded").default(0).notNull(),
    inclusionNote: text("inclusion_note"),
    costCodeId: text("cost_code_id"),
    budgetLineItemId: text("budget_line_item_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bid_submission_lines_submission_idx").on(t.submissionId, t.position),
    index("bid_submission_lines_levelling_idx").on(t.levellingItemId),
    index("bid_submission_lines_package_idx").on(t.packageId),
  ],
);

/** The neutral scope row every bidder is compared on. See the file header. */
export const bidLevellingItems = pgTable(
  "bid_levelling_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    position: integer("position").default(0).notNull(),
    itemCode: text("item_code"),
    description: text("description").notNull(),
    category: text("category").default("base_scope").notNull(), // LevellingItemCategory
    /** what defines the scope of this row */
    specSectionId: text("spec_section_id"),
    scopeReference: text("scope_reference"),
    drawingSheetId: text("drawing_sheet_id"),
    unit: text("unit"),
    estimatedQuantity: doublePrecision("estimated_quantity"),
    /** our own number, so "everyone is 30% over" is visible */
    engineersEstimate: doublePrecision("engineers_estimate"),
    currency: text("currency").default("USD").notNull(),
    /** a mandatory row every bidder must price or explicitly exclude */
    isMandatory: integer("is_mandatory").default(1).notNull(),
    budgetLineItemId: text("budget_line_item_id"),
    costCodeId: text("cost_code_id"),
    notes: text("notes"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bid_levelling_items_package_idx").on(t.packageId, t.position),
    index("bid_levelling_items_project_idx").on(t.projectId),
  ],
);

/**
 * One cell of the comparison grid: what this bidder said about this scope
 * row, what we adjusted it by, and WHY. `levelledAmount` = `asBidAmount` +
 * `adjustmentAmount`, stored rather than computed because the comparison is
 * read far more often than it is edited and because the number must be
 * frozen once an award is made on it.
 */
export const bidLevellingEntries = pgTable(
  "bid_levelling_entries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    levellingItemId: text("levelling_item_id").notNull(),
    submissionId: text("submission_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    submissionLineId: text("submission_line_id"),
    includedStatus: text("included_status").default("unclear").notNull(), // LevellingInclusion
    asBidAmount: doublePrecision("as_bid_amount"),
    adjustmentAmount: doublePrecision("adjustment_amount").default(0).notNull(),
    adjustmentReason: text("adjustment_reason"), // LevellingAdjustmentReason
    adjustmentNote: text("adjustment_note"),
    /** as-bid plus adjustment — the like-for-like figure */
    levelledAmount: doublePrecision("levelled_amount"),
    currency: text("currency").default("USD").notNull(),
    quantity: doublePrecision("quantity"),
    unitRate: doublePrecision("unit_rate"),
    /** the adjustment rests on an assumption the bidder has not confirmed */
    isAssumption: integer("is_assumption").default(0).notNull(),
    /** raised as a tender query rather than assumed */
    clarificationRef: text("clarification_ref"),
    adjustedBy: text("adjusted_by"),
    adjustedAt: timestamp("adjusted_at", { withTimezone: true, mode: "string" }),
    /** review of the levelling — never the person who made the adjustment */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bid_levelling_entries_uq").on(t.levellingItemId, t.submissionId),
    index("bid_levelling_entries_submission_idx").on(t.submissionId),
    index("bid_levelling_entries_package_idx").on(t.packageId),
  ],
);

/** The award decision. Recommending and approving are separate acts by
 *  separate people, and not taking the lowest bid must be justified in
 *  writing — see the file header. */
export const bidAwards = pgTable(
  "bid_awards",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    packageId: text("package_id").notNull(),
    submissionId: text("submission_id").notNull(),
    vendorId: text("vendor_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    awardAmount: doublePrecision("award_amount").notNull(),
    currency: text("currency").default("USD").notNull(),
    scopeSummary: text("scope_summary"),
    status: text("status").default("recommended").notNull(), // BidAwardStatus
    /* the recommendation */
    recommendationBasis: text("recommendation_basis"),
    /** [{ criterion, weight, score, note }] per shortlisted bidder */
    evaluationSummary: jsonb("evaluation_summary").$type<unknown[]>().default([]).notNull(),
    /** the two columns every procurement audit asks for */
    isLowestBid: integer("is_lowest_bid").default(1).notNull(),
    notLowestJustification: text("not_lowest_justification"),
    lowestBidAmount: doublePrecision("lowest_bid_amount"),
    savingAgainstEstimate: doublePrecision("saving_against_estimate"),
    recommendedBy: text("recommended_by"),
    recommendedAt: timestamp("recommended_at", { withTimezone: true, mode: "string" }),
    /* the approval — never the recommender */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    /** the delegated authority the approver acted under */
    approvalAuthority: text("approval_authority"),
    approvalReference: text("approval_reference"),
    rejectedReason: text("rejected_reason"),
    /* contracting out */
    letterOfIntentAt: timestamp("letter_of_intent_at", { withTimezone: true, mode: "string" }),
    letterOfIntentFileId: text("letter_of_intent_file_id"),
    letterOfIntentCap: doublePrecision("letter_of_intent_cap"),
    /** THE seam into the money spine: financials.commitments.id */
    commitmentId: text("commitment_id"),
    contractIssuedAt: timestamp("contract_issued_at", { withTimezone: true, mode: "string" }),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "string" }),
    /* losing bidders */
    unsuccessfulNotifiedAt: timestamp("unsuccessful_notified_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** public-procurement standstill before the contract may be signed */
    standstillEndsAt: timestamp("standstill_ends_at", { withTimezone: true, mode: "string" }),
    debriefProvidedAt: timestamp("debrief_provided_at", { withTimezone: true, mode: "string" }),
    challengeReceived: integer("challenge_received").default(0).notNull(),
    challengeNote: text("challenge_note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bid_awards_uq").on(t.projectId, t.number),
    index("bid_awards_package_idx").on(t.packageId, t.status),
    index("bid_awards_vendor_idx").on(t.vendorId),
    index("bid_awards_commitment_idx").on(t.commitmentId),
  ],
);

/* ------------------------------------------------------------------ */
/* Prequalification — company-level, and it expires                    */
/* ------------------------------------------------------------------ */

/** A questionnaire issued to the supply chain. `projectId` is genuinely
 *  nullable: prequalification is a property of the supply chain, not of one
 *  project, and a project-scoped questionnaire is the exception. */
export const prequalificationQuestionnaires = pgTable(
  "prequalification_questionnaires",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide questionnaire, the normal case */
    projectId: text("project_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").default(1).notNull(),
    status: text("status").default("draft").notNull(), // PrequalQuestionnaireStatus
    /** trades this questionnaire is issued for */
    tradeScope: jsonb("trade_scope").$type<string[]>().default([]).notNull(),
    /** PrequalCategory[] the question set covers */
    categories: jsonb("categories").$type<string[]>().default([]).notNull(),
    questionCount: integer("question_count").default(0).notNull(),
    maxScore: doublePrecision("max_score"),
    passThreshold: doublePrecision("pass_threshold"),
    /** how long an approval from this questionnaire remains valid */
    validityMonths: integer("validity_months"),
    requiresAnnualRefresh: integer("requires_annual_refresh").default(0).notNull(),
    /** financial screening thresholds: { minTurnover, maxContractRatio, … } */
    financialThresholds: jsonb("financial_thresholds")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    approvalAuthority: text("approval_authority"),
    supersedesId: text("supersedes_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** questionnaire approval — never the author */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prequalification_questionnaires_uq").on(t.companyId, t.number),
    index("prequalification_questionnaires_company_idx").on(t.companyId, t.status),
    index("prequalification_questionnaires_project_idx").on(t.projectId),
  ],
);

/**
 * A question. `itemType` reuses ChecklistItemType (quality.ts) so one
 * renderer and one validator serve checklists, safety inspections and
 * prequalification alike. `isKnockout` is the field that does the real work:
 * a wrong answer disqualifies the bidder outright regardless of score.
 */
export const prequalificationQuestions = pgTable(
  "prequalification_questions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** mirrors the questionnaire's scope — null for a company-wide question set */
    projectId: text("project_id"),
    questionnaireId: text("questionnaire_id").notNull(),
    section: text("section"),
    position: integer("position").default(0).notNull(),
    questionCode: text("question_code"),
    text: text("text").notNull(),
    category: text("category").default("technical_capability").notNull(), // PrequalCategory
    itemType: text("item_type").default("text").notNull(), // ChecklistItemType
    required: integer("required").default(1).notNull(),
    options: jsonb("options").$type<string[]>().default([]).notNull(),
    minValue: doublePrecision("min_value"),
    maxValue: doublePrecision("max_value"),
    unit: text("unit"),
    weight: doublePrecision("weight").default(1).notNull(),
    maxScore: doublePrecision("max_score"),
    scoringGuidance: text("scoring_guidance"),
    /** a wrong answer disqualifies outright — see the doc comment above */
    isKnockout: integer("is_knockout").default(0).notNull(),
    /** the answer that triggers the knockout */
    knockoutValue: text("knockout_value"),
    evidenceRequired: integer("evidence_required").default(0).notNull(),
    /** what documents must be attached, e.g. ["iso_9001", "employers_liability"] */
    evidenceKinds: jsonb("evidence_kinds").$type<string[]>().default([]).notNull(),
    guidance: text("guidance"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("prequalification_questions_questionnaire_idx").on(t.questionnaireId, t.position),
    index("prequalification_questions_company_idx").on(t.companyId),
  ],
);

/**
 * A bidder's submitted prequalification, its assessment, and its EXPIRY.
 * `reviewedBy` and `approvedBy` are separate: assessing a questionnaire and
 * admitting a company to the supply chain are different acts. The approved
 * financial limits are the module's real output — most approvals are not
 * binary but capped.
 */
export const prequalificationSubmissions = pgTable(
  "prequalification_submissions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = company-wide prequalification, the normal case */
    projectId: text("project_id"),
    questionnaireId: text("questionnaire_id").notNull(),
    /** directory.vendors.id */
    vendorId: text("vendor_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    status: text("status").default("invited").notNull(), // PrequalSubmissionStatus
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "string" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true, mode: "string" }),
    submittedByContactId: text("submitted_by_contact_id"),
    submittedByName: text("submitted_by_name"),
    /* scoring */
    overallScore: doublePrecision("overall_score"),
    maxScore: doublePrecision("max_score"),
    scorePercent: doublePrecision("score_percent"),
    /** [{ category, score, maxScore }] — a bidder can pass overall and fail H&S */
    categoryScores: jsonb("category_scores").$type<unknown[]>().default([]).notNull(),
    knockoutFailed: integer("knockout_failed").default(0).notNull(),
    knockoutReason: text("knockout_reason"),
    /* outcome */
    outcome: text("outcome").default("pending").notNull(), // PrequalOutcome
    conditions: text("conditions"),
    /** the cap the screening figures exist to set */
    singleProjectLimit: doublePrecision("single_project_limit"),
    aggregateLimit: doublePrecision("aggregate_limit"),
    currency: text("currency").default("USD").notNull(),
    /** trades the vendor is approved for, which may be narrower than asked */
    tradeScopeApproved: jsonb("trade_scope_approved").$type<string[]>().default([]).notNull(),
    /* assessment, segregated */
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewNote: text("review_note"),
    /** admission to the supply chain — never the reviewer */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
    rejectedReason: text("rejected_reason"),
    /* validity — prequalification expires (see the file header) */
    validFrom: text("valid_from"),
    expiresAt: text("expires_at"),
    renewalDueAt: text("renewal_due_at"),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true, mode: "string" }),
    /** renewal bound to the obligations register (ADR 0012) */
    obligationId: text("obligation_id"),
    signalId: text("signal_id"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "string" }),
    suspendedReason: text("suspended_reason"),
    supersedesId: text("supersedes_id"),
    attachmentFileIds: jsonb("attachment_file_ids").$type<string[]>().default([]).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prequalification_submissions_uq").on(t.companyId, t.number),
    index("prequalification_submissions_vendor_idx").on(t.vendorId, t.status),
    index("prequalification_submissions_questionnaire_idx").on(t.questionnaireId),
    index("prequalification_submissions_expiry_idx").on(t.companyId, t.expiresAt),
  ],
);

/** One answer, with the assessor's score against it. `questionText` is a
 *  snapshot for the same reason a checklist response snapshots its question:
 *  the assessment must stay readable after the questionnaire is revised. */
export const prequalificationResponses = pgTable(
  "prequalification_responses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** mirrors the submission's scope — null for a company-wide prequalification */
    projectId: text("project_id"),
    submissionId: text("submission_id").notNull(),
    questionnaireId: text("questionnaire_id").notNull(),
    questionId: text("question_id").notNull(),
    questionCode: text("question_code"),
    /** the question exactly as asked at the time */
    questionText: text("question_text").notNull(),
    category: text("category"), // PrequalCategory
    itemType: text("item_type"), // ChecklistItemType
    response: text("response"),
    numericValue: doublePrecision("numeric_value"),
    selectedOptions: jsonb("selected_options").$type<string[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    score: doublePrecision("score"),
    maxScore: doublePrecision("max_score"),
    isKnockoutFail: integer("is_knockout_fail").default(0).notNull(),
    assessorNote: text("assessor_note"),
    /** the assessor — never the bidder who answered */
    assessedBy: text("assessed_by"),
    assessedAt: timestamp("assessed_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prequalification_responses_uq").on(t.submissionId, t.questionId),
    index("prequalification_responses_submission_idx").on(t.submissionId),
    index("prequalification_responses_company_idx").on(t.companyId),
  ],
);

/**
 * Financial screening figures for one accounting period. Kept per period
 * rather than as current values on the vendor because the trend is the
 * signal: a company whose turnover doubled while its net assets halved is the
 * one that fails mid-contract. `source` records what the figures came from —
 * audited accounts and a self-declared turnover are not the same evidence
 * (ADR 0004), and a screening decision that does not say which it relied on
 * cannot be defended.
 */
export const prequalificationFinancials = pgTable(
  "prequalification_financials",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** directory.vendors.id */
    vendorId: text("vendor_id").notNull(),
    submissionId: text("submission_id"),
    financialYearEnd: text("financial_year_end").notNull(), // ISO date
    periodLabel: text("period_label"),
    periodMonths: integer("period_months"),
    source: text("source").default("self_declared").notNull(), // FinancialDataSource
    currency: text("currency").default("USD").notNull(),
    /* the statements */
    turnover: doublePrecision("turnover"),
    grossProfit: doublePrecision("gross_profit"),
    operatingProfit: doublePrecision("operating_profit"),
    profitBeforeTax: doublePrecision("profit_before_tax"),
    netAssets: doublePrecision("net_assets"),
    currentAssets: doublePrecision("current_assets"),
    currentLiabilities: doublePrecision("current_liabilities"),
    cashAtBank: doublePrecision("cash_at_bank"),
    totalDebt: doublePrecision("total_debt"),
    workingCapital: doublePrecision("working_capital"),
    /* the ratios a screening decision actually turns on */
    currentRatio: doublePrecision("current_ratio"),
    acidTestRatio: doublePrecision("acid_test_ratio"),
    gearingPercent: doublePrecision("gearing_percent"),
    profitMarginPercent: doublePrecision("profit_margin_percent"),
    returnOnCapitalPercent: doublePrecision("return_on_capital_percent"),
    /* capacity — the exposure test */
    largestContractValue: doublePrecision("largest_contract_value"),
    orderBookValue: doublePrecision("order_book_value"),
    /** turnover a single contract may represent without over-exposing them */
    recommendedSingleProjectLimit: doublePrecision("recommended_single_project_limit"),
    contractToTurnoverRatio: doublePrecision("contract_to_turnover_ratio"),
    employeeCount: integer("employee_count"),
    /* external credit view */
    creditAgency: text("credit_agency"),
    creditScore: doublePrecision("credit_score"),
    creditLimit: doublePrecision("credit_limit"),
    creditRating: text("credit_rating"),
    dunsNumber: text("duns_number"),
    /** an auditor's going-concern qualification is a hard stop, not a score */
    isGoingConcernQualified: integer("is_going_concern_qualified").default(0).notNull(),
    auditorQualification: text("auditor_qualification"),
    ccjCount: integer("ccj_count"),
    /** [{ kind, date, note }] — administration, CVA, winding-up petitions */
    insolvencyEvents: jsonb("insolvency_events").$type<unknown[]>().default([]).notNull(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** verification of the figures — never the bidder who supplied them */
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("prequalification_financials_uq").on(t.vendorId, t.financialYearEnd, t.source),
    index("prequalification_financials_vendor_idx").on(t.vendorId, t.financialYearEnd),
    index("prequalification_financials_submission_idx").on(t.submissionId),
  ],
);
