/**
 * DESIGN MANAGEMENT workspace — the shared vocabulary (spec Vol I §1.5
 * #249–255; Vol II Domain T #886–912).
 *
 * Types mirror `apps/api/src/modules/design/*` exactly. The rules every tab
 * obeys:
 *
 *  1. A figure the API could not derive is `{ value: null, reasons }` and is
 *     rendered as "Not available" WITH the server's reasons, never as 0.
 *  2. Money is bucketed per currency and never added across currencies.
 *  3. Every panel loads, fails and empties on its own.
 *  4. Every computed verdict (consolidated code, slippage level, required
 *     authorisation, readiness) is shown next to the basis the engine used.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Card, CardBody, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import type { Tone } from "../../ui/tokens";
import { api } from "../../lib/api";

/* ========================================================================== */
/* Wire types                                                                  */
/* ========================================================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Figure {
  value: number | null;
  unit: string;
  inputs: Record<string, unknown>;
  reasons: string[];
}

export interface StageDefinitionRow {
  key: string;
  order: number;
  label: string;
  riba: string;
  aia: string;
  iso19650: string;
  purpose: string;
  gateOutcome: string;
  isConstructionStage: boolean;
}

export interface GateCriterion {
  key: string;
  label: string;
  met: boolean;
  note?: string;
}

export interface StageGateRow {
  id: string;
  stageKey: string;
  framework: string;
  label: string | null;
  displayLabel: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  status: string;
  criteria: GateCriterion[];
  blockers: string[];
  signedOffBy: string | null;
  signedOffAt: string | null;
  signOffNotes: string | null;
  rejectedReason: string | null;
  packages: { total: number; approved: number };
}

export interface StagesResponse {
  framework: string;
  library: StageDefinitionRow[];
  gates: StageGateRow[];
  outOfOrder: string[];
}

export interface PackageRow {
  id: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  discipline: string;
  stageKey: string | null;
  status: string;
  leadVendorId: string | null;
  leadUserId: string | null;
  consultantId: string | null;
  plannedIssueDate: string | null;
  actualIssueDate: string | null;
  plannedApprovalDate: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  revision: string | null;
  frozenAt: string | null;
  freezeId: string | null;
  reviewCount: number;
  openIssueCount: number;
  openCommentCount: number;
  dcnCount: number;
  postFreezeDcnCount: number;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PackageDetail extends PackageRow {
  reviews: ReviewRow[];
  issues: IssueRow[];
  deliverables: DeliverableRow[];
  changeNotices: ChangeNoticeRow[];
  freezes: FreezeRow[];
  readiness: ReadinessVerdict;
}

export interface FreezeRow {
  id: string;
  scope: string;
  packageId: string | null;
  stageKey: string | null;
  title: string;
  reason: string | null;
  effectiveFrom: string;
  status: string;
  requiredAuthorisation: string;
  declaredBy: string;
  liftedBy: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

export interface ReviewRow {
  id: string;
  number: number;
  reference: string;
  packageId: string;
  title: string;
  revision: string | null;
  cycleNumber: number;
  previousReviewId: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  closedAt: string | null;
  status: string;
  consolidatedCode: string | null;
  consolidationBasis: string | null;
  turnaroundDays: number | null;
  reviewerCount: number;
  returnedCount: number;
  commentCount: number;
  openCommentCount: number;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ParticipantRow {
  id: string;
  reviewId: string;
  userId: string | null;
  vendorId: string | null;
  displayName: string | null;
  discipline: string;
  isRequired: number;
  dueAt: string | null;
  status: string;
  returnedCode: string | null;
  returnedAt: string | null;
  declineReason: string | null;
  summary: string | null;
}

export interface CommentRow {
  id: string;
  reviewId: string;
  packageId: string;
  sequence: number;
  category: string;
  priority: string;
  discipline: string;
  body: string;
  locationRef: string | null;
  drawingSheetId: string | null;
  specSectionId: string | null;
  bimModelId: string | null;
  code: string | null;
  status: string;
  response: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeNote: string | null;
  issueId: string | null;
  raisedBy: string;
  createdAt: string;
}

export interface Consolidation {
  code: string | null;
  basis: string;
  returned: number;
  required: number;
  requiredReturned: number;
  declined: number;
  byCode: Record<string, number>;
  outstanding: string[];
}

export interface ReviewDetail extends ReviewRow {
  package: PackageRow | null;
  participants: ParticipantRow[];
  comments: CommentRow[];
  consolidation: Consolidation;
  codeMeaning: Record<string, string>;
  canClose: { canClose: boolean; blockers: string[]; consolidation: Consolidation };
}

export interface IssueRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  issueType: string;
  priority: string;
  status: string;
  discipline: string;
  affectedDisciplines: string[];
  packageId: string | null;
  reviewId: string | null;
  commentId: string | null;
  assignedToUserId: string | null;
  assignedToVendorId: string | null;
  assignedAt: string | null;
  dueDate: string | null;
  raisedBy: string;
  raisedAt: string;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  voidReason: string | null;
  drawingSheetId: string | null;
  specSectionId: string | null;
  bimModelId: string | null;
  locationRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionOption {
  key: string;
  label: string;
  costImpact?: number | null;
  timeImpactDays?: number | null;
  note?: string;
}

export interface DecisionRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  question: string;
  background: string | null;
  discipline: string;
  stageKey: string | null;
  packageId: string | null;
  issueId: string | null;
  options: DecisionOption[];
  status: string;
  decision: string | null;
  chosenOptionKey: string | null;
  rationale: string | null;
  authorisationLevel: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  costImpact: number | null;
  currency: string;
  timeImpactDays: number | null;
  supersedesId: string | null;
  supersededById: string | null;
  reversedReason: string | null;
  proposedBy: string;
  createdAt: string;
}

export interface PiVerdict {
  consultantId: string;
  adequate: boolean | null;
  shortfall: number | null;
  expiresInDays: number | null;
  severity: string;
  reasons: string[];
  key: string;
}

export interface ConsultantRow {
  id: string;
  vendorId: string | null;
  name: string;
  discipline: string;
  role: string | null;
  appointmentRef: string | null;
  status: string;
  appointedAt: string | null;
  feeValue: number | null;
  currency: string;
  contactName: string | null;
  contactEmail: string | null;
  piRequiredAmount: number | null;
  piCoverAmount: number | null;
  piCurrency: string | null;
  piExpiresOn: string | null;
  piInsurerName: string | null;
  piPolicyNumber: string | null;
  piVerifiedBy: string | null;
  piVerifiedAt: string | null;
  notes: string | null;
  createdBy: string;
  pi?: PiVerdict;
}

export interface DeliverableAssessment {
  level: string;
  slippageDays: number | null;
  comparedAgainst: string | null;
  basis: string;
  reasons: string[];
  blocksTask: boolean;
}

export interface DeliverableRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  deliverableType: string;
  discipline: string;
  packageId: string | null;
  consultantId: string | null;
  vendorId: string | null;
  stageKey: string | null;
  scheduleTaskId: string | null;
  requiredOnSite: string | null;
  plannedIssueDate: string | null;
  forecastIssueDate: string | null;
  actualIssueDate: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  revision: string | null;
  status: string;
  slippageLevel: string;
  slippageDays: number | null;
  slippageReasons: string[];
  assessedAt: string | null;
  obligationId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  assessment?: DeliverableAssessment;
}

export interface DeliverableDetail extends DeliverableRow {
  assessment: DeliverableAssessment;
  consultant: ConsultantRow | null;
  obligation: { id: string; deadline: string | null; status: string; trigger: string } | null;
  task: { id: string; name: string; startDate: string | null; isCritical: number } | null;
}

export interface InfoRequirementRow {
  id: string;
  number: number;
  reference: string;
  kind: string;
  title: string;
  requirement: string | null;
  stageKey: string | null;
  packageId: string | null;
  consultantId: string | null;
  responsibleUserId: string | null;
  responsibleVendorId: string | null;
  dueDate: string | null;
  status: string;
  deliveredAt: string | null;
  deliveredBy: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
  waivedAt: string | null;
  waiveReason: string | null;
  obligationId: string | null;
  createdBy: string;
}

export interface ImpactRow {
  id: string;
  changeNoticeId: string;
  discipline: string;
  packageId: string | null;
  consultantId: string | null;
  summary: string;
  costImpact: number | null;
  currency: string;
  timeImpactDays: number | null;
  reworkHours: number | null;
  affectedPackageIds: string[];
  riskNote: string | null;
  assessedBy: string;
  assessedAt: string;
}

export interface ImpactRollup {
  costByCurrency: Record<string, number>;
  currencies: string[];
  cost: number | null;
  costReasons: string[];
  timeDays: number | null;
  timeBasis: string;
  reworkHours: number | null;
  disciplines: string[];
  affectedPackageIds: string[];
  lineCount: number;
  linesWithoutCost: number;
  linesWithoutTime: number;
}

export interface ChangeNoticeRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  description: string | null;
  packageId: string | null;
  stageKey: string | null;
  discipline: string;
  classification: string;
  originator: string;
  originatorVendorId: string | null;
  status: string;
  isPostFreeze: number;
  freezeId: string | null;
  requiredAuthorisation: string;
  authorisationBasis: string | null;
  assessedCost: number | null;
  currency: string;
  assessedTimeDays: number | null;
  assessedReworkHours: number | null;
  impactCount: number;
  impactCurrencies: string[];
  changeEventId: string | null;
  scheduleTaskId: string | null;
  needByDate: string | null;
  requestedBy: string;
  requestedAt: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  implementedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  createdAt: string;
}

export interface Entitlement {
  carriesEntitlement: boolean;
  costCarrier: string;
  raisesChangeEvent: boolean;
  reasons: string[];
}

export interface AuthorisationVerdict {
  level: string;
  basis: string;
  reasons: string[];
}

export interface ChangeNoticeDetail extends ChangeNoticeRow {
  package: PackageRow | null;
  impacts: ImpactRow[];
  rollup: ImpactRollup;
  freeze: { isPostFreeze: boolean; freezeId: string | null; requiredAuthorisation: string | null; basis: string };
  authorisation: AuthorisationVerdict;
  entitlement: Entitlement;
  thresholds: { projectManagerAbove: number; clientAbove: number; boardAbove: number; clientTimeDaysAbove: number };
}

export interface ReadinessDimension {
  key: string;
  label: string;
  score: number | null;
  weight: number;
  basis: string;
  inputs: Record<string, number | null>;
  reasons: string[];
}

export interface ReadinessVerdict {
  score: number | null;
  level: string;
  confidence: number;
  dimensions: ReadinessDimension[];
  blockers: string[];
  reasons: string[];
  projectId?: string;
  packageId?: string | null;
  computedAt?: string;
  snapshotWritten?: boolean;
}

export interface ReadinessResponse extends ReadinessVerdict {
  history: Array<{ id: string; computedAt: string; score: number | null; level: string; confidence: number }>;
}

export interface SignalRow {
  id: string;
  detector: string;
  severity: string;
  title: string;
  explanation: string;
  disposition: string;
  createdAt: string;
  evidenceRefs: Record<string, unknown> | null;
}

export interface Summary {
  asOf: string;
  packages: { total: number; byStatus: Record<string, number>; byDiscipline: Record<string, number>; frozen: number; approved: number };
  stages: { planned: number; open: number; signedOff: number; current: { stageKey: string; label: string | null } | null };
  reviews: { open: number; overdue: number; total: number; averageTurnaroundDays: Figure; byCode: Record<string, number> };
  comments: { total: number; open: number };
  issues: { total: number; open: number; criticalOpen: number; byDiscipline: Record<string, number> };
  decisions: { total: number; proposed: number; decided: number };
  deliverables: { total: number; late: number; atRisk: number; issued: number; onTimePercent: Figure };
  changeNotices: { total: number; open: number; postFreeze: number; costByCurrency: Record<string, number>; currencyNote: string | null };
  infoRequirements: { total: number; overdue: number; delivered: number; verified: number };
  consultants: { total: number; piInadequate: number; piUnknown: number };
  freezes: { active: number };
  readiness: { level: string; score: number | null; confidence: number; blockers: string[]; computedAt: string | null };
  signals: { open: number; bySeverity: Record<string, number>; items: SignalRow[] };
}

export interface Analytics {
  asOf: string;
  reviewCycles: {
    cyclesClosed: number;
    cyclesOpen: number;
    cyclesOverdue: number;
    averageTurnaroundDays: number | null;
    medianTurnaroundDays: number | null;
    averageAgainstTargetDays: number | null;
    onTimeCount: number;
    lateCount: number;
    onTimePercent: number | null;
    byCode: Record<string, number>;
    reworkMultiple: number | null;
    packagesAccepted: number;
    reasons: string[];
  };
  deliverables: {
    total: number;
    byLevel: Record<string, number>;
    issued: number;
    issuedOnTime: number;
    issuedLate: number;
    onTimePercent: number | null;
    averageSlippageDays: number | null;
    worstSlippageDays: number | null;
    outstandingLate: number;
    reasons: string[];
    byConsultant: Array<{ consultantId: string | null; total: number; late: number; atRisk: number; issued: number; averageSlippageDays: number | null }>;
  };
  changeFrequency: Array<{ packageId: string; reference: string | null; changes: number; postFreeze: number; ratePerMonth: number; exceedsThreshold: boolean; basis: string }>;
  issues: {
    total: number;
    open: number;
    byStatus: Record<string, number>;
    byDiscipline: Record<string, number>;
    byPriority: Record<string, number>;
    averageOpenAgeDays: number | null;
    averageResolutionDays: number | null;
    reasons: string[];
  };
  changeNotices: {
    total: number;
    byStatus: Record<string, number>;
    byClassification: Record<string, number>;
    byOriginator: Record<string, number>;
    postFreeze: number;
    costByCurrency: Record<string, number>;
    currencyNote: string | null;
    timeDaysApproved: number | null;
  };
}

export interface HealthInputs {
  metrics: Record<string, number | null>;
  reasons: string[];
}

export interface PerformanceResponse {
  overall: Analytics["deliverables"];
  byConsultant: Array<{ consultantId: string | null; name: string; total: number; late: number; atRisk: number; issued: number; averageSlippageDays: number | null }>;
}

export interface DisciplineBallInCourt {
  discipline: string;
  open: number;
  overdue: number;
  critical: number;
  oldestDays: number | null;
  total: number;
}

/* Lookups from neighbouring registers */
export interface VendorOption {
  id: string;
  name: string;
}
export interface UserOption {
  id: string;
  name: string;
  email: string;
}
export interface TaskOption {
  id: string;
  name: string;
  startDate: string | null;
  isCritical: number;
}
export interface SheetOption {
  id: string;
  number: string;
  title: string;
}

