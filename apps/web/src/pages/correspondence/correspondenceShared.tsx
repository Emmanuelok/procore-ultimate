/**
 * Shared types, vocabulary and presentational helpers for the Correspondence
 * workspace (spec Vol I §2.11–2.13, #440–464, and #99 inbound email).
 *
 * The view-models mirror the API exactly. The honesty rules this workspace
 * obeys, implemented once here:
 *
 *  · a figure the API returned as null renders "—" with the reason it gave,
 *    never 0 — "nobody was asked to acknowledge" and "nobody acknowledged"
 *    are different sentences;
 *  · a deadline is always shown with how late it is, because "due 3 Sep" and
 *    "8 days overdue" are read differently;
 *  · every panel loads, fails and empties on its own.
 */
import { useCallback, useState, type ReactNode } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Alert, Badge, Skeleton, cx } from "../../ui";
import type { Tone } from "../../ui/tokens";
import { useResource, type Loadable, type Paginated } from "../../layouts/project/lib";

export { useResource };
export type { Loadable, Paginated };

/* ================================= Types ================================== */

export interface Figure {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface CorrespondenceType {
  id: string;
  projectId: string | null;
  key: string;
  name: string;
  description: string | null;
  prefix: string;
  defaultDirection: string;
  requiresResponse: number;
  responseDays: number | null;
  isContractual: number;
  createsObligation: number;
  approvalSteps: Array<{ name: string; role?: string | null; userId?: string | null }>;
  isActive: number;
  isSystem: number;
  createdAt: string;
  letterCount?: number;
}

export interface Recipient {
  id: string;
  recordType: string;
  recordId: string;
  kind: string;
  partyType: string;
  partyId: string | null;
  name: string;
  email: string | null;
  organisation: string | null;
  deliveryStatus: string;
  sentAt: string | null;
  firstReadAt: string | null;
  lastReadAt: string | null;
  readCount: number;
  acknowledgementRequired: number;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
}

export interface LetterAssessment {
  id: string;
  reference: string;
  open: boolean;
  awaitingResponse: boolean;
  dueInDays: number | null;
  daysOverdue: number | null;
  overdue: boolean;
  dueSoon: boolean;
  ballInCourt: "us" | "recipient" | "none";
  ageDays: number | null;
  responseDays: number | null;
}

export interface Letter {
  id: string;
  typeId: string;
  typeKey: string;
  number: number;
  reference: string;
  subject: string;
  body: string | null;
  direction: string;
  status: string;
  priority: string;
  source: string;
  isContractual: number;
  threadId: string;
  inReplyToId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  letterDate: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  responseRequired: number;
  responseDueDate: string | null;
  respondedAt: string | null;
  responseLetterId: string | null;
  closedAt: string | null;
  voidReason: string | null;
  fileIds: string[];
  obligationId: string | null;
  inboundMessageId: string | null;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  assessment?: LetterAssessment;
  recipients?: Array<{ id: string; name: string; kind: string; acknowledgedAt: string | null }>;
}

export interface Approval {
  id: string;
  seq: number;
  name: string;
  role: string | null;
  userId: string | null;
  status: string;
  decidedAt: string | null;
  decidedBy: string | null;
  comment: string | null;
}

export interface LetterDetail extends Letter {
  recipients: Recipient[];
  approvals: Approval[];
  thread: Array<{
    id: string;
    reference: string;
    subject: string;
    direction: string;
    status: string;
    letterDate: string | null;
    issuedAt: string | null;
    createdAt: string;
  }>;
  type: CorrespondenceType | null;
  inboundMessage: InboundMessage | null;
  assessment: LetterAssessment;
}

export interface InboundMessage {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string | null;
  receivedAt: string;
  attachments: Array<{ fileId?: string | null; filename?: string | null; contentType?: string | null }>;
  status: string;
  routingReason: string | null;
  detectedReference: string | null;
  letterId: string | null;
  senderUserId: string | null;
  senderContactId: string | null;
  signatureVerified: number | null;
  createdAt: string;
}

export interface TransmittalItem {
  id: string;
  seq: number;
  itemType: string;
  itemId: string | null;
  title: string;
  revision: string | null;
  format: string | null;
  copies: number;
  notes: string | null;
}

export interface Transmittal {
  id: string;
  number: number;
  reference: string;
  subject: string;
  purpose: string;
  status: string;
  method: string;
  coverNote: string | null;
  issuedAt: string | null;
  ackDueDate: string | null;
  ackRequired: number;
  recipientCount: number;
  ackRequiredCount: number;
  acknowledgedCount: number;
  itemCount: number;
  obligationId: string | null;
  letterId: string | null;
  createdAt: string;
  outstanding?: number;
  overdue?: boolean;
}

export interface AckPosition {
  recipients: number;
  required: number;
  acknowledged: number;
  outstanding: number;
  read: number;
  bounced: number;
  percent: number | null;
  reasons: string[];
  overdue: boolean;
  daysOverdue: number | null;
  outstandingNames: string[];
}

export interface TransmittalDetail extends Transmittal {
  items: TransmittalItem[];
  recipients: Recipient[];
  position: AckPosition;
}

export interface SignoffParty {
  partyType: string;
  partyId?: string | null;
  label: string;
}

export interface TemplateActivity {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  evidenceRequired: number;
  evidenceRequirement: string | null;
  referenceFileIds: string[];
  signoffParties: SignoffParty[];
  isQualityCheckpoint: number;
  dueOffsetDays: number | null;
}

export interface ActionPlanTemplate {
  id: string;
  projectId: string | null;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  version: number;
  isActive: number;
  createdAt: string;
  activityCount?: number;
  activities?: TemplateActivity[];
}

export interface Signoff {
  id: string;
  seq: number;
  activityId: string;
  partyType: string;
  partyId: string | null;
  label: string;
  status: string;
  signedAt: string | null;
  signedBy: string | null;
  signerName: string | null;
  note: string | null;
}

export interface PlanActivity {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  status: string;
  assigneeId: string | null;
  dueDate: string | null;
  evidenceRequired: number;
  evidenceRequirement: string | null;
  evidenceFileIds: string[];
  evidenceNote: string | null;
  evidenceSubmittedAt: string | null;
  evidenceSubmittedBy: string | null;
  isQualityCheckpoint: number;
  signoffRequiredCount: number;
  signoffCount: number;
  completedAt: string | null;
  waivedReason: string | null;
  blockedReason: string | null;
  signoffs?: Signoff[];
  readiness?: { ready: boolean; blockers: string[] };
}

export interface PlanProgress {
  total: number;
  signedOff: number;
  waived: number;
  outstanding: number;
  blocked: number;
  overdue: number;
  percent: number | null;
  reasons: string[];
  nextActivity: { id: string; seq: number; title: string } | null;
  heldBy: { id: string; seq: number; title: string } | null;
  byStatus: Record<string, number>;
}

export interface CompletionRow {
  seq: number;
  title: string;
  status: string;
  isQualityCheckpoint: boolean;
  evidenceRequired: boolean;
  evidenceCount: number;
  signoffCount: number;
  signoffRequiredCount: number;
  dueDate: string | null;
  overdue: boolean;
  gaps: string[];
}

export interface ActionPlan {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  templateId: string | null;
  templateVersion: number | null;
  status: string;
  anchor: string;
  locationId: string | null;
  scheduleTaskId: string | null;
  ownerId: string | null;
  startDate: string | null;
  dueDate: string | null;
  activityCount: number;
  completedCount: number;
  progressPercent: number | null;
  blockedReason: string | null;
  createdAt: string;
  overdue?: boolean;
}

export interface ActionPlanDetail extends ActionPlan {
  activities: PlanActivity[];
  progress: PlanProgress;
  report: { rows: CompletionRow[]; progress: PlanProgress; gaps: string[]; complete: boolean };
}

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormLogicCondition {
  field: string;
  operator: string;
  value?: unknown;
}

export interface FormLogicRule {
  all?: FormLogicCondition[];
  any?: FormLogicCondition[];
}

export interface FormFieldDef {
  key: string;
  label: string;
  type: string;
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

export interface FormTemplate {
  id: string;
  projectId: string | null;
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  status: string;
  version: number;
  fields: FormFieldDef[];
  logic: Record<string, FormLogicRule>;
  signatureRequired: number;
  pdfFileId: string | null;
  pdfFieldMap: Record<string, string>;
  publishedAt: string | null;
  createdAt: string;
  fieldCount?: number;
}

export interface FormTemplateDetail extends FormTemplate {
  responseCount: number;
  problems: string[];
  pdfMapping: { mapped: Record<string, string>; danglingPdfFields: string[]; unmappedFields: string[] };
  initialVisibility: { visible: string[]; hidden: string[]; defects: string[] };
}

export interface FormAssignment {
  id: string;
  templateId: string;
  templateVersion: number;
  assigneeUserId: string | null;
  assigneeContactId: string | null;
  assigneeName: string;
  locationId: string | null;
  scheduleTaskId: string | null;
  dueDate: string | null;
  status: string;
  instructions: string | null;
  responseId: string | null;
  completedAt: string | null;
  createdAt: string;
  overdue?: boolean;
}

export interface FormSignature {
  name: string;
  signedAt: string;
  method: string;
  fileId?: string | null;
  statement?: string | null;
}

export interface FormResponse {
  id: string;
  templateId: string;
  templateVersion: number;
  assignmentId: string | null;
  number: number;
  reference: string;
  title: string | null;
  status: string;
  values: Record<string, unknown>;
  hiddenFields: string[];
  signature: FormSignature | null;
  fileIds: string[];
  locationId: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface FormResponseDetail extends FormResponse {
  template: FormTemplate | null;
  templateDrifted: boolean;
  visibility: { visible: string[]; hidden: string[]; defects: string[] };
}

export interface RegisterStats {
  total: number;
  byStatus: Record<string, number>;
  byDirection: Record<string, number>;
  byType: Record<string, number>;
  open: number;
  awaitingResponse: number;
  overdue: number;
  dueSoon: number;
  ballWithUs: number;
  ballWithRecipient: number;
  averageResponseDays: number | null;
  averageResponseBasis: string;
  oldestOpenDays: number | null;
}

export interface CorrespondenceSummary {
  letters: RegisterStats;
  transmittals: {
    total: number;
    byStatus: Record<string, number>;
    issued: number;
    outstandingAcks: number;
    overdueAcks: number;
    acknowledgementRate: Figure;
  };
  plans: {
    total: number;
    byStatus: Record<string, number>;
    active: number;
    blocked: number;
    completed: number;
    overdueActivities: number;
    averageProgress: Figure;
  };
  forms: {
    templates: number;
    published: number;
    assignments: number;
    openAssignments: number;
    overdueAssignments: number;
    responses: number;
    submitted: number;
  };
  inbound: { captured: number; unmatched: number };
  openSignals: number;
  reasons: string[];
}

export interface CorrespondenceSignal {
  id: string;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  disposition: string;
  createdAt: string;
}

export interface SweepResult {
  scanned: number;
  raised: number;
  notified: number;
  cleared: number;
}

export interface ScanResult {
  responses: SweepResult;
  acknowledgements: SweepResult;
  plans: SweepResult;
  forms: SweepResult;
  ranAt: string;
}

export interface VendorLite {
  id: string;
  name: string;
}

export interface ContactLite {
  id: string;
  name: string;
  email: string | null;
}

export interface LocationLite {
  id: string;
  name: string;
}

/* ============================== Vocabulary ================================ */

export const DIRECTIONS = ["outbound", "inbound", "internal"] as const;
export const LETTER_STATUSES = [
  "draft",
  "pending_approval",
  "issued",
  "acknowledged",
  "responded",
  "closed",
  "void",
] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const RECIPIENT_KINDS = ["to", "cc", "bcc"] as const;
export const PARTY_TYPES = ["user", "contact", "vendor", "external"] as const;
export const TRANSMITTAL_PURPOSES = [
  "for_approval",
  "for_review",
  "for_information",
  "for_construction",
  "for_record",
  "for_tender",
  "for_coordination",
] as const;
export const TRANSMITTAL_STATUSES = [
  "draft",
  "issued",
  "partially_acknowledged",
  "acknowledged",
  "closed",
  "void",
] as const;
export const TRANSMITTAL_METHODS = ["email", "portal", "courier", "hand", "post", "ftp"] as const;
export const TRANSMITTAL_ITEM_TYPES = [
  "file",
  "drawing_sheet",
  "submittal",
  "document",
  "spec_section",
  "model",
  "other",
] as const;
export const PLAN_STATUSES = ["draft", "active", "blocked", "completed", "cancelled"] as const;
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
export const FORM_RESPONSE_STATUSES = ["draft", "submitted", "approved", "rejected", "void"] as const;

export const DETECTOR_LABEL: Record<string, string> = {
  correspondence_response_overdue: "Response overdue",
  correspondence_ack_overdue: "Acknowledgement overdue",
  correspondence_plan_overdue: "Action plan overdue",
  correspondence_form_overdue: "Form overdue",
  correspondence_inbound_unmatched: "Unrouted inbound email",
};

/* ================================ Helpers ================================= */

export const DASH = "—";

export function titleCase(value: string | null | undefined): string {
  if (!value) return DASH;
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function pct(value: number | null | undefined, dp = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(dp)}%`;
}

export function days(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `${n} day${Math.abs(n) === 1 ? "" : "s"}`;
}

export function errorMessage(err: unknown, fallback = "The request failed."): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/* ================================= Tones ================================== */

export function letterTone(status: string): Tone {
  switch (status) {
    case "void":
      return "danger";
    case "responded":
    case "closed":
      return "success";
    case "acknowledged":
      return "info";
    case "issued":
      return "warning";
    case "pending_approval":
      return "accent";
    default:
      return "neutral";
  }
}

export function transmittalTone(status: string): Tone {
  switch (status) {
    case "void":
      return "danger";
    case "acknowledged":
    case "closed":
      return "success";
    case "partially_acknowledged":
      return "warning";
    case "issued":
      return "info";
    default:
      return "neutral";
  }
}

export function planTone(status: string): Tone {
  switch (status) {
    case "blocked":
      return "danger";
    case "completed":
      return "success";
    case "active":
      return "info";
    case "cancelled":
      return "neutral";
    default:
      return "neutral";
  }
}

export function activityTone(status: string): Tone {
  switch (status) {
    case "signed_off":
      return "success";
    case "waived":
      return "info";
    case "blocked":
      return "danger";
    case "evidence_submitted":
      return "warning";
    default:
      return "neutral";
  }
}

export function responseTone(status: string): Tone {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
      return "danger";
    case "submitted":
      return "warning";
    case "void":
      return "neutral";
    default:
      return "neutral";
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      return "neutral";
  }
}

export function ballTone(ball: string): Tone {
  if (ball === "us") return "warning";
  if (ball === "recipient") return "info";
  return "neutral";
}

/* ============================ Panel primitives ============================ */

export function ReasonList({ reasons, className }: { reasons: readonly string[]; className?: string }) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className="flex items-start gap-1.5 text-meta text-content-muted">
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function LoadError({
  message,
  onRetry,
  title = "This panel could not be loaded",
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover"
          >
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** A label/value row inside a drawer. */
export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-meta text-content-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-meta text-content">
        <div>{children}</div>
        {hint ? <div className="text-2xs text-content-subtle">{hint}</div> : null}
      </dd>
    </div>
  );
}

/**
 * A deadline with how it stands. "Due 3 Sep" and "8 days overdue" are read
 * differently, so both are printed.
 */
export function DueBadge({
  date,
  daysOverdue,
  dueInDays,
}: {
  date: string | null;
  daysOverdue?: number | null;
  dueInDays?: number | null;
}) {
  if (!date) return <span className="text-content-subtle">{DASH}</span>;
  if (daysOverdue !== null && daysOverdue !== undefined && daysOverdue > 0) {
    return (
      <Badge tone="danger" size="xs" dot title={`Was due ${date}`}>
        {days(daysOverdue)} overdue
      </Badge>
    );
  }
  if (dueInDays !== null && dueInDays !== undefined && dueInDays >= 0 && dueInDays <= 3) {
    return (
      <Badge tone="warning" size="xs" dot title={`Due ${date}`}>
        due in {days(dueInDays)}
      </Badge>
    );
  }
  return <span className="tabular-nums">{isoDate(date)}</span>;
}

/** A figure the API declined to invent renders as a dash plus its reason. */
export function FigureValue({ figure, unit }: { figure: Figure | null | undefined; unit?: string }) {
  if (!figure || figure.value === null) {
    return (
      <span className="text-content-subtle" title={figure?.reasons.join(" ") ?? "Not available."}>
        {DASH}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {figure.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
      {unit ?? figure.unit}
    </span>
  );
}

/* ================================= Hooks ================================== */

export function useAction(): {
  busy: string | null;
  error: string | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, clear, run };
}

export function useSummary(projectId: string): Loadable<CorrespondenceSummary> {
  return useResource<CorrespondenceSummary>(`/api/v1/projects/${projectId}/correspondence/summary`);
}

export function useTypes(projectId: string): Loadable<{ items: CorrespondenceType[]; total: number }> {
  return useResource<{ items: CorrespondenceType[]; total: number }>(
    `/api/v1/correspondence/types?projectId=${projectId}`,
  );
}

export function useVendors(): Loadable<Paginated<VendorLite>> {
  return useResource<Paginated<VendorLite>>("/api/v1/vendors?page=1&pageSize=200");
}

export function useContacts(): Loadable<Paginated<ContactLite>> {
  return useResource<Paginated<ContactLite>>("/api/v1/contacts?page=1&pageSize=200");
}

export function useLocations(projectId: string): Loadable<{ items: LocationLite[] }> {
  return useResource<{ items: LocationLite[] }>(`/api/v1/projects/${projectId}/locations`);
}

/* ================================== API =================================== */

const p = (projectId: string) => `/api/v1/projects/${projectId}/correspondence`;

export const corrApi = {
  /* types */
  seedTypes: () => api.post<{ created: string[]; skipped: string[] }>("/api/v1/correspondence/types/seed", {}),
  createType: (body: Record<string, unknown>) =>
    api.post<CorrespondenceType>("/api/v1/correspondence/types", body),
  patchType: (id: string, body: Record<string, unknown>) =>
    api.patch<CorrespondenceType>(`/api/v1/correspondence/types/${id}`, body),

  /* letters */
  createLetter: (projectId: string, body: Record<string, unknown>) =>
    api.post<Letter>(`${p(projectId)}/letters`, body),
  patchLetter: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.patch<Letter>(`${p(projectId)}/letters/${id}`, body),
  addLetterRecipient: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Recipient>(`${p(projectId)}/letters/${id}/recipients`, body),
  submitLetter: (projectId: string, id: string) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/submit`, {}),
  decideApproval: (projectId: string, id: string, approvalId: string, body: Record<string, unknown>) =>
    api.post<{ readyToIssue: boolean; letterStatus: string }>(
      `${p(projectId)}/letters/${id}/approvals/${approvalId}/decide`,
      body,
    ),
  issueLetter: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/issue`, body),
  respondLetter: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/respond`, body),
  closeLetter: (projectId: string, id: string) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/close`, {}),
  voidLetter: (projectId: string, id: string, reason: string) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/void`, { reason }),
  replyLetter: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Letter>(`${p(projectId)}/letters/${id}/reply`, body),
  captureInbound: (projectId: string, body: Record<string, unknown>) =>
    api.post<{ action: string; reason: string; letterId: string; reference: string }>(
      `${p(projectId)}/inbound`,
      body,
    ),

