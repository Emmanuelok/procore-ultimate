/**
 * Provenance for one `ai_runs` row.
 *
 * `ai_runs` predates this wave and its columns are frozen, but a run cannot be
 * explained after the fact without knowing which prompt version produced it,
 * how much evidence it was given, how many of its citations were invented and
 * whether a person or a schedule asked for it (Vol II X #1017–#1018, #1026,
 * #1027). Those facts live here, keyed 1:1 on the run id.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentRunMeta } from "@constructos/db";
import type { AgentRunSource } from "@constructos/shared";
import type { Db } from "../../lib/db.js";

export interface RunMetaWrite {
  runId: string;
  companyId: string;
  projectId: string | null;
  agentKind: string;
  promptVersion: string;
  agentVersion: string;
  source: AgentRunSource;
  sourceRef: string | null;
  evidenceScore: number | null;
  evidenceBasis: Record<string, unknown>;
  citationCount: number;
  droppedCitations: number;
  inputRefCount: number;
  dataCategories: string[];
}

export type RunMetaRow = typeof agentRunMeta.$inferSelect;

/** Idempotent: a run id is written once, so a retry never doubles a row. */
export async function recordRunMeta(db: Db, meta: RunMetaWrite): Promise<void> {
  await db
    .insert(agentRunMeta)
    .values({
      runId: meta.runId,
      companyId: meta.companyId,
      projectId: meta.projectId,
      agentKind: meta.agentKind,
      promptVersion: meta.promptVersion,
      agentVersion: meta.agentVersion,
      source: meta.source,
      sourceRef: meta.sourceRef,
      evidenceScore: meta.evidenceScore,
      evidenceBasis: meta.evidenceBasis,
      citationCount: meta.citationCount,
      droppedCitations: meta.droppedCitations,
      inputRefCount: meta.inputRefCount,
      dataCategories: meta.dataCategories,
    })
    .onConflictDoNothing({ target: agentRunMeta.runId });
}

/** Record what the run went on to produce once the proposals exist. */
export async function noteRunOutcome(
  db: Db,
  runId: string,
  outcome: { proposalCount: number; actionCount: number },
): Promise<void> {
  await db
    .update(agentRunMeta)
    .set({ proposalCount: outcome.proposalCount, actionCount: outcome.actionCount })
    .where(eq(agentRunMeta.runId, runId));
}

export async function loadRunMeta(
  db: Db,
  companyId: string,
  runId: string,
): Promise<RunMetaRow | null> {
  const [row] = await db
    .select()
    .from(agentRunMeta)
    .where(and(eq(agentRunMeta.runId, runId), eq(agentRunMeta.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

export async function loadRunMetaMany(
  db: Db,
  companyId: string,
  runIds: string[],
): Promise<Map<string, RunMetaRow>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(agentRunMeta)
    .where(and(eq(agentRunMeta.companyId, companyId), inArray(agentRunMeta.runId, runIds)));
  return new Map(rows.map((r) => [r.runId, r]));
}

/**
 * Which prompt versions of which agents are actually in use, newest first —
 * the model-transparency report's spine (#775, #1027).
 */
export async function promptVersionsInUse(
  db: Db,
  companyId: string,
  limit = 500,
): Promise<RunMetaRow[]> {
  return db
    .select()
    .from(agentRunMeta)
    .where(eq(agentRunMeta.companyId, companyId))
    .orderBy(desc(agentRunMeta.createdAt))
    .limit(limit);
}
