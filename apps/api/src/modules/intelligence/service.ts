/**
 * Intelligence service — the orchestration between the pure engines and
 * the tables (Vol I §6.1–6.3 #731–758, §7 #776–789; Vol II X #1010–1012).
 *
 *   computeProjectHealth   inputs → engine → snapshot (+ ledger on a level change)
 *   refreshAttention       sources → engine → idempotent upsert, resolve the gone
 *   refreshPulse           latest health + attention → company snapshot + "since yesterday"
 *   readPulse              the one fast read the Pulse page makes
 *   runCompanyRefresh      what the scheduler jobs and the admin button call
 *
 * Idempotency: a snapshot identical to the latest one within six hours is
 * not re-inserted; an attention row keeps its id (and therefore its
 * dismissal) across refreshes; a level change is ledgered once, when it
 * happens. Every write is company-scoped; every read that lists across
 * projects accepts a visibility set (plan §6.3).
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  attentionItems,
  projectHealthSnapshots,
  projectMemberships,
  projects,
  pulseBriefings,
  pulseSnapshots,
} from "@constructos/db";
import type { HealthLevel, HealthRecomputeTrigger } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";
import { rankCandidates } from "./attention-engine.js";
import { collectAttentionCandidates, type ProjectLite } from "./attention-sources.js";
import { scoreHealth, type HealthComputation } from "./health-engine.js";
import { loadHealthInputs } from "./health-inputs.js";
import type {
  AttentionItem,
  BriefingSummary,
  HealthDimension,
  HealthTrendPoint,
  PortfolioRollup,
  ProjectHealth,
  PulseChanges,
  PulseResponse,
} from "./types.js";

export type { ProjectLite } from "./attention-sources.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** identical snapshots inside this window are not re-inserted */
const SNAPSHOT_DEDUPE_MS = 6 * HOUR_MS;
const HEALTH_RETENTION_DAYS = 90;
const PULSE_RETENTION_DAYS = 30;
const TREND_DAYS = 14;
const MAX_PROJECTS_PER_COMPANY = 1000;
/** above this, a first Pulse read does not recompute the whole portfolio inline */
const COLD_READ_PROJECT_LIMIT = 25;

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** ProjectHealth plus the display fields the Pulse grid wants. */
export interface ProjectHealthRow extends ProjectHealth {
  projectName: string | null;
  stage: string | null;
  currency: string | null;
  ratedDimensions: number;
  basis: string;
  snapshotId: string | null;
}

type SnapshotRow = typeof projectHealthSnapshots.$inferSelect;

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export async function listCompanyProjects(db: Db, companyId: string): Promise<ProjectLite[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      stage: projects.stage,
      currency: projects.currency,
      finishDate: projects.finishDate,
    })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.isTemplate, 0)))
    .orderBy(asc(projects.name))
    .limit(MAX_PROJECTS_PER_COMPANY);
  return rows;
}