  /* recipients (shared) */
  markRead: (projectId: string, recipientId: string) =>
    api.post<Recipient>(`${p(projectId)}/recipients/${recipientId}/read`, {}),
  acknowledge: (projectId: string, recipientId: string, note?: string) =>
    api.post<Recipient>(`${p(projectId)}/recipients/${recipientId}/acknowledge`, { note }),
  removeRecipient: (projectId: string, recipientId: string) =>
    api.del<{ deleted: boolean }>(`${p(projectId)}/recipients/${recipientId}`),

  /* transmittals */
  createTransmittal: (projectId: string, body: Record<string, unknown>) =>
    api.post<TransmittalDetail>(`${p(projectId)}/transmittals`, body),
  addTransmittalItems: (projectId: string, id: string, items: unknown[]) =>
    api.post<{ items: TransmittalItem[]; itemCount: number }>(`${p(projectId)}/transmittals/${id}/items`, {
      items,
    }),
  removeTransmittalItem: (projectId: string, id: string, itemId: string) =>
    api.del<{ deleted: boolean }>(`${p(projectId)}/transmittals/${id}/items/${itemId}`),
  addTransmittalRecipient: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<Recipient>(`${p(projectId)}/transmittals/${id}/recipients`, body),
  issueTransmittal: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<TransmittalDetail>(`${p(projectId)}/transmittals/${id}/issue`, body),
  closeTransmittal: (projectId: string, id: string) =>
    api.post<Transmittal>(`${p(projectId)}/transmittals/${id}/close`, {}),
  voidTransmittal: (projectId: string, id: string, reason: string) =>
    api.post<Transmittal>(`${p(projectId)}/transmittals/${id}/void`, { reason }),

