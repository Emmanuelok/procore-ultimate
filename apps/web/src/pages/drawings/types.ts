/** Wire + viewer types for the drawings surface. */
import type { MarkupShape, SheetCalibration, SheetPoint } from "@constructos/shared";

export type { MarkupShape, SheetCalibration, SheetPoint };

/* ------------------------------- wire types ------------------------------- */

export interface DrawingSetItem {
  id: string;
  name: string;
  issuedDate?: string | null;
  area?: string | null;
  processing: string; // pending | processing | ready | failed
  processingError?: string | null;
  pageCount?: number | null;
  processedPages?: number;
  sheetsCreated?: number;
  revisionsAdded?: number;
  autoLinksCreated?: number;
  unresolvedCallouts?: number;
  sheetCount?: number;
  uploadedByName?: string | null;
  createdAt?: string;
  error?: string | null;
}

export interface RevisionSummary {
  id: string;
  revision: string;
  fileId: string;
  pageIndex: number;
  setId?: string;
  isSuperseded?: number | boolean;
  calibration?: SheetCalibration | null;
  createdAt?: string;
  changeVerdict?: string | null;
  changedRegionCount?: number;
  supersedesRevisionId?: string | null;
  hasTextLayer?: number;
  detection?: Record<string, unknown> | null;
  set?: { id: string; name: string; issuedDate: string | null } | null;
}

export interface SheetListItem {
  id: string;
  number: string;
  title: string;
  discipline: string;
  area?: string | null;
  needsReview: number | boolean;
  currentRevisionId?: string | null;
  currentRevision?: RevisionSummary | null;
  canEdit?: boolean;
  updatedAt?: string;
}

export interface SheetDetail extends SheetListItem {
  revisions: RevisionSummary[];
  pinsCount?: number;
  access?: { canEdit: boolean; canAdmin: boolean; level: string };
}

export interface MarkupRecord {
  id: string;
  revisionId: string;
  authorId: string;
  authorName?: string | null;
  layer: "personal" | "published" | string;
  shapes: MarkupShape[];
  carriedFromRevisionId?: string | null;
  reviewFlags?: number[];
  prior?: boolean;
  revisionLabel?: string | null;
  updatedAt?: string;
}

export interface MarkupsResponse {
  items: MarkupRecord[];
  prior: MarkupRecord[];
  total: number;
  changedRegions: ChangedRegion[];
}

export interface PinRecord {
  id: string;
  sheetId: string;
  recordType: string;
  recordId: string;
  label?: string | null;
  locationId?: string | null;
  x: number;
  y: number;
  createdBy?: string;
  createdAt?: string;
}

export interface HyperlinkRecord {
  id: string;
  fromRevisionId: string;
  toSheetId: string | null;
  targetNumber: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string | null;
  source: string;
  confidence: number | null;
  status: string;
  detail?: Record<string, unknown>;
  target?: { id: string; number: string; title: string; currentRevisionId: string | null } | null;
}

export interface ChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "added" | "removed" | "moved";
  items: number;
  sample: string;
}

export interface RevisionDiff {
  revisionId: string;
  againstRevisionId: string | null;
  verdict: "changed" | "unchanged" | "unknown";
  regions: ChangedRegion[];
  stats: {
    prevItems: number;
    nextItems: number;
    added: number;
    removed: number;
    moved: number;
    common: number;
    changeRatio: number | null;
  } | null;
  basis: string;
  computedAt: string | null;
  stored: boolean;
  against?: { id: string; revision: string };
  pinsInChangedRegions: Array<{ id: string; recordType: string; recordId: string; label: string | null }>;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

/* ------------------------------ viewer types ------------------------------ */

/** Pan/zoom transform: screen = pagePoint * scale + offset (page @ scale 1 css px). */
export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Page dimensions in css px at pdf.js scale 1. */
export interface PageSize {
  width: number;
  height: number;
}

export type ToolId =
  | "select"
  | "pan"
  | "pen"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "cloud"
  | "text"
  | "measure"
  | "pin";

export const PIN_RECORD_TYPES = [
  "rfi",
  "punch",
  "observation",
  "photo",
  "inspection",
  "submittal",
] as const;

export const PIN_STYLE: Record<string, { letter: string; color: string }> = {
  rfi: { letter: "R", color: "#2563eb" },
  punch: { letter: "P", color: "#dc2626" },
  observation: { letter: "O", color: "#d97706" },
  photo: { letter: "F", color: "#059669" },
  inspection: { letter: "I", color: "#7c3aed" },
  submittal: { letter: "S", color: "#0891b2" },
};

export const MARKUP_COLORS = [
  "#dc2626", // red
  "#ea580c", // orange
  "#ca8a04", // yellow
  "#16a34a", // green
  "#2563eb", // blue
  "#7c3aed", // violet
  "#0f172a", // ink
] as const;

export const MARKUP_WIDTHS = [1, 2, 4, 6] as const;

/** The API caps a pen stroke at this many points; the viewer simplifies before it gets there. */
export const MAX_PEN_POINTS = 5000;