async function loadProjectLite(db: Db, companyId: string, projectId: string): Promise<ProjectLite | null> {
  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      stage: projects.stage,
      currency: projects.currency,
      finishDate: projects.finishDate,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

function snapshotToHealth(
  row: SnapshotRow,
  project: ProjectLite | null,
  trend: HealthTrendPoint[],
): ProjectHealthRow {
  const dims = (row.dimensions as HealthDimension[]) ?? [];
  return {
    projectId: row.projectId,
    projectName: project?.name ?? null,
    stage: project?.stage ?? null,
    currency: project?.currency ?? null,
    level: row.level as HealthLevel,
    score: row.score,
    dimensions: dims,
    computedAt: new Date(row.computedAt).toISOString(),
    trend,
    ratedDimensions: row.ratedDimensions,
    // the engine's own sentence, so a re-read explains the verdict exactly as
    // the computation did; the rebuild is only for rows written before the
    // column existed
    basis: row.basis && row.basis.length > 0 ? row.basis : overallBasisFromDims(dims, row.level as HealthLevel, row.ratedDimensions),
    snapshotId: row.id,
  };
}

function overallBasisFromDims(dims: HealthDimension[], level: HealthLevel, rated: number): string {
  if (level === "unrated") return "No dimension holds enough records to score.";
  const off = dims.filter((d) => d.level === "off_track").map((d) => d.key);
  const watch = dims.filter((d) => d.level === "watch").map((d) => d.key);
  let s = `Weighted mean of ${rated} rated dimension${rated === 1 ? "" : "s"} (${dims.length - rated} unrated).`;
  if (off.length > 0) s += ` Off track: ${off.join(", ")}.`;
  else if (watch.length > 0) s += ` On watch: ${watch.join(", ")}.`;
  return s;
}

/** Last snapshot per day for the trend window, oldest first, plus the newest point. */
export async function loadTrend(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
  days = TREND_DAYS,
): Promise<HealthTrendPoint[]> {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const dayExpr = sql`date_trunc('day', ${projectHealthSnapshots.computedAt})`;
  const rows = await db
    .selectDistinctOn([dayExpr], {
      computedAt: projectHealthSnapshots.computedAt,
      score: projectHealthSnapshots.score,
    })
    .from(projectHealthSnapshots)
    .where(
      and(
        eq(projectHealthSnapshots.companyId, companyId),
        eq(projectHealthSnapshots.projectId, projectId),
        gte(projectHealthSnapshots.computedAt, since),
      ),
    )
    .orderBy(dayExpr, desc(projectHealthSnapshots.computedAt))
    .limit(days + 1);
  return rows
    .map((r) => ({ at: new Date(r.computedAt).toISOString(), score: r.score }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

async function latestSnapshot(db: Db, companyId: string, projectId: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(projectHealthSnapshots)
    .where(and(eq(projectHealthSnapshots.companyId, companyId), eq(projectHealthSnapshots.projectId, projectId)))
    .orderBy(desc(projectHealthSnapshots.computedAt), desc(projectHealthSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

function sameComputation(a: SnapshotRow, b: HealthComputation): boolean {
  if (a.level !== b.level || a.score !== b.score || a.ratedDimensions !== b.ratedDimensions) return false;
  const prev = a.dimensions as HealthDimension[];
  if (prev.length !== b.dimensions.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const p = prev[i];
    const q = b.dimensions[i];
    if (!p || !q || p.key !== q.key || p.score !== q.score || p.level !== q.level) return false;
  }
  return true;
}

export interface ComputeOptions {
  /** who asked; null = the platform (scheduler / ledger hook) */
  actorId?: string | null;
}

export interface ComputeResult {
  health: ProjectHealthRow;
  inserted: boolean;
  previousLevel: HealthLevel | null;
  levelChanged: boolean;
}

/**
 * Compute, snapshot and (on a level change) ledger a project's health. The
 * manual trigger always writes a snapshot — a person asked and deserves a
 * row that says so; the automatic triggers dedupe against the latest.
 */
export async function computeProjectHealth(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
  trigger: HealthRecomputeTrigger,
  opts: ComputeOptions = {},
): Promise<ComputeResult> {
  const project = await loadProjectLite(db, companyId, projectId);
  if (!project) throw new Error(`Project ${projectId} is not in company ${companyId}`);
  const inputs = await loadHealthInputs(db, companyId, projectId, now);
  const computed = scoreHealth(inputs);
  const previous = await latestSnapshot(db, companyId, projectId);
  const previousLevel = (previous?.level as HealthLevel | undefined) ?? null;
  const levelChanged = previous !== null && previousLevel !== computed.level;

  const dedupe =
    trigger !== "manual" &&
    previous !== null &&
    sameComputation(previous, computed) &&
    now.getTime() - Date.parse(previous.computedAt) < SNAPSHOT_DEDUPE_MS;

  let row: SnapshotRow;
  let inserted = false;
  if (dedupe && previous) {
    row = previous;
  } else {
    const [created] = await db
      .insert(projectHealthSnapshots)
      .values({
        id: newId("hlt"),
        companyId,
        projectId,
        level: computed.level,
        score: computed.score,
        ratedDimensions: computed.ratedDimensions,
        dimensions: computed.dimensions,
        basis: computed.basis,
        trigger,
        computedAt: now.toISOString(),
      })
      .returning();
    row = created!;
    inserted = true;
  }

  if (levelChanged) {
    await appendLedger(db, {
      companyId,
      actorId: opts.actorId ?? null,
      action: "state_change",
      objectType: "project_health",
      objectId: projectId,
      projectId,
      storePayload: true,
      payload: {
        projectId,
        from: previousLevel,
        to: computed.level,
        score: computed.score,
        trigger,
        snapshotId: row.id,
        basis: computed.basis,
      },
    });
    if (computed.level === "off_track") {
      await notifyOffTrack(db, companyId, project, computed);
    }
  }

  const trend = await loadTrend(db, companyId, projectId, now);
  const health = snapshotToHealth(row, project, trend);
  health.basis = computed.basis;
  return { health, inserted, previousLevel, levelChanged };
}

/**
 * A project that just went off track is the one thing the intelligence layer
 * should say out loud: every member of the project is told once, on the
 * transition, with the off-track dimensions in the body. Bounded — a project
 * with a thousand members gets the first 200 told.
 */
async function notifyOffTrack(db: Db, companyId: string, project: ProjectLite, computed: HealthComputation): Promise<void> {
  const members = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.projectId, project.id)))
    .limit(200);
  if (members.length === 0) return;
  const off = computed.dimensions.filter((d) => d.level === "off_track").map((d) => d.key);
  await pushNotifications(
    db,
    members.map((m) => ({
      companyId,
      userId: m.userId,
      projectId: project.id,
      kind: "attention" as const,
      title: `${project.name} is off track${computed.score !== null ? ` (${computed.score}/100)` : ""}`,
      body: off.length > 0 ? `Off track: ${off.join(", ")}. ${computed.basis}` : computed.basis,
      recordType: "project_health",
      recordId: project.id,
    })),
  );
}

/** The latest snapshot as a ProjectHealth, or null when none has been taken. */
export async function latestHealth(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
): Promise<ProjectHealthRow | null> {
  const [project, snap] = await Promise.all([
    loadProjectLite(db, companyId, projectId),
    latestSnapshot(db, companyId, projectId),
  ]);
  if (!snap) return null;
  const trend = await loadTrend(db, companyId, projectId, now);
  return snapshotToHealth(snap, project, trend);
}

/** Read the latest health, computing one on this read when the project has none yet. */
export async function getOrComputeHealth(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
): Promise<{ health: ProjectHealthRow; computedOnRead: boolean }> {
  const existing = await latestHealth(db, companyId, projectId, now);
  if (existing) return { health: existing, computedOnRead: false };
  const result = await computeProjectHealth(db, companyId, projectId, now, "read");
  return { health: result.health, computedOnRead: true };
}

export async function listHealthHistory(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
  days: number,
  limit = 200,
): Promise<Array<{ id: string; computedAt: string; level: string; score: number | null; ratedDimensions: number; trigger: string; dimensions: HealthDimension[] }>> {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const rows = await db
    .select()
    .from(projectHealthSnapshots)
    .where(
      and(
        eq(projectHealthSnapshots.companyId, companyId),
        eq(projectHealthSnapshots.projectId, projectId),
        gte(projectHealthSnapshots.computedAt, since),
      ),
    )
    .orderBy(desc(projectHealthSnapshots.computedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    computedAt: new Date(r.computedAt).toISOString(),
    level: r.level,
    score: r.score,
    ratedDimensions: r.ratedDimensions,
    trigger: r.trigger,
    dimensions: r.dimensions as HealthDimension[],
  }));
}

/** Latest snapshot per project for a company, keyed by projectId. */
async function latestSnapshotPerProject(db: Db, companyId: string): Promise<Map<string, SnapshotRow>> {
  const rows = await db
    .selectDistinctOn([projectHealthSnapshots.projectId])
    .from(projectHealthSnapshots)
    .where(eq(projectHealthSnapshots.companyId, companyId))
    .orderBy(asc(projectHealthSnapshots.projectId), desc(projectHealthSnapshots.computedAt), desc(projectHealthSnapshots.createdAt))
    .limit(MAX_PROJECTS_PER_COMPANY);
  return new Map(rows.map((r) => [r.projectId, r] as const));
}

/** Last-of-day trend points for every project in one query, keyed by projectId. */
async function trendsPerProject(db: Db, companyId: string, now: Date): Promise<Map<string, HealthTrendPoint[]>> {
  const since = new Date(now.getTime() - TREND_DAYS * DAY_MS).toISOString();
  const dayExpr = sql`date_trunc('day', ${projectHealthSnapshots.computedAt})`;
  const rows = await db
    .selectDistinctOn([projectHealthSnapshots.projectId, dayExpr], {
      projectId: projectHealthSnapshots.projectId,
      computedAt: projectHealthSnapshots.computedAt,
      score: projectHealthSnapshots.score,
    })
    .from(projectHealthSnapshots)
    .where(and(eq(projectHealthSnapshots.companyId, companyId), gte(projectHealthSnapshots.computedAt, since)))
    .orderBy(asc(projectHealthSnapshots.projectId), dayExpr, desc(projectHealthSnapshots.computedAt))
    .limit(MAX_PROJECTS_PER_COMPANY * (TREND_DAYS + 1));
  const out = new Map<string, HealthTrendPoint[]>();
  for (const r of rows) {
    const list = out.get(r.projectId) ?? [];
    list.push({ at: new Date(r.computedAt).toISOString(), score: r.score });
    out.set(r.projectId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/* ------------------------------------------------------------------ */
/* Attention                                                           */
/* ------------------------------------------------------------------ */

export interface AttentionRefreshResult {
  candidates: number;
  upserted: number;
  resolved: number;
  open: number;
  /** source types that hold more than the sweep may keep — nothing there is resolved */
  truncatedSources: string[];
}

export interface RefreshAttentionOptions {
  /** refresh only this project's items (the single-project recompute path) */
  projectId?: string | null;
  /** true when the project list itself was capped: resolution is unsafe */
  projectsTruncated?: boolean;
  /** per-source row cap override (tests) */
  sourceLimit?: number;
}

/**
 * Idempotent: the same conditions produce the same ids, so a second run
 * updates rather than duplicates; rows whose source condition is gone are
 * resolved; a person's dismissal is preserved.
 *
 * Resolution is a claim ("the underlying condition is gone"), so it is only
 * made where the sweep actually looked: a source whose query hit its cap, and
 * every source at all when the project list was capped, is left alone — an
 * item pushed out of the top N by newer, more urgent ones is still live.
 */
export async function refreshAttention(
  db: Db,
  companyId: string,
  projectList: ProjectLite[],
  now: Date,
  opts: RefreshAttentionOptions = {},
): Promise<AttentionRefreshResult> {
  const onlyProject = opts.projectId ?? null;
  const { candidates, truncatedSources } = await collectAttentionCandidates(db, companyId, projectList, now, {
    projectId: onlyProject,
    sourceLimit: opts.sourceLimit,
  });
  const ranked = rankCandidates(candidates, now);
  const nowIso = now.toISOString();
  const seen = new Set<string>();
  for (const r of ranked) {
    seen.add(r.id);
    await db
      .insert(attentionItems)
      .values({
        id: r.id,
        companyId,
        projectId: r.projectId,
        projectName: r.projectName,
        kind: r.kind,
        severity: r.severity,
        title: r.title,
        detail: r.detail,
        dueAt: r.dueAt,
        href: r.href,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        score: r.score,
        money: r.money ?? null,
        currency: r.currency ?? null,
        status: "open",
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      })
      .onConflictDoUpdate({
        target: attentionItems.id,
        set: {
          projectName: r.projectName,
          severity: r.severity,
          title: r.title,
          detail: r.detail,
          dueAt: r.dueAt,
          href: r.href,
          score: r.score,
          money: r.money ?? null,
          currency: r.currency ?? null,
          lastSeenAt: nowIso,
          // a resolved condition that has come back is open again; a dismissal stands
          status: sql`case when ${attentionItems.status} = 'dismissed' then 'dismissed' else 'open' end`,
          resolvedAt: sql`case when ${attentionItems.status} = 'dismissed' then ${attentionItems.resolvedAt} else null end`,
        },
      });
  }
  // Resolve open rows this sweep no longer produced — but only from the
  // sources it actually exhausted, and only within the scope it swept.
  let toResolve: string[] = [];
  if (!opts.projectsTruncated) {
    const stale = await db
      .select({ id: attentionItems.id })
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.companyId, companyId),
          eq(attentionItems.status, "open"),
          lte(attentionItems.lastSeenAt, nowIso),
          onlyProject ? eq(attentionItems.projectId, onlyProject) : undefined,
          truncatedSources.length > 0 ? notInArray(attentionItems.sourceType, truncatedSources) : undefined,
        ),
      );
    toResolve = stale.map((s) => s.id).filter((id) => !seen.has(id));
    if (toResolve.length > 0) {
      await db
        .update(attentionItems)
        .set({ status: "resolved", resolvedAt: nowIso })
        .where(and(eq(attentionItems.companyId, companyId), inArray(attentionItems.id, toResolve)));
    }
  }
  const [openRow] = await db
    .select({ n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "open")));
  const truncated = opts.projectsTruncated ? [...truncatedSources, "projects"].sort() : truncatedSources;
  return { candidates: candidates.length, upserted: ranked.length, resolved: toResolve.length, open: n(openRow?.n), truncatedSources: truncated };
}

/**
 * Refresh one project's slice of the feed. This is what a person pressing
 * "recompute" on a project pays for: their project's sources, not the whole
 * company's (a company-wide sweep is the scheduler's job).
 */
export async function refreshProjectAttention(
  db: Db,
  companyId: string,
  projectId: string,
  now: Date,
): Promise<AttentionRefreshResult | null> {
  const project = await loadProjectLite(db, companyId, projectId);
  if (!project) return null;
  return refreshAttention(db, companyId, [project], now, { projectId });
}

type AttentionRow = typeof attentionItems.$inferSelect;

export function rowToAttention(r: AttentionRow): AttentionItem {
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: r.projectName,
    kind: r.kind,
    severity: r.severity as AttentionItem["severity"],
    title: r.title,
    detail: r.detail,
    dueAt: r.dueAt ? new Date(r.dueAt).toISOString() : null,
    href: r.href,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    score: r.score,
    money: r.money,
    currency: r.currency,
    status: r.status,
    firstSeenAt: new Date(r.firstSeenAt).toISOString(),
    lastSeenAt: new Date(r.lastSeenAt).toISOString(),
  };
}

export interface ListAttentionOptions {
  /** null = every project; a Set restricts project-scoped items (company-level items always pass) */
  visible: Set<string> | null;
  projectId?: string | null;
  status?: string;
  kind?: string;
  severity?: string;
  limit: number;
  offset?: number;
}

function visibilityCondition(visible: Set<string> | null) {
  if (visible === null) return undefined;
  const ids = [...visible];
  if (ids.length === 0) return isNull(attentionItems.projectId);
  return or(isNull(attentionItems.projectId), inArray(attentionItems.projectId, ids));
}

export async function listAttention(
  db: Db,
  companyId: string,
  opts: ListAttentionOptions,
): Promise<{ items: AttentionItem[]; total: number }> {
  const where = and(
    eq(attentionItems.companyId, companyId),
    eq(attentionItems.status, opts.status ?? "open"),
    opts.projectId ? eq(attentionItems.projectId, opts.projectId) : undefined,
    opts.kind ? eq(attentionItems.kind, opts.kind) : undefined,
    opts.severity ? eq(attentionItems.severity, opts.severity) : undefined,
    visibilityCondition(opts.visible),
  );
  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(attentionItems)
      .where(where)
      .orderBy(desc(attentionItems.score), asc(attentionItems.dueAt), asc(attentionItems.title))
      .limit(opts.limit)
      .offset(opts.offset ?? 0),
    db.select({ n: count() }).from(attentionItems).where(where),
  ]);
  return { items: rows.map(rowToAttention), total: n(totalRow[0]?.n) };
}

