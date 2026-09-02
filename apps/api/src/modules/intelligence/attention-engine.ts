/**
 * Attention engine — the pure ranking core of the attention feed
 * (Vol I §6.2 #741–748, §7 #782–785; Vol II X #1011).
 *
 * A candidate is anything a module holds that a person should look at now:
 * an obligation due, a time bar closing, a critical signal, an overdue RFI.
 * The feed's order is severity × urgency × money:
 *
 *   severity  what the source module says it is (critical…info)
 *   urgency   how close (or how far past) the deadline is
 *   money     the amount at stake, when the source carries one — a
 *             magnitude multiplier, never a currency conversion
 *
 * Ids are deterministic (company + source + kind), so a refresh upserts the
 * same row and a person's dismissal is never lost by the next sweep.
 * Nothing here touches the database or the clock; `now` is an argument.
 */
import { createHash } from "node:crypto";
import type { AttentionSeverity } from "@constructos/shared";

export interface AttentionCandidate {
  companyId: string;
  projectId: string | null;
  projectName: string | null;
  kind: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  /** ISO timestamp, or null when the item has no deadline */
  dueAt: string | null;
  /** SPA path */
  href: string;
  sourceType: string;
  sourceId: string;
  money?: number | null;
  currency?: string | null;
}

export interface RankedCandidate extends AttentionCandidate {
  id: string;
  score: number;
  urgency: number;
}

const DAY_MS = 86_400_000;

export const SEVERITY_WEIGHT: Record<AttentionSeverity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 20,
  info: 5,
};

export function attentionId(
  companyId: string,
  sourceType: string,
  sourceId: string,
  kind: string,
): string {
  const digest = createHash("sha256")
    .update([companyId, sourceType, sourceId, kind].join("|"))
    .digest("hex");
  return `att_${digest.slice(0, 24)}`;
}

export function severityWeight(severity: AttentionSeverity): number {
  return SEVERITY_WEIGHT[severity] ?? SEVERITY_WEIGHT.info;
}

/**
 * Urgency as a multiplier. Overdue beats due-soon beats due-later; an item
 * with no deadline sits a little below "due this month" so a dated item of
 * equal severity outranks it.
 */
export function urgencyFactor(dueAt: string | null, now: Date): number {
  if (!dueAt) return 0.9;
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return 0.9;
  const days = (due - now.getTime()) / DAY_MS;
  if (days < -7) return 1.6;
  if (days < 0) return 1.5;
  if (days <= 1) return 1.4;
  if (days <= 3) return 1.25;
  if (days <= 7) return 1.1;
  if (days <= 30) return 1.0;
  return 0.85;
}

/** Magnitude only. Money in different currencies is never compared as a sum. */
export function moneyFactor(money: number | null | undefined): number {
  if (money === null || money === undefined || !Number.isFinite(money) || money <= 0) return 1.0;
  if (money >= 1_000_000) return 1.3;
  if (money >= 100_000) return 1.2;
  if (money >= 10_000) return 1.1;
  return 1.05;
}

export function rankAttention(candidate: AttentionCandidate, now: Date): number {
  const score =
    severityWeight(candidate.severity) *
    urgencyFactor(candidate.dueAt, now) *
    moneyFactor(candidate.money);
  return Math.round(score * 100) / 100;
}

/** Days until due (negative = overdue), rounded; null without a deadline. */
export function daysUntil(dueAt: string | null, now: Date): number | null {
  if (!dueAt) return null;
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return null;
  return Math.round((due - now.getTime()) / DAY_MS);
}

/**
 * Rank and de-duplicate candidates. When two sources produce the same id
 * (same record, same kind) the higher-scoring one wins. Sort: score desc,
 * then earlier deadline, then title — a total order, so the feed is stable
 * between refreshes.
 */
export function rankCandidates(candidates: AttentionCandidate[], now: Date): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const c of candidates) {
    const id = attentionId(c.companyId, c.sourceType, c.sourceId, c.kind);
    const ranked: RankedCandidate = {
      ...c,
      id,
      score: rankAttention(c, now),
      urgency: urgencyFactor(c.dueAt, now),
    };
    const existing = byId.get(id);
    if (!existing || existing.score < ranked.score) byId.set(id, ranked);
  }
  return [...byId.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return a.title.localeCompare(b.title);
  });
}

/** Severity from "days overdue" for deadline-driven kinds where the source has no severity of its own. */
export function severityForDeadline(
  dueAt: string | null,
  now: Date,
  base: AttentionSeverity = "medium",
): AttentionSeverity {
  const days = daysUntil(dueAt, now);
  if (days === null) return base;
  if (days < 0) return "critical";
  if (days <= 3) return "high";
  if (days <= 14) return base;
  return "low";
}
