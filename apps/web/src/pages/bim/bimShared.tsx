/**
 * Shared types + ISO 19650 helpers for the BIM pages.
 * Mirrors the contracts served by apps/api/src/modules/bim.
 */

export interface QualityFinding {
  check: string;
  count: number;
  severity: "info" | "warning" | "blocking";
  detail: string;
}

export interface QualityReport {
  computedAt: string;
  elementCount: number;
  spatialCount: number;
  findings: QualityFinding[];
  passed: boolean;
  notes: string[];
}

export interface ModelVersion {
  id: string;
  modelId: string;
  version: number;
  fileId: string;
  cdeState: string;
  suitability: string;
  processing: string;
  elementCount: number;
  spatialCount?: number;
  processingError?: string | null;
  processedAt?: string | null;
  sizeBytes?: number | null;
  authorisedBy?: string | null;
  authorisedAt?: string | null;
  authorisationNote?: string | null;
  qualityReport?: QualityReport | null;
  uploadedBy?: string;
  createdAt?: string;
}

export interface BimModel {
  id: string;
  name: string;
  discipline: string;
  format: string;
  currentVersionId: string | null;
  currentVersion?: ModelVersion | null;
  latestVersion?: ModelVersion | null;
  versionCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface BimModelDetail extends BimModel {
  versions: ModelVersion[];
}

export interface BimElement {
  id: string;
  modelVersionId: string;
  globalId: string;
  ifcType: string;
  name: string | null;
  classification?: string | null;
  typeName?: string | null;
  storey?: string | null;
  locationId?: string | null;
  properties?: Record<string, unknown>;
  minX?: number | null;
}

export interface ElementTypeCount {
  ifcType: string;
  count: number;
}

export interface FederationMember {
  id: string;
  groupId: string;
  modelVersionId: string;
  modelId: string;
  modelName: string;
  discipline: string;
  version: number;
  processing?: string;
  elementCount?: number;
}

export interface FederationGroup {
  id: string;
  name: string;
  createdAt?: string;
  members: FederationMember[];
  clashTests?: { id: string; name: string }[];
}

export interface CoordinationIssue {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  discipline: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  createdByName?: string | null;
  dueDate: string | null;
  elementGlobalIds: string[];
  modelVersionId: string | null;
  rfiId?: string | null;
  source?: string;
  overdue?: boolean;
  resolvedAt?: string | null;
  verifiedAt?: string | null;
  createdAt: string;
}

export interface IssueComment {
  id: string;
  issueId: string;
  body: string;
  mentions: string[];
  authorId: string;
  authorName?: string | null;
  createdAt: string;
}

export interface IssueDetail extends CoordinationIssue {
  comments: IssueComment[];
  rfi: { id: string; number: number; subject: string; status: string } | null;
  nextStatuses: string[];
}

export interface ClashTest {
  id: string;
  name: string;
  federationId: string | null;
  ruleKind: string;
  toleranceMm: number;
  clearanceMm: number;
  state: string;
  lastRunAt: string | null;
  lastError: string | null;
  lastResult: Record<string, number>;
  counts?: Record<string, number>;
}

export interface ClashResult {
  id: string;
  testId: string;
  fingerprint: string;
  kind: string;
  status: string;
  globalIdA: string;
  nameA: string | null;
  ifcTypeA: string | null;
  disciplineA: string | null;
  globalIdB: string;
  nameB: string | null;
  ifcTypeB: string | null;
  disciplineB: string | null;
  penetrationMm: number | null;
  distanceMm: number | null;
  storey: string | null;
  issueId: string | null;
  notes: string | null;
}

export interface ElementLink {
  id: string;
  linkType: string;
  globalId: string;
  targetId: string;
  role: string;
  quantity: number | null;
  unit: string | null;
}

export interface FourDTask {
  id: string;
  name: string;
  startDate: string | null;
  finishDate: string | null;
  percentComplete: number;
  isCritical: number;
  elementCount: number;
  globalIds: string[];
  roles: string[];
}

export interface FiveDLine {
  id: string;
  costCode: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  revisedBudget: number;
  elementCount: number;
  modelQuantity: number | null;
  modelQuantityUnit: string | null;
  quantityBasis: string;
  variance: number | null;
}

export interface RealityCapture {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  status: string;
  capturedAt: string | null;
  modelVersionId: string | null;
  coveragePercent: number | null;
  viewerUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  withinTolerancePercent: number | null;
  deviation: {
    sampleCount: number;
    meanMm: number;
    maxMm: number;
    toleranceMm: number;
    withinTolerance: number;
  } | null;
}

export interface Geofence {
  id: string;
  name: string;
  purpose: string;
  description: string | null;
  ring: Array<[number, number]>;
  colour: string | null;
  isActive: number;
  areaM2?: number | null;
  featureCount?: number;
}

export interface MapFeature {
  id: string;
  kind: string;
  label: string;
  latitude: number;
  longitude: number;
  at?: string | null;
  geofenceIds: string[];
  meta?: Record<string, unknown>;
}

export interface MapData {
  project: {
    id: string;
    name: string;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
  };
  centre: { latitude: number; longitude: number } | null;
  centreBasis: string;
  geofences: Geofence[];
  features: MapFeature[];
  coverage: Record<string, { located: number; total: number }>;
  outsideAnyFence: number;
}

export interface BimSummary {
  models: number;
  modelsWithVersion: number;
  publishedVersions: number;
  failedVersions: number;
  queuedVersions: number;
  openIssues: number;
  overdueIssues: number;
  openClashes: number;
  elements: number;
  captures: number;
  activeGeofences: number;
  links: Record<string, number>;
  fourDCoverage: number | null;
  fourDCoverageBasis: string;
  fiveDCoverage: number | null;
}

export interface VersionDiffResponse {
  baseVersionId: string | null;
  targetVersionId: string;
  baseVersion?: number;
  targetVersion?: number;
  cached?: boolean;
  reason?: string;
  diff: {
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    unchangedCount: number;
    byType: Record<string, { added: number; removed: number; modified: number }>;
    sampleAdded: Array<{ globalId: string; ifcType: string; name: string | null }>;
    sampleRemoved: Array<{ globalId: string; ifcType: string; name: string | null }>;
    sampleModified: Array<{ globalId: string; ifcType: string; name: string | null }>;
  } | null;
  affectedIssues?: Array<{
    id: string;
    number: number;
    title: string;
    removedElements: string[];
    modifiedElements: string[];
  }>;
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

/* ------------------------- ISO 19650 state machine ------------------------ */

/** Legal next CDE states (client-side mirror of the API's transition map). */
export const CDE_NEXT_STATES: Record<string, string[]> = {
  wip: ["shared"],
  shared: ["shared", "published"],
  published: ["archived"],
  archived: [],
};

/** Suitability codes coherent with each CDE state. */
export const SUITABILITY_BY_STATE: Record<string, string[]> = {
  wip: ["S0"],
  shared: ["S1", "S2", "S3", "S4"],
  published: ["A1", "B1", "CR"],
  archived: ["CR"],
};

/** Coordination issue lifecycle (void allowed from any live state). */
export const ISSUE_NEXT_STATUSES: Record<string, string[]> = {
  open: ["assigned", "void"],
  assigned: ["open", "resolved", "void"],
  resolved: ["assigned", "verified", "void"],
  verified: ["void"],
  void: [],
};

export const CLASH_STATUSES = ["new", "active", "resolved", "approved", "ignored"] as const;

export const REALITY_CAPTURE_KINDS = [
  "point_cloud",
  "photogrammetry",
  "panorama_360",
  "drone_flight",
  "total_station",
  "thermal",
  "other",
] as const;

export const GEOFENCE_PURPOSES = [
  "site_boundary",
  "work_zone",
  "exclusion",
  "laydown",
  "access_route",
  "welfare",
  "environmental",
  "other",
] as const;

/* --------------------------------- Chips ---------------------------------- */

const cdeChipStyles: Record<string, string> = {
  wip: "bg-ink-100 text-ink-600",
  shared: "bg-brand-100 text-brand-800",
  published: "bg-emerald-100 text-emerald-800",
  archived: "bg-ink-800 text-ink-100",
};

export function CdeBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-ink-300">—</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
        cdeChipStyles[state] ?? "bg-ink-100 text-ink-600"
      }`}
    >
      {state}
    </span>
  );
}

export function SuitabilityChip({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="text-ink-300">—</span>;
  return (
    <span className="inline-flex items-center rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-700">
      {code}
    </span>
  );
}

export function ProcessingChip({
  processing,
  error,
}: {
  processing: string | null | undefined;
  error?: string | null;
}) {
  if (!processing) return <span className="text-ink-300">—</span>;
  const styles: Record<string, string> = {
    pending: "bg-ink-100 text-ink-600",
    queued: "bg-ink-100 text-ink-600",
    processing: "bg-amber-100 text-amber-800",
    ready: "bg-emerald-100 text-emerald-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      title={error ?? undefined}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        styles[processing] ?? "bg-ink-100 text-ink-600"
      }`}
    >
      {processing}
    </span>
  );
}