/** The company-level bucket of the per-project rollup (items with no project). */
export const COMPANY_ROLLUP_KEY = "_company";

export type ProjectRollup = Record<string, { level: string; attention: Record<string, number> }>;

const emptySeverityCounts = (): Record<string, number> => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/**
 * Open attention counted per project and severity, so a snapshot can be
 * re-read by someone who may only see part of the portfolio without either
 * leaking the company's totals or inventing a number.
 */
export async function attentionCountsByProject(db: Db, companyId: string): Promise<Record<string, Record<string, number>>> {
  const rows = await db
    .select({ projectId: attentionItems.projectId, severity: attentionItems.severity, n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "open")))
    .groupBy(attentionItems.projectId, attentionItems.severity);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const key = r.projectId ?? COMPANY_ROLLUP_KEY;
    const bucket = out[key] ?? emptySeverityCounts();
    bucket[r.severity] = n(r.n);
    out[key] = bucket;
  }
  return out;
}

/** Sum a stored rollup over the projects a caller may see (company items always count). */
export function rollupForVisible(
  rollup: ProjectRollup,
  visible: Set<string> | null,
): { byHealth: PortfolioRollup["byHealth"]; projects: number; openAttention: number; attentionBySeverity: Record<string, number> } {
  const byHealth = { on_track: 0, watch: 0, off_track: 0, unrated: 0 };
  const attentionBySeverity = emptySeverityCounts();
  let projectsCounted = 0;
  let open = 0;
  for (const [key, entry] of Object.entries(rollup)) {
    const isCompanyBucket = key === COMPANY_ROLLUP_KEY;
    if (!isCompanyBucket) {
      if (visible !== null && !visible.has(key)) continue;
      projectsCounted += 1;
      if (entry.level in byHealth) byHealth[entry.level as HealthLevel] += 1;
    }
    for (const [severity, value] of Object.entries(entry.attention ?? {})) {
      attentionBySeverity[severity] = (attentionBySeverity[severity] ?? 0) + value;
      open += value;
    }
  }
  return { byHealth, projects: projectsCounted, openAttention: open, attentionBySeverity };
}

