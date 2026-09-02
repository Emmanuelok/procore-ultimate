/**
 * Shared enums and wire types for CORRESPONDENCE, TRANSMITTALS, ACTION PLANS
 * and FORMS (spec Vol I §2.11–2.13 #440–464, §0.6 #99 inbound email).
 *
 * Four registers share one vocabulary because they share one idea: a record
 * that leaves the tenant, or that someone is asked to complete, carries a
 * NAMED RECIPIENT and a DEADLINE, and the platform tracks whether that person
 * did the thing by that date. Recipients, acknowledgement and sign-off are
 * therefore modelled once and reused, not re-invented per register.
 *
 * Add new `as const` string unions and their types here; never edit enums.ts
 * from a parallel work package.
 */

/* ------------------------------------------------------------------ */
/* Correspondence — types, letters, recipients (#440–446)              */
/* ------------------------------------------------------------------ */

/** Which way a record travelled. `internal` never leaves the tenant. */
export const CORRESPONDENCE_DIRECTIONS = ["outbound", "inbound", "internal"] as const;
export type CorrespondenceDirection = (typeof CORRESPONDENCE_DIRECTIONS)[number];

/**
 * Letter lifecycle. `issued` is the point of no return: an issued letter is a
 * contractual act, so its subject, body and recipients are frozen and further
 * change happens through a new letter that references it.
 */
export const CORRESPONDENCE_STATUSES = [
  "draft",
  "pending_approval",
  "issued",
  "acknowledged",
  "responded",
  "closed",
  "void",
] as const;
export type CorrespondenceStatus = (typeof CORRESPONDENCE_STATUSES)[number];

export const CORRESPONDENCE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type CorrespondencePriority = (typeof CORRESPONDENCE_PRIORITIES)[number];

/** How the record entered the register — a provenance fact, never editable. */
export const CORRESPONDENCE_SOURCES = ["manual", "inbound_email", "api", "transmittal"] as const;
export type CorrespondenceSource = (typeof CORRESPONDENCE_SOURCES)[number];

/** Recipient line. `bcc` is hidden from the issued document, not from the register. */
export const RECIPIENT_KINDS = ["to", "cc", "bcc"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const RECIPIENT_PARTY_TYPES = [
  "user",
  "contact",
  "vendor",
  "external",
  "distribution_group",
] as const;
export type RecipientPartyType = (typeof RECIPIENT_PARTY_TYPES)[number];

/**
 * What the transport reported. The platform never invents delivery: a
 * recipient stays `pending` until something told us otherwise.
 */
export const RECIPIENT_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "bounced",
  "failed",
] as const;
export type RecipientDeliveryStatus = (typeof RECIPIENT_DELIVERY_STATUSES)[number];

/** The parent register a recipient row belongs to. */
export const RECIPIENT_RECORD_TYPES = ["letter", "transmittal"] as const;
export type RecipientRecordType = (typeof RECIPIENT_RECORD_TYPES)[number];