  /* action plans */
  createPlanTemplate: (body: Record<string, unknown>) =>
    api.post<ActionPlanTemplate>("/api/v1/correspondence/action-plan-templates", body),
  createPlan: (projectId: string, body: Record<string, unknown>) =>
    api.post<ActionPlanDetail>(`${p(projectId)}/action-plans`, body),
  activatePlan: (projectId: string, id: string) =>
    api.post<ActionPlanDetail>(`${p(projectId)}/action-plans/${id}/activate`, {}),
  cancelPlan: (projectId: string, id: string, reason: string) =>
    api.post<ActionPlan>(`${p(projectId)}/action-plans/${id}/cancel`, { reason }),
  addActivity: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<PlanActivity>(`${p(projectId)}/action-plans/${id}/activities`, body),
  submitEvidence: (projectId: string, activityId: string, body: Record<string, unknown>) =>
    api.post<PlanActivity>(`${p(projectId)}/activities/${activityId}/evidence`, body),
  sign: (projectId: string, activityId: string, signoffId: string, body: Record<string, unknown>) =>
    api.post<{ activity: PlanActivity; progress: PlanProgress; planStatus: string }>(
      `${p(projectId)}/activities/${activityId}/signoffs/${signoffId}/sign`,
      body,
    ),
  waive: (projectId: string, activityId: string, reason: string) =>
    api.post<PlanActivity>(`${p(projectId)}/activities/${activityId}/waive`, { reason }),