export async function attentionBySeverity(
  db: Db,
  companyId: string,
  visible: Set<string> | null,
): Promise<{ counts: Record<string, number>; open: number }> {
  const rows = await db
    .select({ severity: attentionItems.severity, n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "open"), visibilityCondition(visible)))
    .groupBy(attentionItems.severity);
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let open = 0;
  for (const r of rows) {
    counts[r.severity] = n(r.n);
    open += n(r.n);
  }
  return { counts, open };
}

export async function getAttentionItem(db: Db, companyId: string, id: string): Promise<AttentionRow | null> {
  const [row] = await db
    .select()
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.id, id)))
    .limit(1);
  return row ?? null;
}

export async function setAttentionStatus(
  db: Db,
  companyId: string,
  id: string,
  next: "open" | "dismissed",
  actorId: string,
  reason: string | null,
  now: Date,
): Promise<AttentionRow> {
  const nowIso = now.toISOString();
  const [row] = await db
    .update(attentionItems)
    .set(
      next === "dismissed"
        ? { status: "dismissed", dismissedBy: actorId, dismissedAt: nowIso, dismissReason: reason }
        : { status: "open", dismissedBy: null, dismissedAt: null, dismissReason: null, resolvedAt: null },
    )
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.id, id)))
    .returning();
  return row!;
}

