import { sql } from "drizzle-orm";
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

/**
 * SPECIFICATIONS — the spec book as a first-class record (spec Vol I §2.3,
 * module M19).
 *
 * A spec book arrives as one 800-page PDF and is worthless in that form. It
 * is split the way a drawing set is split (`drawing_sets` → `drawing_sheets`
 * → `drawing_revisions`, drawings.ts) and for the same reason: the unit
 * people actually reference is the SECTION, the unit that changes is the
 * REVISION, and the two must be separable so that "approved against section
 * 03 30 00 rev B" stays true after rev C is issued.
 *
 *   spec_books                the uploaded issue, split by a pipeline
 *     └ spec_divisions        CSI MasterFormat divisions ("03 Concrete")
 *         └ spec_sections     the logical section, unique per project by code
 *             └ spec_section_revisions   each issue of that section's text
 *
 * THE RELATIONSHIP THAT MATTERS. A submittal register is not typed by hand;
 * it is BUILT FROM the spec book. Part 1.3 of every section lists what must
 * be submitted, and `spec_submittal_requirements` is that list, one row per
 * requirement, carrying `registeredSubmittalId` forward to the real
 * `submittals` row (field.ts) it produced. The three-state lifecycle —
 * identified → confirmed → registered — is the audit trail of that build, so
 * "the shop drawing was never registered" is answerable from the data rather
 * than from memory. `sourceRequirementId` on the submittal side is deliberately
 * NOT added here: this module owns the forward link, field.ts stays unaware
 * of specifications, and the register-build is a one-way write.
 *
 * CROSS-REFERENCES. core.ts already has `record_links` for generic
 * record↔record association. `spec_references` exists alongside it because a
 * spec cross-reference is anchored at a PARAGRAPH ("2.3.C.4"), carries an
 * extraction confidence, and asserts a KIND — and `conflicts_with` between a
 * clause and a drawing is the origin of a change order, which a generic link
 * row cannot express.
 */
export const specBooks = pgTable(
  "spec_books",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    /** human label, e.g. "SPEC-002" */
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** the issue this book represents, e.g. "IFC", "Tender", "Rev C" */
    issueLabel: text("issue_label"),
    issuedDate: text("issued_date"), // ISO date
    issuedByOrganisation: text("issued_by_organisation"),
    classificationSystem: text("classification_system")
      .default("masterformat_2020")
      .notNull(), // SpecClassificationSystem
    status: text("status").default("draft").notNull(), // SpecBookStatus
    /** split/extract pipeline state, mirroring drawing_sets.processing */
    processing: text("processing").default("pending").notNull(), // pending | processing | ready | failed
    processingError: text("processing_error"),
    /** the uploaded PDF, content-addressed (files.id / files.sha256) */
    sourceFileId: text("source_file_id"),
    sourceFileSha256: text("source_file_sha256"),
    pageCount: integer("page_count"),
    divisionCount: integer("division_count").default(0).notNull(),
    sectionCount: integer("section_count").default(0).notNull(),
    /** exactly one current book per project drives the register build */
    isCurrent: integer("is_current").default(0).notNull(),
    supersedesId: text("supersedes_id"),
    supersededById: text("superseded_by_id"),
    /** stamped when the submittal register was last built from this book */
    registerBuiltAt: timestamp("register_built_at", { withTimezone: true, mode: "string" }),
    registerBuiltBy: text("register_built_by"),
    contractId: text("contract_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** the contractor's acceptance of the issue — never the uploader */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spec_books_uq").on(t.projectId, t.number),
    index("spec_books_project_idx").on(t.projectId, t.status),
    index("spec_books_company_idx").on(t.companyId),
  ],
);

/** A MasterFormat division within a book ("03 — Concrete"). */
export const specDivisions = pgTable(
  "spec_divisions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    bookId: text("book_id").notNull(),
    /** division number as written, e.g. "03" or "26" */
    code: text("code").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    sortOrder: integer("sort_order").default(0).notNull(),
    sectionCount: integer("section_count").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spec_divisions_uq").on(t.bookId, t.code),
    index("spec_divisions_project_idx").on(t.projectId),
  ],
);

/**
 * The logical section. Unique per project by code, NOT per book: "03 30 00"
 * is the same section across every issue of the book, which is what lets a
 * submittal, an ITP and an NCR point at one stable id while the text under it
 * is revised. `currentRevisionId` is the text in force today.
 */
