/**
 * Shared enums for the intelligence area (platform upgrade wave).
 *
 * The intelligence layer (Vol I §6.1–6.3 #731–758, §7 #776–789, Vol II X
 * #1010–1012, #1017–1018) reads every module and says three things about a
 * project: how healthy it is and why (dimension scores with their basis),
 * what needs a human's attention now (ranked by severity × urgency × money),
 * and what changed since yesterday. Everything the API, the Pulse page and
 * the tests name is declared here.
 */

/** The overall verdict on a project. `unrated` = the platform holds too few inputs to say. */
export const HEALTH_LEVELS = ["on_track", "watch", "off_track", "unrated"] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

/** The dimensions a project is scored on. Order is the display order. */
export const HEALTH_DIMENSIONS = [
  "schedule",
  "cost",
  "commercial",
  "assurance",
  "safety",
  "quality",
  "field",
  "contract",
  "risk",
  "finance",
] as const;
export type HealthDimensionKey = (typeof HEALTH_DIMENSIONS)[number];

/** Why a health snapshot was taken. */
export const HEALTH_RECOMPUTE_TRIGGERS = ["interval", "event", "manual", "boot", "read"] as const;
export type HealthRecomputeTrigger = (typeof HEALTH_RECOMPUTE_TRIGGERS)[number];

/** What an attention item is about. Open — other modules may raise kinds of their own. */
export const ATTENTION_KINDS = [
  "obligation_due",
  "time_bar",
  "signal",
  "payment_due",
  "overdue_rfi",
  "overdue_submittal",
  "safety_incident",
  "ncr_open",
  "schedule_slip",
  "budget_overrun",
  "invoice_hold",
  "agent_proposal",
  "grievance_sla",
  "permit_expiry",
  "insurance_expiry",
  "cert_expiry",
  "automation_failed",
  "covenant_breach",
  "change_exposure",
  "punch_overdue",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

/**
 * `open` is in the feed; `dismissed` was set aside by a person (with a
 * reason, ledgered); `resolved` means the underlying condition is gone — the
 * refresh could no longer find its source.
 */
export const ATTENTION_STATUSES = ["open", "dismissed", "resolved"] as const;
export type AttentionStatus = (typeof ATTENTION_STATUSES)[number];

/** Agent kinds the intelligence layer runs through `runAgent` (ai_runs.agent_kind is text). */
export const INTELLIGENCE_AGENT_KINDS = ["daily_briefing"] as const;
export type IntelligenceAgentKind = (typeof INTELLIGENCE_AGENT_KINDS)[number];

/** What a briefing may propose. Every proposal lands in the AI review queue; none self-applies. */
export const BRIEFING_ACTION_KINDS = ["notify", "escalate", "review", "recompute", "other"] as const;
export type BriefingActionKind = (typeof BRIEFING_ACTION_KINDS)[number];
