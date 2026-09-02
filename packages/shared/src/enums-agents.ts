/**
 * Shared enums for the AI agent fleet (platform upgrade wave, WP-AGENTS;
 * spec Vol I §6.4 #759–775, Vol II X #995–1027).
 *
 * `enums.ts` is frozen for this wave, so the original eight `AI_AGENT_KINDS`
 * stay where they are and the fleet's new kinds live here. Anything that
 * validates `ai_runs.agent_kind` (a text column) accepts the union
 * `ALL_AGENT_KINDS`. Never edit enums.ts from a work package.
 */
import { AI_AGENT_KINDS, AI_REVIEW_STATUSES } from "./enums.js";

/** Agent kinds added by the fleet. The original eight live in enums.ts. */
export const AGENT_KINDS = [
  "obligation_monitor",
  "time_bar_notice_drafter",
  "claim_narrative_drafter",
  "rebuttal_finder",
  "evidence_sufficiency_scorer",
  "counterfactual_analyst",
  "anomaly_explainer",
  "integrity_monitor",
  "risk_monitor",
  "multi_document_reasoner",
  "cost_forecaster",
  "schedule_risk_analyst",
  "meeting_minutes_drafter",
  "incident_classifier",
  "spec_compliance_checker",
  "change_impact_analyst",
  "bid_levelling_analyst",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Every kind an `ai_runs.agent_kind` may carry: the legacy eight plus the fleet. */
export const ALL_AGENT_KINDS = [...AI_AGENT_KINDS, ...AGENT_KINDS] as const;
export type AllAgentKind = (typeof ALL_AGENT_KINDS)[number];

export const AGENT_CATEGORIES = ["monitor", "drafter", "analyst", "reviewer", "assistant"] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/** Per-kind authorisation limit (#1022). */
export const AGENT_AUTHORISATIONS = [
  "propose_only",
  "auto_apply_below_threshold",
  "auto_apply",
] as const;
export type AgentAuthorisation = (typeof AGENT_AUTHORISATIONS)[number];

/** Review-queue statuses: the frozen four plus `reverted` (an approved item whose action was rolled back). */
export const AGENT_REVIEW_STATUSES = [...AI_REVIEW_STATUSES, "reverted"] as const;
export type AgentReviewStatus = (typeof AGENT_REVIEW_STATUSES)[number];

/** Lifecycle of an applied agent action (#1023). */
export const AGENT_ACTION_STATUSES = ["applied", "rolled_back", "failed", "not_reversible"] as const;
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

/** Who asked for a run — recorded distinctly on every run's metadata. */
export const AGENT_RUN_SOURCES = ["user", "system", "schedule", "trigger", "automation", "review"] as const;
export type AgentRunSource = (typeof AGENT_RUN_SOURCES)[number];

/** Work-queue item lifecycle (scheduled and triggered runs). */
export const AGENT_QUEUE_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export type AgentQueueStatus = (typeof AGENT_QUEUE_STATUSES)[number];

/** Governance reports the console can generate (#1024–#1027). */
export const AGENT_REPORT_KINDS = ["adversarial", "bias", "validation"] as const;
export type AgentReportKind = (typeof AGENT_REPORT_KINDS)[number];

/** Outcome of a model invocation as stored on ai_runs.status. */
export const AGENT_RUN_STATUSES = ["succeeded", "failed", "refused"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
