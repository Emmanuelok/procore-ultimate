/**
 * Shared types and helpers for the AI agent console (Vol I §6.4 #759–#775,
 * Vol II X #995–#1027).
 *
 * The view-models mirror `apps/api/src/modules/ai` exactly. Two honesty rules
 * run through this file and the components that use it:
 *
 *   · A number the API did not return renders "—" with the reason, never 0.
 *     `num()` and `pct()` are the only places that decide that.
 *   · CONFIDENCE is the platform's damped figure, not the model's claim. The
 *     two are shown side by side wherever the difference matters, because a
 *     model that is 95% sure over evidence it invented is exactly what the
 *     reviewer needs to see.
 */
import { ApiClientError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { Tone } from "../../ui";

/* ================================ Lists ================================== */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Accept the paginate() envelope or a bare array so drift degrades gracefully. */
export function asList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: res.length };
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    const r = res as { items: T[]; total?: number };
    return { items: r.items, total: typeof r.total === "number" ? r.total : r.items.length };
  }
  return { items: [], total: 0 };
}

/* ================================ Types ================================== */

export interface AgentDescriptor {
  kind: string;
  name: string;
  description: string;
  category: "monitor" | "drafter" | "analyst" | "reviewer" | "assistant";
  scope: "project" | "company" | "both";
  inputs: string[];
  outputs: string[];
  dataCategories: string[];
  targetTypes: string[];
  consequential: boolean;
  runnable: boolean;
  route: string;
  promptVersion: string | null;
  authorisation: string;
  threshold: number | null;
  minConfidence: number | null;
  schedulable: boolean;
  enabled: boolean;
  policySource: "default" | "config" | "tenant";
  lastRunAt: string | null;
  runCount: number;
  pendingProposals: number;
}

export interface AgentListResponse {
  aiEnabled: boolean;
  items: AgentDescriptor[];
}