export const specSections = pgTable(
  "spec_sections",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    divisionId: text("division_id"),
    /** section code as written, e.g. "03 30 00" */
    code: text("code").notNull(),
    /** code with separators stripped, for tolerant matching ("033000") */
    normalisedCode: text("normalised_code").notNull(),
    title: text("title").notNull(),
    divisionCode: text("division_code"),
    status: text("status").default("current").notNull(), // SpecSectionStatus
    currentRevisionId: text("current_revision_id"),
    revisionCount: integer("revision_count").default(0).notNull(),
    /** responsible designer/consultant for questions on this section */
    responsibleVendorId: text("responsible_vendor_id"),
    responsibleUserId: text("responsible_user_id"),
    /** trade/discipline this section is procured under */
    tradeCode: text("trade_code"),
    /** true when a requirement extraction has been confirmed by a human */
    requirementsConfirmed: integer("requirements_confirmed").default(0).notNull(),
    submittalRequirementCount: integer("submittal_requirement_count").default(0).notNull(),
    /** set when the section is absent from the current issue and a person withdrew it (#288) */
    withdrawnAt: ts("withdrawn_at"),
    withdrawnBy: text("withdrawn_by"),
    withdrawnReason: text("withdrawn_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spec_sections_uq").on(t.projectId, t.code),
    index("spec_sections_project_idx").on(t.projectId, t.status),
    index("spec_sections_division_idx").on(t.divisionId),
    index("spec_sections_normalised_idx").on(t.projectId, t.normalisedCode),
  ],
);

/**
 * One issue of a section's text. Supersession is explicit in both directions
 * (`supersedesRevisionId` / `isSuperseded`) because the question asked in a
 * dispute is "what did the spec say on the day the work was priced", and that
 * is answered by reading a superseded row, not by reading history.
 */
