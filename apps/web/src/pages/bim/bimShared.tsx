/**
 * Shared types + ISO 19650 helpers for the BIM pages.
 * Mirrors the contracts served by apps/api/src/modules/bim.
 */

export interface ModelVersion {
  id: string;
  modelId: string;
  version: number;
  fileId: string;
  cdeState: string;
  suitability: string;
  processing: string;
  elementCount: number;
  createdAt?: string;
}

export interface BimModel {
  id: string;
  name: string;
  discipline: string;
  format: string;
  currentVersionId: string | null;
  currentVersion?: ModelVersion | null;
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
}

export interface FederationGroup {
  id: string;
  name: string;
  createdAt?: string;
  members: FederationMember[];
}

export interface CoordinationIssue {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  discipline: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  elementGlobalIds: string[];
  modelVersionId: string | null;
  createdAt: string;
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
  assigned: ["resolved", "void"],
  resolved: ["verified", "void"],
  verified: ["void"],
  void: [],
};

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

export function ProcessingChip({ processing }: { processing: string | null | undefined }) {
  if (!processing) return <span className="text-ink-300">—</span>;
  const styles: Record<string, string> = {
    pending: "bg-ink-100 text-ink-600",
    processing: "bg-amber-100 text-amber-800",
    ready: "bg-emerald-100 text-emerald-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        styles[processing] ?? "bg-ink-100 text-ink-600"
      }`}
    >
      {processing}
    </span>
  );
}
