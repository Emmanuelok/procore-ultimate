/**
 * Shared types + helpers for the digital-twin workspace (spec Domain L).
 * Mirrors the contracts served by apps/api/src/modules/twin.
 */

export interface Asset {
  id: string;
  tagCode: string;
  name: string;
  category: string | null;
  classificationSystem: string | null;
  classificationCode: string | null;
  parentId: string | null;
  locationId: string | null;
  ownerId: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  installedAt: string | null;
  commissionedAt: string | null;
  decommissionedAt?: string | null;
  warrantyStart: string | null;
  warrantyMonths: number | null;
  expectedLifeYears: number | null;
  criticality: string;
  status: string;
  designBaseline?: Record<string, number> | null;
  attributes: Record<string, unknown>;
  createdAt: string;
}

/** A row of the asset register: the asset plus the counts the list computes. */
export interface AssetRow extends Asset {
  elementLinkCount: number;
  sensorCount: number;
  warranties: Array<{ endDate: string; status: string }>;
}

export interface AssetElementLink {
  id: string;
  assetId: string;
  globalId: string;
  modelVersionId: string | null;
}

export interface Warranty {
  id: string;
  assetId?: string;
  provider: string;
  description: string | null;
  startDate: string;
  endDate: string;
  status?: string;
  documentFileId?: string | null;
  obligationId?: string | null;
  notifiedDays?: number | null;
  expired?: boolean;
  daysRemaining?: number;
  assetName?: string;
  tagCode?: string;
}

export interface WarrantyClaim {
  id: string;
  warrantyId: string;
  assetId: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  lodgedAt: string | null;
  respondedAt: string | null;
  closedAt: string | null;
  resolution: string | null;
  assetName?: string;
  tagCode?: string;
  provider?: string;
}

export interface Sensor {
  id: string;
  projectId?: string;
  assetId: string | null;
  locationId: string | null;
  ownerId: string | null;
  externalId: string | null;
  name: string;
  kind: string;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
  designSetpoint: number | null;
  staleAfterMinutes: number | null;
  cooldownMinutes: number;
  lastReadingAt: string | null;
  lastValue: number | null;
  lastAlertAt: string | null;
  isActive: string;
}

export interface SensorOverviewRow extends Sensor {
  window: {
    hours: number;
    readings: number;
    avg: number | null;
    min: number | null;
    max: number | null;
    basis: string;
  };
  openAlerts: number;
  alertKinds: string[];
}

export interface SensorAlert {
  id: string;
  sensorId: string;
  assetId: string | null;
  kind: string;
  status: string;
  value: number | null;
  threshold: number | null;
  breachCount: number;
  firstBreachAt: string | null;
  lastBreachAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  clearedAt: string | null;
  notes: string | null;
  sensorName?: string;
  unit?: string;
  assetName?: string | null;
  assetTag?: string | null;
}

export interface AssetDetail extends Asset {
  location: { id: string; name: string; path: string } | null;
  elementLinks: AssetElementLink[];
  warranties: Warranty[];
  warrantyClaims: WarrantyClaim[];
  sensors: Sensor[];
  children: Array<{ id: string; tagCode: string; name: string; status: string }>;
  openAlerts: SensorAlert[];
}

export interface AssetTreeNode {
  id: string;
  tagCode: string;
  name: string;
  status: string;
  criticality: string;
  children: AssetTreeNode[];
}

