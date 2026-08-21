/** Wire + viewer types for the drawings surface. */
import type { MarkupShape, SheetCalibration, SheetPoint } from "@constructos/shared";

export type { MarkupShape, SheetCalibration, SheetPoint };

/* ------------------------------- wire types ------------------------------- */

export interface DrawingSetItem {
  id: string;
  name: string;
  issuedDate?: string | null;
  processing: string; // pending | processing | ready | failed
  sheetCount?: number;
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
  updatedAt?: string;
}

export interface SheetDetail extends SheetListItem {
  revisions: RevisionSummary[];
  pinsCount?: number;
}

export interface MarkupRecord {
  id: string;
  revisionId: string;
  authorId: string;
  layer: "personal" | "published" | string;
  shapes: MarkupShape[];
  updatedAt?: string;
}

export interface PinRecord {
  id: string;
  sheetId: string;
  recordType: string;
  recordId: string;
  x: number;
  y: number;
  createdBy?: string;
  createdAt?: string;
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