  /* forms */
  createFormTemplate: (body: Record<string, unknown>) =>
    api.post<FormTemplate>("/api/v1/correspondence/form-templates", body),
  patchFormTemplate: (id: string, body: Record<string, unknown>) =>
    api.patch<FormTemplate>(`/api/v1/correspondence/form-templates/${id}`, body),
  publishFormTemplate: (id: string) =>
    api.post<FormTemplate>(`/api/v1/correspondence/form-templates/${id}/publish`, {}),
  archiveFormTemplate: (id: string) =>
    api.post<FormTemplate>(`/api/v1/correspondence/form-templates/${id}/archive`, {}),
  assignForm: (projectId: string, body: Record<string, unknown>) =>
    api.post<FormAssignment>(`${p(projectId)}/form-assignments`, body),
  cancelAssignment: (projectId: string, id: string, reason: string) =>
    api.post<FormAssignment>(`${p(projectId)}/form-assignments/${id}/cancel`, { reason }),
  createResponse: (projectId: string, body: Record<string, unknown>) =>
    api.post<FormResponse>(`${p(projectId)}/form-responses`, body),
  patchResponse: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.patch<FormResponse>(`${p(projectId)}/form-responses/${id}`, body),
  submitResponse: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<FormResponse>(`${p(projectId)}/form-responses/${id}/submit`, body),
  reviewResponse: (projectId: string, id: string, body: Record<string, unknown>) =>
    api.post<FormResponse>(`${p(projectId)}/form-responses/${id}/review`, body),