/** Configurable per-type approval workflow step outcome (#445). */
export const CORRESPONDENCE_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "skipped",
] as const;
export type CorrespondenceApprovalStatus = (typeof CORRESPONDENCE_APPROVAL_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Inbound email capture (#99)                                         */
/* ------------------------------------------------------------------ */

/**
 * What the inbound path did with a message. `duplicate` is a success: the
 * same `messageId` arriving twice must produce one record, not two.
 */
export const INBOUND_MESSAGE_STATUSES = [
  "captured",
  "created",
  "linked",
  "duplicate",
  "unmatched",
  "ignored",
  "failed",
] as const;
export type InboundMessageStatus = (typeof INBOUND_MESSAGE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Transmittals (#442–443)                                             */
/* ------------------------------------------------------------------ */

/** Why the documents were issued — the single most disputed fact in a claim. */
export const TRANSMITTAL_PURPOSES = [
  "for_approval",
  "for_review",
  "for_information",
  "for_construction",
  "for_record",
  "for_tender",
  "for_coordination",
] as const;
export type TransmittalPurpose = (typeof TRANSMITTAL_PURPOSES)[number];

export const TRANSMITTAL_STATUSES = [
  "draft",
  "issued",
  "partially_acknowledged",
  "acknowledged",
  "closed",
  "void",
] as const;
export type TransmittalStatus = (typeof TRANSMITTAL_STATUSES)[number];

export const TRANSMITTAL_METHODS = ["email", "portal", "courier", "hand", "post", "ftp"] as const;
export type TransmittalMethod = (typeof TRANSMITTAL_METHODS)[number];

/** What is on the transmittal. Every kind is a pointer into another register. */
export const TRANSMITTAL_ITEM_TYPES = [
  "file",
  "drawing_sheet",
  "submittal",
  "document",
  "spec_section",
  "model",
  "other",
] as const;
export type TransmittalItemType = (typeof TRANSMITTAL_ITEM_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Action plans (#447–456)                                             */
/* ------------------------------------------------------------------ */

export const ACTION_PLAN_STATUSES = [
  "draft",
  "active",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type ActionPlanStatus = (typeof ACTION_PLAN_STATUSES)[number];

/**
 * Activity lifecycle. `evidence_submitted` exists because #449 makes evidence
 * a precondition of sign-off: the doer submits, a different party signs.
 */
export const ACTION_PLAN_ACTIVITY_STATUSES = [
  "pending",
  "in_progress",
  "evidence_submitted",
  "signed_off",
  "waived",
  "blocked",
] as const;
export type ActionPlanActivityStatus = (typeof ACTION_PLAN_ACTIVITY_STATUSES)[number];

export const SIGNOFF_STATUSES = ["pending", "signed", "rejected"] as const;
export type SignoffStatus = (typeof SIGNOFF_STATUSES)[number];

/** Who a required signature belongs to (#451–452, multi-party sign-off). */
export const SIGNOFF_PARTY_TYPES = ["user", "role", "vendor", "external"] as const;
export type SignoffPartyType = (typeof SIGNOFF_PARTY_TYPES)[number];

/** What an action plan is anchored to (#453). */
export const ACTION_PLAN_ANCHORS = ["none", "location", "schedule_task"] as const;
export type ActionPlanAnchor = (typeof ACTION_PLAN_ANCHORS)[number];

/* ------------------------------------------------------------------ */
/* Forms (#457–464)                                                    */
/* ------------------------------------------------------------------ */

export const FORM_TEMPLATE_STATUSES = ["draft", "published", "archived"] as const;
export type FormTemplateStatus = (typeof FORM_TEMPLATE_STATUSES)[number];

/**
 * Field kinds the renderer and the validator both understand. `heading` is
 * presentational and never carries a value; `signature` is the only kind that
 * satisfies #462.
 */
export const FORM_FIELD_TYPES = [
  "heading",
  "text",
  "textarea",
  "number",
  "date",
  "time",
  "select",
  "multiselect",
  "checkbox",
  "radio",
  "rating",
  "signature",
  "photo",
  "file",
  "user",
  "location",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Operators available to show/hide logic (#459). No expressions, no eval. */
export const FORM_LOGIC_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "empty",
  "not_empty",
] as const;
export type FormLogicOperator = (typeof FORM_LOGIC_OPERATORS)[number];

export const FORM_RESPONSE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "void",
] as const;
export type FormResponseStatus = (typeof FORM_RESPONSE_STATUSES)[number];

export const FORM_ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type FormAssignmentStatus = (typeof FORM_ASSIGNMENT_STATUSES)[number];

/** One condition in a show/hide rule: `field <operator> value`. */
export interface FormLogicCondition {
  field: string;
  operator: FormLogicOperator;
  value?: unknown;
}

/** A rule is a conjunction, a disjunction, or both (all AND any). */
export interface FormLogicRule {
  all?: FormLogicCondition[];
  any?: FormLogicCondition[];
}

export interface FormFieldOption {
  value: string;
  label: string;
}

/**
 * One field on a form template. `pdfField` is the acroform field name this
 * maps to when the template was built from an uploaded fillable PDF
 * (#457–458); the platform stores the mapping, it does not flatten the PDF.
 */
export interface FormFieldDef {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  help?: string | null;
  placeholder?: string | null;
  section?: string | null;
  options?: FormFieldOption[];
  min?: number | null;
  max?: number | null;
  maxLength?: number | null;
  defaultValue?: unknown;
  pdfField?: string | null;
  visibleWhen?: FormLogicRule | null;
}

/** A captured signature (#462). The image, when present, is a stored file. */
export interface FormSignature {
  name: string;
  signedAt: string;
  method: "typed" | "drawn" | "uploaded";
  fileId?: string | null;
  statement?: string | null;
}

/* ------------------------------------------------------------------ */
/* Detectors this module raises into `signals`                         */
/* ------------------------------------------------------------------ */

export const CORRESPONDENCE_DETECTORS = [
  "correspondence_response_overdue",
  "correspondence_ack_overdue",
  "correspondence_plan_overdue",
  "correspondence_form_overdue",
  "correspondence_inbound_unmatched",
] as const;
export type CorrespondenceDetector = (typeof CORRESPONDENCE_DETECTORS)[number];
