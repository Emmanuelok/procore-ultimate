/**
 * Record snapshot registry for the automation engine.
 *
 * A ledger event names an object by (objectType, objectId) and nothing more —
 * the payload is frequently unstored. A rule that says "when an RFI's status
 * becomes open and its due date is within 3 days" needs the record itself, so
 * this registry maps the ledger's objectType vocabulary onto the tables that
 * hold those records and loads a snapshot by (companyId, id).
 *
 * The registry is small and honest: it covers the record types rules are
 * written about in practice. An objectType it does not know gets an
 * EVENT-ONLY context — the rule can still fire on the event, it just cannot
 * see fields — and the run says so (`recordKnown: false`).
 *
 * Every entry also carries what the builder and the schedule scanner need:
 * the field catalogue (paths + types) for the condition picker, the statuses
 * that count as "open" so a scheduled scan stays bounded, and which column
 * an `assign` action writes. Schedule scans never load a table unbounded:
 * they filter by company (+ project), by open status where the type has one,
 * and take at most `SCAN_LIMIT` rows ordered newest first.
 */
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import {
  changeEvents,
  commitments,
  contractEvents,
  contracts,
  dailyLogs,
  drawingSheets,
  files,
  insuranceCertificates,
  insurancePolicies,
  invoices,
  meetingActionItems,
  nonConformanceReports,
  obligations,
  permits,
  primeContracts,
  projects,
  punchItems,
  rfis,
  risks,
  safetyIncidents,
  safetyObservations,
  scheduleTasks,
  signals,
  submittals,
  vendors,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";

export const SCAN_LIMIT = 500;

export type SnapshotFieldType = "text" | "number" | "date" | "datetime" | "boolean" | "enum" | "user" | "vendor" | "list";

export interface SnapshotField {
  path: string;
  type: SnapshotFieldType;
  label: string;
  /** enum members when the type is `enum` */
  options?: readonly string[];
}

export interface SnapshotEntry {
  objectType: string;
  label: string;
  table: AnyPgTable;
  idColumn: PgColumn;
  /** absent for tables with no company column (schedule tasks) — tenant is checked via the project */
  companyColumn?: PgColumn;
  /** absent for company-level records (vendors); for projects the record IS the project */
  projectColumn?: PgColumn;
  statusColumn?: PgColumn;
  createdAtColumn?: PgColumn;
  /** statuses that mean "still live" — bounds schedule scans */
  openStatuses?: readonly string[];
  /** the column an `assign` action writes (a user id) */
  assignField?: string;
  /** the most natural deadline field, for templates and the builder's hints */
  dueField?: string;
  /** a human label field for notifications */
  titleField: string;
  /** whether the record's project id is the record id (projects) */
  selfProject?: boolean;
  fields: SnapshotField[];
}

const common = (extra: SnapshotField[]): SnapshotField[] => [
  { path: "id", type: "text", label: "Id" },
  ...extra,
  { path: "createdAt", type: "datetime", label: "Created at" },
];

const statusField = (options: readonly string[]): SnapshotField => ({
  path: "status",
  type: "enum",
  label: "Status",
  options,
});

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

const ENTRIES: SnapshotEntry[] = [
  {
    objectType: "project",
    label: "Project",
    table: projects,
    idColumn: projects.id,
    companyColumn: projects.companyId,
    selfProject: true,
    createdAtColumn: projects.createdAt,
    titleField: "name",
    fields: common([
      { path: "name", type: "text", label: "Name" },
      { path: "stage", type: "enum", label: "Stage", options: ["bidding", "pre_construction", "course_of_construction", "warranty", "closed"] },
      { path: "currency", type: "text", label: "Currency" },
      { path: "value", type: "number", label: "Value" },
      { path: "startDate", type: "date", label: "Start date" },
      { path: "finishDate", type: "date", label: "Finish date" },
    ]),
  },
  {
    objectType: "rfi",
    label: "RFI",
    table: rfis,
    idColumn: rfis.id,
    companyColumn: rfis.companyId,
    projectColumn: rfis.projectId,
    statusColumn: rfis.status,
    createdAtColumn: rfis.createdAt,
    openStatuses: ["draft", "open"],
    assignField: "assigneeId",
    dueField: "dueDate",
    titleField: "subject",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "subject", type: "text", label: "Subject" },
      statusField(["draft", "open", "answered", "closed", "void"]),
      { path: "assigneeId", type: "user", label: "Assignee" },
      { path: "ballInCourtId", type: "user", label: "Ball in court" },
      { path: "dueDate", type: "date", label: "Due date" },
      { path: "costImpact", type: "enum", label: "Cost impact", options: ["yes", "no", "tbd"] },
      { path: "scheduleImpact", type: "enum", label: "Schedule impact", options: ["yes", "no", "tbd"] },
      { path: "scheduleImpactDays", type: "number", label: "Schedule impact (days)" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "submittal",
    label: "Submittal",
    table: submittals,
    idColumn: submittals.id,
    companyColumn: submittals.companyId,
    projectColumn: submittals.projectId,
    statusColumn: submittals.status,
    createdAtColumn: submittals.createdAt,
    openStatuses: ["draft", "open", "in_review"],
    assignField: "ballInCourtId",
    dueField: "submitByDate",
    titleField: "title",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "title", type: "text", label: "Title" },
      statusField(["draft", "open", "in_review", "responded", "closed", "void"]),
      { path: "submittalType", type: "text", label: "Type" },
      { path: "specSection", type: "text", label: "Spec section" },
      { path: "ballInCourtId", type: "user", label: "Ball in court" },
      { path: "requiredOnSite", type: "date", label: "Required on site" },
      { path: "submitByDate", type: "date", label: "Submit by" },
      { path: "responseCode", type: "text", label: "Response code" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "punch_item",
    label: "Punch item",
    table: punchItems,
    idColumn: punchItems.id,
    companyColumn: punchItems.companyId,
    projectColumn: punchItems.projectId,
    statusColumn: punchItems.status,
    createdAtColumn: punchItems.createdAt,
    openStatuses: ["open", "in_progress", "ready_for_review"],
    assignField: "assigneeId",
    dueField: "dueDate",
    titleField: "title",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "title", type: "text", label: "Title" },
      statusField(["open", "in_progress", "ready_for_review", "closed", "void"]),
      { path: "priority", type: "enum", label: "Priority", options: ["low", "medium", "high"] },
      { path: "assigneeId", type: "user", label: "Assignee" },
      { path: "verifierId", type: "user", label: "Verifier" },
      { path: "vendorId", type: "vendor", label: "Vendor" },
      { path: "dueDate", type: "date", label: "Due date" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "daily_log",
    label: "Daily log",
    table: dailyLogs,
    idColumn: dailyLogs.id,
    companyColumn: dailyLogs.companyId,
    projectColumn: dailyLogs.projectId,
    statusColumn: dailyLogs.status,
    createdAtColumn: dailyLogs.createdAt,
    openStatuses: ["draft", "submitted"],
    titleField: "logDate",
    fields: common([
      { path: "logDate", type: "date", label: "Log date" },
      statusField(["draft", "submitted", "approved"]),
      { path: "createdBy", type: "user", label: "Created by" },
      { path: "approvedBy", type: "user", label: "Approved by" },
    ]),
  },
  {
    objectType: "invoice",
    label: "Invoice",
    table: invoices,
    idColumn: invoices.id,
    companyColumn: invoices.companyId,
    projectColumn: invoices.projectId,
    statusColumn: invoices.status,
    createdAtColumn: invoices.createdAt,
    openStatuses: ["draft", "submitted", "under_review", "revise_and_resubmit", "approved", "approved_as_noted"],
    dueField: "dueDate",
    titleField: "reference",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "kind", type: "text", label: "Kind" },
      statusField(["draft", "submitted", "under_review", "revise_and_resubmit", "approved", "approved_as_noted", "rejected", "paid", "void"]),
      { path: "vendorId", type: "vendor", label: "Vendor" },
      { path: "commitmentId", type: "text", label: "Commitment" },
      { path: "currency", type: "text", label: "Currency" },
      { path: "total", type: "number", label: "Total" },
      { path: "currentPaymentDue", type: "number", label: "Current payment due" },
      { path: "dueDate", type: "date", label: "Due date" },
      { path: "requiresLienWaiver", type: "boolean", label: "Requires lien waiver" },
      { path: "lienWaiverStatus", type: "text", label: "Lien waiver status" },
      { path: "submittedBy", type: "user", label: "Submitted by" },
      { path: "approvedBy", type: "user", label: "Approved by" },
    ]),
  },
  {
    objectType: "change_event",
    label: "Change event",
    table: changeEvents,
    idColumn: changeEvents.id,
    companyColumn: changeEvents.companyId,
    projectColumn: changeEvents.projectId,
    statusColumn: changeEvents.status,
    createdAtColumn: changeEvents.createdAt,
    openStatuses: ["open", "pending"],
    dueField: "dueDate",
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      statusField(["open", "pending", "closed", "void"]),
      { path: "eventType", type: "text", label: "Event type" },
      { path: "scope", type: "text", label: "Scope" },
      { path: "estimatedCost", type: "number", label: "Estimated cost" },
      { path: "latestCost", type: "number", label: "Latest cost" },
      { path: "scheduleImpactDays", type: "number", label: "Schedule impact (days)" },
      { path: "dueDate", type: "date", label: "Due date" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "commitment",
    label: "Commitment",
    table: commitments,
    idColumn: commitments.id,
    companyColumn: commitments.companyId,
    projectColumn: commitments.projectId,
    statusColumn: commitments.status,
    createdAtColumn: commitments.createdAt,
    openStatuses: ["draft", "out_for_bid", "out_for_signature", "approved"],
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      statusField(["draft", "out_for_bid", "out_for_signature", "approved", "complete", "terminated", "void"]),
      { path: "kind", type: "text", label: "Kind" },
      { path: "vendorId", type: "vendor", label: "Vendor" },
      { path: "currency", type: "text", label: "Currency" },
      { path: "revisedCommitmentSum", type: "number", label: "Revised commitment sum" },
      { path: "paymentHold", type: "boolean", label: "Payment hold" },
      { path: "executed", type: "boolean", label: "Executed" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "prime_contract",
    label: "Prime contract",
    table: primeContracts,
    idColumn: primeContracts.id,
    companyColumn: primeContracts.companyId,
    projectColumn: primeContracts.projectId,
    statusColumn: primeContracts.status,
    createdAtColumn: primeContracts.createdAt,
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      { path: "status", type: "text", label: "Status" },
      { path: "currency", type: "text", label: "Currency" },
      { path: "revisedContractSum", type: "number", label: "Revised contract sum" },
      { path: "executed", type: "boolean", label: "Executed" },
    ]),
  },
  {
    objectType: "contract",
    label: "Contract",
    table: contracts,
    idColumn: contracts.id,
    companyColumn: contracts.companyId,
    projectColumn: contracts.projectId,
    statusColumn: contracts.status,
    createdAtColumn: contracts.createdAt,
    titleField: "name",
    fields: common([
      { path: "name", type: "text", label: "Name" },
      { path: "form", type: "text", label: "Form" },
      { path: "status", type: "text", label: "Status" },
      { path: "currency", type: "text", label: "Currency" },
      { path: "contractSum", type: "number", label: "Contract sum" },
      { path: "completionDate", type: "date", label: "Completion date" },
    ]),
  },
  {
    objectType: "contract_event",
    label: "Contract event (time bar)",
    table: contractEvents,
    idColumn: contractEvents.id,
    companyColumn: contractEvents.companyId,
    projectColumn: contractEvents.projectId,
    statusColumn: contractEvents.status,
    createdAtColumn: contractEvents.createdAt,
    openStatuses: ["open"],
    dueField: "noticeDeadline",
    titleField: "title",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "title", type: "text", label: "Title" },
      { path: "kind", type: "text", label: "Kind" },
      { path: "clauseRef", type: "text", label: "Clause" },
      statusField(["open", "notice_served", "time_barred", "resolved", "withdrawn"]),
      { path: "eventDate", type: "date", label: "Event date" },
      { path: "noticeDeadline", type: "date", label: "Notice deadline" },
      { path: "noticeServedAt", type: "datetime", label: "Notice served at" },
      { path: "costImpactEstimate", type: "number", label: "Cost impact estimate" },
      { path: "timeImpactDaysEstimate", type: "number", label: "Time impact (days)" },
      { path: "raisedBy", type: "user", label: "Raised by" },
    ]),
  },
  {
    objectType: "signal",
    label: "Signal",
    table: signals,
    idColumn: signals.id,
    companyColumn: signals.companyId,
    projectColumn: signals.projectId,
    statusColumn: signals.disposition,
    createdAtColumn: signals.createdAt,
    openStatuses: ["new", "under_review", "confirmed", "escalated"],
    titleField: "title",
    fields: common([
      { path: "title", type: "text", label: "Title" },
      { path: "detector", type: "text", label: "Detector" },
      { path: "severity", type: "enum", label: "Severity", options: ["info", "low", "medium", "high", "critical"] },
      { path: "confidence", type: "number", label: "Confidence" },
      { path: "disposition", type: "enum", label: "Disposition", options: ["new", "under_review", "confirmed", "false_positive", "escalated", "closed"] },
      { path: "reviewerId", type: "user", label: "Reviewer" },
    ]),
  },
  {
    objectType: "obligation",
    label: "Obligation",
    table: obligations,
    idColumn: obligations.id,
    companyColumn: obligations.companyId,
    projectColumn: obligations.projectId,
    statusColumn: obligations.status,
    createdAtColumn: obligations.createdAt,
    openStatuses: ["open"],
    dueField: "deadline",
    titleField: "trigger",
    fields: common([
      { path: "sourceClause", type: "text", label: "Source clause" },
      { path: "trigger", type: "text", label: "Trigger" },
      statusField(["open", "satisfied", "breached", "waived", "disputed"]),
      { path: "deadline", type: "datetime", label: "Deadline" },
      { path: "warnDaysBefore", type: "number", label: "Warn days before" },
      { path: "obligorId", type: "text", label: "Obligor" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "safety_incident",
    label: "Safety incident",
    table: safetyIncidents,
    idColumn: safetyIncidents.id,
    companyColumn: safetyIncidents.companyId,
    projectColumn: safetyIncidents.projectId,
    statusColumn: safetyIncidents.status,
    createdAtColumn: safetyIncidents.createdAt,
    openStatuses: ["reported", "under_investigation", "actions_open", "pending_closure", "reopened"],
    assignField: "investigationLeadId",
    dueField: "investigationDueDate",
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      { path: "incidentType", type: "text", label: "Incident type" },
      { path: "severity", type: "text", label: "Severity" },
      statusField(["reported", "under_investigation", "actions_open", "pending_closure", "closed", "reopened", "void"]),
      { path: "isLostTime", type: "boolean", label: "Lost time" },
      { path: "isFatality", type: "boolean", label: "Fatality" },
      { path: "isReportable", type: "boolean", label: "Reportable" },
      { path: "reportDueAt", type: "datetime", label: "Regulator report due" },
      { path: "regulatorNotifiedAt", type: "datetime", label: "Regulator notified at" },
      { path: "investigationStatus", type: "text", label: "Investigation status" },
      { path: "investigationLeadId", type: "user", label: "Investigation lead" },
      { path: "investigationDueDate", type: "date", label: "Investigation due" },
      { path: "vendorId", type: "vendor", label: "Vendor" },
    ]),
  },
  {
    objectType: "safety_observation",
    label: "Safety observation",
    table: safetyObservations,
    idColumn: safetyObservations.id,
    companyColumn: safetyObservations.companyId,
    projectColumn: safetyObservations.projectId,
    createdAtColumn: safetyObservations.createdAt,
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      { path: "kind", type: "text", label: "Kind" },
      { path: "category", type: "text", label: "Category" },
      { path: "severity", type: "text", label: "Severity" },
      { path: "riskScore", type: "number", label: "Risk score" },
      { path: "workStopped", type: "boolean", label: "Work stopped" },
      { path: "vendorId", type: "vendor", label: "Vendor" },
    ]),
  },
  {
    objectType: "non_conformance_report",
    label: "Non-conformance report",
    table: nonConformanceReports,
    idColumn: nonConformanceReports.id,
    companyColumn: nonConformanceReports.companyId,
    projectColumn: nonConformanceReports.projectId,
    statusColumn: nonConformanceReports.status,
    createdAtColumn: nonConformanceReports.createdAt,
    openStatuses: ["open", "under_review", "disposition_proposed", "disposition_approved", "action_in_progress", "verification_pending"],
    dueField: "responseDueDate",
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      { path: "category", type: "text", label: "Category" },
      { path: "severity", type: "text", label: "Severity" },
      statusField(["open", "under_review", "disposition_proposed", "disposition_approved", "action_in_progress", "verification_pending", "closed", "rejected", "void"]),
      { path: "disposition", type: "text", label: "Disposition" },
      { path: "responseDueDate", type: "date", label: "Response due" },
      { path: "raisedAgainstVendorId", type: "vendor", label: "Vendor" },
      { path: "costImpact", type: "number", label: "Cost impact" },
      { path: "createdBy", type: "user", label: "Created by" },
    ]),
  },
  {
    objectType: "insurance_certificate",
    label: "Insurance certificate",
    table: insuranceCertificates,
    idColumn: insuranceCertificates.id,
    companyColumn: insuranceCertificates.companyId,
    projectColumn: insuranceCertificates.projectId,
    statusColumn: insuranceCertificates.status,
    createdAtColumn: insuranceCertificates.createdAt,
    openStatuses: ["active"],
    dueField: "validTo",
    titleField: "subjectName",
    fields: common([
      { path: "subjectName", type: "text", label: "Subject" },
      { path: "policyType", type: "text", label: "Policy type" },
      { path: "status", type: "text", label: "Status" },
      { path: "vendorId", type: "vendor", label: "Vendor" },
      { path: "validFrom", type: "date", label: "Valid from" },
      { path: "validTo", type: "date", label: "Valid to" },
      { path: "verifiedAt", type: "datetime", label: "Verified at" },
      { path: "limitOfIndemnity", type: "number", label: "Limit of indemnity" },
    ]),
  },
  {
    objectType: "insurance_policy",
    label: "Insurance policy",
    table: insurancePolicies,
    idColumn: insurancePolicies.id,
    companyColumn: insurancePolicies.companyId,
    projectColumn: insurancePolicies.projectId,
    statusColumn: insurancePolicies.status,
    createdAtColumn: insurancePolicies.createdAt,
    dueField: "periodEnd",
    titleField: "policyNumber",
    fields: common([
      { path: "number", type: "text", label: "Number" },
      { path: "policyType", type: "text", label: "Policy type" },
      { path: "policyNumber", type: "text", label: "Policy number" },
      { path: "insurer", type: "text", label: "Insurer" },
      { path: "status", type: "text", label: "Status" },
      { path: "periodStart", type: "date", label: "Period start" },
      { path: "periodEnd", type: "date", label: "Period end" },
      { path: "notificationDays", type: "number", label: "Notification days" },
    ]),
  },
  {
    objectType: "file",
    label: "File",
    table: files,
    idColumn: files.id,
    companyColumn: files.companyId,
    projectColumn: files.projectId,
    createdAtColumn: files.createdAt,
    titleField: "name",
    fields: common([
      { path: "name", type: "text", label: "Name" },
      { path: "contentType", type: "text", label: "Content type" },
      { path: "sizeBytes", type: "number", label: "Size (bytes)" },
      { path: "version", type: "number", label: "Version" },
      { path: "isPrivate", type: "boolean", label: "Private" },
      { path: "uploadedBy", type: "user", label: "Uploaded by" },
    ]),
  },
  {
    objectType: "drawing_sheet",
    label: "Drawing sheet",
    table: drawingSheets,
    idColumn: drawingSheets.id,
    companyColumn: drawingSheets.companyId,
    projectColumn: drawingSheets.projectId,
    createdAtColumn: drawingSheets.createdAt,
    titleField: "title",
    fields: common([
      { path: "number", type: "text", label: "Sheet number" },
      { path: "title", type: "text", label: "Title" },
      { path: "discipline", type: "text", label: "Discipline" },
      { path: "area", type: "text", label: "Area" },
      { path: "needsReview", type: "boolean", label: "Needs review" },
    ]),
  },
  {
    objectType: "risk",
    label: "Risk",
    table: risks,
    idColumn: risks.id,
    companyColumn: risks.companyId,
    projectColumn: risks.projectId,
    statusColumn: risks.status,
    createdAtColumn: risks.createdAt,
    openStatuses: ["open", "mitigating"],
    assignField: "ownerId",
    titleField: "title",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "title", type: "text", label: "Title" },
      { path: "category", type: "text", label: "Category" },
      statusField(["open", "mitigating", "closed", "realised"]),
      { path: "ownerId", type: "user", label: "Owner" },
      { path: "probabilityScore", type: "number", label: "Probability (1-5)" },
      { path: "impactScore", type: "number", label: "Impact (1-5)" },
      { path: "occurrenceProbability", type: "number", label: "Occurrence probability" },
    ]),
  },
  {
    objectType: "permit",
    label: "Permit",
    table: permits,
    idColumn: permits.id,
    companyColumn: permits.companyId,
    projectColumn: permits.projectId,
    statusColumn: permits.status,
    createdAtColumn: permits.createdAt,
    openStatuses: ["not_started", "applied", "in_review", "granted"],
    assignField: "ownerId",
    dueField: "expiresAt",
    titleField: "title",
    fields: common([
      { path: "number", type: "number", label: "Number" },
      { path: "title", type: "text", label: "Title" },
      { path: "kind", type: "text", label: "Kind" },
      { path: "authority", type: "text", label: "Authority" },
      statusField(["not_started", "applied", "in_review", "granted", "refused", "expired"]),
      { path: "dueAt", type: "date", label: "Due" },
      { path: "grantedAt", type: "date", label: "Granted" },
      { path: "expiresAt", type: "date", label: "Expires" },
      { path: "ownerId", type: "user", label: "Owner" },
    ]),
  },
  {
    objectType: "meeting_action_item",
    label: "Action item",
    table: meetingActionItems,
    idColumn: meetingActionItems.id,
    companyColumn: meetingActionItems.companyId,
    projectColumn: meetingActionItems.projectId,
    statusColumn: meetingActionItems.status,
    createdAtColumn: meetingActionItems.createdAt,
    openStatuses: ["open", "in_progress", "blocked"],
    assignField: "ownerId",
    dueField: "dueDate",
    titleField: "title",
    fields: common([
      { path: "reference", type: "text", label: "Reference" },
      { path: "title", type: "text", label: "Title" },
      statusField(["open", "in_progress", "blocked", "completed", "verified", "cancelled"]),
      { path: "priority", type: "enum", label: "Priority", options: ["low", "medium", "high", "critical"] },
      { path: "ownerId", type: "user", label: "Owner" },
      { path: "dueDate", type: "date", label: "Due date" },
      { path: "carryCount", type: "number", label: "Carried forward (times)" },
      { path: "escalatedToId", type: "user", label: "Escalated to" },
    ]),
  },
  {
    objectType: "schedule_task",
    label: "Schedule task",
    table: scheduleTasks,
    idColumn: scheduleTasks.id,
    projectColumn: scheduleTasks.projectId,
    createdAtColumn: scheduleTasks.createdAt,
    assignField: "responsibleId",
    dueField: "finishDate",
    titleField: "name",
    fields: common([
      { path: "name", type: "text", label: "Name" },
      { path: "wbsCode", type: "text", label: "WBS" },
      { path: "durationDays", type: "number", label: "Duration (days)" },
      { path: "percentComplete", type: "number", label: "% complete" },
      { path: "startDate", type: "date", label: "Start" },
      { path: "finishDate", type: "date", label: "Finish" },
      { path: "actualFinish", type: "date", label: "Actual finish" },
      { path: "totalFloat", type: "number", label: "Total float" },
      { path: "isCritical", type: "boolean", label: "Critical" },
      { path: "responsibleId", type: "user", label: "Responsible" },
    ]),
  },
  {
    objectType: "vendor",
    label: "Vendor",
    table: vendors,
    idColumn: vendors.id,
    companyColumn: vendors.companyId,
    statusColumn: vendors.status,
    createdAtColumn: vendors.createdAt,
    openStatuses: ["active"],
    titleField: "name",
    fields: common([
      { path: "name", type: "text", label: "Name" },
      { path: "status", type: "enum", label: "Status", options: ["active", "inactive", "merged"] },
      { path: "country", type: "text", label: "Country" },
      { path: "taxId", type: "text", label: "Tax id" },
      { path: "entityId", type: "text", label: "Entity" },
    ]),
  },
];

