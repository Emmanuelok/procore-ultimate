/**
 * CORRESPONDENCE, TRANSMITTALS, ACTION PLANS & FORMS — schema
 * (spec Vol I §2.11 #440–446, §2.12 #447–456, §2.13 #457–464, §0.6 #99).
 *
 * Four registers, one spine:
 *
 *   correspondence_types            what a letter IS in this tenant, and the
 *                                   numbering / response / approval rules
 *    └ correspondence_letters       the formal record, numbered, threaded
 *        ├ correspondence_recipients  who it went to (shared with transmittals)
 *        └ correspondence_approvals   the configurable workflow it passed
 *   correspondence_inbound_messages the raw parsed email, kept so routing is
 *                                   auditable and a re-delivery is a no-op
 *   transmittals                    the issue of documents, with a purpose
 *    └ transmittal_items            what was on it, by pointer
 *   action_plan_templates           the library
 *    └ action_plan_template_activities
 *   action_plans                    the instance, anchored to a location or a
 *                                   schedule task
 *    ├ action_plan_activities       required activities + evidence
 *    └ action_plan_signoffs         multi-party signatures per activity
 *   form_templates                  fields + show/hide logic + PDF mapping
 *    ├ form_assignments             who must fill it in, by when
 *    └ form_responses               the values, validated against the version
 *                                   of the template they were captured on
 *
 * Every table is company-scoped; every project record carries project_id.
 * What this schema deliberately does NOT duplicate: files (documents.files),
 * drawing sheets, submittals, spec sections, contacts/vendors (directory),
 * locations and schedule tasks — it links to all of them by id. The
 * acknowledgement of a drawing distribution stays in drawings.*; this module
 * owns the formal transmittal the distribution may point at.
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

/**
 * The JSON shapes this schema stores. @constructos/db deliberately has no
 * dependency on @constructos/shared (it is the lower layer), so the field,
 * logic and signature shapes are restated here structurally; the canonical
 * unions and the validator live in packages/shared/src/enums-correspondence.ts
 * and the two are kept identical by the module's tests.
 */
interface StoredFormLogicCondition {
  field: string;
  operator: string;
  value?: unknown;
}
interface StoredFormLogicRule {
  all?: StoredFormLogicCondition[];
  any?: StoredFormLogicCondition[];
}
interface StoredFormFieldDef {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  help?: string | null;
  placeholder?: string | null;
  section?: string | null;
  options?: Array<{ value: string; label: string }>;
  min?: number | null;
  max?: number | null;
  maxLength?: number | null;
  defaultValue?: unknown;
  pdfField?: string | null;
  visibleWhen?: StoredFormLogicRule | null;
}
interface StoredFormSignature {
  name: string;
  signedAt: string;
  method: string;
  fileId?: string | null;
  statement?: string | null;
}

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/* ------------------------------------------------------------------ */
/* Correspondence types (#440, #445)                                   */
/* ------------------------------------------------------------------ */

/**
 * A configurable correspondence type. Company-wide when `projectId` is null,
 * otherwise specific to one project. `prefix` drives the reference
 * (LTR-007) and the counter is per type per project, so an Instruction and a
 * Notice each run their own sequence — which is what a register that is read
 * back in a dispute needs.
 */
export const correspondenceTypes = pgTable(
  "correspondence_types",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = available to every project in the tenant */
    projectId: text("project_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** reference prefix, e.g. "LTR", "EOT", "NOD" */
    prefix: text("prefix").notNull(),
    defaultDirection: text("default_direction").default("outbound").notNull(), // CorrespondenceDirection
    /** a response is expected; drives the due date and the obligation */
    requiresResponse: integer("requires_response").default(0).notNull(),
    responseDays: integer("response_days"),
    /** the record is a contractual act (a notice under the contract) */
    isContractual: integer("is_contractual").default(0).notNull(),
    /** an obligation is opened for the response deadline */
    createsObligation: integer("creates_obligation").default(1).notNull(),
    /**
     * Ordered approval steps required before issue (#445). Each entry names
     * a company role or a specific user; the approver may never be the author.
     */
    approvalSteps: jsonb("approval_steps")
      .$type<Array<{ name: string; role?: string | null; userId?: string | null }>>()
      .default([])
      .notNull(),
    isActive: integer("is_active").default(1).notNull(),
    isSystem: integer("is_system").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("correspondence_types_key_uq").on(t.companyId, t.key),
    index("correspondence_types_company_idx").on(t.companyId, t.isActive),
    index("correspondence_types_project_idx").on(t.projectId),
  ],
);

