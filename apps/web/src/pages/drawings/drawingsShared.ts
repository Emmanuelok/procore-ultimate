/**
 * Wire types and small helpers shared by the drawings workspace tabs.
 * Everything here is a plain description of what the drawings API returns;
 * the "why" of a figure (basis, reason, confidence) travels with it.
 */
import type { ChangedRegion, HyperlinkRecord } from "./types";

export interface DrawingsSummary {
  sheets: number;
  needsReview: number;
  byDiscipline: Record<string, number>;
  sets: Record<string, number>;
  unresolvedCallouts: number;
  issues: Record<string, number>;
  unacknowledgedRecipients: number;
  segregated: boolean;
}

export interface SheetCandidate {
  number: string;
  score: number;
  x: number;
  y: number;
  titleBlock: boolean;
}

export interface ReviewItem {
  id: string;
  number: string;
  title: string;
  discipline: string;
  area: string | null;
  revisionId: string | null;
  setId: string | null;
  setName: string | null;
  pageIndex: number | null;
  hasTextLayer: boolean | null;
  detection: {
    method?: string;
    confidence?: number;
    candidates?: SheetCandidate[];
    detectedNumber?: string | null;
    detectedTitle?: string | null;
    isIndexPage?: boolean;
    noTextLayer?: boolean;
    reason?: string | null;
  };
  duplicateOf: { id: string; number: string; title: string } | null;
  reason: string;
}

export interface LogRow {
  sheetId: string;
  number: string;
  title: string;
  discipline: string;
  area: string | null;
  currentRevision: string | null;
  currentRevisionId: string | null;
  revisionCount: number;
  issuedDate: string | null;
  setName: string | null;
  changeVerdict: string | null;
  needsReview: boolean;
  lastIssuedReference: string | null;
  lastIssuedAt: string | null;
  lastIssuePurpose: string | null;
  acknowledged: string | null;
  history: Array<{
    revisionId: string;
    revision: string;
    setName: string | null;
    issuedDate: string | null;
    changeVerdict: string | null;
    isSuperseded: boolean;
  }>;
}

export interface SetQa {
  setId: string;
  processing: string;
  processedPages: number;
  pageCount: number | null;
  summary: {
    pages: number;
    unresolvedCallouts: number;
    lowConfidenceLinks: number;
    pagesNeedingReview: number;
    noTextLayer: number;
    unchangedReissues: number;
    diffUnknown: number;
  };
  unresolvedCallouts: Array<{ linkId: string; number: string | null; pageIndex: number | null; targetNumber: string | null; label: string | null; confidence: number | null }>;
  lowConfidenceLinks: Array<{ linkId: string; number: string | null; targetNumber: string | null; confidence: number | null }>;
  pagesNeedingReview: Array<{ sheetId: string | null; number: string | null; pageIndex: number | null }>;
  noTextLayer: Array<{ sheetId: string | null; number: string | null; pageIndex: number | null }>;
  unchangedReissues: Array<{ sheetId: string | null; number: string | null; revision: string }>;
  diffUnknown: Array<{ sheetId: string | null; number: string | null }>;
}

export interface LinkReviewItem extends HyperlinkRecord {
  from: { sheetId: string; number: string; title: string; revision: string; pageIndex: number };
  reason: string;
}

export interface PermissionRule {
  id: string;
  scope: "discipline" | "area" | "sheet";
  scopeValue: string;
  scopeLabel: string;
  subjectType: "user" | "template";
  subjectId: string;
  subjectName: string | null;
  level: "read" | "standard";
  createdAt: string;
}

export interface PermissionsResponse {
  items: PermissionRule[];
  total: number;
  areas: string[];
  note: string;
}

export interface IssueRecipient {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  notifiedAt: string | null;
  remindedAt: string | null;
  acknowledgedAt: string | null;
}

export interface IssueSheet {
  revisionId: string;
  revision: string;
  isSuperseded: number;
  sheetId: string;
  number: string;
  title: string;
  discipline: string;
}

export interface DrawingIssue {
  id: string;
  number: number;
  reference: string;
  title: string;
  purpose: string;
  status: "draft" | "issued" | "cancelled" | string;
  setId: string | null;
  revisionIds: string[];
  notes: string | null;
  transmittalId: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  createdBy: string;
  createdAt: string;
  sheetCount?: number;
  recipients?: number;
  acknowledged?: number;
}

export interface DrawingIssueDetail extends Omit<DrawingIssue, "recipients" | "acknowledged"> {
  sheets: IssueSheet[];
  recipients: IssueRecipient[];
  acknowledged: number;
  createdByName: string | null;
  issuedByName: string | null;
  isRecipient: boolean;
}

export interface CompanyUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export const DISCIPLINES = [
  "general",
  "civil",
  "architectural",
  "structural",
  "mechanical",
  "electrical",
  "plumbing",
  "fire_protection",
  "landscape",
  "interiors",
  "telecom",
  "other",
] as const;

export const ISSUE_PURPOSES = [
  "for_construction",
  "for_information",
  "for_approval",
  "for_tender",
  "for_coordination",
  "as_built",
] as const;

export const PERMISSION_TEMPLATES = [
  "project_admin",
  "project_manager",
  "field_engineer",
  "subcontractor",
  "owner_stakeholder",
  "read_only",
] as const;

export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export function verdictTone(v: string | null | undefined): "success" | "warning" | "neutral" | "info" {
  if (v === "changed") return "warning";
  if (v === "unchanged") return "success";
  if (v === "unknown") return "neutral";
  return "info";
}

export function regionSummary(regions: ChangedRegion[]): string {
  const added = regions.filter((r) => r.kind === "added").length;
  const removed = regions.filter((r) => r.kind === "removed").length;
  const moved = regions.filter((r) => r.kind === "moved").length;
  return `${regions.length} region${regions.length === 1 ? "" : "s"} · ${added} added · ${removed} removed · ${moved} moved`;
}
