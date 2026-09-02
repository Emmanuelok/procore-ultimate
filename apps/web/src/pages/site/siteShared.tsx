/**
 * SITE OPERATIONS workspace — the shared vocabulary (spec Vol II Z #1067–1084,
 * X #995–1003; Vol I §2.15 #471–478).
 *
 * Types mirror `apps/api/src/modules/site/*` exactly. The rules every tab
 * obeys:
 *
 *  1. A figure the API could not derive renders as "Not available" WITH the
 *     server's reasons, never as 0. An empty on-site register says WHY it is
 *     empty rather than implying the site is.
 *  2. Every panel loads, fails and empties on its own.
 *  3. Every computed verdict (adverse day, deviation verdict, progress
 *     result, ground finding) is shown next to the basis the engine used.
 *  4. Refusals are quoted, not swallowed: when the platform declines an
 *     action on purpose, the reason is what the user reads.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Badge, Tooltip } from "../../ui";
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

export interface RegisterPerson {
  personKey: string;
  personName: string;
  passId: string | null;
  workerId: string | null;
  vendorId: string | null;
  personKind: string | null;
  sinceAt: string | null;
  inside: boolean;
  lastEventAt: string;
  lastDirection: string;
  lastGate: string | null;
  entries: number;
  exits: number;
  refusals: number;
  completedMinutes: number;
  openMinutes: number | null;
  anomalies: string[];
}

export interface RegisterResponse {
  asOf: string;
  windowFrom: string;
  windowTo: string;
  onSite: RegisterPerson[];
  offSite: RegisterPerson[];
  headcount: number;
  byVendor: Record<string, number>;
  byPersonKind: Record<string, number>;
  eventsConsidered: number;
  refusedEvents: number;
  anomalyCount: number;
  overstays: RegisterPerson[];
  truncated: boolean;
  reasons: string[];
}

export interface InductionRow {
  id: string;
  personName: string;
  personKind: string;
  workerId: string | null;
  vendorId: string | null;
  inductionType: string;
  status: string;
  conductedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  topics: string[];
  scorePercent: number | null;
  passMark: number | null;
  revokeReason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface PassRow {
  id: string;
  inductionId: string | null;
  workerId: string | null;
  personName: string;
  personKind: string;
  vendorId: string | null;
  badgeCode: string;
  credentialType: string;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  zonesAllowed: string[];
  revokeReason: string | null;
  createdAt: string;
}

export interface GateEventRow {
  id: string;
  gateName: string;
  badgeCode: string | null;
  personName: string | null;
  personKind: string | null;
  direction: string;
  occurredAt: string;
  source: string;
  accepted: number;
  refusalReason: string | null;
  externalRef: string | null;
}

export interface MusterRow {
  id: string;
  reference: string;
  kind: string;
  musterPoint: string | null;
  declaredAt: string;
  status: string;
  expectedCount: number;
  accountedCount: number;
  unaccountedCount: number;
  unexpectedCount: number;
  durationSeconds: number | null;
  clearedAt: string | null;
  signalId: string | null;
  notes: string | null;
}

export interface MusterPerson {
  key: string;
  name: string;
  status: string;
  checkedInAt: string | null;
  onRegister: boolean;
  sinceAt: string | null;
}

export interface MusterReconciliation {
  expectedCount: number;
  accountedCount: number;
  unaccountedCount: number;
  unexpectedCount: number;
  present: MusterPerson[];
  accountedOffsite: MusterPerson[];
  unaccounted: MusterPerson[];
  unexpected: MusterPerson[];
  durationSeconds: number | null;
  clear: boolean;
  reasons: string[];
}

export interface MusterDetail extends MusterRow {
  expectedRegister: Array<{ key: string; name: string; passId: string | null; workerId: string | null; sinceAt: string | null }>;
  checkins: Array<{ id: string; personKey: string; personName: string; status: string; checkedInAt: string | null; unexpected: number }>;
  outstanding: Array<{ key: string; name: string; sinceAt: string | null }>;
}

export interface Precaution {
  item: string;
  required: boolean;
  done: boolean;
  note?: string;
}

export interface PermitRow {
  id: string;
  reference: string;
  permitType: string;
  title: string;
  description: string | null;
  status: string;
  locationDescription: string | null;
  vendorId: string | null;
  supervisorName: string | null;
  validFrom: string | null;
  validTo: string | null;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  closedAt: string | null;
  precautions: Precaution[];
  maxOccupancy: number | null;
  requiresGasTest: number;
  fireWatchMinutes: number | null;
  fireWatchCompletedAt: string | null;
  utilityScanId: string | null;
  createdAt: string;
}

export interface PermitEntryRow {
  id: string;
  permitId: string;
  personName: string;
  attendantName: string | null;
  enteredAt: string;
  expectedExitAt: string | null;
  exitedAt: string | null;
  status: string;
  gasReadings: Array<{ at: string; gas: string; value: number; unit: string; safe: boolean }>;
}

export interface PermitDetail extends PermitRow {
  openEntries: number;
  entries: PermitEntryRow[];
  overdueEntries: Array<{ id: string; personName: string; expectedExitAt: string; overdueMinutes: number; insideMinutes: number }>;
  transitions: Array<{ action: string; allowed: boolean; warnings?: string[]; reason?: string }>;
}

export interface ZoneRow {
  id: string;
  name: string;
  kind: string;
  permitId: string | null;
  ring: Array<[number, number]>;
  centreLat: number | null;
  centreLon: number | null;
  radiusM: number | null;
  status: string;
  severity: string;
  activeFrom: string | null;
  activeTo: string | null;
  description: string | null;
}

export interface LoneWorkerRow {
  id: string;
  personName: string;
  activity: string;
  locationDescription: string | null;
  startedAt: string;
  intervalMinutes: number;
  nextDueAt: string;
  lastCheckInAt: string | null;
  checkInCount: number;
  missedCount: number;
  status: string;
  contactName: string | null;
  contactPhone: string | null;
}

export interface LoneWorkerList extends ListResponse<LoneWorkerRow> {
  due: Array<{ id: string; personName: string; nextDueAt: string; lateMinutes: number; action: string; reason: string }>;
  asOf: string;
}

export interface WeatherObservationRow {
  id: string;
  observedOn: string;
  source: string;
  provider: string | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipitationMm: number | null;
  snowfallMm: number | null;
  windMeanKph: number | null;
  windGustKph: number | null;
  conditions: string | null;
  workStopped: number;
  hoursLost: number | null;
  adverse: number | null;
  adverseReasons: string[];
  notes: string | null;
}

export interface WeatherBaselineRow {
  id: string;
  name: string;
  source: string;
  contractRef: string | null;
  thresholds: Array<{ metric: string; comparator: string; value: number; label?: string }>;
  monthlyExpectedAdverseDays: Record<string, number>;
  isActive: number;
  notes: string | null;
}

export interface WeatherAnalysisRow {
  id: string;
  reference: string;
  baselineId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  daysInPeriod: number;
  daysObserved: number;
  observedAdverseDays: number | null;
  baselineAdverseDays: number | null;
  exceptionalDays: number | null;
  hoursLost: number | null;
  coveragePercent: number | null;
  byMonth: Array<{ month: string; days: number; observed: number; expected: number | null; exceptional: number | null; reasons: string[] }>;
  adverseDayDetail: Array<{ date: string; reasons: string[]; hoursLost: number | null; workStopped: boolean }>;
  reasons: string[];
  generatedAt: string;
  issuedAt: string | null;
  gapDates?: string[];
}

export interface WeatherAnalysisDetail extends WeatherAnalysisRow {
  baseline: WeatherBaselineRow | null;
  observations: Array<WeatherObservationRow & { verdict: { adverse: boolean; undetermined: boolean; reasons: string[]; undeterminedMetrics: string[] } }>;
}

export interface EnvironmentalEventRow {
  id: string;
  reference: string;
  category: string;
  detectedVia: string;
  occurredAt: string;
  magnitude: number | null;
  magnitudeUnit: string | null;
  thresholdValue: number | null;
  thresholdUnit: string | null;
  exceededThreshold: number;
  severity: string;
  status: string;
  sensorRef: string | null;
  impact: string | null;
  workStopped: number;
  stoppageMinutes: number | null;
  actionsTaken: string | null;
}

export interface FlightRow {
  id: string;
  reference: string;
  purpose: string;
  status: string;
  pilotName: string | null;
  aircraft: string | null;
  plannedFor: string | null;
  flownAt: string | null;
  durationMinutes: number | null;
  permissionStatus: string;
  permissionRef: string | null;
  imageCount: number | null;
  outputs: Array<{ kind: string; fileId?: string; ref?: string; note?: string }>;
}

export interface ScanRow {
  id: string;
  reference: string;
  name: string;
  method: string;
  status: string;
  capturedAt: string | null;
  capturedByName: string | null;
  setupCount: number | null;
  pointCountMillions: number | null;
  registrationStatus: string;
  registrationErrorMm: number | null;
  coordinateSystem: string | null;
  modelId: string | null;
}

export interface DeviationRow {
  id: string;
  reference: string;
  scanId: string;
  toleranceMm: number;
  elementCount: number;
  withinToleranceCount: number;
  marginalCount: number;
  outOfToleranceCount: number;
  maxDeviationMm: number | null;
  meanAbsDeviationMm: number | null;
  rmsDeviationMm: number | null;
  verdict: string;
  status: string;
  byZone: Array<{ zone: string; elements: number; outOfTolerance: number; maxDeviationMm: number | null; verdict: string }>;
  reasons: string[];
  generatedAt: string;
}

export interface TourRow {
  id: string;
  name: string;
  level: string | null;
  status: string;
  capturedAt: string | null;
  stationCount: number;
  coverageNotes: string | null;
}

export interface SurveyPointRow {
  id: string;
  pointRef: string;
  kind: string;
  easting: number | null;
  northing: number | null;
  elevation: number | null;
  lat: number | null;
  lon: number | null;
  coordinateSystem: string | null;
  method: string;
  accuracyMm: number | null;
  status: string;
  lastCheckedAt: string | null;
  lastDeltaMm: number | null;
  description: string | null;
}

export interface SettingOutRow {
  id: string;
  reference: string;
  description: string;
  elementRef: string | null;
  method: string;
  controlPointRefs: string[];
  toleranceMm: number | null;
  maxDeviationMm: number | null;
  setOutBy: string;
  setOutAt: string | null;
  checkedBy: string | null;
  checkedAt: string | null;
  approvedBy: string | null;
  status: string;
  rejectionReason: string | null;
}

export interface GeotechRow {
  id: string;
  reference: string;
  holeRef: string;
  kind: string;
  status: string;
  isBaseline: number;
  baselineInvestigationId: string | null;
  investigatedOn: string | null;
  depthM: number | null;
  waterStrikeDepthM: number | null;
  strata: Array<{ fromM: number; toM: number; description: string; soilType?: string; spt?: number; strengthKpa?: number }>;
  notes: string | null;
}

export interface GroundFindingRow {
  id: string;
  investigationId: string;
  category: string;
  severity: string;
  depthFromM: number | null;
  depthToM: number | null;
  baselineDescription: string | null;
  observedDescription: string;
  differsFromBaseline: number;
  varianceNotes: string | null;
  status: string;
  assessmentNotes: string | null;
  detectedAt: string;
}

export interface UtilityRow {
  id: string;
  serviceRef: string;
  utilityType: string;
  ownerName: string | null;
  specification: string | null;
  depthM: number | null;
  detectionMethod: string;
  confidence: string;
  status: string;
  markedOutAt: string | null;
  markValidUntil: string | null;
}

export interface StrikeRow {
  id: string;
  reference: string;
  occurredAt: string;
  utilityType: string;
  severity: string;
  status: string;
  locationDescription: string | null;
  operativeName: string | null;
  plantType: string | null;
  permitInPlace: number;
  scanCompleted: number;
  marksPresent: number;
  injuries: number;
  rootCause: string | null;
}

export interface StrikeList extends ListResponse<StrikeRow> {
  controls: { total: number; withPermit: number; withScan: number; withMarks: number };
}

export interface ProgressRow {
  id: string;
  reference: string;
  zoneName: string;
  workPackageRef: string | null;
  claimedPercent: number;
  observedPercent: number;
  variancePercent: number;
  method: string;
  observedAt: string;
  observedBy: string;
  claimantId: string;
  claimSourceType: string;
  result: string;
  confidence: number | null;
  independenceScore: number | null;
  signalId: string | null;
  assertionId: string;
  evidenceId: string;
  reconciliationId: string;
  notes: string | null;
}

export interface ProgressDetail extends ProgressRow {
  assertion: { value: number | null; basis: string; claimantId: string; assertedAt: string } | null;
  evidence: { kind: string; source: string; contentHash: string; independenceScore: number; provenance: unknown; metadata: Record<string, unknown> } | null;
  reconciliation: { method: string; result: string; variance: number | null; variancePercent: number | null; confidence: number | null; notes: string | null } | null;
}

export interface SignalRow {
  id: string;
  detector: string;
  severity: string;
  confidence: number;
  title: string;
  explanation: string;
  disposition: string;
  createdAt: string;
}

export interface Summary {
  asOf: string;
  register: { headcount: number; windowFrom: string; overstays: number; anomalies: number; refusedEvents: number; reasons: string[] };
  access: { activePasses: number; validInductions: number; expiringPasses: number };
  permits: { open: number; active: number; expired: number; byType: Record<string, number> };
  entries: { inside: number; overdue: number };
  loneWorkers: { active: number; overdue: number; escalated: number };
  zones: { active: number };
  weather: { observations: number; lastObservedOn: string | null; analyses: number; lastExceptionalDays: number | null };
  capture: { flights: number; scans: number; deviationsOutOfTolerance: number; toursPublished: number };
  ground: { investigations: number; openFindings: number; strikes: number; nearMisses: number };
  environmental: { open: number; exceedances: number };
  progress: { observations: number; overclaims: number; worstVariance: Figure };
  settingOut: { awaitingCheck: number };
  signals: { open: number };
}

export interface HealthInputs {
  metrics: Record<string, number | null>;
  reasons: string[];
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

export const EM_DASH = "—";
export const NOT_AVAILABLE = "Not available";

export const labelize = (value: string | null | undefined): string =>
  !value ? EM_DASH : value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function isoDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.slice(0, 10);
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function minutesLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return EM_DASH;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function relativeToNow(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const deltaMinutes = Math.round((parsed - Date.now()) / 60_000);
  const abs = Math.abs(deltaMinutes);
  const label = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return deltaMinutes >= 0 ? `in ${label}` : `${label} ago`;
}

/* ========================================================================== */
/* Tones                                                                       */
/* ========================================================================== */