  /* sweeps */
  runSweeps: (projectId: string) => api.post<ScanResult>(`${p(projectId)}/sweeps/run`, {}),
};

/** Client-side mirror of the API's visibility rules, so the form renders the
 *  same questions the server will accept. The server remains the authority. */
export function evaluateCondition(
  condition: FormLogicCondition,
  values: Record<string, unknown>,
): boolean {
  const actual = values[condition.field];
  const empty =
    actual === null ||
    actual === undefined ||
    (typeof actual === "string" && actual.trim() === "") ||
    (Array.isArray(actual) && actual.length === 0);
  const num = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const same = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a === "boolean" || typeof b === "boolean") {
      const ab = typeof a === "boolean" ? a : a === "true" || a === 1;
      const bb = typeof b === "boolean" ? b : b === "true" || b === 1;
      return ab === bb;
    }
    const an = num(a);
    const bn = num(b);
    if (an !== null && bn !== null) return an === bn;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a) === String(b);
  };
  switch (condition.operator) {
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "eq":
      return same(actual, condition.value);
    case "ne":
      return !same(actual, condition.value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = num(actual);
      const b = num(condition.value);
      if (a === null || b === null) return false;
      if (condition.operator === "gt") return a > b;
      if (condition.operator === "gte") return a >= b;
      if (condition.operator === "lt") return a < b;
      return a <= b;
    }
    case "in": {
      const list = Array.isArray(condition.value) ? condition.value : [];
      if (Array.isArray(actual)) return actual.some((v) => list.some((c) => same(v, c)));
      return list.some((c) => same(actual, c));
    }
    case "not_in": {
      const list = Array.isArray(condition.value) ? condition.value : [];
      if (Array.isArray(actual)) return !actual.some((v) => list.some((c) => same(v, c)));
      return !list.some((c) => same(actual, c));
    }
    case "contains": {
      if (Array.isArray(actual)) return actual.some((v) => same(v, condition.value));
      if (typeof actual === "string" && condition.value != null) {
        return actual.toLowerCase().includes(String(condition.value).toLowerCase());
      }
      return false;
    }
    default:
      return false;
  }
}