/* ------------------------------------------------------------------ */
/* Letters (#441, #444, #446)                                          */
/* ------------------------------------------------------------------ */

/**
 * A formal letter. Threading: `threadId` is the id of the first letter in the
 * chain (its own id when it starts one) and `inReplyToId` names the immediate
 * parent, so a register row can show the whole exchange without a recursive
 * query. `responseDueDate` is a date the platform will chase.
 */
export const correspondenceLetters = pgTable(
  "correspondence_letters",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    typeId: text("type_id").notNull(),
    typeKey: text("type_key").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    body: text("body"),
    direction: text("direction").default("outbound").notNull(), // CorrespondenceDirection
    status: text("status").default("draft").notNull(), // CorrespondenceStatus
    priority: text("priority").default("normal").notNull(), // CorrespondencePriority
    source: text("source").default("manual").notNull(), // CorrespondenceSource
    isContractual: integer("is_contractual").default(0).notNull(),
    /* --- the exchange --- */
    threadId: text("thread_id").notNull(),
    inReplyToId: text("in_reply_to_id"),
    /* --- who --- */
    fromName: text("from_name"),
    fromEmail: text("from_email"),
    fromUserId: text("from_user_id"),
    fromVendorId: text("from_vendor_id"),
    /* --- dates --- */
    letterDate: text("letter_date"),
    issuedAt: ts("issued_at"),
    issuedBy: text("issued_by"),
    responseRequired: integer("response_required").default(0).notNull(),
    responseDueDate: text("response_due_date"),
    respondedAt: ts("responded_at"),
    respondedBy: text("responded_by"),
    /** the letter that answered this one */
    responseLetterId: text("response_letter_id"),
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    voidReason: text("void_reason"),
    /* --- attachments and links --- */
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    /** assurance.obligations.id opened for the response deadline */
    obligationId: text("obligation_id"),
    /** correspondence_inbound_messages.id when this came from a mailbox */
    inboundMessageId: text("inbound_message_id"),
    /** the transmittal this letter was the cover note for */
    transmittalId: text("transmittal_id"),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** set when the response-due sweep has already chased this letter */
    overdueNotifiedAt: ts("overdue_notified_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("correspondence_letters_ref_uq").on(t.projectId, t.reference),
    index("correspondence_letters_project_idx").on(t.projectId, t.status),
    index("correspondence_letters_company_idx").on(t.companyId),
    index("correspondence_letters_due_idx").on(t.status, t.responseDueDate),
    index("correspondence_letters_thread_idx").on(t.threadId),
    index("correspondence_letters_type_idx").on(t.projectId, t.typeId),
  ],
);

/**
 * A recipient of a letter OR a transmittal — one table, because
 * acknowledgement tracking and read receipts are the same behaviour in both
 * registers and a second copy would drift.
 */
export const correspondenceRecipients = pgTable(
  "correspondence_recipients",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    recordType: text("record_type").notNull(), // RecipientRecordType
    recordId: text("record_id").notNull(),
    kind: text("kind").default("to").notNull(), // RecipientKind
    partyType: text("party_type").default("external").notNull(), // RecipientPartyType
    /** users.id / contacts.id / vendors.id / distribution_groups.id */
    partyId: text("party_id"),
    name: text("name").notNull(),
    email: text("email"),
    organisation: text("organisation"),
    /* --- delivery --- */
    deliveryStatus: text("delivery_status").default("pending").notNull(), // RecipientDeliveryStatus
    sentAt: ts("sent_at"),
    deliveryNote: text("delivery_note"),
    /* --- read receipt (#443) --- */
    firstReadAt: ts("first_read_at"),
    lastReadAt: ts("last_read_at"),
    readCount: integer("read_count").default(0).notNull(),
    downloadCount: integer("download_count").default(0).notNull(),
    /* --- acknowledgement (#443) --- */
    acknowledgementRequired: integer("acknowledgement_required").default(0).notNull(),
    acknowledgedAt: ts("acknowledged_at"),
    acknowledgedBy: text("acknowledged_by"),
    acknowledgementNote: text("acknowledgement_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("correspondence_recipients_record_idx").on(t.recordType, t.recordId),
    index("correspondence_recipients_project_idx").on(t.projectId),
    index("correspondence_recipients_company_idx").on(t.companyId),
    index("correspondence_recipients_email_idx").on(t.email),
  ],
);

