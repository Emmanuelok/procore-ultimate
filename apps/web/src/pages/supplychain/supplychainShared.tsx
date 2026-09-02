/**
 * SUPPLY CHAIN workspace — the shared vocabulary (spec Vol II Domain U
 * #913–947; Vol I §5.4 #719–730).
 *
 * Types mirror `apps/api/src/modules/supplychain/*` exactly. The rules every
 * tab obeys:
 *
 *  1. A figure the API could not derive is `{ value: null, reasons }` and is
 *     rendered as "Not available" WITH the server's reasons, never as 0.
 *  2. Money is bucketed per currency and never added across currencies.
 *  3. Every panel loads, fails and empties on its own.
 *  4. Every computed verdict (risk level, order-by date, chain completeness,
 *     on-time %) is shown next to the basis the engine used.
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

export interface NodeRow {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  tier: number;
  country: string | null;
  city: string | null;
  criticality: string;
  categories: string[];
  vendorId: string | null;
  entityId: string | null;
  commitmentId: string | null;
  annualValue: number | null;
  currency: string;
  leadTimeDays: number | null;
  status: string;
  notes: string | null;
  riskLevel: string | null;
  riskScore: number | null;
  riskAssessedAt: string | null;
  createdAt: string;
}

export interface LinkRow {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  description: string | null;
  category: string | null;
  isSoleSource: number;
  leadTimeDays: number | null;
  value: number | null;
  currency: string | null;
}

export interface MapResponse {
  nodes: NodeRow[];
  links: LinkRow[];
  stats: {
    nodes: number;
    links: number;
    maxTier: number;
    byTier: Record<string, number>;
    byCountry: Record<string, number>;
    byCriticality: Record<string, number>;
    byRiskLevel: Record<string, number>;
    soleSourceLinks: number;
    lastRiskRunAt: string | null;
  };
}

export interface RiskFlag {
  code: string;
  severity: string;
  detail: string;
  basis: string;
  points: number;
}

export interface AssessmentRow {
  id: string;
  nodeId: string;
  assessedAt: string;
  score: number | null;
  level: string;
  flags: RiskFlag[];
  inputs: Record<string, unknown>;
  basis: string;
  signalIds: string[];
}

export interface NodeDetail extends NodeRow {
  upstream: LinkRow[];
  downstream: LinkRow[];
  longLeadItems: Array<{ id: string; reference: string; name: string; status: string; riskLevel: string; requiredOnSite: string | null }>;
  assessments: AssessmentRow[];
  latestAssessment: AssessmentRow | null;
}

export interface LongLeadAssessment {
  orderByDate: string | null;
  expectedOnSite: string | null;
  expectedOnSiteBasis: string;
  floatDays: number | null;
  riskLevel: string;
  reasons: string[];
  orderLatenessDays: number | null;
}

export interface LongLeadRow {
  id: string;
  number: number;
  reference: string;
  name: string;
  description: string | null;
  category: string | null;
  supplierNodeId: string | null;
  vendorId: string | null;
  commitmentId: string | null;
  purchaseOrderRef: string | null;
  materialItemId: string | null;
  scheduleTaskId: string | null;
  scheduleTaskName: string | null;
  requiredOnSite: string | null;
  requiredFromSchedule: number;
  leadTimeDays: number;
  bufferDays: number;
  orderByDate: string | null;
  floatDays: number | null;
  riskLevel: string;
  riskReasons: string[];
  riskAssessedAt: string | null;
  plannedOrderDate: string | null;
  actualOrderDate: string | null;
  plannedProductionStart: string | null;
  actualProductionStart: string | null;
  plannedShipDate: string | null;
  actualShipDate: string | null;
  plannedArrivalDate: string | null;
  forecastArrivalDate: string | null;
  actualArrivalDate: string | null;
  customsRequired: number;
  customsClearedAt: string | null;
  installedAt: string | null;
  status: string;
  quantity: number | null;
  unit: string | null;
  value: number | null;
  currency: string;
  incoterms: string | null;
  originCountry: string | null;
  expeditingOwnerId: string | null;
  lastExpeditedAt: string | null;
  expeditingCount: number;
  signalId: string | null;
  createdAt: string;
  assessment?: LongLeadAssessment;
}

export interface ExpeditingLogRow {
  id: string;
  action: string;
  note: string | null;
  contactName: string | null;
  promisedDate: string | null;
  loggedBy: string;
  loggedAt: string;
}

export interface LongLeadDetail extends LongLeadRow {
  assessment: LongLeadAssessment;
  expeditingLog: ExpeditingLogRow[];
  task: { id: string; name: string; startDate: string | null; actualStart: string | null; isCritical: boolean } | null;
  supplierNode: NodeRow | null;
  obligationId: string | null;
}

export interface UnitRollup {
  stagesTotal: number;
  stagesComplete: number;
  percentComplete: number;
  qaGatesTotal: number;
  qaGatesPassed: number;
  qaGatesFailed: number;
  qaGatesPending: number;
  readyToShip: boolean;
  onQaHold: boolean;
  reasons: string[];
}

export interface UnitRow {
  id: string;
  number: number;
  reference: string;
  name: string;
  unitType: string;
  serialNumber: string | null;
  designReference: string | null;
  factoryNodeId: string | null;
  vendorId: string | null;
  longLeadItemId: string | null;
  locationId: string | null;
  scheduleTaskId: string | null;
  status: string;
  stagesTotal: number;
  stagesComplete: number;
  percentComplete: number;
  qaGatesTotal: number;
  qaGatesPassed: number;
  qaGatesFailed: number;
  plannedProductionStart: string | null;
  plannedProductionEnd: string | null;
  actualProductionStart: string | null;
  actualProductionEnd: string | null;
  plannedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  installedAt: string | null;
  vestingCertificateFileId: string | null;
  vestingCertifiedAt: string | null;
  titleTransferredAt: string | null;
  storageLocationText: string | null;
  storageInsuredUntil: string | null;
  storageInspectedAt: string | null;
  value: number | null;
  currency: string;
  percentVerifiedForPayment: number | null;
  verifiedForPaymentBy: string | null;
  verifiedForPaymentAt: string | null;
  deliverySlotId: string | null;
  transportKm: number | null;
  weightTonnes: number | null;
  createdAt: string;
  rollup?: UnitRollup;
}

export interface StageRow {
  id: string;
  unitId: string;
  position: number;
  name: string;
  status: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  completedBy: string | null;
  isQaGate: number;
  qaResult: string;
  qaVerifiedBy: string | null;
  qaVerifiedAt: string | null;
  qaNotes: string | null;
  evidenceFileIds: string[];
}

export interface InspectionRow {
  id: string;
  unitId: string | null;
  longLeadItemId: string | null;
  nodeId: string | null;
  kind: string;
  title: string;
  scheduledFor: string | null;
  performedAt: string | null;
  inspectorId: string | null;
  inspectorName: string | null;
  result: string;
  findings: string | null;
  percentVerified: number | null;
  fileIds: string[];
  createdAt: string;
}

export interface UnitDetail extends UnitRow {
  stages: StageRow[];
  inspections: InspectionRow[];
  rollup: UnitRollup;
  verifiedForPayment: { percent: number | null; inspectionCount: number; reasons: string[] };
  task: { id: string; name: string; startDate: string | null; actualStart: string | null; isCritical: boolean } | null;
  factoryNode: NodeRow | null;
  traceRecords: Array<{ id: string; reference: string; description: string; status: string; chainComplete: number }>;
  allowedTransitions: string[];
}

export interface GateRow {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  opensAt: string;
  closesAt: string;
  concurrentSlots: number;
  slotMinutes: number;
  maxVehicleType: string | null;
  craneAvailable: number;
  laydownAreas: string[];
  status: string;
}

export interface SlotRow {
  id: string;
  number: number;
  reference: string;
  gateId: string;
  gateName?: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  description: string;
  supplierNodeId: string | null;
  vendorId: string | null;
  longLeadItemId: string | null;
  offsiteUnitId: string | null;
  materialDeliveryId: string | null;
  scheduleTaskId: string | null;
  vehicleType: string;
  vehicleRegistration: string | null;
  haulierName: string | null;
  driverName: string | null;
  driverPhone: string | null;
  craneRequired: number;
  craneMinutes: number | null;
  laydownArea: string | null;
  arrivedAt: string | null;
  unloadingStartedAt: string | null;
  completedAt: string | null;
  waitingMinutes: number | null;
  wasOnTime: number | null;
  lateMinutes: number | null;
  issueKind: string;
  issueNotes: string | null;
  transportMode: string;
  originText: string | null;
  originCountry: string | null;
  transportKm: number | null;
  loadTonnes: number | null;
  carbonKgCo2e: number | null;
  carbonBasis: string | null;
  carbonEntryId: string | null;
  bookedBy: string;
  createdAt: string;
}

export interface SlotDetail extends SlotRow {
  gate: GateRow | null;
  supplierNode: { id: string; name: string } | null;
  longLeadItem: { id: string; reference: string; name: string; status: string } | null;
  offsiteUnit: { id: string; reference: string; name: string; status: string } | null;
  carbonEstimate: { kgCo2e: number | null; basis: string; reasons: string[] };
}

export interface FreeWindow {
  startsAt: string;
  endsAt: string;
  freeBays: number;
  craneFree: boolean;
}

export interface AvailabilityResponse {
  gate: GateRow;
  date: string;
  windows: FreeWindow[];
  booked: Array<{ id: string; reference?: string; startsAt: string; endsAt: string; craneRequired: boolean; status: string }>;
  note: string;
}

export interface OnTimeStats {
  completed: number;
  onTime: number;
  late: number;
  noShow: number;
  onTimePercent: number | null;
  averageLateMinutes: number | null;
  averageWaitingMinutes: number | null;
  reasons: string[];
}

export interface OnTimeResponse {
  from: string | null;
  to: string | null;
  overall: OnTimeStats;
  bySupplier: Array<OnTimeStats & { key: string; name: string }>;
  byHaulier: Array<OnTimeStats & { key: string }>;
  byGate: Array<OnTimeStats & { key: string }>;
  issues: Record<string, number>;
  carbon: { kgCo2e: number | null; deliveriesWithDistance: number; deliveriesWithoutDistance: number; reasons: string[]; basis: string };
  method: string;
}

export interface TraceCertificate {
  id: string;
  kind: string;
  reference: string;
  fileId?: string | null;
  issuedBy?: string | null;
  issuedAt?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  addedBy?: string;
  addedAt?: string;
}

export interface ChainCompleteness {
  complete: boolean;
  score: number;
  gaps: string[];
  links: {
    identifier: boolean;
    provenance: boolean;
    certificate: boolean;
    certificateVerified: boolean;
    conformityMarking: boolean | null;
    installed: boolean;
  };
}

export interface TraceRow {
  id: string;
  number: number;
  reference: string;
  description: string;
  materialType: string | null;
  heatNumber: string | null;
  batchNumber: string | null;
  lotNumber: string | null;
  serialNumber: string | null;
  quantity: number | null;
  unit: string | null;
  supplierNodeId: string | null;
  vendorId: string | null;
  manufacturer: string | null;
  originCountry: string | null;
  materialItemId: string | null;
  materialDeliveryLineId: string | null;
  deliverySlotId: string | null;
  longLeadItemId: string | null;
  offsiteUnitId: string | null;
  certificates: TraceCertificate[];
  certificateCount: number;
  conformityMarking: string | null;
  responsibleSourcingScheme: string | null;
  status: string;
  receivedAt: string | null;
  installedAt: string | null;
  installedLocationId: string | null;
  installedRef: string | null;
  installedBy: string | null;
  chainComplete: number;
  chainGaps: string[];
  detail: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  chain?: ChainCompleteness;
}

export interface TraceCoverage {
  records: number;
  complete: number;
  installed: number;
  installedWithoutCertificate: number;
  completenessPercent: number | null;
  reasons: string[];
  byStatus: Record<string, number>;
  byMaterialType: Array<{ materialType: string; records: number; complete: number; installed: number; installedWithoutCertificate: number; completenessPercent: number | null }>;
  installedWithoutCertificateItems: Array<{ id: string; reference: string; description: string; installedLocationId: string | null }>;
  openGaps: Array<{ id: string; reference: string; description: string; status: string; gaps: string[] }>;
}

export interface ConcentrationBucket {
  country: string;
  nodes: number;
  criticalNodes: number;
  share: number;
}

export interface RiskResponse {
  items: Array<{
    nodeId: string;
    name: string;
    tier: number;
    country: string | null;
    criticality: string;
    vendorId: string | null;
    entityId: string | null;
    status: string;
    level: string;
    score: number | null;
    assessedAt: string | null;
    flags: RiskFlag[];
    basis: string | null;
    inputs: Record<string, unknown> | null;
    signalIds: string[];
  }>;
  summary: Record<string, number>;
  concentration: { byCountry: ConcentrationBucket[]; flagged: ConcentrationBucket[]; threshold: number; reasons: string[] };
  lastRunAt: string | null;
  reasons: string[];
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

export interface JitConflict {
  kind: string;
  severity: string;
  key: string;
  taskId: string;
  taskName: string;
  sourceType: string;
  sourceId: string;
  sourceRef: string;
  title: string;
  explanation: string;
  daysDelta: number | null;
}

export interface JitResponse {
  asOf: string;
  items: JitConflict[];
  total: number;
  byKind: Record<string, number>;
  method: string;
}

export interface Summary {
  asOf: string;
  /** registers the roll-up had to cap; empty when every figure is the whole truth */
  truncated?: string[];
  map: { nodes: number; links: number; tiers: number; countries: number; soleSourceLinks: number; byRiskLevel: Record<string, number>; lastRiskRunAt: string | null };
  longLead: {
    total: number;
    open: number;
    byRisk: Record<string, number>;
    late: number;
    atRisk: number;
    watch: number;
    notAssessable: number;
    orderByWithin14Days: number;
    expeditingBacklog: number;
    expeditingBacklogItems: Array<{ id: string; reference: string; name: string; status: string; lastExpeditedAt: string | null }>;
    valueByCurrency: Record<string, number>;
    currencyNote: string | null;
  };
  deliveries: {
    total: number;
    upcoming: number;
    completed: number;
    onTimePercent: Figure;
    averageLateMinutes: number | null;
    averageWaitingMinutes: number | null;
    noShows: number;
    withIssues: number;
    transportCarbonKgCo2e: Figure;
  };
  offsite: {
    units: number;
    byStatus: Record<string, number>;
    inFactory: number;
    qaHold: number;
    averagePercentComplete: Figure;
    averagePercentVerified: Figure;
    valueInFactoryByCurrency: Record<string, number>;
    readyToShipUninsured: number;
  };
  traceability: { records: number; complete: number; installed: number; installedWithoutCertificate: number; completenessPercent: number | null; reasons: string[] };
  signals: { open: number; bySeverity: Record<string, number>; items: SignalRow[] };
}

