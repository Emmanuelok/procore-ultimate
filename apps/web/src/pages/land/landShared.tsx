/**
 * Shared types + presentational helpers for the land, resettlement &
 * community workspace (spec Vol II Domain J / M16). Mirrors the API
 * view-models: parcels carry papCount and blocking-task hydration, PAPs carry
 * the entitlement matrix and derived vulnerability flag, grievances carry the
 * computed SLA state, and the analytics endpoints return zero-filled tallies
 * so charts never render a ragged axis.
 */

/* --------------------------------- Types ----------------------------------- */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ParcelRow {
  id: string;
  reference: string;
  description: string | null;
  areaSqm: number | null;
  tenureType: string;
  ownerName: string | null;
  ownerEntityId: string | null;
  encumbrances: string | null;
  status: string;
  valuationAmount: number | null;
  compensationAmount: number | null;
  currency: string;
  compensationPaidAt: string | null;
  evidenceIds: string[];
  latitude: number | null;
  longitude: number | null;
  blockingTaskIds: string[];
  createdAt: string;
  updatedAt: string;
  papCount: number;
}

export interface BlockingTask {
  id: string;
  name: string | null;
  startDate: string | null;
  missing: boolean;
}

export interface ParcelDetail extends ParcelRow {
  affectedPersons: PapRow[];
  blockingTasks: BlockingTask[];
  allowedTransitions: string[];
}

export interface Entitlement {
  item: string;
  basis: string;
  amount: number;
  delivered: boolean;
}

export interface PapRow {
  id: string;
  reference: string;
  householdHead: string;
  householdSize: number | null;
  parcelId: string | null;
  displacementType: string;
  vulnerabilities: string[];
  baseline: Record<string, unknown>;
  entitlements: Entitlement[];
  compensationTotal: number | null;
  compensationPaidAt: string | null;
  livelihoodProgramme: string | null;
  livelihoodRestoredAt: string | null;
  status: string;
  censusDate: string | null;
  createdAt: string;
  updatedAt: string;
  vulnerable?: boolean;
  entitlementCount?: number;
  livelihoodRequired?: boolean;
}

export interface GrievanceSlaRule {
  acknowledgeDays: number;
  resolveDays: number;
  rationale: string;
}

export interface GrievanceRow {
  id: string;
  number: number;
  channel: string;
  isAnonymous: boolean;
  complainantName: string | null;
  complainantContact: string | null;
  papId: string | null;
  category: string;
  severity: string;
  description: string;
  locationId: string | null;
  receivedAt: string;
  acknowledgeDueAt: string | null;
  resolveDueAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  complainantSatisfied: boolean | null;
  status: string;
  assigneeId: string | null;
  obligationId: string | null;
  createdAt: string;
  /** derived by the API */
  sla: GrievanceSlaRule | null;
  daysToResolve: number | null;
  daysToAcknowledge: number | null;
  overdue: boolean;
  daysOverdue: number;
  daysUntilDue: number | null;
}

export interface StakeholderRow {
  id: string;
  name: string;
  organisation: string | null;
  category: string | null;
  influence: number;
  interest: number;
  contact: string | null;
  notes: string | null;
  quadrant: string;
}

export interface FeedbackPoint {
  point: string;
  raisedBy?: string | null;
  disposition?: string | null;
}

export interface EngagementRow {
  id: string;
  title: string;
  kind: string;
  engagementDate: string;
  location: string | null;
  stakeholderIds: string[];
  attendeeCount: number | null;
  summary: string | null;
  feedback: FeedbackPoint[];
  consentStatus: string | null;
  fileIds: string[];
  createdAt: string;
  stakeholderNames?: string[];
  feedbackCount?: number;
}

export interface RapProgress {
  parcels: {
    total: number;
    byStatus: Record<string, number>;
    areaSqm: number;
    acquired: number;
  };
  paps: { total: number; byStatus: Record<string, number>; households: number };
  physicallyDisplaced: number;
  economicallyDisplaced: number;
  vulnerableHouseholds: number;
  byVulnerability: Record<string, number>;
  compensationCommitted: number;
  compensationPaid: number;
  compensationOutstanding: number;
  compensation: {
    parcels: { committed: number; paid: number };
    paps: { committed: number; paid: number };
  };
  livelihoodRequired: number;
  livelihoodRestored: number;
  livelihoodRestoredPercent: number | null;
  readyForConstructionPercent: number | null;
  cutOffDate: string | null;
}

export interface ScheduleRiskItem {
  parcelId: string;
  reference: string;
  status: string;
  tenureType: string;
  ownerName: string | null;
  taskId: string;
  taskName: string;
  taskStart: string;
  daysUntilStart: number;
}

export interface ScheduleRisk {
  horizonDays: number;
  blockedTasks: number;
  blockedParcels: number;
  imminent: number;
  alreadyStarted: number;
  signalHorizonDays: number;
  items: ScheduleRiskItem[];
}

export interface GrievanceAnalytics {
  total: number;
  open: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  byChannel: Record<string, number>;
  byStatus: Record<string, number>;
  byMonth: Record<string, number>;
  byLocation: Record<string, number>;
  anonymousCount: number;
  anonymousShare: number | null;
  medianDaysToResolve: number | null;
  medianDaysToAcknowledge: number | null;
  openOverdue: number;
  slaComplianceRate: number | null;
  verifiedClosures: number;
  satisfactionRate: number | null;
  reopened: number;
}

export interface MatrixCell {
  influence: number;
  interest: number;
  quadrant: string;
  count: number;
  stakeholders: { id: string; name: string; organisation: string | null }[];
}

export interface MatrixResponse {
  size: number;
  grid: MatrixCell[];
  quadrants: Record<string, number>;
  total: number;
}