export const SEVERITY_TONE: Record<string, Tone> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export const PERMIT_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  requested: "info",
  approved: "info",
  active: "success",
  suspended: "warning",
  closed: "neutral",
  expired: "danger",
  cancelled: "neutral",
  rejected: "danger",
};

export const PASS_STATUS_TONE: Record<string, Tone> = {
  active: "success",
  suspended: "warning",
  expired: "danger",
  revoked: "danger",
  lost: "warning",
};

export const INDUCTION_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  valid: "success",
  expired: "danger",
  revoked: "danger",
  failed: "danger",
};

export const ENTRY_STATUS_TONE: Record<string, Tone> = {
  inside: "info",
  exited: "success",
  overdue: "danger",
};

export const LONE_WORKER_TONE: Record<string, Tone> = {
  active: "info",
  completed: "success",
  overdue: "warning",
  escalated: "danger",
  cancelled: "neutral",
};

export const ZONE_STATUS_TONE: Record<string, Tone> = {
  planned: "neutral",
  active: "danger",
  lifted: "success",
  cancelled: "neutral",
};

export const DEVIATION_TONE: Record<string, Tone> = {
  within_tolerance: "success",
  marginal: "warning",
  out_of_tolerance: "danger",
  not_assessable: "neutral",
};

export const RECONCILIATION_TONE: Record<string, Tone> = {
  supported: "success",
  partially_supported: "warning",
  unsupported: "danger",
  contradicted: "danger",
  insufficient_evidence: "neutral",
};