export function visibleFieldKeys(
  fields: readonly FormFieldDef[],
  values: Record<string, unknown>,
  logic: Record<string, FormLogicRule> = {},
): Set<string> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const memo = new Map<string, boolean>();
  const stack = new Set<string>();
  const rulesFor = (key: string): FormLogicRule[] => {
    const out: FormLogicRule[] = [];
    const field = byKey.get(key);
    if (field?.visibleWhen) out.push(field.visibleWhen);
    const extra = logic[key];
    if (extra) out.push(extra);
    return out;
  };
  const visible = (key: string): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) return true;
    stack.add(key);
    let ok = true;
    for (const rule of rulesFor(key)) {
      for (const dep of [...(rule.all ?? []), ...(rule.any ?? [])].map((c) => c.field)) {
        if (byKey.has(dep) && !visible(dep)) ok = false;
      }
      if (ok) {
        const all = rule.all ?? [];
        const any = rule.any ?? [];
        const allPass = all.every((c) => evaluateCondition(c, values));
        const anyPass = any.length === 0 ? true : any.some((c) => evaluateCondition(c, values));
        if (!(allPass && anyPass)) ok = false;
      }
      if (!ok) break;
    }
    stack.delete(key);
    memo.set(key, ok);
    return ok;
  };
  return new Set(fields.filter((f) => visible(f.key)).map((f) => f.key));
}