const BY_TYPE = new Map(ENTRIES.map((e) => [e.objectType, e]));

export function snapshotEntry(objectType: string): SnapshotEntry | undefined {
  return BY_TYPE.get(objectType);
}

export function knownObjectTypes(): string[] {
  return ENTRIES.map((e) => e.objectType);
}

/** What the builder shows: every known type with its field catalogue. */
export function snapshotCatalogue() {
  return ENTRIES.map((e) => ({
    objectType: e.objectType,
    label: e.label,
    projectScoped: Boolean(e.projectColumn) || Boolean(e.selfProject),
    openStatuses: e.openStatuses ?? null,
    assignField: e.assignField ?? null,
    dueField: e.dueField ?? null,
    titleField: e.titleField,
    fields: e.fields,
  }));
}

export interface LoadedSnapshot {
  record: Record<string, unknown>;
  projectId: string | null;
  title: string;
}

function rowProject(entry: SnapshotEntry, row: Record<string, unknown>): string | null {
  if (entry.selfProject) return typeof row["id"] === "string" ? (row["id"] as string) : null;
  if (!entry.projectColumn) return null;
  const v = row["projectId"];
  return typeof v === "string" && v !== "" ? v : null;
}

function rowTitle(entry: SnapshotEntry, row: Record<string, unknown>): string {
  const v = row[entry.titleField];
  if (typeof v === "string" && v.trim() !== "") return v;
  const ref = row["reference"];
  if (typeof ref === "string") return ref;
  const id = row["id"];
  return typeof id === "string" ? id : entry.label;
}