export interface CutOffResponse {
  cutOffDate: string | null;
  declaredAt: string | null;
  declaredBy: string | null;
  papsAfterCutOff: number;
}

export interface EngagementDetail extends EngagementRow {
  stakeholders: StakeholderRow[];
}

/* ------------------------- cross-module pickers ---------------------------- */

export interface ScheduleLite {
  id: string;
  name: string;
  isActive: number;
  projectStart: string;
}

export interface ScheduleTaskLite {
  id: string;
  name: string;
  startDate: string | null;
}

export interface TaskOption {
  id: string;
  name: string;
  scheduleName: string;
  startDate: string | null;
  isActiveSchedule: boolean;
}

export interface UserLite {
  id: string;
  name: string;
  email: string;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  source: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
}

/* ------------------------------- Presentation ------------------------------ */

/** Brand palette used by the hand-rolled SVG charts on this workspace. */
export const BRAND = "#1d60f1";
export const BRAND_SOFT = "#c3d5fd";
export const GRID = "#ebedf1";
export const AXIS_INK = "#7f8ea4";
export const RED = "#dc2626";
export const AMBER = "#d97706";
export const EMERALD = "#059669";

export function parcelTone(status: string): string {
  switch (status) {
    case "acquired":
      return "green";
    case "compensated":
      return "blue";
    case "agreed":
      return "violet";
    case "under_negotiation":
      return "amber";
    case "disputed":
      return "red";
    default:
      return "gray";
  }
}

export function papTone(status: string): string {
  switch (status) {
    case "livelihood_restored":
      return "green";
    case "resettled":
    case "compensated":
      return "blue";
    case "entitlement_agreed":
      return "violet";
    case "grievance_open":
      return "red";
    default:
      return "gray";
  }
}

export function severityTone(severity: string): string {
  switch (severity) {
    case "critical":
      return "red";
    case "high":
      return "amber";
    case "medium":
      return "blue";
    default:
      return "gray";
  }
}

export function grievanceStatusTone(status: string): string {
  switch (status) {
    case "closed_verified":
      return "green";
    case "resolved":
      return "blue";
    case "escalated":
      return "red";
    case "investigating":
    case "acknowledged":
      return "amber";
    case "rejected":
      return "gray";
    default:
      return "gray";
  }
}

export function consentTone(status: string | null): string {
  switch (status) {
    case "granted":
      return "green";
    case "conditional":
      return "amber";
    case "refused":
      return "red";
    case "pending":
      return "blue";
    default:
      return "gray";
  }
}

export function quadrantLabel(q: string): string {
  switch (q) {
    case "manage_closely":
      return "Manage closely";
    case "keep_satisfied":
      return "Keep satisfied";
    case "keep_informed":
      return "Keep informed";
    default:
      return "Monitor";
  }
}

export function fmtMoney(value: number | null | undefined, currency = "USD"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
}

export function fmtNum(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${fmtNum(value, value % 1 === 0 ? 0 : 1)}%`;
}

export function fmtShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${fmtNum(value * 100, 0)}%`;
}

/** Human phrasing for the schedule-risk countdown. */
export function startPhrase(days: number): string {
  if (days < 0) return `started ${Math.abs(days)}d ago`;
  if (days === 0) return "starts today";
  return `in ${days}d`;
}

/**
 * Monochromatic brand ramp for categorical splits that are not ordinal and
 * carry no good/bad valence — intake channels, stakeholder quadrants. One hue
 * keeps the page reading as a single system instead of a rainbow.
 */
export const BRAND_RAMP = [
  "#1d60f1",
  "#4a7ff4",
  "#6d92f7",
  "#8fabf9",
  "#a9c1fb",
  "#c3d5fd",
  "#d7e3fe",
  "#e8eefe",
] as const;

export function rampColor(index: number): string {
  return BRAND_RAMP[index % BRAND_RAMP.length] ?? BRAND;
}

/** The GRM lifecycle rail, in the order a grievance actually walks it (#572-573). */
export const GRIEVANCE_RAIL = [
  "received",
  "acknowledged",
  "investigating",
  "resolved",
  "closed_verified",
] as const;

/**
 * How far along the rail a grievance has travelled. `escalated` and
 * `rejected` sit off the rail, so they report the last rail state reached
 * rather than pretending to be one of the five.
 */
export function railIndex(g: {
  status: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}): number {
  if (g.status === "closed_verified") return 4;
  if (g.status === "resolved" || g.resolvedAt) return 3;
  if (g.status === "investigating" || g.status === "escalated") return 2;
  if (g.status === "acknowledged" || g.acknowledgedAt) return 1;
  return 0;
}

/** Phrasing + tone for the resolve-due countdown badge. */
export function dueBadge(g: {
  overdue: boolean;
  daysOverdue: number;
  daysUntilDue: number | null;
  resolvedAt: string | null;
  daysToResolve: number | null;
}): { label: string; tone: string } {
  if (g.overdue) return { label: `${g.daysOverdue}d overdue`, tone: "red" };
  if (g.resolvedAt) {
    return {
      label: g.daysToResolve === null ? "Resolved" : `Resolved in ${fmtNum(g.daysToResolve, 1)}d`,
      tone: "green",
    };
  }
  if (g.daysUntilDue === null) return { label: "No deadline", tone: "gray" };
  if (g.daysUntilDue === 0) return { label: "Due today", tone: "amber" };
  return { label: `${g.daysUntilDue}d left`, tone: g.daysUntilDue <= 3 ? "amber" : "blue" };
}

/**
 * Decimal degrees with a hemisphere letter. No map tiles are bundled, so the
 * drawer shows the coordinate plainly and hands it to whatever mapping tool
 * the surveyor actually uses.
 */
export function fmtLatLng(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}