export interface AgentPolicy {
  agentKind: string;
  policyId: string | null;
  source: "default" | "config" | "tenant";
  enabled: boolean;
  authorisation: string;
  autoApplyMinConfidence: number | null;
  minConfidence: number | null;
  allowedTargetTypes: string[];
  allowedRoles: string[];
  maxRunsPerDay: number | null;
  maxInputTokensPerDay: number | null;
  maxOutputTokensPerDay: number | null;
  notes: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface UsageCounters {
  runs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface PolicyResponse {
  policy: AgentPolicy;
  usedToday: UsageCounters;
  verdict: { allowed: boolean; reason: string };
}

export interface RunSummary {
  id: string;
  companyId: string;
  projectId: string | null;
  agentKind: string;
  model: string;
  requestedBy: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  inputRefCount: number;
  citationCount: number;
  createdAt: string;
  promptVersion?: string | null;
  evidenceScore?: number | null;
  droppedCitations?: number;
  source?: string | null;
  proposalCount?: number;
}

export interface RunProvenance {
  runId: string;
  promptVersion: string;
  agentVersion: string;
  source: string;
  sourceRef: string | null;
  evidenceScore: number | null;
  evidenceBasis: Record<string, unknown>;
  droppedCitations: number;
  citationCount: number;
  inputRefCount: number;
  dataCategories: string[];
  proposalCount: number;
  actionCount: number;
  createdAt: string;
}

export interface Citation {
  ref?: number;
  type: string;
  id: string;
  excerpt?: string;
}

export interface RunDetail {
  run: RunSummary & {
    prompt: string | null;
    output: string | null;
    outputJson: unknown;
    citations: Citation[];
    inputRefs: Array<{ type: string; id: string }>;
  };
  provenance: RunProvenance | null;
  reviews: ReviewItem[];
  actions: AgentAction[];
}

export interface ReviewItem {
  id: string;
  companyId: string;
  projectId: string | null;
  runId: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  confidence: number | null;
  status: string;
  reviewerId: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface ReviewDetail {
  item: ReviewItem & { proposal: Record<string, unknown> };
  run: (RunSummary & { citations: Citation[]; inputRefs: Array<{ type: string; id: string }> }) | null;
  provenance: RunProvenance | null;
  action: AgentAction | null;
  current: Record<string, unknown> | null;
  stale: boolean;
  staleAfterDays: number;
}

export interface AgentAction {
  id: string;
  companyId: string;
  projectId: string | null;
  agentKind: string;
  runId: string | null;
  reviewId: string | null;
  actionType: string;
  targetType: string;
  targetId: string | null;
  beforeImage: Record<string, unknown> | null;
  afterImage: Record<string, unknown> | null;
  status: string;
  reversible: number;
  irreversibleReason: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
  authorisation: string;
  confidence: number | null;
  summary: string | null;
  createdAt: string;
}

export interface AgentSchedule {
  id: string;
  companyId: string;
  projectId: string | null;
  agentKind: string;
  name: string | null;
  enabled: number;
  everyMinutes: number;
  params: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRunId: string | null;
  runCount: number;
  failureCount: number;
  createdAt: string;
}

export interface AgentReport {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  data: Record<string, unknown>;
  windowFrom: string | null;
  windowTo: string | null;
  generatedBy: string | null;
  createdAt: string;
}

export interface UsageResponse {
  date: string;
  costBasis: string;
  totals: UsageCounters & { estimatedCostMicros: number };
  agents: Array<
    UsageCounters & {
      agentKind: string;
      limits: {
        maxRunsPerDay: number | null;
        maxInputTokensPerDay: number | null;
        maxOutputTokensPerDay: number | null;
      };
      withinBudget: boolean;
    }
  >;
}

export interface ModelsResponse {
  provider: string;
  enabled: boolean;
  defaultModel: string;
  retentionStatement: string;
  humanInTheLoop: string;
  agents: Array<AgentDescriptor & { model: string; policy: AgentPolicy | null }>;
}

export interface AgentRunResult {
  runId: string | null;
  agentKind: string;
  skipped: boolean;
  summary: string;
  proposals: number;
  queued: number;
  filtered: number;
  actions: number;
  signals: number;
  reviewIds: string[];
  evidenceScore: number | null;
  droppedCitations: number;
  confidence: number | null;
  usage: { inputTokens: number; outputTokens: number; costMicros: number } | null;
}

/* =============================== Helpers ================================= */

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiClientError ? err.status : null;
}

/** Owner/admin gates policy edits, report generation and the manual tick. */
export function useIsCompanyAdmin(): boolean {
  const { company } = useAuth();
  return company?.role === "owner" || company?.role === "admin";
}

/** A figure the API did not return is "—", never 0. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

/** Estimated micro-USD, always labelled as an estimate by its caller. */
export function micros(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 10_000) return `$${(n / 1_000_000).toFixed(4)}`;
  return `$${(n / 1_000_000).toFixed(2)}`;
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export const RUN_STATUS_TONE: Record<string, Tone> = {
  succeeded: "success",
  failed: "danger",
  refused: "warning",
};

export const REVIEW_STATUS_TONE: Record<string, Tone> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
  superseded: "neutral",
  reverted: "warning",
};

export const ACTION_STATUS_TONE: Record<string, Tone> = {
  applied: "success",
  rolled_back: "warning",
  failed: "danger",
  not_reversible: "neutral",
};

export const CATEGORY_TONE: Record<string, Tone> = {
  monitor: "info",
  drafter: "highlight",
  analyst: "accent",
  reviewer: "warning",
  assistant: "neutral",
};

/** A confidence band with the words the platform uses for it. */
export function confidenceBand(value: number | null | undefined): {
  tone: Tone;
  label: string;
} {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { tone: "neutral", label: "not stated" };
  }
  if (value >= 0.75) return { tone: "success", label: "high" };
  if (value >= 0.5) return { tone: "warning", label: "moderate" };
  return { tone: "danger", label: "low" };
}

/** Human sentence for how long a schedule's interval is. */
export function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "daily" : `every ${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "hourly" : `every ${hours} hours`;
  }
  return `every ${minutes} minutes`;
}

export const SCHEDULE_INTERVALS: Array<{ value: number; label: string }> = [
  { value: 60, label: "Hourly" },
  { value: 240, label: "Every 4 hours" },
  { value: 720, label: "Twice a day" },
  { value: 1440, label: "Daily" },
  { value: 10080, label: "Weekly" },
];
