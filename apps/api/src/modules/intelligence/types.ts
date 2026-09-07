/**
 * Wire shapes of the intelligence layer — the cross-package contract (plan
 * §3.1) that WP-SHELL, the project overview and the MCP server build against.
 * Keep these stable; add fields, never rename them.
 */
import type {
  AttentionKind,
  AttentionSeverity,
  HealthDimensionKey,
  HealthLevel,
} from "@constructos/shared";

export interface HealthDimension {
  key: HealthDimensionKey;
  /** 0..100, null when the platform holds no inputs for this dimension */
  score: number | null;
  level: HealthLevel;
  /** one or two sentences: which inputs drove the score and how */
  basis: string;
  /** the raw metrics the score was derived from, for the "why" panel */
  inputs: Record<string, unknown>;
}

export interface HealthTrendPoint {
  at: string;
  score: number | null;
}

export interface ProjectHealth {
  projectId: string;
  level: HealthLevel;
  /** 0..100, null when unrated */
  score: number | null;
  dimensions: HealthDimension[];
  computedAt: string;
  trend: HealthTrendPoint[];
}

export interface AttentionItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  kind: AttentionKind | string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  dueAt: string | null;
  /** SPA path */
  href: string;
  sourceType: string;
  sourceId: string;
  /** severity × urgency × money */
  score: number;
  money?: number | null;
  currency?: string | null;
  status?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /**
   * May the caller set this item aside / reopen it? Seeing is not acting
   * (plan §6.3), so the API says which of the two the reader has rather than
   * letting the page offer a button that 403s.
   */
  canAct?: boolean;
}

export interface PortfolioRollup {
  projects: number;
  byStage: Record<string, number>;
  byHealth: { on_track: number; watch: number; off_track: number; unrated: number };
}

export interface PulseChanges {
  /** generatedAt of the snapshot compared against, null when there is none */
  since: string | null;
  levelChanges: Array<{
    projectId: string;
    projectName: string | null;
    from: HealthLevel;
    to: HealthLevel;
    scoreFrom: number | null;
    scoreTo: number | null;
  }>;
  newAttention: number;
  resolvedAttention: number;
  openAttentionFrom: number | null;
  openAttentionTo: number;
}

export interface BriefingSummary {
  text: string | null;
  runId: string | null;
  /** why there is no text: "ai_disabled" | "never_generated" | ... */
  reason: string | null;
  id?: string | null;
  generatedAt?: string | null;
  headline?: string | null;
  proposals?: number;
}

export interface PulseResponse {
  generatedAt: string;
  portfolio: PortfolioRollup;
  attention: AttentionItem[];
  attentionBySeverity: Record<string, number>;
  openAttention: number;
  scores: ProjectHealth[];
  briefing: BriefingSummary;
  changes: PulseChanges;
  /**
   * Source types whose sweep hit its row cap: the feed holds the most urgent
   * items of more, and the page says so instead of implying completeness.
   */
  attentionTruncated: string[];
  /** true when the snapshot was built on this request rather than read from cache */
  computedOnRead: boolean;
}
