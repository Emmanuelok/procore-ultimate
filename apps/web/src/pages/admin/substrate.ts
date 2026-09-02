/**
 * Shared view-models and helpers for the substrate's web surfaces — admin
 * governance, the workflow workspace, global search and the directory
 * upgrades (Vol I §0.1, §0.3–§0.5, §0.8).
 *
 * The shapes mirror `apps/api/src/modules/{admin,projects,workflow,search}`
 * exactly. Nothing here fabricates a number: a figure the API did not return
 * is `null`, and every renderer turns `null` into "—" with a reason.
 */
import { ApiClientError } from "../../lib/api";
import type { Tone } from "../../ui";

/* ============================== Lists ================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Accept the paginate() envelope or a bare array so drift degrades gracefully. */
export function asList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: res.length };
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    const r = res as { items: T[]; total?: number };
    return { items: r.items, total: typeof r.total === "number" ? r.total : r.items.length };
  }
  return { items: [], total: 0 };
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiClientError ? err.status : null;
}

/** A count the API did return renders as a number; anything else renders "—". */
export function num(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat().format(value)
    : "—";
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s.]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* ============================== Audit ================================== */

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  objectType: string;
  objectId: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  payload: unknown;
  payloadStored: boolean;
  payloadHash: string | null;
  entryHash: string;
  prevHash: string | null;
}

export interface AuditFacets {
  objectTypes: Array<{ value: string; count: number }>;
  actions: Array<{ value: string; count: number }>;
}

export const AUDIT_ACTION_TONE: Record<string, Tone> = {
  create: "success",
  update: "info",
  delete: "danger",
  state_change: "warning",
  access: "neutral",
};

/* ============================ Retention ================================ */

export interface RetentionPolicy {
  id: string;
  objectType: string;
  retainMonths: number;
  action: string;
  basis: string | null;
  isActive: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface RetentionPreviewRow {
  objectType: string;
  retainMonths: number;
  action: string;
  dueForAction: number;
  heldBack: number;
  enforced: boolean;
  note: string;
}

export interface LegalHold {
  id: string;
  projectId: string | null;
  objectType: string | null;
  objectId: string | null;
  name: string;
  reason: string;
  matter: string | null;
  custodianIds: string[];
  status: string;
  placedBy: string;
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
}

/* ============================= Exports ================================= */

export interface ExportJob {
  id: string;
  status: string;
  datasets: string[];
  format: string;
  manifest: Record<string, unknown> | null;
  rowCount: number | null;
  error: string | null;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
}

export const EXPORT_DATASETS = [
  "projects",
  "vendors",
  "contacts",
  "cost_codes",
  "locations",
  "users",
  "permission_templates",
  "workflow_templates",
  "ledger",
] as const;

/* =========================== Delegation ================================ */

export interface AdminDelegation {
  id: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  projectIds: string[];
  capabilities: string[];
  note: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  grantedBy: string;
  createdAt: string;
}

/* =========================== Recycle bin =============================== */

export interface RecycledProject {
  id: string;
  name: string;
  number: string | null;
  stage: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deletedByName: string | null;
  objectType: "project";
}

export interface RecycledDirectoryRow {
  id: string;
  name: string;
  deletedAt: string | null;
  deletedBy: string | null;
  objectType: "vendor" | "contact";
}

/* ============================= Imports ================================= */

export interface ImportColumn {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  oneOf?: string[];
}

export interface ImportRowError {
  row: number;
  field: string | null;
  message: string;
  severity: "error" | "warning";
}

export interface ImportPreview {
  id: string;
  dataset: string;
  columns: ImportColumn[];
  rows: Array<Record<string, string>>;
  errors: ImportRowError[];
  rowCount: number;
  validCount: number;
  errorCount: number;
  status: string;
}

export interface ImportJob {
  id: string;
  dataset: string;
  status: string;
  projectId: string | null;
  fileName: string | null;
  rowCount: number;
  validCount: number;
  errorCount: number;
  createdCount: number;
  updatedCount: number;
  createdAt: string;
  committedAt: string | null;
}

/* ============================= Workflow ================================ */

export interface WorkflowCondition {
  field: string;
  op: string;
  value?: unknown;
}

export interface WorkflowStepDef {
  name: string;
  type: string;
  assigneeIds?: string[];
  role?: string;
  groupId?: string;
  quorum?: "any" | "all";
  parallel?: boolean;
  dueInDays?: number;
  escalateAfterDays?: number;
  escalateTo?: string;
  condition?: WorkflowCondition;
}

export interface WorkflowTemplate {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  recordType: string;
  version: number;
  steps: WorkflowStepDef[];
  isActive: number;
  isMandatory?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface WorkflowStepInstance {
  id: string;
  instanceId: string;
  position: number;
  name: string;
  type: string;
  assigneeId: string | null;
  assigneeKind?: string | null;
  assigneeKey?: string | null;
  delegatedToId: string | null;
  decision: string;
  comment: string | null;
  decidedAt: string | null;
  dueDate: string | null;
  escalationAt: string | null;
  escalatedAt: string | null;
  remindedAt: string | null;
  createdAt: string;
}

export interface WorkflowInstance {
  id: string;
  companyId: string;
  projectId: string;
  templateId: string;
  templateVersion: number;
  recordType: string;
  recordId: string;
  status: string;
  currentPosition: number;
  blockedReason?: string | null;
  startedBy: string;
  completedAt: string | null;
  createdAt: string;
  context?: Record<string, unknown> | null;
  steps?: WorkflowStepInstance[];
}

export interface WorkflowInboxItem extends WorkflowStepInstance {
  overdue: boolean;
  instance: {
    id: string;
    projectId: string;
    projectName: string | null;
    recordType: string;
    recordId: string;
    startedBy: string;
  };
}

export interface WorkflowGraphNode {
  position: number;
  label: string;
  parallel: boolean;
  state: "pending" | "active" | "done" | "rejected" | "skipped";
  steps: WorkflowStepInstance[];
}

export interface WorkflowGraph {
  instanceId: string;
  status: string;
  currentPosition?: number;
  blockedReason?: string | null;
  nodes: WorkflowGraphNode[];
  unavailable: string | null;
}

export const WORKFLOW_STATUS_TONE: Record<string, Tone> = {
  running: "info",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  blocked: "warning",
};

export const DECISION_TONE: Record<string, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  skipped: "neutral",
  withdrawn: "neutral",
};

/* ============================== Search ================================= */

export interface SearchHit {
  type: string;
  id: string;
  projectId: string | null;
  title: string;
  subtitle: string | null;
  status: string | null;
  href: string;
  score: number;
  updatedAt: string | null;
}

export interface SearchResponse {
  items: SearchHit[];
  total: number;
  tookMs: number;
  coverage: string[];
}

export interface SearchSourceInfo {
  type: string;
  label: string;
  tool: string | null;
  scope: string;
}

/* ========================== Notifications ============================== */

export interface NotificationRow {
  id: string;
  kind: string | null;
  title: string | null;
  body: string | null;
  readAt: string | null;
  createdAt: string | null;
  projectId: string | null;
  recordType?: string | null;
  recordId?: string | null;
}

export interface UnreadCount {
  count: number;
  byKind: Record<string, number>;
}

export interface NotificationPreferences {
  id: string | null;
  defaultChannel: string;
  digest: string;
  kinds: Record<string, string>;
  mutedProjectIds: string[];
  mutedTools: string[];
  lastDigestAt: string | null;
  catalogue: {
    kinds: readonly string[];
    channels: readonly string[];
    digests: readonly string[];
  };
}

export interface DigestItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  projectId: string | null;
  createdAt: string;
}