/* ------------------------------------------------------------------ */
/* Pulse                                                               */
/* ------------------------------------------------------------------ */

type PulseRow = typeof pulseSnapshots.$inferSelect;

function rollup(scores: ProjectHealthRow[]): PortfolioRollup {
  const byStage: Record<string, number> = {};
  const byHealth = { on_track: 0, watch: 0, off_track: 0, unrated: 0 };
  for (const s of scores) {
    const stage = s.stage ?? "unknown";
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    byHealth[s.level] += 1;
  }
  return { projects: scores.length, byStage, byHealth };
}

/** Every project's latest health (unrated placeholder when none), with trend. */
async function portfolioScores(db: Db, companyId: string, projectList: ProjectLite[], now: Date): Promise<ProjectHealthRow[]> {
  const [latest, trends] = await Promise.all([latestSnapshotPerProject(db, companyId), trendsPerProject(db, companyId, now)]);
  return projectList.map((p) => {
    const snap = latest.get(p.id);
    if (!snap) {
      return {
        projectId: p.id,
        projectName: p.name,
        stage: p.stage,
        currency: p.currency,
        level: "unrated",
        score: null,
        dimensions: [],
        computedAt: now.toISOString(),
        trend: [],
        ratedDimensions: 0,
        basis: "Health has not been computed for this project yet.",
        snapshotId: null,
      };
    }
    return snapshotToHealth(snap, p, trends.get(p.id) ?? []);
  });
}

async function previousPulse(db: Db, companyId: string, now: Date): Promise<PulseRow | null> {
  const cutoff = new Date(now.getTime() - 20 * HOUR_MS).toISOString();
  const [dayOld] = await db
    .select()
    .from(pulseSnapshots)
    .where(and(eq(pulseSnapshots.companyId, companyId), lte(pulseSnapshots.generatedAt, cutoff)))
    .orderBy(desc(pulseSnapshots.generatedAt))
    .limit(1);
  if (dayOld) return dayOld;
  const [earliest] = await db
    .select()
    .from(pulseSnapshots)
    .where(eq(pulseSnapshots.companyId, companyId))
    .orderBy(asc(pulseSnapshots.generatedAt))
    .limit(1);
  return earliest ?? null;
}

async function computeChanges(
  db: Db,
  companyId: string,
  scores: ProjectHealthRow[],
  openAttention: number,
  prev: PulseRow | null,
  now: Date,
): Promise<PulseChanges> {
  const since = prev ? new Date(prev.generatedAt).toISOString() : new Date(now.getTime() - DAY_MS).toISOString();
  const prevScores = new Map<string, { level: HealthLevel; score: number | null }>();
  if (prev) {
    for (const s of prev.scores as Array<{ projectId: string; level: HealthLevel; score: number | null }>) {
      prevScores.set(s.projectId, { level: s.level, score: s.score });
    }
  }
  const levelChanges: PulseChanges["levelChanges"] = [];
  for (const s of scores) {
    const p = prevScores.get(s.projectId);
    if (!p || p.level === s.level) continue;
    levelChanges.push({ projectId: s.projectId, projectName: s.projectName, from: p.level, to: s.level, scoreFrom: p.score, scoreTo: s.score });
  }
  const [newRow] = await db
    .select({ n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "open"), gte(attentionItems.firstSeenAt, since)));
  const [resolvedRow] = await db
    .select({ n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "resolved"), gte(attentionItems.resolvedAt, since)));
  return {
    since: prev ? since : null,
    levelChanges,
    newAttention: n(newRow?.n),
    resolvedAttention: n(resolvedRow?.n),
    openAttentionFrom: prev ? prev.openAttention : null,
    openAttentionTo: openAttention,
  };
}

