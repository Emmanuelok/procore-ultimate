/**
 * Agent authorisation limits and cost budgets (Vol II X #1022).
 *
 * Two facts per tenant per agent kind:
 *   · what the agent is ALLOWED to do (enabled, propose-only vs auto-apply,
 *     which target types, which company roles may run it by hand);
 *   · what it is allowed to SPEND today (runs, input tokens, output tokens).
 *
 * A tenant that has never opened the policy page still has a policy: the
 * code-resident default for the kind, registered by the agent registry at
 * import time. That matters because a new agent kind must ship with its
 * ceiling already in force rather than unbounded until someone notices.
 *
 * The ceiling is checked BEFORE the model is called and booked after, so a
 * runaway client is stopped by the counter it has already moved.
 */
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agentPolicies, agentUsageDaily } from "@constructos/db";
import type { AgentAuthorisation } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export interface PolicyDefaults {
  enabled: boolean;
  authorisation: AgentAuthorisation;
  autoApplyMinConfidence: number | null;
  minConfidence: number | null;
  allowedTargetTypes: string[];
  allowedRoles: string[];
  maxRunsPerDay: number | null;
  maxInputTokensPerDay: number | null;
  maxOutputTokensPerDay: number | null;
}

/** The platform-wide fallback for a kind nobody registered a default for. */
export const GLOBAL_POLICY_DEFAULT: PolicyDefaults = {
  enabled: true,
  authorisation: "propose_only",
  autoApplyMinConfidence: null,
  minConfidence: null,
  allowedTargetTypes: [],
  allowedRoles: [],
  maxRunsPerDay: 200,
  maxInputTokensPerDay: 2_000_000,
  maxOutputTokensPerDay: 400_000,
};

const registered = new Map<string, PolicyDefaults>();

/** Called by the agent registry at import time; last registration wins. */
export function registerPolicyDefaults(kind: string, defaults: Partial<PolicyDefaults>): void {
  registered.set(kind, { ...GLOBAL_POLICY_DEFAULT, ...defaults });
}

export function policyDefaults(kind: string): PolicyDefaults {
  return registered.get(kind) ?? GLOBAL_POLICY_DEFAULT;
}