export function issueStatusTone(status: string): "gray" | "blue" | "amber" | "green" | "red" {
  switch (status) {
    case "open":
      return "amber";
    case "assigned":
      return "blue";
    case "resolved":
      return "green";
    case "verified":
      return "green";
    default:
      return "gray";
  }
}

export function clashStatusTone(status: string): "gray" | "blue" | "amber" | "green" | "red" {
  switch (status) {
    case "new":
      return "red";
    case "active":
      return "amber";
    case "resolved":
      return "green";
    case "approved":
      return "blue";
    default:
      return "gray";
  }
}

/** "—" for a value the API could not compute, with the reason in the title. */
export function orDash(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toLocaleString()}${suffix}`;
}

/**
 * A dependency-free plan view: project features and geofences projected onto
 * an equirectangular box. It is a schematic, not a basemap, and says so.
 */
export function MiniMap({
  features,
  geofences,
  height = 320,
  onSelect,
}: {
  features: MapFeature[];
  geofences: Geofence[];
  height?: number;
  onSelect?: (feature: MapFeature) => void;
}) {
  const points: Array<[number, number]> = [
    ...features.map((f) => [f.longitude, f.latitude] as [number, number]),
    ...geofences.flatMap((g) => g.ring),
  ];
  if (points.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-ink-200 text-xs text-ink-400">
        Nothing on this project carries coordinates yet.
      </div>
    );
  }
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const padX = Math.max((east - west) * 0.12, 0.0005);
  const padY = Math.max((north - south) * 0.12, 0.0005);
  const w = 800;
  const h = height;
  const x = (lng: number) => ((lng - (west - padX)) / (east - west + padX * 2)) * w;
  const y = (lat: number) => h - ((lat - (south - padY)) / (north - south + padY * 2)) * h;

  const kindColour: Record<string, string> = {
    equipment: "#1d60f1",
    photo: "#8b5cf6",
    capture: "#0d9488",
  };

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full rounded-lg bg-ink-50" role="img" aria-label="Project plan">
        {geofences.map((fence) => (
          <polygon
            key={fence.id}
            points={fence.ring.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}
            fill={fence.colour ?? "#1d60f1"}
            fillOpacity={0.08}
            stroke={fence.colour ?? "#1d60f1"}
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        ))}
        {features.map((f) => (
          <g key={`${f.kind}-${f.id}`} onClick={() => onSelect?.(f)} className={onSelect ? "cursor-pointer" : ""}>
            <circle
              cx={x(f.longitude)}
              cy={y(f.latitude)}
              r={5}
              fill={kindColour[f.kind] ?? "#64748b"}
              fillOpacity={0.85}
            />
            <title>{`${f.label} (${f.kind})`}</title>
          </g>
        ))}
      </svg>
      <p className="mt-1 text-[11px] text-ink-400">
        Schematic plan projected from latitude/longitude — not a survey drawing or a basemap.
      </p>
    </div>
  );
}

/* ------------------------------ downloads --------------------------------- */

/**
 * Fetch an authenticated text export and hand it to the browser as a file.
 * It goes through `api.get`, so it inherits the client's single-flight token
 * refresh instead of failing with a bare 401 the way a plain <a href> does.
 */
export async function downloadText(path: string, filename: string): Promise<void> {
  const { api } = await import("../../lib/api");
  const body = await api.get<string>(path);
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Download a binary body (the model container) with the same refresh-once
 * behaviour as `api.request`: a raw fetch cannot refresh, so on a 401 we make
 * one cheap authenticated call through the client (which refreshes) and retry.
 */
export async function fetchAuthedBuffer(path: string): Promise<ArrayBuffer> {
  const { api, tokenStore } = await import("../../lib/api");
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const access = tokenStore.access;
    if (access) headers["authorization"] = `Bearer ${access}`;
    const companyId = tokenStore.companyId;
    if (companyId) headers["x-company-id"] = companyId;
    return fetch(path, { headers });
  };
  let res = await attempt();
  if (res.status === 401) {
    // this call refreshes the access token (or bounces to /login) inside the
    // shared client; then the raw fetch is retried once with the new token
    await api.get("/api/v1/me").catch(() => undefined);
    res = await attempt();
  }
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  return res.arrayBuffer();
}