/** One step of a type's configurable approval workflow, on one letter (#445). */
export const correspondenceApprovals = pgTable(
  "correspondence_approvals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    letterId: text("letter_id").notNull(),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    /** company role that satisfies the step, when it is not a named person */
    role: text("role"),
    userId: text("user_id"),
    status: text("status").default("pending").notNull(), // CorrespondenceApprovalStatus
    decidedAt: ts("decided_at"),
    decidedBy: text("decided_by"),
    comment: text("comment"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("correspondence_approvals_seq_uq").on(t.letterId, t.seq),
    index("correspondence_approvals_letter_idx").on(t.letterId, t.status),
    index("correspondence_approvals_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Inbound email capture (#99)                                         */
/* ------------------------------------------------------------------ */

/**
 * The message exactly as the transport handed it over, plus what routing did
 * with it. Keeping the raw record is what makes "the email was never
 * received" answerable; `messageId` is unique per project so a redelivery is
 * idempotent rather than a duplicate letter.
 */
export const correspondenceInboundMessages = pgTable(
  "correspondence_inbound_messages",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: jsonb("to_addresses").$type<string[]>().default([]).notNull(),
    ccAddresses: jsonb("cc_addresses").$type<string[]>().default([]).notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text"),
    receivedAt: ts("received_at").notNull(),
    attachments: jsonb("attachments")
      .$type<Array<{ fileId?: string | null; filename?: string | null; contentType?: string | null }>>()
      .default([])
      .notNull(),
    status: text("status").default("captured").notNull(), // InboundMessageStatus
    /** why routing did what it did — printed verbatim in the register */
    routingReason: text("routing_reason"),
    detectedReference: text("detected_reference"),
    letterId: text("letter_id"),
    senderUserId: text("sender_user_id"),
    senderContactId: text("sender_contact_id"),
    /** signature verification result when the transport signed the payload */
    signatureVerified: integer("signature_verified"),
    ingestedBy: text("ingested_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("correspondence_inbound_msgid_uq").on(t.projectId, t.messageId),
    index("correspondence_inbound_project_idx").on(t.projectId, t.status),
    index("correspondence_inbound_company_idx").on(t.companyId),
    index("correspondence_inbound_received_idx").on(t.projectId, t.receivedAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Transmittals (#442–443)                                             */
/* ------------------------------------------------------------------ */

/**
 * The formal issue of documents. `purpose` is the fact a claim turns on
 * ("issued for construction" vs "for information"), so it is required and
 * frozen at issue. Acknowledgement counters are denormalised for the register
 * scan and recomputed by the same engine that answers the detail route.
 */
export const transmittals = pgTable(
  "transmittals",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    purpose: text("purpose").default("for_information").notNull(), // TransmittalPurpose
    status: text("status").default("draft").notNull(), // TransmittalStatus
    method: text("method").default("email").notNull(), // TransmittalMethod
    coverNote: text("cover_note"),
    issuedAt: ts("issued_at"),
    issuedBy: text("issued_by"),
    /** acknowledgement deadline; drives the obligation and the sweep */
    ackDueDate: text("ack_due_date"),
    ackRequired: integer("ack_required").default(1).notNull(),
    closedAt: ts("closed_at"),
    closedBy: text("closed_by"),
    voidReason: text("void_reason"),
    /* denormalised acknowledgement position */
    recipientCount: integer("recipient_count").default(0).notNull(),
    ackRequiredCount: integer("ack_required_count").default(0).notNull(),
    acknowledgedCount: integer("acknowledged_count").default(0).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    obligationId: text("obligation_id"),
    /** the cover letter, when one was raised */
    letterId: text("letter_id"),
    overdueNotifiedAt: ts("overdue_notified_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("transmittals_ref_uq").on(t.projectId, t.reference),
    index("transmittals_project_idx").on(t.projectId, t.status),
    index("transmittals_company_idx").on(t.companyId),
    index("transmittals_ack_due_idx").on(t.status, t.ackDueDate),
  ],
);

/** One line on a transmittal — a pointer into the register that owns the item. */
export const transmittalItems = pgTable(
  "transmittal_items",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    transmittalId: text("transmittal_id").notNull(),
    seq: integer("seq").notNull(),
    itemType: text("item_type").default("file").notNull(), // TransmittalItemType
    /** files.id / drawing_sheets.id / submittals.id / spec_sections.id */
    itemId: text("item_id"),
    title: text("title").notNull(),
    /** the issuer's revision label at the moment of issue — frozen */
    revision: text("revision"),
    format: text("format"),
    copies: integer("copies").default(1).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("transmittal_items_parent_idx").on(t.transmittalId, t.seq),
    index("transmittal_items_project_idx").on(t.projectId),
    index("transmittal_items_item_idx").on(t.itemType, t.itemId),
  ],
);

/* ------------------------------------------------------------------ */
/* Action plans (#447–456)                                             */
/* ------------------------------------------------------------------ */

export const actionPlanTemplates = pgTable(
  "action_plan_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = available to every project */
    projectId: text("project_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    /** bumped on every published edit; instances record the version they used */
    version: integer("version").default(1).notNull(),
    isActive: integer("is_active").default(1).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("action_plan_templates_key_uq").on(t.companyId, t.key),
    index("action_plan_templates_company_idx").on(t.companyId, t.isActive),
  ],
);

/**
 * A required activity on a template (#448) with its evidence requirement
 * (#449), reference documents (#450) and sign-off configuration (#451).
 */
export const actionPlanTemplateActivities = pgTable(
  "action_plan_template_activities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    templateId: text("template_id").notNull(),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    evidenceRequired: integer("evidence_required").default(0).notNull(),
    evidenceRequirement: text("evidence_requirement"),
    /** documents.files.id list attached as reference material (#450) */
    referenceFileIds: jsonb("reference_file_ids").$type<string[]>().default([]).notNull(),
    /** parties whose signature the activity needs (#451–452) */
    signoffParties: jsonb("signoff_parties")
      .$type<Array<{ partyType: string; partyId?: string | null; label: string }>>()
      .default([])
      .notNull(),
    /** a quality control checkpoint blocks everything after it (#456) */
    isQualityCheckpoint: integer("is_quality_checkpoint").default(0).notNull(),
    /** days after the plan start this activity is due */
    dueOffsetDays: integer("due_offset_days"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("action_plan_template_activities_seq_uq").on(t.templateId, t.seq),
    index("action_plan_template_activities_company_idx").on(t.companyId),
  ],
);

/** A plan instance, anchored to a location or a schedule task (#453). */
export const actionPlans = pgTable(
  "action_plans",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    status: text("status").default("draft").notNull(), // ActionPlanStatus
    anchor: text("anchor").default("none").notNull(), // ActionPlanAnchor
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    ownerId: text("owner_id"),
    startDate: text("start_date"),
    dueDate: text("due_date"),
    activatedAt: ts("activated_at"),
    completedAt: ts("completed_at"),
    completedBy: text("completed_by"),
    cancelledReason: text("cancelled_reason"),
    /* denormalised progress, recomputed by the engine on every mutation */
    activityCount: integer("activity_count").default(0).notNull(),
    completedCount: integer("completed_count").default(0).notNull(),
    progressPercent: doublePrecision("progress_percent"),
    blockedReason: text("blocked_reason"),
    overdueNotifiedAt: ts("overdue_notified_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("action_plans_ref_uq").on(t.projectId, t.reference),
    index("action_plans_project_idx").on(t.projectId, t.status),
    index("action_plans_company_idx").on(t.companyId),
    index("action_plans_due_idx").on(t.status, t.dueDate),
    index("action_plans_location_idx").on(t.locationId),
    index("action_plans_task_idx").on(t.scheduleTaskId),
  ],
);

export const actionPlanActivities = pgTable(
  "action_plan_activities",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    planId: text("plan_id").notNull(),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").default("pending").notNull(), // ActionPlanActivityStatus
    assigneeId: text("assignee_id"),
    dueDate: text("due_date"),
    evidenceRequired: integer("evidence_required").default(0).notNull(),
    evidenceRequirement: text("evidence_requirement"),
    evidenceFileIds: jsonb("evidence_file_ids").$type<string[]>().default([]).notNull(),
    evidenceNote: text("evidence_note"),
    evidenceSubmittedAt: ts("evidence_submitted_at"),
    evidenceSubmittedBy: text("evidence_submitted_by"),
    referenceFileIds: jsonb("reference_file_ids").$type<string[]>().default([]).notNull(),
    isQualityCheckpoint: integer("is_quality_checkpoint").default(0).notNull(),
    signoffRequiredCount: integer("signoff_required_count").default(0).notNull(),
    signoffCount: integer("signoff_count").default(0).notNull(),
    completedAt: ts("completed_at"),
    waivedReason: text("waived_reason"),
    blockedReason: text("blocked_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("action_plan_activities_seq_uq").on(t.planId, t.seq),
    index("action_plan_activities_plan_idx").on(t.planId, t.status),
    index("action_plan_activities_project_idx").on(t.projectId, t.status),
    index("action_plan_activities_due_idx").on(t.status, t.dueDate),
    index("action_plan_activities_assignee_idx").on(t.assigneeId),
  ],
);

/** One required signature on one activity (#452). */
export const actionPlanSignoffs = pgTable(
  "action_plan_signoffs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    planId: text("plan_id").notNull(),
    activityId: text("activity_id").notNull(),
    seq: integer("seq").notNull(),
    partyType: text("party_type").default("user").notNull(), // SignoffPartyType
    partyId: text("party_id"),
    label: text("label").notNull(),
    status: text("status").default("pending").notNull(), // SignoffStatus
    signedAt: ts("signed_at"),
    signedBy: text("signed_by"),
    signerName: text("signer_name"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("action_plan_signoffs_seq_uq").on(t.activityId, t.seq),
    index("action_plan_signoffs_activity_idx").on(t.activityId, t.status),
    index("action_plan_signoffs_plan_idx").on(t.planId),
    index("action_plan_signoffs_company_idx").on(t.companyId),
  ],
);

/* ------------------------------------------------------------------ */
/* Forms (#457–464)                                                    */
/* ------------------------------------------------------------------ */

/**
 * A form template: fields, show/hide logic and an optional mapping onto an
 * uploaded fillable PDF (#457–458). Publishing freezes `version`; a response
 * records the version it was captured against so an edited template never
 * rewrites history.
 */
export const formTemplates = pgTable(
  "form_templates",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    /** null = available to every project */
    projectId: text("project_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"),
    status: text("status").default("draft").notNull(), // FormTemplateStatus
    version: integer("version").default(1).notNull(),
    fields: jsonb("fields").$type<StoredFormFieldDef[]>().default([]).notNull(),
    /** rules evaluated on top of per-field `visibleWhen`, keyed by field */
    logic: jsonb("logic").$type<Record<string, StoredFormLogicRule>>().default({}).notNull(),
    signatureRequired: integer("signature_required").default(0).notNull(),
    /** documents.files.id of the fillable PDF this template was built from */
    pdfFileId: text("pdf_file_id"),
    /** acroform field name → template field key (#458) */
    pdfFieldMap: jsonb("pdf_field_map").$type<Record<string, string>>().default({}).notNull(),
    publishedAt: ts("published_at"),
    publishedBy: text("published_by"),
    archivedAt: ts("archived_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("form_templates_key_uq").on(t.companyId, t.key),
    index("form_templates_company_idx").on(t.companyId, t.status),
    index("form_templates_project_idx").on(t.projectId),
  ],
);

/** Who must complete a form and by when (#460). */
export const formAssignments = pgTable(
  "form_assignments",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    assigneeUserId: text("assignee_user_id"),
    assigneeContactId: text("assignee_contact_id"),
    assigneeName: text("assignee_name").notNull(),
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    dueDate: text("due_date"),
    status: text("status").default("assigned").notNull(), // FormAssignmentStatus
    instructions: text("instructions"),
    responseId: text("response_id"),
    completedAt: ts("completed_at"),
    cancelledReason: text("cancelled_reason"),
    overdueNotifiedAt: ts("overdue_notified_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("form_assignments_project_idx").on(t.projectId, t.status),
    index("form_assignments_template_idx").on(t.templateId),
    index("form_assignments_due_idx").on(t.status, t.dueDate),
    index("form_assignments_assignee_idx").on(t.assigneeUserId),
    index("form_assignments_company_idx").on(t.companyId),
  ],
);

export const formResponses = pgTable(
  "form_responses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id").notNull(),
    templateId: text("template_id").notNull(),
    templateVersion: integer("template_version").notNull(),
    assignmentId: text("assignment_id"),
    number: integer("number").notNull(),
    reference: text("reference").notNull(),
    title: text("title"),
    status: text("status").default("draft").notNull(), // FormResponseStatus
    values: jsonb("values").$type<Record<string, unknown>>().default({}).notNull(),
    /** field keys the logic hid at submission — kept so the record is readable */
    hiddenFields: jsonb("hidden_fields").$type<string[]>().default([]).notNull(),
    signature: jsonb("signature").$type<StoredFormSignature | null>(),
    fileIds: jsonb("file_ids").$type<string[]>().default([]).notNull(),
    locationId: text("location_id"),
    scheduleTaskId: text("schedule_task_id"),
    submittedAt: ts("submitted_at"),
    submittedBy: text("submitted_by"),
    reviewedAt: ts("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("form_responses_ref_uq").on(t.projectId, t.reference),
    index("form_responses_project_idx").on(t.projectId, t.status),
    index("form_responses_template_idx").on(t.templateId, t.status),
    index("form_responses_assignment_idx").on(t.assignmentId),
    index("form_responses_company_idx").on(t.companyId),
  ],
);