/** Read a numeric override from the deployment config when the key exists. */
function configNumber(app: FastifyInstance, key: string): number | null {
  const raw = (app.appConfig as unknown as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Effective policy                                                    */
/* ------------------------------------------------------------------ */

export interface EffectivePolicy extends PolicyDefaults {
  agentKind: string;
  /** null when the tenant has never saved a policy for this kind */
  policyId: string | null;
  source: "default" | "config" | "tenant";
  updatedAt: string | null;
  updatedBy: string | null;
  notes: string | null;
}

type PolicyRow = typeof agentPolicies.$inferSelect;

function fromRow(kind: string, row: PolicyRow): EffectivePolicy {
  return {
    agentKind: kind,
    policyId: row.id,
    source: "tenant",
    enabled: row.enabled === 1,
    authorisation: row.authorisation as AgentAuthorisation,
    autoApplyMinConfidence: row.autoApplyMinConfidence,
    minConfidence: row.minConfidence,
    allowedTargetTypes: row.allowedTargetTypes ?? [],
    allowedRoles: row.allowedRoles ?? [],
    maxRunsPerDay: row.maxRunsPerDay,
    maxInputTokensPerDay: row.maxInputTokensPerDay,
    maxOutputTokensPerDay: row.maxOutputTokensPerDay,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    notes: row.notes,
  };
}

function fromDefaults(app: FastifyInstance, kind: string): EffectivePolicy {
  const base = policyDefaults(kind);
  const runs = configNumber(app, "AI_MAX_RUNS_PER_DAY");
  const input = configNumber(app, "AI_MAX_INPUT_TOKENS_PER_DAY");
  const output = configNumber(app, "AI_MAX_OUTPUT_TOKENS_PER_DAY");
  const configured = runs !== null || input !== null || output !== null;
  return {
    ...base,
    agentKind: kind,
    policyId: null,
    source: configured ? "config" : "default",
    maxRunsPerDay: runs ?? base.maxRunsPerDay,
    maxInputTokensPerDay: input ?? base.maxInputTokensPerDay,
    maxOutputTokensPerDay: output ?? base.maxOutputTokensPerDay,
    updatedAt: null,
    updatedBy: null,
    notes: null,
  };
}

export async function loadEffectivePolicy(
  app: FastifyInstance,
  companyId: string,
  agentKind: string,
): Promise<EffectivePolicy> {
  const [row] = await app.db
    .select()
    .from(agentPolicies)
    .where(and(eq(agentPolicies.companyId, companyId), eq(agentPolicies.agentKind, agentKind)))
    .limit(1);
  return row ? fromRow(agentKind, row) : fromDefaults(app, agentKind);
}

/** Every kind's effective policy in one query (the console's fleet grid). */
export async function loadEffectivePolicies(
  app: FastifyInstance,
  companyId: string,
  kinds: readonly string[],
): Promise<Map<string, EffectivePolicy>> {
  const rows = await app.db
    .select()
    .from(agentPolicies)
    .where(eq(agentPolicies.companyId, companyId));
  const byKind = new Map(rows.map((r) => [r.agentKind, r]));
  const out = new Map<string, EffectivePolicy>();
  for (const kind of kinds) {
    const row = byKind.get(kind);
    out.set(kind, row ? fromRow(kind, row) : fromDefaults(app, kind));
  }
  return out;
}

export interface PolicyUpdate {
  enabled?: boolean;
  authorisation?: AgentAuthorisation;
  autoApplyMinConfidence?: number | null;
  minConfidence?: number | null;
  allowedTargetTypes?: string[];
  allowedRoles?: string[];
  maxRunsPerDay?: number | null;
  maxInputTokensPerDay?: number | null;
  maxOutputTokensPerDay?: number | null;
  notes?: string | null;
}

/** Upsert the tenant's policy for one kind, starting from its effective one. */
export async function savePolicy(
  app: FastifyInstance,
  companyId: string,
  agentKind: string,
  update: PolicyUpdate,
  actorId: string,
): Promise<EffectivePolicy> {
  const current = await loadEffectivePolicy(app, companyId, agentKind);
  const merged: PolicyDefaults = {
    enabled: update.enabled ?? current.enabled,
    authorisation: update.authorisation ?? current.authorisation,
    autoApplyMinConfidence:
      update.autoApplyMinConfidence !== undefined
        ? update.autoApplyMinConfidence
        : current.autoApplyMinConfidence,
    minConfidence:
      update.minConfidence !== undefined ? update.minConfidence : current.minConfidence,
    allowedTargetTypes: update.allowedTargetTypes ?? current.allowedTargetTypes,
    allowedRoles: update.allowedRoles ?? current.allowedRoles,
    maxRunsPerDay:
      update.maxRunsPerDay !== undefined ? update.maxRunsPerDay : current.maxRunsPerDay,
    maxInputTokensPerDay:
      update.maxInputTokensPerDay !== undefined
        ? update.maxInputTokensPerDay
        : current.maxInputTokensPerDay,
    maxOutputTokensPerDay:
      update.maxOutputTokensPerDay !== undefined
        ? update.maxOutputTokensPerDay
        : current.maxOutputTokensPerDay,
  };
  const now = new Date().toISOString();
  const id = current.policyId ?? newId("apol");
  const values = {
    id,
    companyId,
    agentKind,
    enabled: merged.enabled ? 1 : 0,
    authorisation: merged.authorisation,
    autoApplyMinConfidence: merged.autoApplyMinConfidence,
    minConfidence: merged.minConfidence,
    allowedTargetTypes: merged.allowedTargetTypes,
    allowedRoles: merged.allowedRoles,
    maxRunsPerDay: merged.maxRunsPerDay,
    maxInputTokensPerDay: merged.maxInputTokensPerDay,
    maxOutputTokensPerDay: merged.maxOutputTokensPerDay,
    notes: update.notes !== undefined ? update.notes : current.notes,
    updatedBy: actorId,
    updatedAt: now,
  };
  await app.db
    .insert(agentPolicies)
    .values(values)
    .onConflictDoUpdate({
      target: [agentPolicies.companyId, agentPolicies.agentKind],
      set: {
        enabled: values.enabled,
        authorisation: values.authorisation,
        autoApplyMinConfidence: values.autoApplyMinConfidence,
        minConfidence: values.minConfidence,
        allowedTargetTypes: values.allowedTargetTypes,
        allowedRoles: values.allowedRoles,
        maxRunsPerDay: values.maxRunsPerDay,
        maxInputTokensPerDay: values.maxInputTokensPerDay,
        maxOutputTokensPerDay: values.maxOutputTokensPerDay,
        notes: values.notes,
        updatedBy: values.updatedBy,
        updatedAt: values.updatedAt,
      },
    });
  return loadEffectivePolicy(app, companyId, agentKind);
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export interface UsageCounters {
  runs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export const ZERO_USAGE: UsageCounters = {
  runs: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

/** UTC calendar day — the budget window. */
export function usageDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function readUsage(
  db: Db,
  companyId: string,
  date: string,
  agentKind: string,
): Promise<UsageCounters> {
  const [row] = await db
    .select()
    .from(agentUsageDaily)
    .where(
      and(
        eq(agentUsageDaily.companyId, companyId),
        eq(agentUsageDaily.usageDate, date),
        eq(agentUsageDaily.agentKind, agentKind),
      ),
    )
    .limit(1);
  if (!row) return { ...ZERO_USAGE };
  return {
    runs: row.runs,
    failures: row.failures,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.estimatedCostMicros,
  };
}

/** Atomic increment; the unique index makes the upsert the concurrency guard. */
export async function bookUsage(
  db: Db,
  companyId: string,
  date: string,
  agentKind: string,
  delta: UsageCounters,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(agentUsageDaily)
    .values({
      id: newId("ausg"),
      companyId,
      usageDate: date,
      agentKind,
      runs: delta.runs,
      failures: delta.failures,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      estimatedCostMicros: delta.costMicros,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentUsageDaily.companyId, agentUsageDaily.usageDate, agentUsageDaily.agentKind],
      set: {
        runs: sql`${agentUsageDaily.runs} + ${delta.runs}`,
        failures: sql`${agentUsageDaily.failures} + ${delta.failures}`,
        inputTokens: sql`${agentUsageDaily.inputTokens} + ${delta.inputTokens}`,
        outputTokens: sql`${agentUsageDaily.outputTokens} + ${delta.outputTokens}`,
        estimatedCostMicros: sql`${agentUsageDaily.estimatedCostMicros} + ${delta.costMicros}`,
        updatedAt: now,
      },
    });
}

/* ------------------------------------------------------------------ */
/* The ceiling check (pure — unit-tested)                              */
/* ------------------------------------------------------------------ */

export interface BudgetVerdict {
  allowed: boolean;
  reason: string;
  detail: Record<string, unknown>;
}

/**
 * Would one more run of this kind breach today's ceiling? Pure: the caller
 * supplies the policy and the counters, so the decision is testable without
 * a database and identical on every code path that asks.
 */
export function budgetVerdict(policy: EffectivePolicy, used: UsageCounters): BudgetVerdict {
  const detail = {
    agentKind: policy.agentKind,
    used,
    limits: {
      maxRunsPerDay: policy.maxRunsPerDay,
      maxInputTokensPerDay: policy.maxInputTokensPerDay,
      maxOutputTokensPerDay: policy.maxOutputTokensPerDay,
    },
    policySource: policy.source,
  };
  if (policy.maxRunsPerDay !== null && used.runs >= policy.maxRunsPerDay) {
    return {
      allowed: false,
      reason: `Daily run budget reached for "${policy.agentKind}" (${used.runs}/${policy.maxRunsPerDay} runs today)`,
      detail,
    };
  }
  if (policy.maxInputTokensPerDay !== null && used.inputTokens >= policy.maxInputTokensPerDay) {
    return {
      allowed: false,
      reason: `Daily input-token budget reached for "${policy.agentKind}" (${used.inputTokens}/${policy.maxInputTokensPerDay} tokens today)`,
      detail,
    };
  }
  if (policy.maxOutputTokensPerDay !== null && used.outputTokens >= policy.maxOutputTokensPerDay) {
    return {
      allowed: false,
      reason: `Daily output-token budget reached for "${policy.agentKind}" (${used.outputTokens}/${policy.maxOutputTokensPerDay} tokens today)`,
      detail,
    };
  }
  return { allowed: true, reason: "Within budget", detail };
}

/**
 * May a proposal for `targetType` be applied without a human, given the
 * policy and the confidence the platform computed (not the model's raw one)?
 * Pure, and deliberately conservative: anything it cannot justify is a no.
 */
export function autoApplyVerdict(
  policy: EffectivePolicy,
  targetType: string,
  confidence: number | null,
  lowConsequenceTypes: readonly string[],
): { auto: boolean; reason: string } {
  if (policy.authorisation === "propose_only") {
    return { auto: false, reason: "Policy is propose-only: a human approves every proposal" };
  }
  if (!lowConsequenceTypes.includes(targetType)) {
    return {
      auto: false,
      reason: `"${targetType}" is not a low-consequence target type; auto-apply is never permitted for it`,
    };
  }
  if (policy.allowedTargetTypes.length > 0 && !policy.allowedTargetTypes.includes(targetType)) {
    return { auto: false, reason: `Policy does not allow "${targetType}"` };
  }
  if (policy.authorisation === "auto_apply") {
    return { auto: true, reason: "Policy authorises auto-apply for this target type" };
  }
  const threshold = policy.autoApplyMinConfidence;
  if (threshold === null) {
    return { auto: false, reason: "Policy has no auto-apply confidence threshold set" };
  }
  if (confidence === null) {
    return { auto: false, reason: "No confidence could be computed for this proposal" };
  }
  if (confidence < threshold) {
    return {
      auto: false,
      reason: `Confidence ${confidence} is below the policy threshold ${threshold}`,
    };
  }
  return { auto: true, reason: `Confidence ${confidence} meets the policy threshold ${threshold}` };
}