/* ========================================================================== */
/* Labels and tones                                                            */
/* ========================================================================== */

export const EM_DASH = "—";
export const NOT_AVAILABLE = "Not available";

export function labelize(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value.length > 10 ? value : `${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}

export function num(value: number | null | undefined, precision = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString(undefined, { maximumFractionDigits: precision, minimumFractionDigits: 0 });
}

export function pct(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(precision)}%`;
}

export const today = (): string => new Date().toISOString().slice(0, 10);

export function shiftDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export const PACKAGE_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  in_progress: "info",
  in_review: "highlight",
  approved: "success",
  frozen: "success",
  superseded: "neutral",
  cancelled: "neutral",
};

export const GATE_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  open: "info",
  signed_off: "success",
  rejected: "danger",
};

export const REVIEW_STATUS_TONE: Record<string, Tone> = {
  open: "info",
  in_review: "highlight",
  consolidating: "warning",
  closed: "success",
  cancelled: "neutral",
};

export const CODE_TONE: Record<string, Tone> = {
  A: "success",
  B: "info",
  C: "warning",
  D: "danger",
};

export const COMMENT_STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  responded: "info",
  closed: "success",
  withdrawn: "neutral",
};

export const ISSUE_STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  assigned: "info",
  in_progress: "highlight",
  resolved: "success",
  closed: "success",
  void: "neutral",
};

