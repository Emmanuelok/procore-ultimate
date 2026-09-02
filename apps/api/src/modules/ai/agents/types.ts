/**
 * What an agent IS, on this platform.
 *
 * An agent is not a prompt. It is four things declared together so the
 * console, the policy engine, the scheduler and the audit trail all read the
 * same definition:
 *
 *   gather()   pulls REAL rows, scoped to the tenant and the project, and
 *              renders them as numbered evidence the model must cite from.
 *              If there is nothing to look at it says so and the run never
 *              happens — an agent that invents work is worse than none.
 *   schema     the exact JSON the model must return. Confidence is REQUIRED
 *              (X #1018); a run without it fails rather than being stored
 *              with an implied certainty nobody supplied.
 *   propose()  turns the model's output into proposals for the review queue
 *              (and, where the finding is an anomaly, a `signals` row). No
 *              agent writes to an operational record directly.
 *   summarise() one honest line for the run log.
 *
 * The registry (../registry.ts) exposes these as descriptors on GET /agents
 * and registers each kind's default policy at import time.
 */
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type {
  AgentCategory,
  AgentDataCategory,
  AgentTargetType,
  SignalSeverity,
} from "@constructos/shared";
import type { Db } from "../../../lib/db.js";
import type { PolicyDefaults } from "../policy.js";
import type { InputRef } from "../service.js";

export interface AgentContext {
  app: FastifyInstance;
  db: Db;
  companyId: string;
  projectId: string | null;
  params: Record<string, unknown>;
  now: Date;
}

export interface GatherResult {
  /** the grounded evidence block placed in the prompt */
  context: string;
  inputRefs: InputRef[];
  /** set when there is nothing to analyse: the model is never called */
  skip?: string;
  /** how many of the supplied records could contradict the proposition */
  contradictions?: number;
  /** facts the proposer needs that do not belong in the prompt */
  facts?: Record<string, unknown>;
}

export interface ProposalSignal {
  detector: string;
  severity: SignalSeverity;
  title: string;
  explanation: string;
  evidenceRefs: unknown[];
}

export interface ProposalDraft {
  targetType: AgentTargetType;
  targetId: string | null;
  summary: string;
  proposal: Record<string, unknown>;
  /** the model's own confidence; the runner damps it by the evidence score */
  confidence: number | null;
  /** raise an integrity/risk signal alongside the queue item */
  signal?: ProposalSignal;
}

export interface AgentDefinition<T = unknown> {
  kind: string;
  name: string;
  description: string;
  category: AgentCategory;
  /** where the agent can be run from */
  scope: "project" | "company" | "both";
  inputs: string[];
  outputs: string[];
  dataCategories: AgentDataCategory[];
  targetTypes: AgentTargetType[];
  /** true when an approved proposal changes an operational record */
  consequential: boolean;
  schedulable: boolean;
  /** fail the run when nothing the model cited was actually supplied */
  requireCitations: boolean;
  maxTokens?: number;
  defaults?: Partial<PolicyDefaults>;
  schema: z.ZodType<T>;
  system: string;
  gather(ctx: AgentContext): Promise<GatherResult>;
  propose(output: T, ctx: AgentContext, gathered: GatherResult): ProposalDraft[];
  summarise(output: T, proposals: ProposalDraft[]): string;
}

/** Erased definition — what the registry and the runner hold. */
export type AnyAgentDefinition = AgentDefinition<never> & {
  schema: z.ZodType<unknown>;
  propose(output: unknown, ctx: AgentContext, gathered: GatherResult): ProposalDraft[];
  summarise(output: unknown, proposals: ProposalDraft[]): string;
};

/** Narrow a definition to the erased form the registry stores. */
export function defineAgent<T>(def: AgentDefinition<T>): AnyAgentDefinition {
  return def as unknown as AnyAgentDefinition;
}

/* ------------------------------------------------------------------ */
/* Evidence rendering — shared by every gather()                       */
/* ------------------------------------------------------------------ */

export interface EvidenceRow {
  type: string;
  id: string;
  label: string;
  detail: string;
}

/**
 * Render rows as `[n] type=… id=… — label` blocks. Every agent cites by the
 * type/id in this header, which is exactly what `validateCitations` checks
 * against, so a citation is either a record that was supplied or it is
 * dropped.
 */
export function renderEvidence(rows: EvidenceRow[]): string {
  return rows
    .map((r, i) => `[${i + 1}] type=${r.type} id=${r.id} — ${r.label}\n${r.detail}`)
    .join("\n\n");
}

export function refsOf(rows: EvidenceRow[]): InputRef[] {
  return rows.map((r) => ({ type: r.type, id: r.id }));
}

/** Trim a free-text field to a sane prompt budget without lying about it. */
export function clip(text: string | null | undefined, max: number): string {
  if (!text) return "(none)";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}… [truncated ${clean.length - max} chars]`;
}

export function isoDay(value: string | Date | null | undefined): string {
  if (!value) return "(none)";
  const d = typeof value === "string" ? value : value.toISOString();
  return d.slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: Date, to: string | null | undefined): number | null {
  if (!to) return null;
  const t = Date.parse(to.length === 10 ? `${to}T00:00:00.000Z` : to);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - from.getTime()) / 86_400_000);
}