export interface ReadingBucket {
  bucketStart: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface MilestoneContainerVerdict {
  id: string;
  label: string;
  kind: string;
  satisfied: boolean;
  reason: string;
  currentState: string | null;
  currentSuitability: string | null;
}

export interface DeliveryMilestone {
  id: string;
  name: string;
  dueDate: string | null;
  requiredState: string;
  requiredSuitability: string | null;
  description: string | null;
  status: string;
  containerCount?: number;
  overdue?: boolean;
  deliveredAt?: string | null;
  acceptedBy?: string | null;
  acceptedAt?: string | null;
  decisionNote?: string | null;
}

export interface MilestoneDetail extends DeliveryMilestone {
  containers: MilestoneContainerVerdict[];
  containersSatisfied: boolean;
}

export interface HandoverDimension {
  key: string;
  label: string;
  weight: number;
  populated: number;
  total: number;
  percent: number;
  basis: string;
  missingTagCodes: string[];
}

export interface HandoverReadiness {
  score: number | null;
  scoreBasis: string;
  assetsAssessed: number;
  dimensions: HandoverDimension[];
  blockers: string[];
  cobie: { completeness: number; errors: number; warnings: number };
  milestones: Record<string, number>;
}

export interface CobieValidation {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Array<{
    sheet: string;
    row: number | null;
    column: string | null;
    severity: string;
    message: string;
  }>;
  completeness: {
    score: number;
    fieldCoverage: Array<{ field: string; populated: number; total: number; percent: number }>;
    missingByComponent: Array<{ tagCode: string; missing: string[] }>;
  };
  sheets: Array<{ name: string; rows: number; reason: string | null }>;
}

export interface PerformanceRow {
  assetId: string | null;
  assetTag: string | null;
  assetName: string | null;
  sensorId: string;
  sensorName: string;
  kind: string;
  unit: string;
  designSetpoint: number | null;
  readings: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  lastValue: number | null;
  lastAt: string | null;
  gap: number | null;
  gapPercent: number | null;
  verdict: string;
  basis: string;
}

export interface TwinSummary {
  assets: Record<string, number>;
  assetsTotal: number;
  sensors: Record<string, number>;
  sensorsTotal: number;
  alerts: Record<string, number>;
  openAlerts: number;
  warranties: { total: number; active: number; expired: number; expiringWithin90Days: number };
  claims: Record<string, number>;
  openClaims: number;
  milestones: { total: number; accepted: number; overdue: number };
  elementLinks: number;
  geometryCoverage: number | null;
  geometryCoverageBasis: string;
  simulationAvailable: boolean;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* ------------------------------ lifecycles ------------------------------- */

/** Forward-only asset lifecycle (spec Domain L #627-629). */
export const ASSET_STATUSES = [
  "planned",
  "installed",
  "commissioned",
  "operational",
  "decommissioned",
] as const;

export function assetNextStatuses(current: string): string[] {
  const idx = ASSET_STATUSES.indexOf(current as (typeof ASSET_STATUSES)[number]);
  return idx < 0 ? [] : ASSET_STATUSES.slice(idx + 1);
}

export const MILESTONE_NEXT_STATUSES: Record<string, string[]> = {
  open: ["delivered"],
  delivered: ["accepted", "rejected"],
  rejected: ["delivered"],
  accepted: [],
};

export function criticalityTone(criticality: string): string {
  switch (criticality) {
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

export function assetStatusTone(status: string): string {
  switch (status) {
    case "planned":
      return "gray";
    case "installed":
      return "blue";
    case "commissioned":
      return "violet";
    case "operational":
      return "green";
    case "decommissioned":
      return "gray";
    default:
      return "gray";
  }
}

/** Compute the warranty end date from start + months (date-only ISO). */
export function warrantyEnd(start: string | null, months: number | null): string | null {
  if (!start || !months) return null;
  const d = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const whole = Math.floor(months);
  d.setUTCMonth(d.getUTCMonth() + whole);
  // fractional months → ~30-day remainder
  const frac = months - whole;
  if (frac > 0) d.setUTCDate(d.getUTCDate() + Math.round(frac * 30));
  return d.toISOString().slice(0, 10);
}

/* -------------------------------- sparkline ------------------------------- */

/**
 * SVG sparkline for sensor readings — polyline of hourly averages with
 * dashed min/max threshold lines so breaches are visible at a glance.
 */
export function Sparkline({
  buckets,
  minValue,
  maxValue,
  unit,
}: {
  buckets: ReadingBucket[];
  minValue: number | null;
  maxValue: number | null;
  unit: string;
}) {
  const W = 640;
  const H = 140;
  const PAD = { top: 12, right: 8, bottom: 16, left: 46 };

  if (buckets.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-ink-400">
        No readings in the selected window.
      </div>
    );
  }

  const values = buckets.flatMap((b) => [b.min, b.max]);
  if (minValue !== null) values.push(minValue);
  if (maxValue !== null) values.push(maxValue);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;

  const x = (i: number) =>
    PAD.left + (buckets.length === 1 ? 0.5 : i / (buckets.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const line = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.avg).toFixed(1)}`).join(" ");
  const band = [
    ...buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.max).toFixed(1)}`),
    ...[...buckets].reverse().map((b, i) => {
      const idx = buckets.length - 1 - i;
      return `${x(idx).toFixed(1)},${y(b.min).toFixed(1)}`;
    }),
  ].join(" ");

  const last = buckets[buckets.length - 1];
  const breached = buckets.some(
    (b) =>
      (maxValue !== null && b.max > maxValue) || (minValue !== null && b.min < minValue),
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full"
        role="img"
        aria-label="Sensor readings sparkline"
      >
        {/* min/max band */}
        <polygon points={band} fill="#3380fc" opacity={0.08} />
        {/* thresholds */}
        {maxValue !== null && (
          <>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(maxValue)}
              y2={y(maxValue)}
              stroke="#dc2626"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text x={PAD.left - 4} y={y(maxValue) + 3} textAnchor="end" fontSize={9} fill="#dc2626">
              {maxValue}
            </text>
          </>
        )}
        {minValue !== null && (
          <>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(minValue)}
              y2={y(minValue)}
              stroke="#d97706"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text x={PAD.left - 4} y={y(minValue) + 3} textAnchor="end" fontSize={9} fill="#d97706">
              {minValue}
            </text>
          </>
        )}
        {/* scale labels */}
        <text x={PAD.left - 4} y={PAD.top + 3} textAnchor="end" fontSize={9} fill="#7f8ea4">
          {hi.toFixed(1)}
        </text>
        <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" fontSize={9} fill="#7f8ea4">
          {lo.toFixed(1)}
        </text>
        {/* avg line */}
        <polyline points={line} fill="none" stroke="#1d60f1" strokeWidth={1.75} />
        {last && (
          <circle cx={x(buckets.length - 1)} cy={y(last.avg)} r={3} fill="#1d60f1" />
        )}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-4 bg-brand-600" /> hourly avg ({unit})
        </span>
        {maxValue !== null && (
          <span className="inline-flex items-center gap-1 text-red-600">
            <span className="h-0 w-4 border-t border-dashed border-red-600" /> max {maxValue}
          </span>
        )}
        {minValue !== null && (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <span className="h-0 w-4 border-t border-dashed border-amber-600" /> min {minValue}
          </span>
        )}
        {breached && (
          <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
            threshold breached
          </span>
        )}
      </div>
    </div>
  );
}