export const PRIORITY_TONE: Record<string, Tone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

export const DECISION_STATUS_TONE: Record<string, Tone> = {
  proposed: "info",
  decided: "success",
  superseded: "neutral",
  reversed: "danger",
};

export const DELIVERABLE_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  in_progress: "info",
  issued: "highlight",
  accepted: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export const SLIPPAGE_TONE: Record<string, Tone> = {
  on_track: "success",
  at_risk: "warning",
  late: "danger",
  delivered: "info",
  not_assessable: "neutral",
};

export const DCN_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  assessing: "highlight",
  approved: "success",
  rejected: "danger",
  implemented: "success",
  withdrawn: "neutral",
};

export const INFO_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  in_progress: "info",
  delivered: "highlight",
  verified: "success",
  overdue: "danger",
  waived: "neutral",
};

export const READINESS_TONE: Record<string, Tone> = {
  ready: "success",
  nearly_ready: "warning",
  not_ready: "danger",
  not_assessable: "neutral",
};

export const SEVERITY_TONE: Record<string, Tone> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const AUTHORISATION_TONE: Record<string, Tone> = {
  design_lead: "neutral",
  project_manager: "info",
  client: "warning",
  board: "danger",
};

export const DETECTOR_LABEL: Record<string, string> = {
  design_deliverable_late: "Deliverable late",
  design_review_overdue: "Review overdue",
  design_post_freeze_change: "Post-freeze change",
  design_issue_stale: "Issue stale",
  design_change_frequency: "Design churn",
  design_info_requirement_overdue: "Information overdue",
  design_pi_inadequate: "PI cover inadequate",
};