function samePulse(
  prev: PulseRow,
  portfolio: PortfolioRollup,
  bySeverity: Record<string, number>,
  open: number,
  truncatedSources: string[],
): boolean {
  return (
    JSON.stringify(prev.portfolio) === JSON.stringify(portfolio) &&
    JSON.stringify(prev.attentionBySeverity) === JSON.stringify(bySeverity) &&
    JSON.stringify(prev.truncatedSources ?? []) === JSON.stringify(truncatedSources) &&
    prev.openAttention === open
  );
}

export interface RefreshPulseOptions {
  force?: boolean;
  /** what the attention sweep that preceded this snapshot could not exhaust */
  truncatedSources?: string[];
}

/** Build and store the company snapshot. Identical snapshots inside six hours are not re-inserted. */
export async function refreshPulse(db: Db, companyId: string, now: Date, opts: RefreshPulseOptions = {}): Promise<PulseRow> {
  const projectList = await listCompanyProjects(db, companyId);
  const scores = await portfolioScores(db, companyId, projectList, now);
  const portfolio = rollup(scores);
  const [{ counts, open }, byProject] = await Promise.all([
    attentionBySeverity(db, companyId, null),
    attentionCountsByProject(db, companyId),
  ]);
  const projectRollup: ProjectRollup = {};
  for (const s of scores) {
    projectRollup[s.projectId] = { level: s.level, attention: byProject[s.projectId] ?? emptySeverityCounts() };
  }
  const companyBucket = byProject[COMPANY_ROLLUP_KEY];
  if (companyBucket) projectRollup[COMPANY_ROLLUP_KEY] = { level: "unrated", attention: companyBucket };
  const [latest] = await db
    .select()
    .from(pulseSnapshots)
    .where(eq(pulseSnapshots.companyId, companyId))
    .orderBy(desc(pulseSnapshots.generatedAt))
    .limit(1);
  // A refresh that did not sweep the sources (a project-scoped recompute)
  // carries the last sweep's truncation forward rather than claiming none.
  const truncatedSources = opts.truncatedSources ?? ((latest?.truncatedSources ?? []) as string[]);
  if (
    !opts.force &&
    latest &&
    samePulse(latest, portfolio, counts, open, truncatedSources) &&
    now.getTime() - Date.parse(latest.generatedAt) < SNAPSHOT_DEDUPE_MS
  ) {
    return latest;
  }
  const prev = await previousPulse(db, companyId, now);
  const changes = await computeChanges(db, companyId, scores, open, prev, now);
  const [created] = await db
    .insert(pulseSnapshots)
    .values({
      id: newId("pls"),
      companyId,
      generatedAt: now.toISOString(),
      portfolio: { ...portfolio },
      scores,
      attentionBySeverity: counts,
      openAttention: open,
      projectRollup,
      truncatedSources,
      changes: { ...changes },
    })
    .returning();
  return created!;
}

export async function latestPulseSnapshot(db: Db, companyId: string): Promise<PulseRow | null> {
  const [row] = await db
    .select()
    .from(pulseSnapshots)
    .where(eq(pulseSnapshots.companyId, companyId))
    .orderBy(desc(pulseSnapshots.generatedAt))
    .limit(1);
  return row ?? null;
}

export interface PulseHistoryPoint {
  generatedAt: string;
  byHealth: PortfolioRollup["byHealth"];
  projects: number;
  openAttention: number;
  attentionBySeverity: Record<string, number>;
}

/**
 * The daily portfolio series. A caller who can only see some projects gets
 * their slice, rebuilt from the snapshot's per-project rollup — never the
 * company's totals (plan §6.3). A snapshot taken before the rollup existed
 * cannot be sliced honestly, so it is left out of a restricted series rather
 * than reported as zeros.
 */