/**
 * Load one record as a plain object, tenant-checked. Returns null when the
 * type is unknown, the row is missing, or it belongs to another company —
 * the caller never sees another tenant's record through this door.
 */
export async function loadSnapshot(
  db: Db,
  companyId: string,
  objectType: string,
  objectId: string,
): Promise<LoadedSnapshot | null> {
  const entry = BY_TYPE.get(objectType);
  if (!entry) return null;
  const conds: SQL[] = [eq(entry.idColumn, objectId)];
  if (entry.companyColumn) conds.push(eq(entry.companyColumn, companyId));
  const rows = (await db.select().from(entry.table).where(and(...conds)).limit(1)) as Array<
    Record<string, unknown>
  >;
  const row = rows[0];
  if (!row) return null;
  const projectId = rowProject(entry, row);
  if (!entry.companyColumn) {
    // No company column on the table (schedule tasks): the tenant check goes
    // through the project the record belongs to.
    if (!projectId) return null;
    const owner = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!owner[0]) return null;
  }
  return { record: row, projectId, title: rowTitle(entry, row) };
}

/**
 * Candidate records for a schedule scan: this company's (and optionally this
 * project's) live records of one type, newest first, capped. Types without a
 * status column are scanned whole but still capped.
 */
export async function scanCandidates(
  db: Db,
  companyId: string,
  objectType: string,
  projectId: string | null,
  limit = SCAN_LIMIT,
): Promise<LoadedSnapshot[]> {
  const entry = BY_TYPE.get(objectType);
  if (!entry) return [];
  const conds: SQL[] = [];
  if (entry.companyColumn) conds.push(eq(entry.companyColumn, companyId));
  if (projectId) {
    if (entry.selfProject) conds.push(eq(entry.idColumn, projectId));
    else if (entry.projectColumn) conds.push(eq(entry.projectColumn, projectId));
    else return []; // a company-level type cannot be scanned per project
  } else if (!entry.companyColumn && entry.projectColumn) {
    // No company column: bound the scan to this company's projects.
    const owned = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    const ids = owned.map((p) => p.id);
    if (ids.length === 0) return [];
    conds.push(inArray(entry.projectColumn, ids));
  }
  if (entry.statusColumn && entry.openStatuses && entry.openStatuses.length > 0) {
    conds.push(inArray(entry.statusColumn, [...entry.openStatuses]));
  }
  let q = db.select().from(entry.table).$dynamic();
  if (conds.length > 0) q = q.where(and(...conds));
  if (entry.createdAtColumn) q = q.orderBy(desc(entry.createdAtColumn));
  const rows = (await q.limit(Math.min(limit, SCAN_LIMIT))) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    record: row,
    projectId: rowProject(entry, row),
    title: rowTitle(entry, row),
  }));
}

/**
 * Write a user id into the type's assign column. Returns false when the type
 * has no assignable field (the action is then `skipped`, not `failed`).
 */
export async function assignRecord(
  db: Db,
  companyId: string,
  objectType: string,
  objectId: string,
  userId: string,
): Promise<{ ok: boolean; field: string | null; reason?: string }> {
  const entry = BY_TYPE.get(objectType);
  if (!entry || !entry.assignField) {
    return { ok: false, field: null, reason: `${objectType} has no assignable field` };
  }
  const column = (entry.table as unknown as Record<string, PgColumn | undefined>)[entry.assignField];
  if (!column) return { ok: false, field: entry.assignField, reason: "assign column not found" };
  const existing = await loadSnapshot(db, companyId, objectType, objectId);
  if (!existing) return { ok: false, field: entry.assignField, reason: "record not found in this company" };
  const conds: SQL[] = [eq(entry.idColumn, objectId)];
  if (entry.companyColumn) conds.push(eq(entry.companyColumn, companyId));
  await db
    .update(entry.table)
    .set({ [entry.assignField]: userId })
    .where(and(...conds));
  return { ok: true, field: entry.assignField };
}