export interface HealthInputs {
  metrics: Record<string, number | null>;
  reasons: string[];
}

/* Lookups from neighbouring registers */
export interface VendorOption {
  id: string;
  name: string;
}
export interface TaskOption {
  id: string;
  name: string;
  startDate: string | null;
  isCritical: number;
}
export interface LocationOption {
  id: string;
  name: string;
}
export interface MaterialOption {
  id: string;
  reference: string;
  name: string;
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

/** Site clock (UTC) HH:MM of a timestamp. */
export function siteTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(11, 16);
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

export function daysFromToday(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const a = Date.parse(`${today()}T00:00:00Z`);
  const b = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export const LONG_LEAD_RISK_TONE: Record<string, Tone> = {
  on_track: "success",
  watch: "info",
  at_risk: "warning",
  late: "danger",
  not_assessable: "neutral",
};

export const SUPPLIER_RISK_TONE: Record<string, Tone> = {
  low: "success",
  medium: "info",
  high: "warning",
  critical: "danger",
  not_assessable: "neutral",
  not_assessed: "neutral",
};

export const LONG_LEAD_STATUS_TONE: Record<string, Tone> = {
  identified: "neutral",
  requisitioned: "info",
  ordered: "info",
  in_production: "info",
  shipped: "highlight",
  in_customs: "warning",
  arrived: "success",
  installed: "success",
  cancelled: "neutral",
};

export const UNIT_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  in_design: "info",
  in_production: "info",
  qa_hold: "danger",
  passed_qa: "success",
  ready_to_ship: "highlight",
  in_transit: "highlight",
  delivered: "success",
  installed: "success",
  rejected: "danger",
};

export const SLOT_STATUS_TONE: Record<string, Tone> = {
  requested: "neutral",
  confirmed: "info",
  arrived: "highlight",
  unloading: "highlight",
  completed: "success",
  no_show: "danger",
  cancelled: "neutral",
};

export const TRACE_STATUS_TONE: Record<string, Tone> = {
  received: "neutral",
  certified: "info",
  quarantined: "warning",
  installed: "success",
  rejected: "danger",
};

export const SEVERITY_TONE: Record<string, Tone> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const CRITICALITY_TONE: Record<string, Tone> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

export const MILESTONE_ORDER = ["requisitioned", "ordered", "production_started", "shipped", "customs_cleared", "arrived", "installed"] as const;

/** The next milestones an item may record, given the lifecycle rules in the engine. */
export function nextMilestones(status: string, customsRequired: boolean): string[] {
  switch (status) {
    case "identified":
      return ["requisitioned", "ordered"];
    case "requisitioned":
      return ["ordered"];
    case "ordered":
      return ["production_started"];
    case "in_production":
      return ["shipped"];
    case "shipped":
      return customsRequired ? ["customs_cleared", "arrived"] : ["arrived", "customs_cleared"];
    case "in_customs":
      return ["arrived"];
    case "arrived":
      return ["installed"];
    default:
      return [];
  }
}

export const EXPECTED_BASIS_LABEL: Record<string, string> = {
  actual_arrival: "actual arrival",
  forecast: "supplier forecast",
  planned_arrival: "planned arrival",
  order_plus_lead: "order date + lead time",
  today_plus_lead: "if ordered today + lead time",
  none: "no basis",
};

export const DETECTOR_LABEL: Record<string, string> = {
  supply_long_lead_late: "Long-lead late",
  supply_long_lead_at_risk: "Long-lead at risk",
  supply_jit_conflict: "Just-in-time conflict",
  supply_single_source_critical: "Single source",
  supply_country_concentration: "Country concentration",
  supply_financial_distress: "Financial distress",
  supply_sanctions: "Screening hit",
  supply_offsite_qa_failed: "Offsite QA failed",
  supply_delivery_no_show: "Delivery no-show",
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

/** Pickers from neighbouring registers. Each fails alone; a failed lookup is an empty list plus a note. */
export function useLookups(projectId: string) {
  const vendors = useResource<ListResponse<VendorOption>>("/api/v1/vendors?pageSize=200");
  const schedules = useResource<ListResponse<{ id: string; isActive: number }>>(`/api/v1/projects/${projectId}/schedules?pageSize=5`);
  const active = schedules.data?.items.find((s) => s.isActive === 1) ?? schedules.data?.items[0] ?? null;
  const schedule = useResource<{ tasks: TaskOption[] }>(active ? `/api/v1/projects/${projectId}/schedules/${active.id}` : null);
  const locations = useResource<ListResponse<LocationOption> | LocationOption[]>(`/api/v1/projects/${projectId}/locations`);
  const materials = useResource<ListResponse<MaterialOption>>(`/api/v1/projects/${projectId}/materials?pageSize=200`);
  const locationItems: LocationOption[] = Array.isArray(locations.data) ? locations.data : (locations.data?.items ?? []);
  return {
    vendors: vendors.data?.items ?? [],
    tasks: schedule.data?.tasks ?? [],
    locations: locationItems,
    materials: materials.data?.items ?? [],
    notes: [
      vendors.error ? `Vendors could not be loaded: ${vendors.error}` : null,
      schedules.error ? `Schedule could not be loaded: ${schedules.error}` : null,
      schedule.error ? `Schedule tasks could not be loaded: ${schedule.error}` : null,
      locations.error ? `Locations could not be loaded: ${locations.error}` : null,
      materials.error ? `Materials could not be loaded: ${materials.error}` : null,
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

/** A figure the platform could not compute: "Not available" + the reasons, never a dash and never zero. */
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
    <Tooltip content={reasons.length > 0 ? reasons.join(" ") : "The platform holds no inputs for this figure."}>
      {chip}
    </Tooltip>
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
        <p className="text-2xs text-content-muted">{note ?? (buckets.length > 1 ? "Reported per currency and never added. A single total would need an FX rate and a date." : "Nothing on this screen adds one currency to another.")}</p>
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
            <dd className="truncate text-meta text-content">{i.value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function optionList<T extends { id: string }>(items: T[], label: (item: T) => string, emptyLabel = "— none —") {
  return [{ value: "", label: emptyLabel }, ...items.map((i) => ({ value: i.id, label: label(i) }))];
}