export async function pulseHistory(
  db: Db,
  companyId: string,
  now: Date,
  days: number,
  visible: Set<string> | null = null,
): Promise<PulseHistoryPoint[]> {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const dayExpr = sql`date_trunc('day', ${pulseSnapshots.generatedAt})`;
  const rows = await db
    .selectDistinctOn([dayExpr], {
      generatedAt: pulseSnapshots.generatedAt,
      portfolio: pulseSnapshots.portfolio,
      openAttention: pulseSnapshots.openAttention,
      attentionBySeverity: pulseSnapshots.attentionBySeverity,
      projectRollup: pulseSnapshots.projectRollup,
    })
    .from(pulseSnapshots)
    .where(and(eq(pulseSnapshots.companyId, companyId), gte(pulseSnapshots.generatedAt, since)))
    .orderBy(dayExpr, desc(pulseSnapshots.generatedAt))
    .limit(days + 1);
  const out: PulseHistoryPoint[] = [];
  for (const r of rows) {
    const generatedAt = new Date(r.generatedAt).toISOString();
    if (visible === null) {
      const pf = r.portfolio as unknown as PortfolioRollup;
      out.push({
        generatedAt,
        byHealth: pf.byHealth ?? { on_track: 0, watch: 0, off_track: 0, unrated: 0 },
        projects: pf.projects ?? 0,
        openAttention: r.openAttention,
        attentionBySeverity: r.attentionBySeverity,
      });
      continue;
    }
    const stored = (r.projectRollup ?? {}) as ProjectRollup;
    if (Object.keys(stored).length === 0) continue;
    const slice = rollupForVisible(stored, visible);
    out.push({ generatedAt, ...slice });
  }
  return out.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

export async function latestBriefing(db: Db, companyId: string, projectId: string | null) {
  const [row] = await db
    .select()
    .from(pulseBriefings)
    .where(and(eq(pulseBriefings.companyId, companyId), projectId ? eq(pulseBriefings.projectId, projectId) : isNull(pulseBriefings.projectId)))
    .orderBy(desc(pulseBriefings.generatedAt))
    .limit(1);
  return row ?? null;
}

export function briefingSummary(row: Awaited<ReturnType<typeof latestBriefing>>, aiEnabled: boolean): BriefingSummary {
  if (!row) {
    return {
      text: null,
      runId: null,
      reason: aiEnabled ? "never_generated" : "ai_disabled",
      id: null,
      generatedAt: null,
      headline: null,
      proposals: 0,
    };
  }
  return {
    text: row.summary,
    runId: row.runId,
    reason: null,
    id: row.id,
    generatedAt: new Date(row.generatedAt).toISOString(),
    headline: row.headline,
    proposals: (row.proposals as unknown[]).length,
  };
}

export interface ReadPulseOptions {
  visible: Set<string> | null;
  attentionLimit: number;
  aiEnabled: boolean;
}

/**
 * The Pulse read. One snapshot row, one attention page, one briefing row —
 * and a build on this request only when the company has never been swept.
 */
export async function readPulse(db: Db, companyId: string, now: Date, opts: ReadPulseOptions): Promise<PulseResponse> {
  let snap = await latestPulseSnapshot(db, companyId);
  let computedOnRead = false;
  if (!snap) {
    // First ever read for this company: build something honest inside the
    // request, but never a whole portfolio's health — past a handful of
    // projects the scheduler's sweep (boot + every 15 min) does that work,
    // and this read shows "unrated" until it has, rather than blocking.
    const projectList = await listCompanyProjects(db, companyId);
    if (projectList.length <= COLD_READ_PROJECT_LIMIT) {
      await runCompanyRefresh(db, companyId, now, "read");
    } else {
      const attention = await refreshAttention(db, companyId, projectList, now, {
        projectsTruncated: projectList.length >= MAX_PROJECTS_PER_COMPANY,
      });
      await refreshPulse(db, companyId, now, { truncatedSources: attention.truncatedSources });
      for (const p of projectList) markProjectDirty(db, companyId, p.id, "project", "read");
    }
    snap = await latestPulseSnapshot(db, companyId);
    computedOnRead = true;
  }
  const allScores = (snap?.scores ?? []) as ProjectHealthRow[];
  const scores = opts.visible === null ? allScores : allScores.filter((s) => opts.visible!.has(s.projectId));
  const portfolio = opts.visible === null ? ((snap?.portfolio as unknown as PortfolioRollup) ?? rollup(scores)) : rollup(scores);
  const [{ items: attention }, sev, briefing] = await Promise.all([
    listAttention(db, companyId, { visible: opts.visible, limit: opts.attentionLimit }),
    attentionBySeverity(db, companyId, opts.visible),
    latestBriefing(db, companyId, null),
  ]);
  const storedChanges = (snap?.changes ?? {}) as Partial<PulseChanges>;
  const visibleIds = opts.visible;
  const changes: PulseChanges =
    visibleIds === null
      ? {
          since: storedChanges.since ?? null,
          levelChanges: storedChanges.levelChanges ?? [],
          newAttention: storedChanges.newAttention ?? 0,
          resolvedAttention: storedChanges.resolvedAttention ?? 0,
          openAttentionFrom: storedChanges.openAttentionFrom ?? null,
          openAttentionTo: storedChanges.openAttentionTo ?? sev.open,
        }
      : // A partial view must not carry the company's totals beside its own
        // filtered figures: recount the movements over the visible projects
        // and read the "from" out of the snapshot this one is compared against.
        await visibleChanges(db, companyId, storedChanges, visibleIds, sev.open, now);
  return {
    generatedAt: snap ? new Date(snap.generatedAt).toISOString() : now.toISOString(),
    portfolio,
    attention,
    attentionBySeverity: sev.counts,
    openAttention: sev.open,
    scores,
    briefing: briefingSummary(briefing, opts.aiEnabled),
    changes,
    attentionTruncated: (snap?.truncatedSources ?? []) as string[],
    computedOnRead,
  };
}

/** The "since yesterday" figures counted over the projects this caller may see. */
async function visibleChanges(
  db: Db,
  companyId: string,
  stored: Partial<PulseChanges>,
  visible: Set<string>,
  openNow: number,
  now: Date,
): Promise<PulseChanges> {
  const since = stored.since ?? new Date(now.getTime() - DAY_MS).toISOString();
  const scope = visibilityCondition(visible);
  const [newRow] = await db
    .select({ n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "open"), gte(attentionItems.firstSeenAt, since), scope));
  const [resolvedRow] = await db
    .select({ n: count() })
    .from(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "resolved"), gte(attentionItems.resolvedAt, since), scope));
  let openFrom: number | null = null;
  if (stored.since) {
    const [prevSnap] = await db
      .select({ projectRollup: pulseSnapshots.projectRollup })
      .from(pulseSnapshots)
      .where(and(eq(pulseSnapshots.companyId, companyId), lte(pulseSnapshots.generatedAt, stored.since)))
      .orderBy(desc(pulseSnapshots.generatedAt))
      .limit(1);
    const rollupRow = (prevSnap?.projectRollup ?? {}) as ProjectRollup;
    if (Object.keys(rollupRow).length > 0) openFrom = rollupForVisible(rollupRow, visible).openAttention;
  }
  return {
    since: stored.since ?? null,
    levelChanges: (stored.levelChanges ?? []).filter((c) => visible.has(c.projectId)),
    newAttention: n(newRow?.n),
    resolvedAttention: n(resolvedRow?.n),
    openAttentionFrom: openFrom,
    openAttentionTo: openNow,
  };
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                              */
/* ------------------------------------------------------------------ */