export const GROUND_STATUS_TONE: Record<string, Tone> = {
  open: "warning",
  assessed: "info",
  accepted: "neutral",
  claimed: "danger",
  closed: "success",
};

export const UTILITY_CONFIDENCE_TONE: Record<string, Tone> = {
  verified: "success",
  probable: "info",
  indicative: "warning",
  unknown: "danger",
};

export const SETTING_OUT_TONE: Record<string, Tone> = {
  draft: "neutral",
  set_out: "info",
  checked: "success",
  approved: "success",
  rejected: "danger",
};

export const DETECTOR_LABEL: Record<string, string> = {
  site_muster_unaccounted: "Muster: unaccounted",
  site_permit_expired_open: "Permit lapsed while open",
  site_confined_space_overdue: "Overdue out of a permitted space",
  site_lone_worker_overdue: "Lone worker check-in missed",
  site_pass_without_induction: "Pass without a valid induction",
  site_overstay: "Overstay on the register",
  site_exceptional_weather: "Exceptional weather",
  site_scan_out_of_tolerance: "Scan out of tolerance",
  site_ground_condition_change: "Ground differs from baseline",
  site_utility_strike: "Utility strike",
  site_excavation_without_scan: "Excavation without a survey",
  site_environmental_threshold: "Environmental threshold exceeded",
  site_progress_overclaim: "Progress overclaim",
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
export function useSiteLookups(projectId: string) {
  const vendors = useResource<ListResponse<{ id: string; name: string }>>("/api/v1/vendors?pageSize=200");
  const locations = useResource<ListResponse<{ id: string; name: string }> | Array<{ id: string; name: string }>>(
    `/api/v1/projects/${projectId}/locations`,
  );
  const workers = useResource<ListResponse<{ id: string; fullName: string; reference: string }>>(
    `/api/v1/projects/${projectId}/workers?pageSize=200`,
  );
  const locationItems = Array.isArray(locations.data) ? locations.data : (locations.data?.items ?? []);
  return {
    vendors: vendors.data?.items ?? [],
    locations: locationItems,
    workers: workers.data?.items ?? [],
    notes: [
      vendors.error ? `Vendors could not be loaded: ${vendors.error}` : null,
      locations.error ? `Locations could not be loaded: ${locations.error}` : null,
      workers.error ? `The labour register could not be loaded: ${workers.error}` : null,
    ].filter((x): x is string => Boolean(x)),
  };
}

export type SiteLookups = ReturnType<typeof useSiteLookups>;

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

export function RefusalNotice({ refusal, onDismiss }: { refusal: Refusal; onDismiss?: () => void }) {
  return (
    <Alert
      tone={refusal.deliberate ? "warning" : "danger"}
      title={refusal.deliberate ? "The platform refused this — deliberately" : "That did not complete"}
      onDismiss={onDismiss}
    >
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

export const enumOptions = (values: readonly string[]) => values.map((v) => ({ value: v, label: labelize(v) }));