export interface DigestSummary {
  userId: string;
  since: string;
  until: string;
  total: number;
  subject: string;
  sections: Array<{
    projectId: string | null;
    projectName: string | null;
    total: number;
    byKind: Array<{ kind: string; count: number; items: DigestItem[] }>;
  }>;
}

/* ============================= Directory =============================== */

export interface VendorRow {
  id: string;
  name: string;
  status?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  taxId?: string | null;
  registrationNumber?: string | null;
  tradeCodes?: string[] | null;
}

export interface DuplicatePair {
  a: string;
  b: string;
  confidence: number;
  reasons: string[];
  aVendor: VendorRow | null;
  bVendor: VendorRow | null;
}

export interface VendorMerge {
  id: string;
  sourceVendorId: string;
  targetVendorId: string;
  sourceName: string;
  targetName: string;
  /** [{ table, column, rows }] — enough to explain and reverse the merge */
  movements: Array<{ table: string; column: string; rows: number }>;
  undoneAt: string | null;
  undoneBy: string | null;
  /** Stated by the API so the UI never offers an undo the API will refuse. */
  undoDeadline: string;
  performedBy: string;
  createdAt: string;
}

export interface VendorPerformance {
  vendor: { id: string; name: string; status: string | null };
  commitments: {
    byCurrency: Array<{ currency: string; count: number; value: number }>;
    total: { value: number | null; reasons: string[] };
  };
  invoices: {
    byCurrencyAndStatus: Array<{
      currency: string;
      status: string;
      count: number;
      value: number;
    }>;
  };
  quality: { openNcrs: number };
  safety: { incidents: number };
  bidding: { submissions: number };
  insurance: { certificates: number; nextExpiry: string | null };
}

export interface InviteResult {
  invitedEmail: string;
  role: string;
  membershipCreated: boolean;
  invitation: {
    id: string;
    status: string;
    expiresAt: string;
    tokenPrefix: string;
  };
  delivery: { dispatched: boolean; status?: string | null; reason?: string | null };
  acceptUrl: string | null;
}

/** Owner/admin of the current tenant — the gate every admin surface honours. */
export function isCompanyAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