export const CODE_MEANING: Record<string, string> = {
  A: "Accepted — proceed",
  B: "Accepted with comments — proceed and incorporate",
  C: "Revise and resubmit",
  D: "Rejected",
};

/* ========================================================================== */
/* Errors and refusals                                                         */
/* ========================================================================== */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export interface Refusal {
  status: number;
  deliberate: boolean;
  message: string;
}

export function refusalFrom(err: unknown): Refusal {
  const status = Number((err as { status?: unknown } | null)?.status ?? 0);
  return {
    status,
    deliberate: status === 400 || status === 403 || status === 409,
    message: errorMessage(err, "The platform refused this action."),
  };
}

/* ========================================================================== */
/* Data loading                                                                */
/* ========================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** One GET, reloadable, aborting on unmount. `null` path means "not yet". */
export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** A mutation with its refusal held next to it, so the panel can quote it. */
export function useAction(): {
  busy: string | null;
  refusal: Refusal | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setRefusal(null);
    try {
      return await fn();
    } catch (err) {
      if (alive.current) setRefusal(refusalFrom(err));
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setRefusal(null), []);
  return { busy, refusal, clear, run };
}

/** Pickers from neighbouring registers. Each fails alone. */
export function useLookups(projectId: string) {
  const vendors = useResource<ListResponse<VendorOption>>("/api/v1/vendors?pageSize=200");
  const users = useResource<ListResponse<UserOption> | UserOption[]>("/api/v1/company/users?pageSize=200");
  const schedules = useResource<ListResponse<{ id: string; isActive: number }>>(`/api/v1/projects/${projectId}/schedules?pageSize=5`);
  const active = schedules.data?.items.find((s) => s.isActive === 1) ?? schedules.data?.items[0] ?? null;
  const schedule = useResource<{ tasks: TaskOption[] }>(active ? `/api/v1/projects/${projectId}/schedules/${active.id}` : null);
  const sheets = useResource<ListResponse<SheetOption>>(`/api/v1/projects/${projectId}/sheets?pageSize=300`);
  const packages = useResource<{ items: Array<{ id: string; reference: string; name: string; discipline: string; status: string; stageKey: string | null }> }>(
    `/api/v1/projects/${projectId}/design/packages-lookup`,
  );
  const consultants = useResource<ListResponse<ConsultantRow>>(`/api/v1/projects/${projectId}/design/consultants?pageSize=200`);
  const userItems: UserOption[] = Array.isArray(users.data) ? users.data : (users.data?.items ?? []);
  return {
    vendors: vendors.data?.items ?? [],
    users: userItems,
    tasks: schedule.data?.tasks ?? [],
    sheets: sheets.data?.items ?? [],
    packages: packages.data?.items ?? [],
    consultants: consultants.data?.items ?? [],
    reload: () => {
      packages.reload();
      consultants.reload();
    },
    notes: [
      vendors.error ? `Vendors could not be loaded: ${vendors.error}` : null,
      users.error ? `The directory could not be loaded: ${users.error}` : null,
      schedule.error ? `Schedule tasks could not be loaded: ${schedule.error}` : null,
      sheets.error ? `Drawing sheets could not be loaded: ${sheets.error}` : null,
      packages.error ? `Design packages could not be loaded: ${packages.error}` : null,
      consultants.error ? `Consultants could not be loaded: ${consultants.error}` : null,
    ].filter((x): x is string => Boolean(x)),
  };
}