export const specSectionRevisions = pgTable(
  "spec_section_revisions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sectionId: text("section_id").notNull(),
    bookId: text("book_id").notNull(),
    /** revision label as issued, e.g. "0", "A", "C1" */
    revision: text("revision").notNull(),
    /** monotonic ordinal so "latest" is an ORDER BY, not a string compare */
    revisionOrdinal: integer("revision_ordinal").default(0).notNull(),
    issuedDate: text("issued_date"),
    effectiveFrom: text("effective_from"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    /** the extracted section PDF, split out of the book */
    fileId: text("file_id"),
    fileSha256: text("file_sha256"),
    /** full text for search, AI extraction and clause citation */
    extractedText: text("extracted_text"),
    /** hash of the text so an unchanged reissue is provable as unchanged */
    contentSha256: text("content_sha256"),
    /** CSI three-part structure: { part1: {...}, part2: {...}, part3: {...} } */
    parts: jsonb("parts").$type<Record<string, unknown>>().default({}).notNull(),
    changeSummary: text("change_summary"),
    /** clause-level diff against the previous revision: [{ ref, kind, text }] */
    changedClauses: jsonb("changed_clauses").$type<unknown[]>().default([]).notNull(),
    /** what the reissue did to the register: { superseded, reconfirm, registeredChanged, newRequirements } (#288) */
    impact: jsonb("impact").$type<Record<string, unknown>>(),
    isSuperseded: integer("is_superseded").default(0).notNull(),
    supersedesRevisionId: text("supersedes_revision_id"),
    supersededByRevisionId: text("superseded_by_revision_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "string" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    /** the party who issued this text — the designer, not us */
    issuedBy: text("issued_by"),
    /** acceptance of the reissue, separate from the upload */
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("spec_section_revisions_uq").on(t.sectionId, t.revision),
    index("spec_section_revisions_section_idx").on(t.sectionId, t.revisionOrdinal),
    index("spec_section_revisions_book_idx").on(t.bookId),
    index("spec_section_revisions_project_idx").on(t.projectId),
    /** full-text search over section text (#298) */
    index("spec_section_revisions_fts_idx").using(
      "gin",
      sql`to_tsvector('english', left(coalesce(${t.extractedText}, ''), 400000))`,
    ),
  ],
);

/**
 * A submittal the spec DEMANDS — the source rows the submittal register is
 * built from. Each row records where in the section the demand appears
 * (`paragraphRef`), how it was found (`extractionMethod` + confidence, so an
 * AI reading is never silently indistinguishable from a human one), whether a
 * human agreed with it, and which real `submittals` row it produced.
 */
export const specSubmittalRequirements = pgTable(
  "spec_submittal_requirements",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sectionId: text("section_id").notNull(),
    /** the exact revision the requirement was read out of */
    sectionRevisionId: text("section_revision_id"),
    sectionCode: text("section_code").notNull(),
    /** where in the section it is written, e.g. "1.3.B.2" */
    paragraphRef: text("paragraph_ref"),
    title: text("title").notNull(),
    description: text("description"),
    /** verbatim clause text — the citation, not a paraphrase */
    clauseText: text("clause_text"),
    submittalType: text("submittal_type").default("other").notNull(), // SubmittalType
    /** copies / sets the spec demands, where it says so */
    requiredCopies: integer("required_copies"),
    /** e.g. "prior to fabrication", "with bid", "at closeout" */
    requiredBefore: text("required_before"),
    leadTimeDays: integer("lead_time_days"),
    reviewDays: integer("review_days"),
    isDeferred: integer("is_deferred").default(0).notNull(),
    status: text("status").default("identified").notNull(), // SpecRequirementStatus
    extractionMethod: text("extraction_method").default("manual").notNull(), // SpecExtractionMethod
    /** 0..1 for AI extraction; null when a human typed it */
    extractionConfidence: doublePrecision("extraction_confidence"),
    /** the human who agreed the requirement is real — never the extractor */
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    /** why a requirement was marked not_required, e.g. "scope not in contract" */
    notRequiredReason: text("not_required_reason"),
    /* --- reissue tracking (#288) --- */
    /** 1 when the clause it was read from was amended after confirmation: the SoD chain re-runs */
    needsReconfirmation: integer("needs_reconfirmation").default(0).notNull(),
    /** the revision whose removal of the clause superseded this row */
    supersededByRevisionId: text("superseded_by_revision_id"),
    reissueNote: text("reissue_note"),
    /** THE build link: the submittals row (field.ts) created from this */
    registeredSubmittalId: text("registered_submittal_id"),
    registeredAt: timestamp("registered_at", { withTimezone: true, mode: "string" }),
    registeredBy: text("registered_by"),
    /** the package/commitment responsible for delivering it */
    responsibleVendorId: text("responsible_vendor_id"),
    commitmentId: text("commitment_id"),
    bidPackageId: text("bid_package_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("spec_submittal_requirements_section_idx").on(t.sectionId, t.status),
    index("spec_submittal_requirements_project_idx").on(t.projectId, t.status),
    index("spec_submittal_requirements_submittal_idx").on(t.registeredSubmittalId),
    index("spec_submittal_requirements_reconfirm_idx").on(t.projectId, t.needsReconfirmation),
  ],
);

/**
 * A paragraph-anchored cross-reference from a spec section to something else
 * on the platform — a drawing sheet, an RFI that clarified it, a submittal
 * that answers it. See the file header for why this is not `record_links`.
 */
export const specReferences = pgTable(
  "spec_references",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sectionId: text("section_id").notNull(),
    sectionRevisionId: text("section_revision_id"),
    /** where in the section the reference sits, e.g. "2.3.C.4" */
    paragraphRef: text("paragraph_ref"),
    pageIndex: integer("page_index"),
    targetType: text("target_type").notNull(), // SpecReferenceTarget
    targetId: text("target_id").notNull(),
    /** denormalised label so a reference list renders without five joins */
    targetLabel: text("target_label"),
    referenceKind: text("reference_kind").default("referenced_by").notNull(), // SpecReferenceKind
    note: text("note"),
    extractionMethod: text("extraction_method").default("manual").notNull(), // SpecExtractionMethod
    extractionConfidence: doublePrecision("extraction_confidence"),
    /** a conflicts_with reference resolved by an RFI answer or an addendum */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolutionNote: text("resolution_note"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("spec_references_section_idx").on(t.sectionId),
    index("spec_references_target_idx").on(t.targetType, t.targetId),
    index("spec_references_project_idx").on(t.projectId, t.referenceKind),
  ],
);

/**
 * A reissue notice (#288): one row per section revision that displaced an
 * earlier text, recording what the change did to the register — which
 * requirements were superseded, which must be re-confirmed, which registered
 * submittals now cite a clause that changed under them — and who was told.
 * It is the "spec changed after approval" trail a dispute reads.
 */
export const specRevisionNotices = pgTable(
  "spec_revision_notices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    sectionId: text("section_id").notNull(),
    sectionCode: text("section_code").notNull(),
    revisionId: text("revision_id").notNull(),
    previousRevisionId: text("previous_revision_id"),
    bookId: text("book_id"),
    revision: text("revision").notNull(),
    changedClauseCount: integer("changed_clause_count").default(0).notNull(),
    requirementsSuperseded: integer("requirements_superseded").default(0).notNull(),
    requirementsToReconfirm: integer("requirements_to_reconfirm").default(0).notNull(),
    requirementsNew: integer("requirements_new").default(0).notNull(),
    /** registered submittals whose clause changed: [{ submittalId, requirementId, paragraphRef, kind }] */
    submittalsAffected: jsonb("submittals_affected").$type<unknown[]>().default([]).notNull(),
    notifiedUserIds: jsonb("notified_user_ids").$type<string[]>().default([]).notNull(),
    /** a person's acknowledgement that the reissue has been actioned */
    acknowledgedBy: text("acknowledged_by"),
    acknowledgedAt: ts("acknowledged_at"),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("spec_revision_notices_project_idx").on(t.projectId, t.createdAt),
    index("spec_revision_notices_section_idx").on(t.sectionId),
    index("spec_revision_notices_ack_idx").on(t.projectId, t.acknowledgedAt),
  ],
);