export interface CompanyRefreshResult {
  projects: number;
  recomputed: number;
  levelChanges: number;
  attention: AttentionRefreshResult;
  pulseId: string;
  /** sources holding more than the sweep may keep (see refreshAttention) */
  truncatedSources: string[];
}

/** Recompute every project, refresh the feed, take the company snapshot, prune history. */
export async function runCompanyRefresh(
  db: Db,
  companyId: string,
  now: Date,
  trigger: HealthRecomputeTrigger,
  projectIds?: string[],
): Promise<CompanyRefreshResult> {
  const projectList = await listCompanyProjects(db, companyId);
  const targets = projectIds ? projectList.filter((p) => projectIds.includes(p.id)) : projectList;
  let recomputed = 0;
  let levelChanges = 0;
  for (const p of targets) {
    const r = await computeProjectHealth(db, companyId, p.id, now, trigger);
    if (r.inserted) recomputed += 1;
    if (r.levelChanged) levelChanges += 1;
  }
  const attention = await refreshAttention(db, companyId, projectList, now, {
    projectsTruncated: projectList.length >= MAX_PROJECTS_PER_COMPANY,
  });
  const pulse = await refreshPulse(db, companyId, now, { truncatedSources: attention.truncatedSources });
  await pruneHistory(db, companyId, now);
  return {
    projects: targets.length,
    recomputed,
    levelChanges,
    attention,
    pulseId: pulse.id,
    truncatedSources: attention.truncatedSources,
  };
}

export async function pruneHistory(db: Db, companyId: string, now: Date): Promise<void> {
  const healthCutoff = new Date(now.getTime() - HEALTH_RETENTION_DAYS * DAY_MS).toISOString();
  const pulseCutoff = new Date(now.getTime() - PULSE_RETENTION_DAYS * DAY_MS).toISOString();
  await db
    .delete(projectHealthSnapshots)
    .where(and(eq(projectHealthSnapshots.companyId, companyId), lt(projectHealthSnapshots.computedAt, healthCutoff)));
  await db
    .delete(pulseSnapshots)
    .where(and(eq(pulseSnapshots.companyId, companyId), lt(pulseSnapshots.generatedAt, pulseCutoff)));
  // resolved attention rows are history, not a feed: drop them after the pulse window
  await db
    .delete(attentionItems)
    .where(and(eq(attentionItems.companyId, companyId), eq(attentionItems.status, "resolved"), lt(attentionItems.resolvedAt, pulseCutoff)));
}

/* ------------------------------------------------------------------ */
/* Ledger-driven recompute (throttled)                                  */
/* ------------------------------------------------------------------ */

interface DirtyEntry {
  companyId: string;
  projectId: string;
  markedAt: number;
}

/** Per-database dirty set: a test file may hold several apps and an event must stay with its own. */
const dirtyByDb = new WeakMap<object, Map<string, DirtyEntry>>();

/** Object types the layer itself writes — never a reason to recompute, or the loop never ends. */
const SELF_OBJECT_TYPES = new Set(["project_health", "attention_item", "pulse_briefing", "pulse_snapshot", "ai_review_item"]);

export function markProjectDirty(db: Db, companyId: string, projectId: string, objectType: string, action: string, at = Date.now()): boolean {
  if (SELF_OBJECT_TYPES.has(objectType) || action === "access") return false;
  let map = dirtyByDb.get(db as object);
  if (!map) {
    map = new Map();
    dirtyByDb.set(db as object, map);
  }
  const key = `${companyId}:${projectId}`;
  if (!map.has(key)) map.set(key, { companyId, projectId, markedAt: at });
  return true;
}

export function dirtyProjects(db: Db): DirtyEntry[] {
  return [...(dirtyByDb.get(db as object)?.values() ?? [])];
}

/**
 * Drain the dirty set: one recompute per project since the last drain,
 * then one attention/pulse refresh per affected company. The job interval
 * is the throttle — a burst of a hundred ledger events on one project costs
 * one recompute.
 */
export async function drainDirtyProjects(db: Db, now: Date): Promise<{ projects: number; companies: number; levelChanges: number }> {
  const map = dirtyByDb.get(db as object);
  if (!map || map.size === 0) return { projects: 0, companies: 0, levelChanges: 0 };
  const entries = [...map.values()];
  map.clear();
  const byCompany = new Map<string, string[]>();
  for (const e of entries) {
    const list = byCompany.get(e.companyId) ?? [];
    list.push(e.projectId);
    byCompany.set(e.companyId, list);
  }
  let levelChanges = 0;
  let projectsDone = 0;
  for (const [companyId, ids] of byCompany) {
    const projectList = await listCompanyProjects(db, companyId);
    const known = new Set(projectList.map((p) => p.id));
    for (const pid of ids) {
      if (!known.has(pid)) continue;
      const r = await computeProjectHealth(db, companyId, pid, now, "event");
      projectsDone += 1;
      if (r.levelChanged) levelChanges += 1;
    }
    const attention = await refreshAttention(db, companyId, projectList, now, {
      projectsTruncated: projectList.length >= MAX_PROJECTS_PER_COMPANY,
    });
    await refreshPulse(db, companyId, now, { truncatedSources: attention.truncatedSources });
  }
  return { projects: projectsDone, companies: byCompany.size, levelChanges };
}