export type Lookups = ReturnType<typeof useLookups>;

/* ========================================================================== */
/* Honesty components                                                          */
/* ========================================================================== */

export function ReasonList({ reasons, className, tone = "muted" }: { reasons: readonly string[]; className?: string; tone?: "muted" | "danger" }) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1", className)}>
      {reasons.map((reason, index) => (
        <li key={index} className={cx("flex items-start gap-1.5 text-meta", tone === "danger" ? "text-danger-fg" : "text-content-muted")}>
          <span aria-hidden className="mt-0.5 shrink-0 text-content-disabled">
            ▪
          </span>
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/** A figure the platform could not compute: "Not available" + the reasons. */
export function FigureCell({
  value,
  reasons,
  render,
  reasonsBelow = false,
  className,
}: {
  value: number | null | undefined;
  reasons: readonly string[];
  render: (value: number) => ReactNode;
  reasonsBelow?: boolean;
  className?: string;
}) {
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    return <span className={cx("tabular-nums", className)}>{render(value)}</span>;
  }
  const chip = (
    <span className={cx("inline-flex items-center gap-1 text-content-muted", className)}>
      <span className="font-medium">{NOT_AVAILABLE}</span>
      <Badge tone="warning" size="xs">
        why
      </Badge>
    </span>
  );
  if (reasonsBelow) {
    return (
      <span className="block">
        {chip}
        <ReasonList reasons={reasons} className="mt-1.5" />
      </span>
    );
  }
  return (
    <Tooltip content={reasons.length > 0 ? reasons.join(" ") : "The platform holds no inputs for this figure."}>{chip}</Tooltip>
  );
}

export function LoadError({ message, onRetry, title = "This view could not be loaded" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Alert
      tone="danger"
      title={title}
      actions={
        onRetry ? (
          <button type="button" onClick={onRetry} className="rounded-md border border-danger-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-content hover:bg-surface-hover">
            Retry
          </button>
        ) : undefined
      }
    >
      {message}
    </Alert>
  );
}

export function RefusalNotice({ refusal, onDismiss }: { refusal: Refusal; onDismiss?: () => void }) {
  return (
    <Alert tone={refusal.deliberate ? "warning" : "danger"} title={refusal.deliberate ? "The platform refused this — deliberately" : "That did not complete"} onDismiss={onDismiss}>
      {refusal.message}
    </Alert>
  );
}

export function SectionHeading({ title, hint, actions, className }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-body font-semibold text-content">{title}</h2>
        {hint ? <p className="mt-0.5 max-w-3xl text-meta text-content-muted">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Per-currency totals side by side; never one cross-currency number. */
export function CurrencyRail({ map, label, note }: { map: Record<string, number> | undefined | null; label: string; note?: string | null }) {
  const buckets = Object.entries(map ?? {}).sort((a, b) => b[1] - a[1]);
  if (buckets.length === 0) return null;
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
          <span className="text-label uppercase tracking-wide text-content-subtle">{label}</span>
          {buckets.map(([currency, value]) => (
            <div key={currency} className="min-w-0">
              <div className="text-display-xs font-semibold tabular-nums text-content">{money(value, currency)}</div>
              <div className="text-2xs uppercase tracking-wide text-content-subtle">{currency}</div>
            </div>
          ))}
        </div>
        <p className="text-2xs text-content-muted">
          {note ?? (buckets.length > 1 ? "Reported per currency and never added. A single total would need an FX rate and a date." : "Nothing on this screen adds one currency to another.")}
        </p>
      </CardBody>
    </Card>
  );
}

/** A compact key/value strip used inside drawers. */
export function KeyValue({ items }: { items: Array<{ label: string; value: ReactNode; hidden?: boolean }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <div key={i.label} className="min-w-0">
            <dt className="text-2xs uppercase tracking-wide text-content-subtle">{i.label}</dt>
            <dd className="text-meta text-content">{i.value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function optionList<T extends { id: string }>(items: T[], label: (item: T) => string, emptyLabel = "— none —") {
  return [{ value: "", label: emptyLabel }, ...items.map((i) => ({ value: i.id, label: label(i) }))];
}

/** The engine's verdict with its basis underneath — never a bare colour. */
export function VerdictLine({ tone, label, basis }: { tone: Tone; label: string; basis?: string | null }) {
  return (
    <div className="min-w-0">
      <Badge tone={tone} size="sm" dot>
        {label}
      </Badge>
      {basis ? <p className="mt-1 text-2xs text-content-muted">{basis}</p> : null}
    </div>
  );
}
