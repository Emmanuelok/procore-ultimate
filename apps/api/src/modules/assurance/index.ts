/**
 * The assurance core (spec Vol III §4-§7, Vol II Domain A and Domain S).
 *
 * The eight primitives — Assertion, Evidence, Reconciliation, Obligation,
 * Event, Entity, Signal, Ledger Entry — plus the detector programme that reads
 * them, the integrity scoring that ranks what it finds, the cases that group
 * findings for referral, and the evidence packs that hand a bundle to someone
 * outside this deployment.
 *
 * THE ONE RULE. An Assertion and the Evidence that tests it must never come
 * from the same actor through the same pathway. Everything else here is
 * scaffolding around that sentence, and every place it is enforced says so.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO:
 *  • Draw conclusions. A detector raises a QUESTION with arithmetic attached;
 *    only a reviewer's disposition turns it into a finding.
 *  • Seal or anchor the chain — `modules/anchoring` owns that, including the
 *    heartbeat and the incremental verification watermark this module reads.
 *  • Screen against live sanctions lists. `screening.ts` ships labelled
 *    fixtures and a provider interface; every result names what it screened
 *    against and whether that was real.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  assuranceGrants,
  authorityLimits,
  chainSeals,
  chainWatermarks,
  commitments,
  conflictDeclarations,
  contacts,
  detectorPolicies,
  detectorRuns,
  entities,
  entityRelationships,
  events,
  evidence,
  evidencePackAccess,
  evidencePacks,
  files,
  integrityCaseItems,
  integrityCases,
  integrityScores,
  invoices,
  ledgerEntries,
  obligations,
  permissionTemplates,
  projectMemberships,
  projects,
  reconciliationPolicies,
  reconciliations,
  screeningResults,
  signalEvidence,
  signals,
  users,
  vendors,
  workers,
  workflowInstances,
  workflowStepInstances,
} from "@constructos/db";
import {
  ASSERTION_KINDS,
  BUILTIN_PERMISSION_TEMPLATES,
  ENTITY_KINDS,
  ENTITY_RELATIONSHIP_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_PACK_PURPOSES,
  INTEGRITY_CASE_ITEM_TYPES,
  INTEGRITY_CASE_STATUSES,
  INTEGRITY_SCORE_SCOPES,
  RECONCILIATION_RESULTS,
  SCREENING_DISPOSITIONS,
  SIGNAL_DISPOSITIONS,
  SIGNAL_LIFECYCLE,
  SIGNAL_SEVERITIES,
  meetsLevel,
  resolveLevel,
  type AssuranceRole,
  type PermissionLevel,
  type ScreeningList,
  type SignalSeverity,
  type ToolPermissionMap,
} from "@constructos/shared";
import {
  hashPayload,
  merkleProof,
  merkleRoot,
  verifyChain,
  type ChainedEntry,
} from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isExpired } from "../../lib/time.js";
import { pushNotifications } from "../notifications/service.js";
import {
  DETECTOR_NAMES,
  approvalVelocity,
  benfordFirstDigit,
  contradictedClaimant,
  duplicateAssertions,
  fingerprintOf,
  roundNumberClustering,
  segregationOfDuties,
  sortedIds,
  type DetectorName,
  type SignalDraft,
} from "./detectors.js";
import {
  DETECTOR_REGISTRY,
  PASSIVE_DETECTORS,
  detectorById,
  detectorsForScope,
} from "./registry.js";
import {
  GHOST_VENDOR_DEFAULTS,
  approverVendorAffinity,
  authorityLimitBreaches,
  dormantVendorActivity,
  duplicatePayments,
  invoiceBeforePurchaseOrder,
  normaliseIdentifier,
  outOfHoursApprovals,
  roundSumInvoicing,
  sequentialInvoiceNumbers,
  splitInvoicing,
  vendorConcentration,
  vendorPersonCollisions,
  type ApprovalLike,
  type GhostVendorThresholds,
} from "./ghostvendor.js";
import { backdatedRecords, overrideActivity } from "./backdating.js";
import { shellCompanyIndicators, undeclaredConflicts, type GraphEdge } from "./graph.js";
import {
  DEFAULT_TOLERANCE,
  RECONCILERS,
  autoReconcile,
  effectiveIndependence,
  reconcilersFor,
  runReconciler,
  type AssertionLike,
  type EvidenceLike,
  type TolerancePolicy,
} from "./reconcilers.js";
import {
  belowPrecisionFloor,
  detectorPrecision,
  integrityScore,
  type DetectorPrecision,
  type ScorableSignal,
} from "./scoring.js";
import {
  defaultProviders,
  screenAgainst,
  statusFromMatches,
  type ScreeningMatch,
} from "./screening.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

/** Lenient ISO timestamp (avoids zod version drift on .datetime()). */
const isoTimestamp = z
  .string()
  .min(4)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO timestamp");

const assertionCreateSchema = z.object({
  kind: z.enum(ASSERTION_KINDS),
  value: z.number().finite().nullable().optional(),
  unit: z.string().max(50).nullable().optional(),
  basis: z.string().min(1).max(2000),
  contractRef: z.string().max(500).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  sourceId: z.string().max(64).nullable().optional(),
  assertedAt: isoTimestamp.optional(),
  claimantId: z.string().max(64).optional(),
  claimantKind: z.enum(["user", "entity"]).optional(),
  periodStart: isoTimestamp.nullable().optional(),
  periodEnd: isoTimestamp.nullable().optional(),
});

const assertionListSchema = pageQuerySchema.extend({
  kind: z.enum(ASSERTION_KINDS).optional(),
  claimantId: z.string().optional(),
  sourceType: z.string().optional(),
  sourceId: z.string().optional(),
});

const evidenceJsonSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  source: z.string().min(1).max(500),
  capturedAt: isoTimestamp.optional(),
  independenceScore: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const evidenceMultipartSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  source: z.string().min(1).max(500),
  capturedAt: isoTimestamp.optional(),
  independenceScore: z.coerce.number().min(0).max(1).optional(),
});

const reconciliationCreateSchema = z.object({
  assertionId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1).max(200),
  method: z.string().min(1).max(200),
  notes: z.string().max(4000).optional(),
  /** required only when method is "manual" and no numeric evidence exists */
  result: z.enum(RECONCILIATION_RESULTS).optional(),
});

const dispositionSchema = z.object({
  disposition: z.string().min(1).max(100),
  notes: z.string().max(4000).optional(),
});

const obligationCreateSchema = z.object({
  sourceClause: z.string().min(1).max(1000),
  trigger: z.string().min(1).max(1000),
  obligorId: z.string().max(64).nullable().optional(),
  obligeeId: z.string().max(64).nullable().optional(),
  deadline: isoTimestamp.nullable().optional(),
  warnDaysBefore: z.number().min(0).max(365).nullable().optional(),
  evidenceRequirement: z.string().max(2000).nullable().optional(),
});

const obligationPatchSchema = obligationCreateSchema.partial();

const eventCreateSchema = z.object({
  type: z.string().min(1).max(200),
  occurredAt: isoTimestamp,
  location: z.string().max(500).nullable().optional(),
  detectedOrReported: z.enum(["detected", "reported"]).optional(),
  causalLinks: z.array(z.string()).max(100).optional(),
  payload: z.unknown().optional(),
});

const entityCreateSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  name: z.string().min(1).max(300),
  identifiers: z.record(z.string(), z.string()).optional(),
  jurisdiction: z.string().max(100).nullable().optional(),
  screeningStatus: z.string().max(50).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const entityPatchSchema = entityCreateSchema.partial();

const relationshipCreateSchema = z.object({
  toEntityId: z.string().min(1),
  kind: z.enum(ENTITY_RELATIONSHIP_KINDS),
  since: z.string().max(50).nullable().optional(),
  source: z.string().max(500).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

const signalDispositionSchema = z.object({
  disposition: z.enum(SIGNAL_DISPOSITIONS),
  reviewerNotes: z.string().max(4000).optional(),
});

const signalListSchema = pageQuerySchema.extend({
  projectId: z.string().optional(),
  severity: z.string().optional(),
  disposition: z.string().optional(),
  detector: z.string().optional(),
  family: z.string().optional(),
  subjectId: z.string().optional(),
});

const detectorsRunSchema = z.object({
  detectors: z.array(z.string()).max(40).optional(),
});

const evidencePackSchema = z.object({
  evidenceIds: z.array(z.string().min(1)).min(1).max(500),
  title: z.string().max(300).optional(),
  purpose: z.enum(EVIDENCE_PACK_PURPOSES).optional(),
  caseId: z.string().max(64).nullable().optional(),
  /** ids the requester knows are linked but is deliberately leaving out */
  exclusions: z
    .array(z.object({ objectType: z.string().max(64), objectId: z.string().max(64), reason: z.string().max(500) }))
    .max(200)
    .optional(),
});

const ledgerListSchema = pageQuerySchema.extend({
  objectType: z.string().optional(),
  objectId: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* Chain verification — incremental, watermarked                       */
/* ------------------------------------------------------------------ */

/**
 * The columns needed to recompute an entry hash. Deliberately EXCLUDES the
 * `payload` jsonb: the chain covers `payloadHash`, never the snapshot, so
 * every link and content check is answerable without loading snapshots that
 * dominate the row size. The snapshot re-hash is a separate, scheduled deep
 * pass (`anchoring.deep-verify`), because it is the expensive one.
 */
const CHAIN_COLUMNS = {
  seq: ledgerEntries.seq,
  companyId: ledgerEntries.companyId,
  actorId: ledgerEntries.actorId,
  action: ledgerEntries.action,
  objectType: ledgerEntries.objectType,
  objectId: ledgerEntries.objectId,
  payloadHash: ledgerEntries.payloadHash,
  at: ledgerEntries.at,
  prevHash: ledgerEntries.prevHash,
  entryHash: ledgerEntries.entryHash,
};

/** Normalise `at` back to the exact ISO-8601 spelling it was hashed in. */
function toChainedEntry(r: {
  companyId: string;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  payloadHash: string;
  at: string;
  prevHash: string;
  entryHash: string;
}): ChainedEntry {
  return {
    companyId: r.companyId,
    actorId: r.actorId,
    action: r.action,
    objectType: r.objectType,
    objectId: r.objectId,
    payloadHash: r.payloadHash,
    at: new Date(r.at).toISOString(),
    prevHash: r.prevHash,
    entryHash: r.entryHash,
  };
}

export interface LedgerVerifyResult {
  valid: boolean;
  count: number;
  /** index of the break WITHIN THE VERIFIED SLICE, kept for the old contract */
  brokenAt: number | null;
  /** the real ledger seq of the break — what an investigator actually needs */
  brokenSeq: number | null;
  reason: string | null;
  /** where this verification started from, and why */
  verifiedFromSeq: number;
  verifiedToSeq: number | null;
  incremental: boolean;
}

/**
 * Verify a company's chain from a watermark forward.
 *
 * The link from entry N to N+1, once checked, cannot un-check itself unless a
 * row changes — and a row that changes inside the verified range breaks the
 * boundary hash, which this catches on the next pass. So a mature tenant pays
 * for the delta, not for its whole history. `fromSeq`/`fromHash` come from
 * `chain_watermarks`; passing 0/null forces a full walk.
 *
 * `brokenAt` keeps its old meaning (index into the slice) for compatibility,
 * but `brokenSeq` is the number to show a human: `seq` is a global bigserial
 * shared across tenants, so slice index 12 is very rarely ledger seq 12.
 */
async function verifyLedgerIncremental(
  db: Db,
  companyId: string,
  from: { seq: number; hash: string | null },
  opts: { batchSize?: number } = {},
): Promise<LedgerVerifyResult> {
  const batchSize = opts.batchSize ?? 5000;
  let cursor = from.seq;
  let prevHash = from.hash;
  let checked = 0;
  let lastSeq: number | null = null;
  let brokenAt: number | null = null;
  let brokenSeq: number | null = null;
  let reason: string | null = null;

  for (;;) {
    const rows = await db
      .select(CHAIN_COLUMNS)
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.companyId, companyId), gt(ledgerEntries.seq, cursor)))
      .orderBy(asc(ledgerEntries.seq))
      .limit(batchSize);
    if (rows.length === 0) break;
    const entries = rows.map((r) => toChainedEntry(r));
    const result = verifyChain(entries, prevHash ?? undefined);
    if (!result.valid) {
      const idx = result.brokenAt ?? 0;
      brokenAt = checked + idx;
      brokenSeq = Number(rows[idx]?.seq ?? rows[rows.length - 1]!.seq);
      reason =
        `Entry at ledger seq ${brokenSeq} does not chain to its predecessor or does not hash ` +
        "to its stored entryHash. Everything before it verified; everything after it is " +
        "unverifiable until this is explained.";
      break;
    }
    checked += rows.length;
    const last = rows[rows.length - 1]!;
    cursor = Number(last.seq);
    lastSeq = cursor;
    prevHash = last.entryHash;
    if (rows.length < batchSize) break;
  }

  return {
    valid: brokenSeq === null,
    count: checked,
    brokenAt,
    brokenSeq,
    reason,
    verifiedFromSeq: from.seq,
    verifiedToSeq: lastSeq,
    incremental: from.seq > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

/** High-value object types whose silent edit or deletion is a finding. */
const HIGH_VALUE_OBJECTS = [
  "invoice",
  "commitment",
  "payment_application",
  "change_order_package",
  "budget_line_item",
  "assertion",
  "evidence",
  "reconciliation",
  "obligation",
  "entity",
  "vendor",
  "payroll_entry",
];

export const assuranceModule: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("assurance", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("assurance", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ---------------------------------------------------------------- */
  /* Authorisation helpers                                             */
  /* ---------------------------------------------------------------- */

  interface AssuranceReach {
    /** owner/admin, or an assurance grant with no project restriction */
    tenantWide: boolean;
    /** projects reachable through project-scoped assurance grants */
    grantedProjectIds: Set<string>;
    roles: AssuranceRole[];
    privileged: boolean;
  }

  /**
   * What this caller may see of the ASSURANCE record, as opposed to of the
   * operational record.
   *
   * The distinction matters: a company member with `assurance: none` is not
   * entitled to the integrity signals naming their colleagues, nor to the
   * ledger's stored snapshots of other projects' commercial state, however
   * legitimately they reach the rest of the platform. Company-wide assurance
   * reads therefore resolve through THIS, never through `requireCompany`
   * alone.
   */
  async function assuranceReachOf(req: FastifyRequest): Promise<AssuranceReach> {
    const owner = req.companyRole === "owner" || req.companyRole === "admin";
    const rows = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    const nowMs = Date.now();
    const live = rows.filter((g) => !isExpired(g.expiresAt, nowMs));
    const tenantWide = owner || live.some((g) => !g.projectId);
    const grantedProjectIds = new Set(
      live.filter((g) => g.projectId).map((g) => g.projectId as string),
    );
    return {
      tenantWide,
      grantedProjectIds,
      roles: [...new Set(live.map((g) => g.role as AssuranceRole))],
      privileged: owner || live.length > 0,
    };
  }

  /** Does the caller hold one of these assurance roles for this project (or tenant-wide)? */
  async function holdsAssuranceRole(
    req: FastifyRequest,
    roles: AssuranceRole[],
    projectId?: string | null,
  ): Promise<boolean> {
    const rows = await app.db
      .select()
      .from(assuranceGrants)
      .where(
        and(
          eq(assuranceGrants.companyId, req.companyId!),
          eq(assuranceGrants.userId, req.user!.id),
        ),
      );
    // Instant comparison, not string comparison: Postgres returns
    // "2026-08-25 23:00:00+00" and toISOString() produces
    // "2026-08-25T10:00:00.000Z", and a space sorts before "T" — so a grant
    // live until 23:00 read as expired at 10:00 on its own expiry day.
    const nowMs = Date.now();
    return rows.some(
      (g) =>
        roles.includes(g.role as AssuranceRole) &&
        !isExpired(g.expiresAt, nowMs) &&
        // A grant scoped to project A says NOTHING about project B. Ignoring
        // this is how a project-scoped reviewer came to be able to close
        // tenant-level collusion signals.
        (!g.projectId || (projectId !== undefined && projectId !== null && g.projectId === projectId)),
    );
  }

  /**
   * Projects whose assurance record this caller may read, or `"all"`.
   *
   * Three routes in: company owner/admin and tenant-wide grants see
   * everything; project-scoped grants see those projects; everyone else sees
   * the projects where their permission template actually grants
   * `assurance: read`. That last branch is what stops a subcontractor
   * membership from listing integrity signals about the whole portfolio.
   */
  async function visibleAssuranceProjectIds(
    req: FastifyRequest,
  ): Promise<"all" | Set<string>> {
    const reach = await assuranceReachOf(req);
    if (reach.tenantWide) return "all";
    const allowed = new Set(reach.grantedProjectIds);
    const memberships = await app.db
      .select({
        projectId: projectMemberships.projectId,
        templateKey: projectMemberships.templateKey,
        overrides: projectMemberships.overrides,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(
        and(
          eq(projectMemberships.userId, req.user!.id),
          eq(projects.companyId, req.companyId!),
        ),
      );
    if (memberships.length === 0) return allowed;
    const templateRows = await app.db
      .select({ key: permissionTemplates.key, tools: permissionTemplates.tools })
      .from(permissionTemplates)
      .where(eq(permissionTemplates.companyId, req.companyId!));
    const stored = new Map(templateRows.map((t) => [t.key, t.tools as ToolPermissionMap]));
    for (const m of memberships) {
      const builtin = BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === m.templateKey)?.tools;
      const merged: ToolPermissionMap | undefined = stored.has(m.templateKey)
        ? { ...(builtin ?? {}), ...(stored.get(m.templateKey) ?? {}) }
        : builtin;
      const level: PermissionLevel = resolveLevel(
        "assurance",
        merged,
        m.overrides as ToolPermissionMap,
      );
      if (meetsLevel(level, "read")) allowed.add(m.projectId);
    }
    return allowed;
  }

  /** Refuse a company-wide assurance read to a caller with no reach at all. */
  async function requireAssuranceReach(req: FastifyRequest): Promise<"all" | Set<string>> {
    const visible = await visibleAssuranceProjectIds(req);
    if (visible !== "all" && visible.size === 0) {
      throw forbidden(
        "Reading the company-wide assurance record requires an assurance grant, company " +
          "owner/admin, or assurance:read on at least one project.",
      );
    }
    return visible;
  }

  /** Project-id filter for a company-wide list, or null when unrestricted. */
  function projectFilter(visible: "all" | Set<string>, requested?: string) {
    if (visible === "all") {
      return requested ? eq(signals.projectId, requested) : undefined;
    }
    const ids = [...visible];
    if (requested) {
      if (!visible.has(requested)) {
        throw forbidden("No assurance visibility of that project");
      }
      return eq(signals.projectId, requested);
    }
    // Tenant-level signals (projectId null) are only for tenant-wide reach.
    return ids.length > 0 ? inArray(signals.projectId, ids) : sql`false`;
  }

  /** Resolve a project's company, so id-scoped routes cannot cross tenants. */
  async function projectOf(companyId: string, projectId: string) {
    const rows = await app.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Detector policy + signal persistence                              */
  /* ---------------------------------------------------------------- */

  interface PolicyRow {
    detector: string;
    enabled: boolean;
    precisionFloor: number | null;
    minReviewedForFloor: number;
    thresholds: Record<string, number>;
  }

  async function loadPolicies(companyId: string): Promise<Map<string, PolicyRow>> {
    const rows = await app.db
      .select()
      .from(detectorPolicies)
      .where(eq(detectorPolicies.companyId, companyId));
    return new Map(
      rows.map((r) => [
        r.detector,
        {
          detector: r.detector,
          enabled: r.enabled === 1,
          precisionFloor: r.precisionFloor,
          minReviewedForFloor: r.minReviewedForFloor,
          thresholds: r.thresholds,
        },
      ]),
    );
  }

  /** Measured precision per detector over the trailing window. */
  async function precisionFor(companyId: string, now: Date): Promise<DetectorPrecision[]> {
    const rows = await app.db
      .select({
        detector: signals.detector,
        disposition: signals.disposition,
        createdAt: signals.createdAt,
      })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          inArray(signals.disposition, ["confirmed", "escalated", "false_positive"]),
        ),
      );
    return detectorPrecision(rows, { now, windowDays: 180, minReviewed: 10 });
  }

  interface RaiseOutcome {
    created: number;
    refreshed: number;
    superseded: number;
    signalIds: string[];
  }

  /**
   * Persist a batch of drafts IDEMPOTENTLY.
   *
   * The rule: one open signal per (detector, fingerprint, project). A repeat
   * observation refreshes `lastSeenAt`/`occurrences` instead of creating a
   * twin; a repeat at a HIGHER severity supersedes the open one, because "this
   * got worse" is news and must reach a reviewer. A finding a reviewer has
   * already closed or dismissed does not come back to life on the next run
   * unless the severity rose — that is the difference between a detector and a
   * nag.
   */
  async function raiseSignals(
    companyId: string,
    projectId: string | null,
    actorId: string | null,
    drafts: SignalDraft[],
    runId: string | null,
  ): Promise<RaiseOutcome> {
    const out: RaiseOutcome = { created: 0, refreshed: 0, superseded: 0, signalIds: [] };
    if (drafts.length === 0) return out;
    const detectors = [...new Set(drafts.map((d) => d.detector))];
    const existing = await app.db
      .select({
        id: signals.id,
        detector: signals.detector,
        fingerprint: signals.fingerprint,
        severity: signals.severity,
        disposition: signals.disposition,
        projectId: signals.projectId,
        occurrences: signals.occurrences,
      })
      .from(signals)
      .where(and(eq(signals.companyId, companyId), inArray(signals.detector, detectors)));
    const key = (detector: string, fingerprint: string, project: string | null) =>
      `${detector}|${fingerprint}|${project ?? ""}`;
    const index = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      if (!row.fingerprint) continue;
      const k = key(row.detector, row.fingerprint, row.projectId);
      const prior = index.get(k);
      // Prefer an OPEN row over a closed one when both exist.
      if (!prior || (prior.disposition === "closed" && row.disposition !== "closed")) {
        index.set(k, row);
      }
    }
    const rank: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const nowIso = new Date().toISOString();

    for (const draft of drafts) {
      const k = key(draft.detector, draft.fingerprint, projectId);
      const prior = index.get(k);
      const open =
        prior !== undefined &&
        prior.disposition !== "closed" &&
        prior.disposition !== "false_positive";
      const worse =
        prior !== undefined && (rank[draft.severity] ?? 0) > (rank[prior.severity] ?? 0);

      if (prior && !worse) {
        // Same condition, same or lower severity. Record that it is still
        // true; do not manufacture a second signal, and do not reopen
        // something a reviewer has judged.
        await app.db
          .update(signals)
          .set({
            lastSeenAt: nowIso,
            occurrences: (prior.occurrences ?? 1) + 1,
            ...(runId ? { runId } : {}),
          })
          .where(eq(signals.id, prior.id));
        out.refreshed += 1;
        out.signalIds.push(prior.id);
        continue;
      }

      const id = newId("sig");
      await app.db.insert(signals).values({
        id,
        companyId,
        projectId,
        detector: draft.detector,
        severity: draft.severity,
        confidence: draft.confidence,
        title: draft.title,
        explanation: draft.explanation,
        evidenceRefs: draft.evidenceRefs,
        fingerprint: draft.fingerprint,
        subjectType: draft.subjectType ?? null,
        subjectId: draft.subjectId ?? null,
        runId,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        occurrences: 1,
      });
      if (draft.links && draft.links.length > 0) {
        const seen = new Set<string>();
        const rows = [];
        for (const link of draft.links.slice(0, 200)) {
          const dedupe = `${link.objectType}|${link.objectId}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          rows.push({
            id: newId("sev"),
            companyId,
            signalId: id,
            objectType: link.objectType,
            objectId: link.objectId,
            role: link.role ?? "supporting",
          });
        }
        if (rows.length > 0) await app.db.insert(signalEvidence).values(rows);
      }
      if (prior && worse) {
        await app.db
          .update(signals)
          .set({ supersededById: id, closedAt: nowIso })
          .where(eq(signals.id, prior.id));
        out.superseded += 1;
      }
      await appendLedger(app.db, {
        companyId,
        actorId,
        action: "create",
        objectType: "signal",
        objectId: id,
        payload: {
          detector: draft.detector,
          severity: draft.severity,
          title: draft.title,
          fingerprint: draft.fingerprint,
          supersedes: prior && worse ? prior.id : null,
        },
        projectId,
      });
      index.set(k, {
        id,
        detector: draft.detector,
        fingerprint: draft.fingerprint,
        severity: draft.severity,
        disposition: "new",
        projectId,
        occurrences: 1,
      });
      out.created += 1;
      out.signalIds.push(id);
    }
    return out;
  }

  /**
   * Close open signals from these detectors whose condition no longer holds.
   *
   * A register that only ever grows is a register nobody reads. When a run
   * executes a detector and the finding is not among its output, the condition
   * has cleared — the duplicate invoice was credited, the approver's limit was
   * raised, the evidence arrived — and the signal is auto-closed with that
   * stated as the reason. Signals a human has dispositioned are left alone:
   * closing a `confirmed` finding because a later run could not see it would
   * erase the investigation.
   */
  async function autoCloseCleared(
    companyId: string,
    projectId: string | null,
    executed: string[],
    stillTrue: Set<string>,
    runId: string,
  ): Promise<number> {
    if (executed.length === 0) return 0;
    const open = await app.db
      .select({
        id: signals.id,
        detector: signals.detector,
        fingerprint: signals.fingerprint,
      })
      .from(signals)
      .where(
        and(
          eq(signals.companyId, companyId),
          projectId === null ? isNull(signals.projectId) : eq(signals.projectId, projectId),
          inArray(signals.detector, executed),
          inArray(signals.disposition, ["new", "under_review"]),
          isNull(signals.closedAt),
        ),
      );
    const nowIso = new Date().toISOString();
    let closed = 0;
    for (const row of open) {
      if (!row.fingerprint) continue; // pre-fingerprint rows are left for a human
      if (stillTrue.has(`${row.detector}|${row.fingerprint}`)) continue;
      await app.db
        .update(signals)
        .set({
          disposition: "closed",
          closedAt: nowIso,
          autoClosedAt: nowIso,
          runId,
          reviewerNotes:
            "Auto-closed: the condition this detector raised no longer holds on a later run.",
        })
        .where(eq(signals.id, row.id));
      await appendLedger(app.db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "signal",
        objectId: row.id,
        payload: { disposition: "closed", autoClosed: true, runId },
        projectId,
      });
      closed += 1;
    }
    return closed;
  }

  /* ---------------------------------------------------------------- */
  /* 1. Assertions                                                     */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/assertions", { preHandler: standardGate }, async (req, reply) => {
    const body = assertionCreateSchema.parse(req.body);
    if (body.claimantKind === "entity" && !body.claimantId) {
      throw badRequest("claimantId is required when claimantKind is entity");
    }

    /*
     * THE SEPARATION RULE, at its first opportunity to be defeated.
     *
     * `claimantId` used to be free text. A user could file an assertion in a
     * colleague's name, submit every piece of evidence themselves, and the
     * reconciliation check — which compares evidence.submittedBy against
     * assertion.claimantId — would find two different ids and wave through a
     * fully self-certified result. The rule the whole architecture rests on
     * was one string away from meaningless.
     *
     * So: for a `user` claim the claimant IS the caller, unless the caller
     * holds an assurance role, which is the only capacity in which recording
     * someone else's claim is a legitimate act. For an `entity` claim the
     * caller's own identity is preserved in `createdBy`, and the
     * reconciliation check tests BOTH.
     */
    let claimantKind = body.claimantKind ?? "user";
    let claimantId = body.claimantId ?? req.user!.id;
    if (claimantKind === "user" && claimantId !== req.user!.id) {
      const onBehalf = await holdsAssuranceRole(
        req,
        ["integrity_reviewer", "auditor"],
        req.projectId,
      );
      if (!onBehalf) {
        throw forbidden(
          "An assertion attributed to another user may only be recorded by an integrity " +
            "reviewer or auditor. Recording a claim in someone else's name and then testing it " +
            "with your own evidence would defeat the separation rule this platform is built on.",
        );
      }
    }
    if (claimantKind === "entity") {
      const entityRows = await app.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.id, claimantId),
            eq(entities.companyId, req.companyId!),
            isNull(entities.deletedAt),
          ),
        )
        .limit(1);
      if (!entityRows[0]) throw notFound("Claimant entity not found in this company");
    } else {
      claimantKind = "user";
      claimantId = claimantId || req.user!.id;
    }

    const id = newId("asr");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      kind: body.kind,
      claimantId,
      claimantKind,
      value: body.value ?? null,
      unit: body.unit ?? null,
      basis: body.basis,
      contractRef: body.contractRef ?? null,
      sourceType: body.sourceType ?? null,
      sourceId: body.sourceId ?? null,
      assertedAt: body.assertedAt ?? new Date().toISOString(),
      createdBy: req.user!.id,
    };
    await app.db.insert(assertions).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "assertion",
      objectId: id,
      payload: row,
      storePayload: true,
      projectId: req.projectId!,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/assertions", { preHandler: readGate }, async (req) => {
    const q = assertionListSchema.parse(req.query);
    const where = and(
      eq(assertions.companyId, req.companyId!),
      eq(assertions.projectId, req.projectId!),
      q.kind ? eq(assertions.kind, q.kind) : undefined,
      q.claimantId ? eq(assertions.claimantId, q.claimantId) : undefined,
      q.sourceType ? eq(assertions.sourceType, q.sourceType) : undefined,
      q.sourceId ? eq(assertions.sourceId, q.sourceId) : undefined,
    );
    const items = await app.db
      .select()
      .from(assertions)
      .where(where)
      .orderBy(desc(assertions.assertedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(assertions).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/assertions/:assertionId", { preHandler: readGate }, async (req) => {
    const { assertionId } = req.params as { assertionId: string };
    const rows = await app.db
      .select()
      .from(assertions)
      .where(
        and(
          eq(assertions.id, assertionId),
          eq(assertions.companyId, req.companyId!),
          eq(assertions.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Assertion not found");
    return rows[0];
  });

  /* ---------------------------------------------------------------- */
  /* 2. Evidence (immutable — create + read only)                      */
  /* ---------------------------------------------------------------- */

  /**
   * EXIF/XMP-style capture facts, lifted out of whatever the client sent so
   * they survive as first-class metadata (Domain S #875). We do not parse
   * binary EXIF here — that belongs with the photo pipeline — but when a
   * client supplies capture facts we keep them, and we FLAG a disagreement
   * between the stated `capturedAt` and the device's own timestamp rather
   * than silently preferring one.
   */
  function captureFacts(
    metadata: Record<string, unknown>,
    capturedAt: string | null,
  ): { facts: Record<string, unknown>; disagreement: string | null } {
    const exif = (metadata["exif"] ?? metadata["capture"]) as Record<string, unknown> | undefined;
    if (!exif || typeof exif !== "object") return { facts: {}, disagreement: null };
    const deviceTime =
      typeof exif["dateTimeOriginal"] === "string"
        ? exif["dateTimeOriginal"]
        : typeof exif["capturedAt"] === "string"
          ? exif["capturedAt"]
          : null;
    const facts: Record<string, unknown> = {
      device: exif["model"] ?? exif["device"] ?? null,
      dateTimeOriginal: deviceTime,
      gps:
        typeof exif["latitude"] === "number" && typeof exif["longitude"] === "number"
          ? { latitude: exif["latitude"], longitude: exif["longitude"] }
          : null,
    };
    let disagreement: string | null = null;
    if (deviceTime && capturedAt) {
      const a = Date.parse(deviceTime);
      const b = Date.parse(capturedAt);
      if (!Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) > 3_600_000) {
        disagreement =
          `The declared capture time (${capturedAt}) and the device's own timestamp ` +
          `(${deviceTime}) differ by ${(Math.abs(a - b) / 3_600_000).toFixed(1)} hours. The ` +
          "device timestamp is preserved verbatim; neither has been overwritten.";
      }
    }
    return { facts, disagreement };
  }

  app.post("/projects/:projectId/evidence", { preHandler: standardGate }, async (req, reply) => {
    const id = newId("evd");
    const now = new Date().toISOString();

    let row;
    if (req.isMultipart()) {
      const mp = await req.file();
      if (!mp) throw badRequest("Expected a multipart file upload");
      const buf = await mp.toBuffer();
      const fieldVal = (name: string): string | undefined => {
        const raw = (mp.fields as Record<string, unknown>)[name];
        const f = Array.isArray(raw) ? raw[0] : raw;
        const v = (f as { value?: unknown } | undefined)?.value;
        return typeof v === "string" ? v : undefined;
      };
      const fields = evidenceMultipartSchema.parse({
        kind: fieldVal("kind"),
        source: fieldVal("source"),
        capturedAt: fieldVal("capturedAt"),
        independenceScore: fieldVal("independenceScore"),
      });
      let metadata: Record<string, unknown> = {};
      const metaRaw = fieldVal("metadata");
      if (metaRaw) {
        try {
          const parsed: unknown = JSON.parse(metaRaw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          } else throw new Error("not an object");
        } catch {
          throw badRequest("metadata must be a JSON object string");
        }
      }
      const capture = captureFacts(metadata, fields.capturedAt ?? null);
      const saved = await app.storage.saveBuffer(req.companyId!, buf);
      const fileId = newId("fil");
      await app.db.insert(files).values({
        id: fileId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        folderId: null,
        name: mp.filename || "evidence",
        contentType: mp.mimetype || "application/octet-stream",
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        storageKey: saved.storageKey,
        metadata: { evidence: true },
        uploadedBy: req.user!.id,
      });
      row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: fields.kind,
        source: fields.source,
        contentHash: saved.sha256,
        fileId,
        capturedAt: fields.capturedAt ?? null,
        independenceScore: fields.independenceScore ?? 0,
        provenance: {
          submittedBy: req.user!.id,
          via: "multipart_upload",
          filename: mp.filename ?? null,
          at: now,
          capture: capture.facts,
          captureDisagreement: capture.disagreement,
        },
        metadata,
        submittedBy: req.user!.id,
      };
    } else {
      const body = evidenceJsonSchema.parse(req.body);
      const metadata = body.metadata ?? {};
      const capture = captureFacts(metadata, body.capturedAt ?? null);
      row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        kind: body.kind,
        source: body.source,
        contentHash: hashPayload(metadata),
        fileId: null,
        capturedAt: body.capturedAt ?? null,
        independenceScore: body.independenceScore ?? 0,
        provenance: {
          submittedBy: req.user!.id,
          via: "api_json",
          at: now,
          capture: capture.facts,
          captureDisagreement: capture.disagreement,
        },
        metadata,
        submittedBy: req.user!.id,
      };
    }

    await app.db.insert(evidence).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "evidence",
      objectId: id,
      payload: { kind: row.kind, source: row.source, contentHash: row.contentHash },
      storePayload: true,
      projectId: req.projectId!,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/evidence", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ kind: z.enum(EVIDENCE_KINDS).optional() }).parse(req.query);
    const where = and(
      eq(evidence.companyId, req.companyId!),
      eq(evidence.projectId, req.projectId!),
      q.kind ? eq(evidence.kind, q.kind) : undefined,
    );
    const items = await app.db
      .select()
      .from(evidence)
      .where(where)
      .orderBy(desc(evidence.ingestedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(evidence).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/evidence/:evidenceId", { preHandler: readGate }, async (req) => {
    const { evidenceId } = req.params as { evidenceId: string };
    const rows = await app.db
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.id, evidenceId),
          eq(evidence.companyId, req.companyId!),
          eq(evidence.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Evidence not found");
    return rows[0];
  });

  /**
   * Retrieve an evidence file, RE-HASHED on the way out (Domain S #862).
   *
   * Content-addressed storage means the object's own address attests to its
   * content — but only if somebody checks. So every download recomputes the
   * sha256 from the bytes actually on disk and compares it to the hash
   * recorded at ingest. A mismatch is a critical signal, not a warning: the
   * evidence a claim rests on has changed since it was accepted, and every
   * reconciliation that relied on it is now in question.
   */
  app.get(
    "/projects/:projectId/evidence/:evidenceId/download",
    { preHandler: readGate },
    async (req, reply) => {
      const { evidenceId } = req.params as { evidenceId: string };
      const rows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.id, evidenceId),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const ev = rows[0];
      if (!ev) throw notFound("Evidence not found");
      if (!ev.fileId) throw badRequest("This evidence record has no attached file");
      const fileRows = await app.db
        .select()
        .from(files)
        .where(and(eq(files.id, ev.fileId), eq(files.companyId, req.companyId!)))
        .limit(1);
      const file = fileRows[0];
      if (!file) throw notFound("Evidence file is missing from the file register");

      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = app.storage.readStream(file.storageKey);
        stream.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          chunks.push(buf);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve());
      });
      const actual = hash.digest("hex");
      const intact = actual === ev.contentHash;

      if (!intact) {
        await raiseSignals(
          req.companyId!,
          req.projectId!,
          req.user!.id,
          [
            {
              detector: "evidence_content_mismatch",
              severity: "critical",
              confidence: 1,
              title: `Evidence ${ev.id} no longer hashes to its recorded content hash`,
              explanation:
                `Evidence ${ev.id} (${ev.kind}, source "${ev.source}") was accepted with content ` +
                `hash ${ev.contentHash}. The bytes now in storage hash to ${actual}. The stored ` +
                "object has been replaced or corrupted since ingest. Every reconciliation that " +
                "relied on this evidence is unsupported until this is explained; preserve a " +
                "storage backup before investigating.",
              evidenceRefs: {
                evidenceId: ev.id,
                fileId: file.id,
                expected: ev.contentHash,
                actual,
                storageKey: file.storageKey,
              },
              fingerprint: fingerprintOf(ev.id, ev.contentHash, actual),
              subjectType: "evidence",
              subjectId: ev.id,
              links: [{ objectType: "evidence", objectId: ev.id, role: "subject" }],
            },
          ],
          null,
        );
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "evidence",
        objectId: ev.id,
        payload: { download: true, integrity: intact ? "intact" : "mismatch", actual },
        storePayload: true,
        projectId: req.projectId!,
      });
      return reply
        .header("content-type", file.contentType)
        .header("content-disposition", `attachment; filename="${file.name.replace(/"/g, "")}"`)
        .header("x-evidence-integrity", intact ? "intact" : "mismatch")
        .header("x-evidence-content-sha256", actual)
        .send(Buffer.concat(chunks));
    },
  );

  /* ---------------------------------------------------------------- */
  /* 3. Reconciliations — THE product table                            */
  /* ---------------------------------------------------------------- */

  /** Tolerance bands in force for one project + assertion kind. */
  async function toleranceFor(
    companyId: string,
    projectId: string,
    assertionKind: string,
  ): Promise<{ policy: TolerancePolicy; source: string }> {
    const rows = await app.db
      .select()
      .from(reconciliationPolicies)
      .where(
        and(
          eq(reconciliationPolicies.companyId, companyId),
          eq(reconciliationPolicies.assertionKind, assertionKind),
          or(
            eq(reconciliationPolicies.projectId, projectId),
            isNull(reconciliationPolicies.projectId),
          ),
        ),
      );
    const project = rows.find((r) => r.projectId === projectId);
    const company = rows.find((r) => !r.projectId);
    const row = project ?? company;
    if (!row) {
      return { policy: DEFAULT_TOLERANCE, source: "library default (±5% / ±15%)" };
    }
    return {
      policy: {
        supportedWithinPercent: row.supportedWithinPercent,
        partialWithinPercent: row.partialWithinPercent,
        minIndependence: row.minIndependence,
        maxCaptureGapDays: row.maxCaptureGapDays,
      },
      source: project ? "project policy" : "company policy",
    };
  }

  function toAssertionLike(row: typeof assertions.$inferSelect): AssertionLike {
    return {
      id: row.id,
      kind: row.kind,
      value: row.value,
      unit: row.unit,
      claimantId: row.claimantId,
      claimantKind: row.claimantKind,
      createdBy: row.createdBy,
      assertedAt: row.assertedAt,
    };
  }

  function toEvidenceLike(row: typeof evidence.$inferSelect): EvidenceLike {
    return {
      id: row.id,
      kind: row.kind,
      source: row.source,
      capturedAt: row.capturedAt,
      ingestedAt: row.ingestedAt,
      independenceScore: row.independenceScore,
      metadata: row.metadata,
      submittedBy: row.submittedBy,
    };
  }

  /**
   * The separation rule, at the moment it actually bites.
   *
   * Every path by which one actor can stand on both sides of a claim is
   * closed here, and each is a real attack rather than a hypothetical:
   *   • the claimant submitting their own evidence (the original check);
   *   • the AUTHOR of the assertion submitting it, when the claim was filed
   *     in someone else's name (bug: claimantId used to be free text);
   *   • an `entity` claim, which used to skip the check entirely, letting the
   *     entity's own representative author both sides.
   * Only an integrity reviewer may knowingly proceed, and the override is
   * recorded on the reconciliation's ledger entry.
   */
  async function separationCheck(
    req: FastifyRequest,
    assertion: typeof assertions.$inferSelect,
    evidenceRows: Array<typeof evidence.$inferSelect>,
  ): Promise<{ override: boolean; reason: string | null }> {
    if (evidenceRows.length === 0) return { override: false, reason: null };
    const submitters = new Set(evidenceRows.map((e) => e.submittedBy));
    const problems: string[] = [];
    if (assertion.claimantKind === "user" && evidenceRows.every((e) => e.submittedBy === assertion.claimantId)) {
      problems.push("every evidence row was submitted by the claimant");
    }
    if (assertion.createdBy && evidenceRows.every((e) => e.submittedBy === assertion.createdBy)) {
      problems.push("every evidence row was submitted by the author of the assertion");
    }
    if (submitters.size === 1 && submitters.has(req.user!.id) && (
      assertion.claimantId === req.user!.id || assertion.createdBy === req.user!.id
    )) {
      problems.push("the caller authored or claimed the assertion and submitted all of its evidence");
    }
    if (problems.length === 0) return { override: false, reason: null };
    const allowed = await holdsAssuranceRole(req, ["integrity_reviewer"], req.projectId);
    if (!allowed) {
      throw forbidden(
        `evidence not independent of claimant: ${problems.join("; ")}. An assertion and the ` +
          "evidence that tests it must not come from the same actor (Vol III §4). An integrity " +
          "reviewer may record such a reconciliation knowingly; nobody else may.",
      );
    }
    return { override: true, reason: problems.join("; ") };
  }

  app.post(
    "/projects/:projectId/reconciliations",
    { preHandler: standardGate },
    async (req, reply) => {
      const body = reconciliationCreateSchema.parse(req.body);

      const assertionRows = await app.db
        .select()
        .from(assertions)
        .where(
          and(
            eq(assertions.id, body.assertionId),
            eq(assertions.companyId, req.companyId!),
            eq(assertions.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const assertion = assertionRows[0];
      if (!assertion) throw notFound("Assertion not found in this project");

      const uniqueEvidenceIds = [...new Set(body.evidenceIds)];
      const evidenceRows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            inArray(evidence.id, uniqueEvidenceIds),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        );
      if (evidenceRows.length !== uniqueEvidenceIds.length) {
        throw notFound("One or more evidence records not found in this project");
      }

      const separation = await separationCheck(req, assertion, evidenceRows);
      const { policy, source: policySource } = await toleranceFor(
        req.companyId!,
        req.projectId!,
        assertion.kind,
      );

      let result;
      let variance: number | null = null;
      let variancePercent: number | null = null;
      let confidence: number;
      let basis: string;
      let reconcilerKind = body.method;
      let rejected: Array<{ evidenceId: string; reason: string }> = [];

      if (body.method === "manual") {
        if (!body.result) {
          throw badRequest("manual reconciliation requires an explicit result");
        }
        result = body.result;
        confidence =
          evidenceRows.reduce(
            (a, e) => a + effectiveIndependence(toEvidenceLike(e), toAssertionLike(assertion)).score,
            0,
          ) / evidenceRows.length;
        basis =
          "Recorded manually by a reviewer. No automated comparison was made; the confidence " +
          "shown is the mean independence of the evidence attached, not a measure of the verdict.";
      } else {
        const outcome = autoReconcile(
          toAssertionLike(assertion),
          evidenceRows.map(toEvidenceLike),
          policy,
        );
        result = outcome.result;
        variance = outcome.variance;
        variancePercent = outcome.variancePercent;
        confidence = outcome.confidence;
        basis = `${outcome.basis} Tolerance from ${policySource}.`;
        reconcilerKind = outcome.reconciler;
        rejected = outcome.rejected;
      }

      const id = newId("rec");
      const row = {
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        assertionId: assertion.id,
        evidenceIds: uniqueEvidenceIds,
        method: body.method,
        result,
        variance,
        variancePercent,
        confidence,
        reviewerId: null,
        disposition: null,
        notes: body.notes ?? null,
        createdBy: req.user!.id,
      };
      await app.db.insert(reconciliations).values(row);
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "reconciliation",
        objectId: id,
        payload: {
          ...row,
          reconciler: reconcilerKind,
          basis,
          selfCertifiedOverride: separation.override ? separation.reason : null,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      return reply.status(201).send({
        ...row,
        reconciler: reconcilerKind,
        basis,
        rejectedEvidence: rejected,
        selfCertifiedOverride: separation.override ? separation.reason : null,
      });
    },
  );

  /**
   * Run every competent reconciler over every unreconciled assertion in the
   * project, against EVERY eligible evidence row — not a hand-picked list.
   *
   * This is the answer to evidence cherry-picking: a claimant who attaches the
   * one favourable survey still gets tested against the four that contradict
   * it, because the pool here is the project's evidence, not the claimant's
   * selection. Assertions that already have a reconciliation are skipped
   * unless `force` is set, so running it twice is safe.
   */
  app.post(
    "/projects/:projectId/reconciliations/auto",
    { preHandler: standardGate },
    async (req) => {
      const body = z
        .object({
          force: z.boolean().optional(),
          kind: z.enum(ASSERTION_KINDS).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .parse(req.body ?? {});
      const limit = body.limit ?? 200;

      const assertionRows = await app.db
        .select()
        .from(assertions)
        .where(
          and(
            eq(assertions.companyId, req.companyId!),
            eq(assertions.projectId, req.projectId!),
            body.kind ? eq(assertions.kind, body.kind) : undefined,
          ),
        )
        .orderBy(desc(assertions.assertedAt))
        .limit(limit);
      if (assertionRows.length === 0) {
        return { assertions: 0, created: 0, skipped: 0, results: {}, contradicted: [] };
      }
      const existing = await app.db
        .select({ assertionId: reconciliations.assertionId })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.companyId, req.companyId!),
            eq(reconciliations.projectId, req.projectId!),
          ),
        );
      const reconciled = new Set(existing.map((r) => r.assertionId));

      const pool = (
        await app.db
          .select()
          .from(evidence)
          .where(
            and(
              eq(evidence.companyId, req.companyId!),
              eq(evidence.projectId, req.projectId!),
            ),
          )
          .orderBy(desc(evidence.ingestedAt))
          .limit(2000)
      ).map(toEvidenceLike);

      let created = 0;
      let skipped = 0;
      const results: Record<string, number> = {};
      const contradicted: Array<{ assertionId: string; reconciliationId: string; variancePercent: number | null }> = [];
      const drafts: SignalDraft[] = [];

      for (const assertion of assertionRows) {
        if (!body.force && reconciled.has(assertion.id)) {
          skipped += 1;
          continue;
        }
        const { policy, source: policySource } = await toleranceFor(
          req.companyId!,
          req.projectId!,
          assertion.kind,
        );
        const outcome = autoReconcile(toAssertionLike(assertion), pool, policy);
        const id = newId("rec");
        const row = {
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          assertionId: assertion.id,
          evidenceIds: outcome.usedEvidenceIds,
          method: outcome.reconciler,
          result: outcome.result,
          variance: outcome.variance,
          variancePercent: outcome.variancePercent,
          confidence: outcome.confidence,
          reviewerId: null,
          disposition: null,
          notes: `${outcome.basis} Tolerance from ${policySource}.`,
          createdBy: req.user!.id,
        };
        await app.db.insert(reconciliations).values(row);
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "reconciliation",
          objectId: id,
          payload: { ...row, auto: true, rejected: outcome.rejected.slice(0, 20) },
          storePayload: true,
          projectId: req.projectId!,
        });
        created += 1;
        results[outcome.result] = (results[outcome.result] ?? 0) + 1;

        if (outcome.result === "contradicted" && outcome.adverse && outcome.confidence > 0) {
          contradicted.push({
            assertionId: assertion.id,
            reconciliationId: id,
            variancePercent: outcome.variancePercent,
          });
          drafts.push({
            detector: "certified_above_evidenced",
            severity: Math.abs(outcome.variancePercent ?? 0) >= 30 ? "high" : "medium",
            confidence: Math.min(0.95, outcome.confidence),
            title: `Claim exceeds independent observation by ${Math.abs(outcome.variancePercent ?? 0).toFixed(1)}%`,
            explanation:
              `Assertion ${assertion.id} (${assertion.kind}) claims ${assertion.value}` +
              `${assertion.unit ? ` ${assertion.unit}` : ""}; the ${outcome.reconciler} reconciler ` +
              `observed ${outcome.observed?.toFixed(3) ?? "—"} from ${outcome.usedEvidenceIds.length} ` +
              `independent evidence row(s). ${outcome.basis}`,
            evidenceRefs: {
              assertionId: assertion.id,
              reconciliationId: id,
              reconciler: outcome.reconciler,
              claimed: outcome.claimed,
              observed: outcome.observed,
              variancePercent: outcome.variancePercent,
              evidenceIds: outcome.usedEvidenceIds,
            },
            fingerprint: fingerprintOf(assertion.id, outcome.reconciler),
            subjectType: assertion.claimantKind === "entity" ? "entity" : "user",
            subjectId: assertion.claimantId,
            links: [
              { objectType: "assertion", objectId: assertion.id, role: "subject" },
              { objectType: "reconciliation", objectId: id },
              ...outcome.usedEvidenceIds.map((e) => ({ objectType: "evidence", objectId: e })),
            ],
          });
        }
      }

      const raised = await raiseSignals(
        req.companyId!,
        req.projectId!,
        req.user!.id,
        drafts,
        null,
      );
      return {
        assertions: assertionRows.length,
        created,
        skipped,
        results,
        contradicted,
        signalsCreated: raised.created,
        signalsRefreshed: raised.refreshed,
      };
    },
  );

  app.get("/projects/:projectId/reconciliations", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ result: z.enum(RECONCILIATION_RESULTS).optional() })
      .parse(req.query);
    const where = and(
      eq(reconciliations.companyId, req.companyId!),
      eq(reconciliations.projectId, req.projectId!),
      q.result ? eq(reconciliations.result, q.result) : undefined,
    );
    const items = await app.db
      .select()
      .from(reconciliations)
      .where(where)
      .orderBy(desc(reconciliations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(reconciliations).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/reconciliations/:reconciliationId",
    { preHandler: readGate },
    async (req) => {
      const { reconciliationId } = req.params as { reconciliationId: string };
      const rows = await app.db
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, reconciliationId),
            eq(reconciliations.companyId, req.companyId!),
            eq(reconciliations.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const rec = rows[0];
      if (!rec) throw notFound("Reconciliation not found");
      const assertionRows = await app.db
        .select()
        .from(assertions)
        .where(and(eq(assertions.id, rec.assertionId), eq(assertions.companyId, req.companyId!)))
        .limit(1);
      const evidenceRows =
        rec.evidenceIds.length > 0
          ? await app.db
              .select()
              .from(evidence)
              .where(
                and(inArray(evidence.id, rec.evidenceIds), eq(evidence.companyId, req.companyId!)),
              )
          : [];
      return { ...rec, assertion: assertionRows[0] ?? null, evidence: evidenceRows };
    },
  );

  app.patch(
    "/reconciliations/:reconciliationId/disposition",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireAssuranceRole(["integrity_reviewer", "auditor"]),
      ],
    },
    async (req) => {
      const { reconciliationId } = req.params as { reconciliationId: string };
      const body = dispositionSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, reconciliationId),
            eq(reconciliations.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const rec = rows[0];
      if (!rec) throw notFound("Reconciliation not found");
      // `requireAssuranceRole` admits any live grant of the role, ignoring the
      // grant's own projectId — so the project scope is enforced HERE, against
      // the target's project. A reviewer for project A has no business
      // disposing of project B's reconciliations.
      if (!(await holdsAssuranceRole(req, ["integrity_reviewer", "auditor"], rec.projectId))) {
        throw forbidden(
          "Your assurance grant does not cover this reconciliation's project. A project-scoped " +
            "grant confers no authority over other projects.",
        );
      }
      const updated = {
        disposition: body.disposition,
        notes: body.notes ?? rec.notes,
        reviewerId: req.user!.id,
      };
      await app.db
        .update(reconciliations)
        .set(updated)
        .where(eq(reconciliations.id, reconciliationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "reconciliation",
        objectId: reconciliationId,
        payload: {
          before: { disposition: rec.disposition, reviewerId: rec.reviewerId },
          after: updated,
        },
        storePayload: true,
        projectId: rec.projectId,
      });
      return { ...rec, ...updated };
    },
  );

  /* ----- reconciliation tolerance policies ------------------------- */

  app.get("/projects/:projectId/reconciliation-policies", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(reconciliationPolicies)
      .where(
        and(
          eq(reconciliationPolicies.companyId, req.companyId!),
          or(
            eq(reconciliationPolicies.projectId, req.projectId!),
            isNull(reconciliationPolicies.projectId),
          ),
        ),
      );
    const effective = [];
    for (const kind of ASSERTION_KINDS) {
      const { policy, source } = await toleranceFor(req.companyId!, req.projectId!, kind);
      effective.push({ assertionKind: kind, ...policy, source });
    }
    return {
      items: rows,
      effective,
      reconcilers: RECONCILERS.map((r) => ({
        kind: r.kind,
        assertionKinds: r.assertionKinds,
        evidenceKinds: r.evidenceKinds,
        fields: r.fields,
        aggregation: r.aggregation,
        description: r.description,
      })),
    };
  });

  app.put("/projects/:projectId/reconciliation-policies", { preHandler: standardGate }, async (req) => {
    const body = z
      .object({
        assertionKind: z.enum(ASSERTION_KINDS),
        supportedWithinPercent: z.number().min(0).max(100),
        partialWithinPercent: z.number().min(0).max(200),
        minIndependence: z.number().min(0).max(1).optional(),
        maxCaptureGapDays: z.number().min(0).max(3650).nullable().optional(),
      })
      .parse(req.body);
    if (body.partialWithinPercent < body.supportedWithinPercent) {
      throw badRequest("partialWithinPercent must be at least supportedWithinPercent");
    }
    const existing = await app.db
      .select()
      .from(reconciliationPolicies)
      .where(
        and(
          eq(reconciliationPolicies.companyId, req.companyId!),
          eq(reconciliationPolicies.projectId, req.projectId!),
          eq(reconciliationPolicies.assertionKind, body.assertionKind),
        ),
      )
      .limit(1);
    const values = {
      supportedWithinPercent: body.supportedWithinPercent,
      partialWithinPercent: body.partialWithinPercent,
      minIndependence: body.minIndependence ?? 0,
      maxCaptureGapDays: body.maxCaptureGapDays ?? null,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString(),
    };
    let id: string;
    if (existing[0]) {
      id = existing[0].id;
      await app.db
        .update(reconciliationPolicies)
        .set(values)
        .where(eq(reconciliationPolicies.id, id));
    } else {
      id = newId("rpol");
      await app.db.insert(reconciliationPolicies).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        assertionKind: body.assertionKind,
        ...values,
      });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing[0] ? "update" : "create",
      objectType: "reconciliation_policy",
      objectId: id,
      payload: { before: existing[0] ?? null, after: { ...values, assertionKind: body.assertionKind } },
      storePayload: true,
      projectId: req.projectId!,
    });
    return { id, assertionKind: body.assertionKind, ...values };
  });

  /* ---------------------------------------------------------------- */
  /* 4. Obligations                                                    */
  /* ---------------------------------------------------------------- */

  async function loadObligation(req: FastifyRequest, obligationId: string) {
    const rows = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.id, obligationId),
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Obligation not found");
    return rows[0];
  }

  /**
   * Breach sweep — a SCHEDULED job, not a side effect of reading.
   *
   * It used to run inside `GET /obligations/upcoming`, which meant an auditor
   * with a read-only grant who opened the Obligations tab caused UPDATEs and
   * ledger `state_change` entries attributed to themselves. The evidentiary
   * record then showed the independent reviewer changing operational state —
   * precisely what segregation of duties exists to prevent — and a read-only
   * role produced writes. Entries are now attributed to the system
   * (`actorId: null`) and the sweep runs on the platform scheduler.
   *
   * Idempotent: only `open` obligations past their deadline move, and they
   * move once, to `breached`.
   */
  async function sweepObligationBreaches(db: Db, companyId: string, now: Date): Promise<number> {
    const nowIso = now.toISOString();
    const overdue = await db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, companyId),
          eq(obligations.status, "open"),
          lt(obligations.deadline, nowIso),
        ),
      )
      .limit(1000);
    for (const o of overdue) {
      await db.update(obligations).set({ status: "breached" }).where(eq(obligations.id, o.id));
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "obligation",
        objectId: o.id,
        payload: {
          status: "breached",
          deadline: o.deadline,
          detectedAt: nowIso,
          sweptBy: "assurance.obligation-breach",
        },
        storePayload: true,
        projectId: o.projectId,
      });
      if (o.createdBy) {
        await pushNotifications(db, [
          {
            companyId,
            userId: o.createdBy,
            projectId: o.projectId,
            kind: "overdue",
            title: "Obligation deadline passed",
            body: `${o.sourceClause}: the deadline ${o.deadline} has passed with no recorded satisfaction.`,
            recordType: "obligation",
            recordId: o.id,
          },
        ]);
      }
    }
    return overdue.length;
  }

  app.post("/projects/:projectId/obligations", { preHandler: standardGate }, async (req, reply) => {
    const body = obligationCreateSchema.parse(req.body);
    const id = newId("obl");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      sourceClause: body.sourceClause,
      obligorId: body.obligorId ?? null,
      obligeeId: body.obligeeId ?? null,
      trigger: body.trigger,
      deadline: body.deadline ?? null,
      warnDaysBefore: body.warnDaysBefore ?? null,
      evidenceRequirement: body.evidenceRequirement ?? null,
      status: "open",
      createdBy: req.user!.id,
    };
    await app.db.insert(obligations).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "obligation",
      objectId: id,
      payload: row,
      storePayload: true,
      projectId: req.projectId!,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/obligations", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ status: z.string().optional() }).parse(req.query);
    const where = and(
      eq(obligations.companyId, req.companyId!),
      eq(obligations.projectId, req.projectId!),
      q.status ? eq(obligations.status, q.status) : undefined,
    );
    const items = await app.db
      .select()
      .from(obligations)
      .where(where)
      .orderBy(desc(obligations.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(obligations).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  // NOTE: registered before /:obligationId so the static segment wins.
  app.get("/projects/:projectId/obligations/upcoming", { preHandler: readGate }, async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(730).default(30) })
      .parse(req.query);
    const nowIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + q.days * 24 * 3600 * 1000).toISOString();

    // READ ONLY. The breach transition is the scheduler's job
    // (assurance.obligation-breach); a read must never mutate the record it
    // reports on, least of all under a read-only assurance grant.
    const items = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          eq(obligations.status, "open"),
          gte(obligations.deadline, nowIso),
          lte(obligations.deadline, untilIso),
        ),
      )
      .orderBy(asc(obligations.deadline));
    const [breachedRow] = await app.db
      .select({ n: count() })
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          eq(obligations.status, "breached"),
        ),
      );
    const [overdueOpenRow] = await app.db
      .select({ n: count() })
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, req.companyId!),
          eq(obligations.projectId, req.projectId!),
          eq(obligations.status, "open"),
          lt(obligations.deadline, nowIso),
        ),
      );
    return {
      items,
      breached: Number(breachedRow?.n ?? 0),
      /** past deadline but not yet swept — the sweep runs on the scheduler */
      awaitingSweep: Number(overdueOpenRow?.n ?? 0),
      windowDays: q.days,
      sweepJob: "assurance.obligation-breach",
    };
  });

  app.get(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: readGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      return loadObligation(req, obligationId);
    },
  );

  /** States from which an obligation may still be satisfied or waived. */
  const OBLIGATION_ACTIONABLE = new Set(["open", "breached", "disputed"]);

  app.patch(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = obligationPatchSchema.parse(req.body);
      const existing = await loadObligation(req, obligationId);
      if (existing.status === "satisfied" || existing.status === "waived") {
        throw conflict(
          `This obligation is ${existing.status}. Editing a closed obligation would rewrite the ` +
            "record of what was owed after the question was settled; raise a new obligation " +
            "instead.",
        );
      }
      const patch: Record<string, unknown> = {};
      if (body.sourceClause !== undefined) patch["sourceClause"] = body.sourceClause;
      if (body.trigger !== undefined) patch["trigger"] = body.trigger;
      if (body.obligorId !== undefined) patch["obligorId"] = body.obligorId;
      if (body.obligeeId !== undefined) patch["obligeeId"] = body.obligeeId;
      if (body.deadline !== undefined) patch["deadline"] = body.deadline;
      if (body.warnDaysBefore !== undefined) patch["warnDaysBefore"] = body.warnDaysBefore;
      if (body.evidenceRequirement !== undefined) {
        patch["evidenceRequirement"] = body.evidenceRequirement;
      }
      if (Object.keys(patch).length === 0) return existing;

      // Moving the deadline of a BREACHED obligation must recompute the
      // status: a deadline pushed into the future un-breaches it, and leaving
      // it "breached" would mean the register disagreed with its own dates.
      // The move itself is recorded either way.
      if (existing.status === "breached" && body.deadline !== undefined) {
        const newDeadline = body.deadline ? Date.parse(body.deadline) : NaN;
        if (!Number.isNaN(newDeadline) && newDeadline > Date.now()) {
          patch["status"] = "open";
        } else if (body.deadline === null) {
          patch["status"] = "open";
        }
      }
      await app.db.update(obligations).set(patch).where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "obligation",
        objectId: obligationId,
        payload: { before: existing, after: { ...existing, ...patch } },
        storePayload: true,
        projectId: req.projectId!,
      });
      return { ...existing, ...patch };
    },
  );

  app.delete(
    "/projects/:projectId/obligations/:obligationId",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const existing = await loadObligation(req, obligationId);
      await app.db.delete(obligations).where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "obligation",
        objectId: obligationId,
        // The full prior row, not just the id: a deletion that keeps no
        // content destroys the evidence it was about (Domain S #867).
        payload: { before: existing },
        storePayload: true,
        projectId: req.projectId!,
      });
      return { ok: true };
    },
  );

  app.post(
    "/projects/:projectId/obligations/:obligationId/satisfy",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = z.object({ evidenceId: z.string().min(1) }).parse(req.body);
      const existing = await loadObligation(req, obligationId);
      if (!OBLIGATION_ACTIONABLE.has(existing.status)) {
        throw conflict(
          `Cannot satisfy an obligation that is already ${existing.status}. Re-satisfying a ` +
            "settled obligation would silently replace the evidence the settlement rests on.",
        );
      }
      const evidenceRows = await app.db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.id, body.evidenceId),
            eq(evidence.companyId, req.companyId!),
            eq(evidence.projectId, req.projectId!),
          ),
        )
        .limit(1);
      const ev = evidenceRows[0];
      if (!ev) throw notFound("Evidence not found in this project");
      await app.db
        .update(obligations)
        .set({ status: "satisfied", satisfiedEvidenceId: ev.id })
        .where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "obligation",
        objectId: obligationId,
        // Separation rule does not gate satisfaction, but self-certification
        // is recorded so a reviewer can weigh it later.
        payload: {
          before: { status: existing.status, satisfiedEvidenceId: existing.satisfiedEvidenceId },
          status: "satisfied",
          evidenceId: ev.id,
          evidenceSubmittedBy: ev.submittedBy,
          selfCertified: ev.submittedBy === req.user!.id,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      return { ...existing, status: "satisfied", satisfiedEvidenceId: ev.id };
    },
  );

  app.post(
    "/projects/:projectId/obligations/:obligationId/waive",
    { preHandler: standardGate },
    async (req) => {
      const { obligationId } = req.params as { obligationId: string };
      const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body);
      const existing = await loadObligation(req, obligationId);
      if (!OBLIGATION_ACTIONABLE.has(existing.status)) {
        throw conflict(
          `Cannot waive an obligation that is already ${existing.status}.`,
        );
      }
      await app.db
        .update(obligations)
        .set({ status: "waived" })
        .where(eq(obligations.id, obligationId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "obligation",
        objectId: obligationId,
        // obligations has no notes column; the waive reason lives in the ledger
        payload: { before: { status: existing.status }, status: "waived", reason: body.reason },
        storePayload: true,
        projectId: req.projectId!,
      });
      return { ...existing, status: "waived" };
    },
  );

  /* ---------------------------------------------------------------- */
  /* 5. Events                                                         */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/events", { preHandler: standardGate }, async (req, reply) => {
    const body = eventCreateSchema.parse(req.body);
    const id = newId("evt");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      type: body.type,
      occurredAt: body.occurredAt,
      location: body.location ?? null,
      detectedOrReported: body.detectedOrReported ?? "reported",
      causalLinks: body.causalLinks ?? [],
      payload: body.payload ?? null,
      createdBy: req.user!.id,
    };
    await app.db.insert(events).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "event",
      objectId: id,
      payload: row,
      storePayload: true,
      projectId: req.projectId!,
    });
    return reply.status(201).send(row);
  });

  app.get("/projects/:projectId/events", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.extend({ type: z.string().optional() }).parse(req.query);
    const where = and(
      eq(events.companyId, req.companyId!),
      eq(events.projectId, req.projectId!),
      q.type ? eq(events.type, q.type) : undefined,
    );
    const items = await app.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(events).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* ---------------------------------------------------------------- */
  /* 6. Entities + relationship graph                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Entity writes are NOT a general company-member capability.
   *
   * The entity register is the investigative substrate: it holds the bank
   * accounts, addresses and ownership edges that the collusion detectors run
   * on. Letting any member edit or delete it means the person under
   * investigation can remove the evidence — and the original implementation
   * did exactly that, with a delete that cascaded every relationship and
   * ledgered nothing but the id.
   */
  async function requireEntityWriter(req: FastifyRequest): Promise<void> {
    if (req.companyRole === "owner" || req.companyRole === "admin") return;
    if (await holdsAssuranceRole(req, ["integrity_reviewer", "auditor"], null)) return;
    throw forbidden(
      "Maintaining the entity register requires company owner/admin or a tenant-wide " +
        "integrity_reviewer/auditor grant. The register is what the collusion detectors run " +
        "on; it is not general member-editable.",
    );
  }

  async function loadEntity(req: FastifyRequest, entityId: string, includeDeleted = false) {
    const rows = await app.db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.id, entityId),
          eq(entities.companyId, req.companyId!),
          includeDeleted ? undefined : isNull(entities.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Entity not found");
    return rows[0];
  }

  app.post("/entities", { preHandler: companyGate }, async (req, reply) => {
    await requireEntityWriter(req);
    const body = entityCreateSchema.parse(req.body);
    const id = newId("ent");
    const row = {
      id,
      companyId: req.companyId!,
      kind: body.kind,
      name: body.name,
      identifiers: body.identifiers ?? {},
      jurisdiction: body.jurisdiction ?? null,
      screeningStatus: body.screeningStatus ?? null,
      notes: body.notes ?? null,
    };
    await app.db.insert(entities).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "entity",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/entities", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const q = pageQuerySchema
      .extend({
        kind: z.enum(ENTITY_KINDS).optional(),
        search: z.string().max(200).optional(),
        screeningStatus: z.string().max(50).optional(),
        includeDeleted: z.coerce.boolean().optional(),
      })
      .parse(req.query);
    const where = and(
      eq(entities.companyId, req.companyId!),
      q.includeDeleted ? undefined : isNull(entities.deletedAt),
      q.kind ? eq(entities.kind, q.kind) : undefined,
      q.screeningStatus ? eq(entities.screeningStatus, q.screeningStatus) : undefined,
      q.search ? ilike(entities.name, `%${q.search}%`) : undefined,
    );
    const items = await app.db
      .select()
      .from(entities)
      .where(where)
      .orderBy(asc(entities.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(entities).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /* -------- entity scan (must precede /entities/:entityId GETs) ----- */

  const SCAN_CHECKS: Array<{
    identifier: string;
    relationshipKind: string;
    confidence: number;
    severity: SignalSeverity;
  }> = [
    {
      identifier: "bank_account",
      relationshipKind: "shares_bank_account_with",
      confidence: 0.9,
      severity: "high",
    },
    {
      identifier: "address",
      relationshipKind: "shares_address_with",
      confidence: 0.6,
      severity: "medium",
    },
    {
      identifier: "email_domain",
      relationshipKind: "shares_contact_with",
      confidence: 0.6,
      severity: "medium",
    },
    { identifier: "phone", relationshipKind: "shares_contact_with", confidence: 0.6, severity: "medium" },
  ];

  function scanIdentifierOf(
    row: { identifiers: Record<string, string> },
    key: string,
  ): string | null {
    const ids = row.identifiers;
    const norm = (s: string | undefined): string | null => {
      const t = (s ?? "").trim().toLowerCase();
      return t.length > 0 ? t : null;
    };
    if (key === "email_domain") {
      const explicit = norm(ids["email_domain"]);
      if (explicit) return explicit;
      const email = norm(ids["email"]);
      return email && email.includes("@") ? (email.split("@")[1] ?? null) : null;
    }
    return norm(ids[key]);
  }

  /**
   * Bucketed identifier scan.
   *
   * The first implementation compared every pair of entities — 50 million
   * comparisons on a 10,000-entity register, each one a serial round trip when
   * it matched. This buckets by normalised identifier value instead, which is
   * O(n) and finds exactly the same collisions: two entities collide precisely
   * when they land in the same bucket.
   */
  app.post("/entities/scan", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const started = Date.now();
    const rows = await app.db
      .select()
      .from(entities)
      .where(and(eq(entities.companyId, req.companyId!), isNull(entities.deletedAt)));

    const existing = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, req.companyId!));
    const seen = new Set<string>();
    for (const r of existing) {
      seen.add(`${r.fromEntityId}|${r.toEntityId}|${r.kind}`);
      seen.add(`${r.toEntityId}|${r.fromEntityId}|${r.kind}`);
    }

    const relationshipValues: Array<typeof entityRelationships.$inferInsert> = [];
    const drafts: SignalDraft[] = [];
    const findings: Array<{
      fromEntityId: string;
      toEntityId: string;
      kind: string;
      identifier: string;
      value: string;
    }> = [];

    for (const check of SCAN_CHECKS) {
      const buckets = new Map<string, typeof rows>();
      for (const row of rows) {
        const v = scanIdentifierOf(row, check.identifier);
        if (!v) continue;
        const list = buckets.get(v) ?? [];
        list.push(row);
        buckets.set(v, list);
      }
      for (const [value, group] of buckets) {
        if (group.length < 2) continue;
        // Pairwise WITHIN a bucket only — bounded by how many entities really
        // do share one identifier, not by the size of the register.
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const a = group[i]!;
            const b = group[j]!;
            const key = `${a.id}|${b.id}|${check.relationshipKind}`;
            if (seen.has(key)) continue;
            seen.add(key);
            seen.add(`${b.id}|${a.id}|${check.relationshipKind}`);
            const relId = newId("erel");
            relationshipValues.push({
              id: relId,
              companyId: req.companyId!,
              fromEntityId: a.id,
              toEntityId: b.id,
              kind: check.relationshipKind,
              source: `scan:shared_identifier:${check.identifier}`,
              confidence: check.confidence,
            });
            drafts.push({
              detector: "shared_identifier",
              severity: check.severity,
              confidence: check.confidence,
              title: `Entities share ${check.identifier.replace(/_/g, " ")}: ${a.name} / ${b.name}`,
              explanation:
                `"${a.name}" (${a.id}) and "${b.name}" (${b.id}) share the same ` +
                `${check.identifier.replace(/_/g, " ")} ("${value}"). Shared identifiers across ` +
                `nominally independent parties are a collusion / related-party indicator.`,
              evidenceRefs: {
                entityIds: [a.id, b.id],
                identifier: check.identifier,
                value,
                relationshipId: relId,
              },
              fingerprint: fingerprintOf(check.identifier, sortedIds([a.id, b.id])),
              subjectType: "entity",
              subjectId: a.id,
              links: [
                { objectType: "entity", objectId: a.id, role: "subject" },
                { objectType: "entity", objectId: b.id, role: "subject" },
              ],
            });
            findings.push({
              fromEntityId: a.id,
              toEntityId: b.id,
              kind: check.relationshipKind,
              identifier: check.identifier,
              value,
            });
          }
        }
      }
    }

    if (relationshipValues.length > 0) {
      // One batched insert, then one ledger entry per relationship (the chain
      // is per-row by construction) — but no longer interleaved with the
      // comparison loop, so a big scan is a handful of round trips.
      for (let i = 0; i < relationshipValues.length; i += 200) {
        await app.db.insert(entityRelationships).values(relationshipValues.slice(i, i + 200));
      }
      for (const rel of relationshipValues) {
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "entity_relationship",
          objectId: rel.id,
          payload: { fromEntityId: rel.fromEntityId, toEntityId: rel.toEntityId, kind: rel.kind },
          storePayload: true,
        });
      }
    }
    const raised = await raiseSignals(req.companyId!, null, req.user!.id, drafts, null);
    return {
      entitiesScanned: rows.length,
      relationshipsCreated: relationshipValues.length,
      signalsCreated: raised.created,
      signalsRefreshed: raised.refreshed,
      findings,
      durationMs: Date.now() - started,
    };
  });

  app.get("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const { entityId } = req.params as { entityId: string };
    return loadEntity(req, entityId, true);
  });

  app.patch("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { entityId } = req.params as { entityId: string };
    const body = entityPatchSchema.parse(req.body);
    const existing = await loadEntity(req, entityId);
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined) patch["kind"] = body.kind;
    if (body.name !== undefined) patch["name"] = body.name;
    if (body.identifiers !== undefined) patch["identifiers"] = body.identifiers;
    if (body.jurisdiction !== undefined) patch["jurisdiction"] = body.jurisdiction;
    if (body.screeningStatus !== undefined) patch["screeningStatus"] = body.screeningStatus;
    if (body.notes !== undefined) patch["notes"] = body.notes;
    if (Object.keys(patch).length === 0) return existing;
    await app.db.update(entities).set(patch).where(eq(entities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "entity",
      objectId: entityId,
      // BEFORE and after. Storing only the patch let someone overwrite a bank
      // account to break future scans and leave no record of what it was
      // (Domain S #866).
      payload: { before: existing, after: { ...existing, ...patch } },
      storePayload: true,
    });
    return { ...existing, ...patch };
  });

  app.delete("/entities/:entityId", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { entityId } = req.params as { entityId: string };
    const body = z.object({ reason: z.string().min(1).max(2000) }).parse(req.body ?? {});
    const existing = await loadEntity(req, entityId);
    const relationships = await app.db
      .select()
      .from(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          or(
            eq(entityRelationships.fromEntityId, entityId),
            eq(entityRelationships.toEntityId, entityId),
          ),
        ),
      );
    const nowIso = new Date().toISOString();
    // SOFT delete. The relationships stay: a scan-inferred
    // "shares_bank_account_with" edge is the evidence, and cascading it away
    // on delete is how the register gets cleaned before an investigation.
    await app.db
      .update(entities)
      .set({ deletedAt: nowIso, deletedBy: req.user!.id, deleteReason: body.reason })
      .where(eq(entities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "entity",
      objectId: entityId,
      payload: {
        before: existing,
        relationshipsRetained: relationships.map((r) => ({
          id: r.id,
          from: r.fromEntityId,
          to: r.toEntityId,
          kind: r.kind,
          source: r.source,
        })),
        soft: true,
        reason: body.reason,
      },
      storePayload: true,
    });
    return { ok: true, soft: true, relationshipsRetained: relationships.length };
  });

  app.post("/entities/:entityId/restore", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { entityId } = req.params as { entityId: string };
    const existing = await loadEntity(req, entityId, true);
    if (!existing.deletedAt) return existing;
    await app.db
      .update(entities)
      .set({ deletedAt: null, deletedBy: null, deleteReason: null })
      .where(eq(entities.id, entityId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "entity",
      objectId: entityId,
      payload: { restored: true, before: { deletedAt: existing.deletedAt } },
      storePayload: true,
    });
    return { ...existing, deletedAt: null, deletedBy: null, deleteReason: null };
  });

  app.post("/entities/:entityId/relationships", { preHandler: companyGate }, async (req, reply) => {
    await requireEntityWriter(req);
    const { entityId } = req.params as { entityId: string };
    const body = relationshipCreateSchema.parse(req.body);
    if (body.toEntityId === entityId) throw badRequest("An entity cannot relate to itself");
    await loadEntity(req, entityId);
    await loadEntity(req, body.toEntityId);
    const dupes = await app.db
      .select({ id: entityRelationships.id })
      .from(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          eq(entityRelationships.fromEntityId, entityId),
          eq(entityRelationships.toEntityId, body.toEntityId),
          eq(entityRelationships.kind, body.kind),
        ),
      )
      .limit(1);
    if (dupes[0]) throw badRequest("Relationship already exists");
    const id = newId("erel");
    const row = {
      id,
      companyId: req.companyId!,
      fromEntityId: entityId,
      toEntityId: body.toEntityId,
      kind: body.kind,
      since: body.since ?? null,
      source: body.source ?? null,
      confidence: body.confidence ?? null,
    };
    await app.db.insert(entityRelationships).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "entity_relationship",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/entities/:entityId/relationships", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const { entityId } = req.params as { entityId: string };
    await loadEntity(req, entityId, true);
    const items = await app.db
      .select()
      .from(entityRelationships)
      .where(
        and(
          eq(entityRelationships.companyId, req.companyId!),
          or(
            eq(entityRelationships.fromEntityId, entityId),
            eq(entityRelationships.toEntityId, entityId),
          ),
        ),
      )
      .orderBy(desc(entityRelationships.createdAt));
    return { items, total: items.length };
  });

  app.delete(
    "/entities/:entityId/relationships/:relationshipId",
    { preHandler: companyGate },
    async (req) => {
      await requireEntityWriter(req);
      const { entityId, relationshipId } = req.params as {
        entityId: string;
        relationshipId: string;
      };
      const rows = await app.db
        .select()
        .from(entityRelationships)
        .where(
          and(
            eq(entityRelationships.id, relationshipId),
            eq(entityRelationships.companyId, req.companyId!),
            or(
              eq(entityRelationships.fromEntityId, entityId),
              eq(entityRelationships.toEntityId, entityId),
            ),
          ),
        )
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("Relationship not found");
      await app.db.delete(entityRelationships).where(eq(entityRelationships.id, relationshipId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "entity_relationship",
        objectId: relationshipId,
        payload: { before: existing },
        storePayload: true,
      });
      return { ok: true };
    },
  );

  app.get("/entities/:entityId/graph", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const { entityId } = req.params as { entityId: string };
    const q = z.object({ depth: z.coerce.number().int().min(1).max(6).default(2) }).parse(req.query);
    await loadEntity(req, entityId, true);

    const allRels = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, req.companyId!));

    const adjacency = new Map<string, typeof allRels>();
    for (const rel of allRels) {
      for (const end of [rel.fromEntityId, rel.toEntityId]) {
        const list = adjacency.get(end) ?? [];
        list.push(rel);
        adjacency.set(end, list);
      }
    }

    const visited = new Map<string, number>([[entityId, 0]]);
    const edgeIds = new Set<string>();
    let frontier = [entityId];
    for (let d = 1; d <= q.depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const rel of adjacency.get(nodeId) ?? []) {
          edgeIds.add(rel.id);
          const other = rel.fromEntityId === nodeId ? rel.toEntityId : rel.fromEntityId;
          if (!visited.has(other)) {
            visited.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const nodeIds = [...visited.keys()];
    const nodeRows =
      nodeIds.length > 0
        ? await app.db
            .select()
            .from(entities)
            .where(and(eq(entities.companyId, req.companyId!), inArray(entities.id, nodeIds)))
        : [];
    const edges = allRels.filter(
      (r) => edgeIds.has(r.id) && visited.has(r.fromEntityId) && visited.has(r.toEntityId),
    );
    return {
      root: entityId,
      depth: q.depth,
      nodes: nodeRows.map((n) => ({ ...n, distance: visited.get(n.id) ?? null })),
      edges,
    };
  });

  /* ---------------------------------------------------------------- */
  /* 6b. Exposure, screening, conflicts and authority                  */
  /* ---------------------------------------------------------------- */

  /** All relationship edges for a company, in the pure engines' shape. */
  async function loadGraphEdges(companyId: string): Promise<GraphEdge[]> {
    const rows = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, companyId));
    return rows.map((r) => ({
      id: r.id,
      from: r.fromEntityId,
      to: r.toEntityId,
      kind: r.kind,
      confidence: r.confidence,
      source: r.source,
    }));
  }

  /**
   * `identifiers.user_id` on a person entity is how the assurance layer knows
   * a platform user and an entity are the same human. Without that mapping the
   * conflict detector has nothing to walk from, which it says out loud rather
   * than reporting a clean result.
   */
  async function userEntityMap(companyId: string): Promise<Map<string, string>> {
    const rows = await app.db
      .select({ id: entities.id, identifiers: entities.identifiers })
      .from(entities)
      .where(and(eq(entities.companyId, companyId), isNull(entities.deletedAt)));
    const map = new Map<string, string>();
    for (const r of rows) {
      const userId = r.identifiers["user_id"];
      if (typeof userId === "string" && userId) map.set(userId, r.id);
    }
    return map;
  }

  async function vendorEntityMap(companyId: string): Promise<Map<string, string>> {
    const rows = await app.db
      .select({ id: vendors.id, entityId: vendors.entityId })
      .from(vendors)
      .where(eq(vendors.companyId, companyId));
    const map = new Map<string, string>();
    for (const r of rows) if (r.entityId) map.set(r.id, r.entityId);
    return map;
  }

  app.get("/entities/:entityId/exposure", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const { entityId } = req.params as { entityId: string };
    const q = z.object({ depth: z.coerce.number().int().min(1).max(5).default(3) }).parse(req.query);
    const root = await loadEntity(req, entityId, true);
    const edges = await loadGraphEdges(req.companyId!);
    const { reachableFrom } = await import("./graph.js");
    const reached = reachableFrom(edges, entityId, q.depth);
    const nodeIds = [...new Set(reached.map((r) => r.targetId))];
    const nodeRows =
      nodeIds.length > 0
        ? await app.db
            .select()
            .from(entities)
            .where(and(eq(entities.companyId, req.companyId!), inArray(entities.id, nodeIds)))
        : [];
    const names = new Map(nodeRows.map((n) => [n.id, n.name]));
    names.set(root.id, root.name);

    const vendorMap = await vendorEntityMap(req.companyId!);
    const vendorByEntity = new Map<string, string>();
    for (const [vendorId, eid] of vendorMap) vendorByEntity.set(eid, vendorId);
    const userMap = await userEntityMap(req.companyId!);
    const userByEntity = new Map<string, string>();
    for (const [userId, eid] of userMap) userByEntity.set(eid, userId);

    const declarations = await app.db
      .select()
      .from(conflictDeclarations)
      .where(eq(conflictDeclarations.companyId, req.companyId!));
    const declaredPairs = new Set(
      declarations.filter((d) => !d.endedAt).map((d) => `${d.userId}|${d.entityId}`),
    );

    return {
      root: { id: root.id, name: root.name, kind: root.kind, deletedAt: root.deletedAt },
      depth: q.depth,
      paths: reached.map((r) => ({
        targetId: r.targetId,
        targetName: names.get(r.targetId) ?? null,
        hops: r.path.length,
        vendorId: vendorByEntity.get(r.targetId) ?? null,
        userId: userByEntity.get(r.targetId) ?? null,
        declared:
          userByEntity.get(r.targetId) !== undefined
            ? declaredPairs.has(`${userByEntity.get(r.targetId)}|${root.id}`)
            : userByEntity.get(root.id) !== undefined
              ? declaredPairs.has(`${userByEntity.get(root.id)}|${r.targetId}`)
              : null,
        citations: r.path.edges.map((e) => ({
          relationshipId: e.id,
          from: e.from,
          fromName: names.get(e.from) ?? null,
          to: e.to,
          toName: names.get(e.to) ?? null,
          kind: e.kind,
          source: e.source,
          confidence: e.confidence,
        })),
      })),
      note:
        "Every hop cites the relationship row it walked. A path is a question, not a finding: " +
        "declared interests appear here too, marked `declared: true`.",
    };
  });

  /* ----- screening ------------------------------------------------- */

  async function screenOneEntity(
    companyId: string,
    entity: { id: string; name: string; kind: string; jurisdiction: string | null },
    actorId: string | null,
  ): Promise<{ matches: ScreeningMatch[]; status: string; resultIds: string[] }> {
    const providers = defaultProviders();
    const matches: ScreeningMatch[] = [];
    for (const provider of providers) {
      const snapshot = await provider.load();
      matches.push(...screenAgainst(entity, snapshot));
    }
    const status = statusFromMatches(matches);
    const resultIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const m of matches) {
      const id = newId("scr");
      resultIds.push(id);
      await app.db.insert(screeningResults).values({
        id,
        companyId,
        entityId: entity.id,
        list: m.list,
        matchScore: m.matchScore,
        matchedName: m.matchedName,
        matchedRef: m.matchedRef,
        listSnapshotHash: m.listSnapshotHash,
        listSource: m.listSource,
        disposition: "pending",
        detail: { ...m.detail, fixture: m.fixture },
        screenedAt: nowIso,
      });
    }
    if (matches.length === 0) {
      // A clean screen is a RESULT, not an absence of one: it is what proves
      // the entity was looked at, against which list, on which snapshot.
      const snapshot = await providers[0]!.load();
      const id = newId("scr");
      resultIds.push(id);
      await app.db.insert(screeningResults).values({
        id,
        companyId,
        entityId: entity.id,
        list: providers[0]!.list,
        matchScore: 0,
        matchedName: null,
        matchedRef: null,
        listSnapshotHash: snapshot.snapshotHash,
        listSource: snapshot.source,
        disposition: "cleared",
        detail: {
          clean: true,
          listsScreened: providers.map((p) => p.list),
          fixture: snapshot.fixture,
        },
        screenedAt: nowIso,
      });
    }
    await app.db
      .update(entities)
      .set({ screeningStatus: status, screenedAt: nowIso })
      .where(eq(entities.id, entity.id));
    await appendLedger(app.db, {
      companyId,
      actorId,
      action: "state_change",
      objectType: "entity",
      objectId: entity.id,
      payload: {
        screened: true,
        status,
        matches: matches.map((m) => ({ list: m.list, ref: m.matchedRef, score: m.matchScore })),
        snapshotHashes: [...new Set(matches.map((m) => m.listSnapshotHash))],
      },
      storePayload: true,
    });
    if (matches.length > 0) {
      const best = matches[0]!;
      await raiseSignals(
        companyId,
        null,
        actorId,
        [
          {
            detector: "entity_screening_hit",
            severity: best.list === "pep" ? "medium" : "high",
            confidence: best.matchScore,
            title: `${entity.name} matches ${best.matchedName} on ${best.list}`,
            explanation:
              `Name screening scored ${(best.matchScore * 100).toFixed(0)}% against "${best.matchedName}" ` +
              `(${best.matchedRef}) on the ${best.list} list. Source: ${best.listSource} ` +
              `Snapshot ${best.listSnapshotHash.slice(0, 16)}…. ${matches.length} match(es) in total. ` +
              "A name match is not an identification — disposition it on the screening register " +
              "with the evidence that confirms or excludes it.",
            evidenceRefs: {
              entityId: entity.id,
              matches: matches.map((m) => ({
                list: m.list,
                ref: m.matchedRef,
                name: m.matchedName,
                score: m.matchScore,
                snapshotHash: m.listSnapshotHash,
                fixture: m.fixture,
              })),
            },
            fingerprint: fingerprintOf(entity.id, sortedIds(matches.map((m) => `${m.list}:${m.matchedRef}`))),
            subjectType: "entity",
            subjectId: entity.id,
            links: [{ objectType: "entity", objectId: entity.id, role: "subject" }],
          },
        ],
        null,
      );
    }
    return { matches, status, resultIds };
  }

  app.post("/entities/:entityId/screen", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { entityId } = req.params as { entityId: string };
    const entity = await loadEntity(req, entityId);
    const result = await screenOneEntity(
      req.companyId!,
      { id: entity.id, name: entity.name, kind: entity.kind, jurisdiction: entity.jurisdiction },
      req.user!.id,
    );
    return {
      entityId,
      status: result.status,
      matches: result.matches,
      resultIds: result.resultIds,
      lists: defaultProviders().map((p) => p.list),
      caveat:
        "This deployment has no live sanctions or PEP feed configured. Screening ran against " +
        "shipped fixtures, and every result names the snapshot it was made against.",
    };
  });

  app.post("/entities/screen", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const body = z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(req.body ?? {});
    const rows = await app.db
      .select()
      .from(entities)
      .where(and(eq(entities.companyId, req.companyId!), isNull(entities.deletedAt)))
      .limit(body.limit ?? 200);
    let hits = 0;
    for (const e of rows) {
      const r = await screenOneEntity(
        req.companyId!,
        { id: e.id, name: e.name, kind: e.kind, jurisdiction: e.jurisdiction },
        req.user!.id,
      );
      if (r.matches.length > 0) hits += 1;
    }
    return { screened: rows.length, withMatches: hits };
  });

  app.get("/entities/:entityId/screening", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const { entityId } = req.params as { entityId: string };
    await loadEntity(req, entityId, true);
    const items = await app.db
      .select()
      .from(screeningResults)
      .where(
        and(
          eq(screeningResults.companyId, req.companyId!),
          eq(screeningResults.entityId, entityId),
        ),
      )
      .orderBy(desc(screeningResults.screenedAt))
      .limit(200);
    return { items, total: items.length };
  });

  app.patch("/screening-results/:resultId", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { resultId } = req.params as { resultId: string };
    const body = z
      .object({
        disposition: z.enum(SCREENING_DISPOSITIONS),
        reviewNotes: z.string().max(4000).optional(),
      })
      .parse(req.body);
    const rows = await app.db
      .select()
      .from(screeningResults)
      .where(
        and(eq(screeningResults.id, resultId), eq(screeningResults.companyId, req.companyId!)),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Screening result not found");
    const patch = {
      disposition: body.disposition,
      reviewNotes: body.reviewNotes ?? existing.reviewNotes,
      reviewedBy: req.user!.id,
      reviewedAt: new Date().toISOString(),
    };
    await app.db.update(screeningResults).set(patch).where(eq(screeningResults.id, resultId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "screening_result",
      objectId: resultId,
      payload: { before: { disposition: existing.disposition }, after: patch },
      storePayload: true,
    });
    return { ...existing, ...patch };
  });

  /* ----- conflict-of-interest register ----------------------------- */

  app.post("/conflict-declarations", { preHandler: companyGate }, async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1).max(64).optional(),
        entityId: z.string().min(1).max(64),
        nature: z.string().min(1).max(500),
        notes: z.string().max(4000).optional(),
      })
      .parse(req.body);
    // Anyone may declare their OWN interest — that is the point of a register.
    // Declaring on someone else's behalf is an administrative act.
    const userId = body.userId ?? req.user!.id;
    if (userId !== req.user!.id) await requireEntityWriter(req);
    await loadEntity(req, body.entityId, true);
    const existing = await app.db
      .select()
      .from(conflictDeclarations)
      .where(
        and(
          eq(conflictDeclarations.companyId, req.companyId!),
          eq(conflictDeclarations.userId, userId),
          eq(conflictDeclarations.entityId, body.entityId),
          eq(conflictDeclarations.nature, body.nature),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (!existing[0].endedAt) return reply.status(200).send(existing[0]);
      await app.db
        .update(conflictDeclarations)
        .set({ endedAt: null, declaredAt: new Date().toISOString() })
        .where(eq(conflictDeclarations.id, existing[0].id));
      return reply.status(200).send({ ...existing[0], endedAt: null });
    }
    const id = newId("coi");
    const row = {
      id,
      companyId: req.companyId!,
      userId,
      entityId: body.entityId,
      nature: body.nature,
      notes: body.notes ?? null,
      recordedBy: req.user!.id,
    };
    await app.db.insert(conflictDeclarations).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "conflict_declaration",
      objectId: id,
      payload: row,
      storePayload: true,
    });
    return reply.status(201).send(row);
  });

  app.get("/conflict-declarations", { preHandler: companyGate }, async (req) => {
    const q = pageQuerySchema
      .extend({ userId: z.string().optional(), entityId: z.string().optional() })
      .parse(req.query);
    const reach = await assuranceReachOf(req);
    // Without assurance reach you may read your own declarations and nobody
    // else's: the register is personal data about who is connected to whom.
    const where = and(
      eq(conflictDeclarations.companyId, req.companyId!),
      reach.privileged ? undefined : eq(conflictDeclarations.userId, req.user!.id),
      q.userId ? eq(conflictDeclarations.userId, q.userId) : undefined,
      q.entityId ? eq(conflictDeclarations.entityId, q.entityId) : undefined,
    );
    const items = await app.db
      .select()
      .from(conflictDeclarations)
      .where(where)
      .orderBy(desc(conflictDeclarations.declaredAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(conflictDeclarations).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.delete("/conflict-declarations/:declarationId", { preHandler: companyGate }, async (req) => {
    const { declarationId } = req.params as { declarationId: string };
    const rows = await app.db
      .select()
      .from(conflictDeclarations)
      .where(
        and(
          eq(conflictDeclarations.id, declarationId),
          eq(conflictDeclarations.companyId, req.companyId!),
        ),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Declaration not found");
    if (existing.userId !== req.user!.id) await requireEntityWriter(req);
    const endedAt = new Date().toISOString();
    // Ending, never deleting: a declaration that existed while the approvals
    // were made stays on the record for exactly that reason.
    await app.db
      .update(conflictDeclarations)
      .set({ endedAt })
      .where(eq(conflictDeclarations.id, declarationId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "conflict_declaration",
      objectId: declarationId,
      payload: { before: existing, endedAt },
      storePayload: true,
    });
    return { ...existing, endedAt };
  });

  /* ----- delegation-of-authority limits ---------------------------- */

  app.post("/authority-limits", { preHandler: adminGate }, async (req, reply) => {
    const body = z
      .object({
        userId: z.string().min(1).max(64),
        projectId: z.string().max(64).nullable().optional(),
        objectType: z.string().max(64).optional(),
        maxAmount: z.number().min(0),
        currency: z.string().length(3).optional(),
        effectiveFrom: z.string().max(30).nullable().optional(),
        effectiveTo: z.string().max(30).nullable().optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    if (body.projectId) {
      const p = await projectOf(req.companyId!, body.projectId);
      if (!p) throw notFound("Project not found in this company");
    }
    const id = newId("aul");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      userId: body.userId,
      objectType: body.objectType ?? "any",
      maxAmount: body.maxAmount,
      currency: body.currency ?? "USD",
      effectiveFrom: body.effectiveFrom ?? null,
      effectiveTo: body.effectiveTo ?? null,
      grantedBy: req.user!.id,
      notes: body.notes ?? null,
    };
    await app.db.insert(authorityLimits).values(row);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "authority_limit",
      objectId: id,
      payload: row,
      storePayload: true,
      projectId: row.projectId,
    });
    return reply.status(201).send(row);
  });

  app.get("/authority-limits", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const q = pageQuerySchema.extend({ userId: z.string().optional() }).parse(req.query);
    const where = and(
      eq(authorityLimits.companyId, req.companyId!),
      q.userId ? eq(authorityLimits.userId, q.userId) : undefined,
    );
    const items = await app.db
      .select()
      .from(authorityLimits)
      .where(where)
      .orderBy(desc(authorityLimits.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(authorityLimits).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.delete("/authority-limits/:limitId", { preHandler: adminGate }, async (req) => {
    const { limitId } = req.params as { limitId: string };
    const rows = await app.db
      .select()
      .from(authorityLimits)
      .where(
        and(eq(authorityLimits.id, limitId), eq(authorityLimits.companyId, req.companyId!)),
      )
      .limit(1);
    const existing = rows[0];
    if (!existing) throw notFound("Authority limit not found");
    await app.db.delete(authorityLimits).where(eq(authorityLimits.id, limitId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "authority_limit",
      objectId: limitId,
      payload: { before: existing },
      storePayload: true,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /* 7. Signals                                                        */
  /* ---------------------------------------------------------------- */

  app.get("/signals", { preHandler: companyGate }, async (req) => {
    const q = signalListSchema.parse(req.query);
    const visible = await requireAssuranceReach(req);
    const family = q.family
      ? new Set(DETECTOR_REGISTRY.filter((d) => d.family === q.family).map((d) => d.id))
      : null;
    const where = and(
      eq(signals.companyId, req.companyId!),
      projectFilter(visible, q.projectId),
      q.severity ? eq(signals.severity, q.severity) : undefined,
      q.disposition ? eq(signals.disposition, q.disposition) : undefined,
      q.detector ? eq(signals.detector, q.detector) : undefined,
      q.subjectId ? eq(signals.subjectId, q.subjectId) : undefined,
      family ? (family.size > 0 ? inArray(signals.detector, [...family]) : sql`false`) : undefined,
    );
    const items = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      scope: visible === "all" ? "company" : "scoped",
      visibleProjects: visible === "all" ? null : [...visible],
    };
  });

  app.get("/signals/stats", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const where = and(eq(signals.companyId, req.companyId!), projectFilter(visible));
    const rows = await app.db
      .select({ severity: signals.severity, disposition: signals.disposition, n: count() })
      .from(signals)
      .where(where)
      .groupBy(signals.severity, signals.disposition);
    const matrix = rows.map((r) => ({
      severity: r.severity,
      disposition: r.disposition,
      count: Number(r.n),
    }));
    const bySeverity: Record<string, number> = {};
    const byDisposition: Record<string, number> = {};
    let total = 0;
    for (const cell of matrix) {
      bySeverity[cell.severity] = (bySeverity[cell.severity] ?? 0) + cell.count;
      byDisposition[cell.disposition] = (byDisposition[cell.disposition] ?? 0) + cell.count;
      total += cell.count;
    }
    const precision = visible === "all" ? await precisionFor(req.companyId!, new Date()) : [];
    return {
      total,
      bySeverity,
      byDisposition,
      matrix,
      /** measured precision per detector — only for tenant-wide reach */
      precision,
      scope: visible === "all" ? "company" : "scoped",
    };
  });

  app.get("/signals/:signalId", { preHandler: companyGate }, async (req) => {
    const { signalId } = req.params as { signalId: string };
    const visible = await requireAssuranceReach(req);
    const rows = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.id, signalId), eq(signals.companyId, req.companyId!)))
      .limit(1);
    const signal = rows[0];
    if (!signal) throw notFound("Signal not found");
    if (visible !== "all") {
      if (!signal.projectId || !visible.has(signal.projectId)) {
        throw forbidden("No assurance visibility of this signal");
      }
    }
    const links = await app.db
      .select()
      .from(signalEvidence)
      .where(eq(signalEvidence.signalId, signalId))
      .limit(300);
    const descriptor = detectorById(signal.detector);
    return {
      ...signal,
      detectorDescriptor: descriptor ?? null,
      links,
      lifecycle: {
        current: signal.disposition,
        allowedNext: SIGNAL_LIFECYCLE[signal.disposition] ?? [],
      },
    };
  });

  app.get("/projects/:projectId/signals", { preHandler: readGate }, async (req) => {
    const q = signalListSchema.parse(req.query);
    const where = and(
      eq(signals.companyId, req.companyId!),
      eq(signals.projectId, req.projectId!),
      q.severity ? eq(signals.severity, q.severity) : undefined,
      q.disposition ? eq(signals.disposition, q.disposition) : undefined,
      q.detector ? eq(signals.detector, q.detector) : undefined,
    );
    const items = await app.db
      .select()
      .from(signals)
      .where(where)
      .orderBy(desc(signals.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(signals).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  // Segregation of duties: ONLY integrity reviewers disposition signals —
  // operational owners/admins must not clear signals about their own records.
  app.patch(
    "/signals/:signalId/disposition",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireAssuranceRole(["integrity_reviewer"]),
      ],
    },
    async (req) => {
      const { signalId } = req.params as { signalId: string };
      const body = signalDispositionSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(signals)
        .where(and(eq(signals.id, signalId), eq(signals.companyId, req.companyId!)))
        .limit(1);
      const signal = rows[0];
      if (!signal) throw notFound("Signal not found");

      // `requireAssuranceRole` admits any live grant of the role and ignores
      // the grant's own projectId. Project scope is therefore enforced here,
      // against the SIGNAL's project: a reviewer granted for project A was
      // otherwise able to dismiss project B's findings, and tenant-level
      // findings (projectId null) belong to tenant-wide reviewers alone.
      if (!(await holdsAssuranceRole(req, ["integrity_reviewer"], signal.projectId))) {
        throw forbidden(
          signal.projectId
            ? "Your integrity_reviewer grant does not cover this signal's project."
            : "This is a tenant-level finding; dispositioning it requires a tenant-wide " +
              "integrity_reviewer grant, not a project-scoped one.",
        );
      }

      const allowed = SIGNAL_LIFECYCLE[signal.disposition] ?? [];
      if (signal.disposition !== body.disposition && !allowed.includes(body.disposition)) {
        throw conflict(
          `A signal cannot move from ${signal.disposition} to ${body.disposition}. ` +
            `Allowed next states: ${allowed.join(", ") || "none"}.`,
        );
      }

      const nowIso = new Date().toISOString();
      const terminal = body.disposition === "closed" || body.disposition === "false_positive";
      const patch = {
        disposition: body.disposition,
        reviewerNotes: body.reviewerNotes ?? signal.reviewerNotes,
        reviewerId: req.user!.id,
        closedAt: terminal ? nowIso : null,
        autoClosedAt: null,
      };
      await app.db.update(signals).set(patch).where(eq(signals.id, signalId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "signal",
        objectId: signalId,
        payload: {
          before: { disposition: signal.disposition, reviewerId: signal.reviewerId },
          after: { disposition: body.disposition, reviewerNotes: body.reviewerNotes ?? null },
        },
        storePayload: true,
        projectId: signal.projectId,
      });
      return { ...signal, ...patch };
    },
  );

  /* ---------------------------------------------------------------- */
  /* 8. Detector programme                                             */
  /* ---------------------------------------------------------------- */

  /** Registry + policy + measured precision, in one place an operator can act on. */
  app.get("/detectors", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const policies = await loadPolicies(req.companyId!);
    const measured = await precisionFor(req.companyId!, new Date());
    const byDetector = new Map(measured.map((m) => [m.detector, m]));
    const counts = await app.db
      .select({ detector: signals.detector, n: count() })
      .from(signals)
      .where(eq(signals.companyId, req.companyId!))
      .groupBy(signals.detector);
    const openCounts = new Map(counts.map((c) => [c.detector, Number(c.n)]));
    return {
      items: DETECTOR_REGISTRY.map((d) => {
        const policy = policies.get(d.id);
        const floor = policy?.precisionFloor ?? d.defaultPrecisionFloor;
        const m = byDetector.get(d.id);
        const suppression = belowPrecisionFloor(m, floor);
        return {
          ...d,
          enabled: policy?.enabled ?? true,
          precisionFloor: floor,
          thresholds: { ...d.defaultThresholds, ...(policy?.thresholds ?? {}) },
          measuredPrecision: m?.precision ?? null,
          precisionBasis: m?.reason ?? "no reviewed signals from this detector yet",
          confirmed: m?.confirmed ?? 0,
          falsePositive: m?.falsePositive ?? 0,
          suppressed: suppression.suppressed,
          suppressionReason: suppression.reason,
          signalsRaised: openCounts.get(d.id) ?? 0,
          passive: PASSIVE_DETECTORS.has(d.id),
        };
      }),
      families: [...new Set(DETECTOR_REGISTRY.map((d) => d.family))],
    };
  });

  app.put("/detectors/:detector/policy", { preHandler: companyGate }, async (req) => {
    await requireEntityWriter(req);
    const { detector } = req.params as { detector: string };
    const descriptor = detectorById(detector);
    if (!descriptor) throw notFound(`Unknown detector "${detector}"`);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        precisionFloor: z.number().min(0).max(1).nullable().optional(),
        minReviewedForFloor: z.number().int().min(1).max(1000).optional(),
        thresholds: z.record(z.string(), z.number()).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body ?? {});
    const existing = await app.db
      .select()
      .from(detectorPolicies)
      .where(
        and(
          eq(detectorPolicies.companyId, req.companyId!),
          eq(detectorPolicies.detector, detector),
        ),
      )
      .limit(1);
    const values = {
      enabled: body.enabled === undefined ? (existing[0]?.enabled ?? 1) : body.enabled ? 1 : 0,
      precisionFloor:
        body.precisionFloor === undefined
          ? (existing[0]?.precisionFloor ?? descriptor.defaultPrecisionFloor)
          : body.precisionFloor,
      minReviewedForFloor: body.minReviewedForFloor ?? existing[0]?.minReviewedForFloor ?? 10,
      thresholds: body.thresholds ?? existing[0]?.thresholds ?? {},
      notes: body.notes ?? existing[0]?.notes ?? null,
      updatedBy: req.user!.id,
      updatedAt: new Date().toISOString(),
    };
    let id: string;
    if (existing[0]) {
      id = existing[0].id;
      await app.db.update(detectorPolicies).set(values).where(eq(detectorPolicies.id, id));
    } else {
      id = newId("dpol");
      await app.db
        .insert(detectorPolicies)
        .values({ id, companyId: req.companyId!, detector, ...values });
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: existing[0] ? "update" : "create",
      objectType: "detector_policy",
      objectId: id,
      payload: { detector, before: existing[0] ?? null, after: values },
      storePayload: true,
    });
    return { id, detector, ...values, enabled: values.enabled === 1 };
  });

  app.get("/detector-runs", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const q = pageQuerySchema.extend({ projectId: z.string().optional() }).parse(req.query);
    const scopeFilter =
      visible === "all"
        ? q.projectId
          ? eq(detectorRuns.projectId, q.projectId)
          : undefined
        : visible.size > 0
          ? inArray(detectorRuns.projectId, [...visible])
          : sql`false`;
    const where = and(eq(detectorRuns.companyId, req.companyId!), scopeFilter);
    const items = await app.db
      .select()
      .from(detectorRuns)
      .where(where)
      .orderBy(desc(detectorRuns.startedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(detectorRuns).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  interface RunContext {
    companyId: string;
    projectId: string | null;
    actorId: string | null;
    trigger: "manual" | "scheduled" | "retrodetect";
    requested?: string[];
  }

  interface RunResult {
    runId: string;
    created: number;
    refreshed: number;
    superseded: number;
    autoClosed: number;
    skipped: Array<{ detector: string; reason: string }>;
    perDetector: Record<string, number>;
    executed: string[];
    durationMs: number;
  }

  /**
   * Which detectors this run will actually execute, and why the others will
   * not. "Skipped, and here is the reason" is the only honest answer when a
   * detector is disabled, suppressed on measured precision, or has nothing to
   * read — reporting a clean run instead would be a lie of omission.
   */
  async function planRun(
    companyId: string,
    scope: "project" | "company",
    requested: string[] | undefined,
    now: Date,
  ): Promise<{
    active: Set<string>;
    skipped: Array<{ detector: string; reason: string }>;
    thresholds: Map<string, Record<string, number>>;
  }> {
    const available = detectorsForScope(scope);
    const availableIds = new Set(available.map((d) => d.id));
    const wanted = requested ? requested.filter((d) => availableIds.has(d)) : [...availableIds];
    const policies = await loadPolicies(companyId);
    const measured = await precisionFor(companyId, now);
    const byDetector = new Map(measured.map((m) => [m.detector, m]));
    const active = new Set<string>();
    const skipped: Array<{ detector: string; reason: string }> = [];
    const thresholds = new Map<string, Record<string, number>>();
    for (const id of wanted) {
      const descriptor = detectorById(id)!;
      const policy = policies.get(id);
      thresholds.set(id, { ...descriptor.defaultThresholds, ...(policy?.thresholds ?? {}) });
      if (policy && !policy.enabled) {
        skipped.push({ detector: id, reason: "disabled by company detector policy" });
        continue;
      }
      const floor = policy?.precisionFloor ?? descriptor.defaultPrecisionFloor;
      const suppression = belowPrecisionFloor(byDetector.get(id), floor);
      if (suppression.suppressed) {
        skipped.push({ detector: id, reason: suppression.reason ?? "below precision floor" });
        continue;
      }
      active.add(id);
    }
    return { active, skipped, thresholds };
  }

  /** Persist a run row, so precision and cadence are measurable facts. */
  async function recordRun(
    ctx: RunContext,
    scope: "project" | "company",
    executed: string[],
    skipped: Array<{ detector: string; reason: string }>,
    perDetector: Record<string, number>,
    outcome: { created: number; refreshed: number; superseded: number; autoClosed: number },
    startedAt: Date,
    runId: string,
  ): Promise<void> {
    await app.db.insert(detectorRuns).values({
      id: runId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      scope,
      actorId: ctx.actorId,
      trigger: ctx.trigger,
      detectors: executed,
      skipped,
      signalsCreated: outcome.created,
      signalsRefreshed: outcome.refreshed,
      signalsAutoClosed: outcome.autoClosed,
      signalsSuperseded: outcome.superseded,
      perDetector,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });
  }

  /* ----- project-scoped detectors ---------------------------------- */

  async function runProjectDetectors(ctx: RunContext & { projectId: string }): Promise<RunResult> {
    const startedAt = new Date();
    const runId = newId("drun");
    const { active, skipped, thresholds } = await planRun(
      ctx.companyId,
      "project",
      ctx.requested,
      startedAt,
    );
    const perDetector: Record<string, number> = {};
    const drafts: SignalDraft[] = [];
    const executed: string[] = [];

    const needsAssertions =
      active.has("benford_first_digit") ||
      active.has("duplicate_assertions") ||
      active.has("round_number_clustering") ||
      active.has("backdated_record");
    const assertionRows = needsAssertions
      ? await app.db
          .select()
          .from(assertions)
          .where(
            and(
              eq(assertions.companyId, ctx.companyId),
              eq(assertions.projectId, ctx.projectId),
            ),
          )
          .limit(20_000)
      : [];
    const numericCostQty = assertionRows
      .filter((a) => (a.kind === "cost" || a.kind === "quantity") && a.value !== null)
      .map((a) => a.value as number);

    if (active.has("benford_first_digit")) {
      const res = benfordFirstDigit(numericCostQty);
      if (res.skipped) {
        skipped.push({
          detector: "benford_first_digit",
          reason: `only ${res.n} numeric cost/quantity assertions — the test needs 30`,
        });
      } else {
        executed.push("benford_first_digit");
        perDetector["benford_first_digit"] = res.draft ? 1 : 0;
        if (res.draft) drafts.push(res.draft);
      }
    }
    if (active.has("duplicate_assertions")) {
      executed.push("duplicate_assertions");
      const found = duplicateAssertions(
        assertionRows.map((a) => ({
          id: a.id,
          kind: a.kind,
          value: a.value,
          unit: a.unit,
          claimantId: a.claimantId,
          assertedAt: a.assertedAt,
        })),
      );
      perDetector["duplicate_assertions"] = found.length;
      drafts.push(...found);
    }
    if (active.has("round_number_clustering")) {
      if (numericCostQty.length < 10) {
        skipped.push({
          detector: "round_number_clustering",
          reason: `only ${numericCostQty.length} usable values — the test needs 10`,
        });
      } else {
        executed.push("round_number_clustering");
        const draft = roundNumberClustering(numericCostQty);
        perDetector["round_number_clustering"] = draft ? 1 : 0;
        if (draft) drafts.push(draft);
      }
    }

    if (active.has("approval_velocity") || active.has("segregation_of_duties")) {
      const instances = await app.db
        .select()
        .from(workflowInstances)
        .where(
          and(
            eq(workflowInstances.companyId, ctx.companyId),
            eq(workflowInstances.projectId, ctx.projectId),
          ),
        )
        .limit(10_000);
      const instanceIds = instances.map((i) => i.id);
      const steps =
        instanceIds.length > 0
          ? await app.db
              .select()
              .from(workflowStepInstances)
              .where(inArray(workflowStepInstances.instanceId, instanceIds))
          : [];
      const stepRows = steps.map((s) => ({
        id: s.id,
        instanceId: s.instanceId,
        assigneeId: s.assigneeId,
        delegatedToId: s.delegatedToId,
        decision: s.decision,
        createdAt: s.createdAt,
        decidedAt: s.decidedAt,
      }));
      if (active.has("approval_velocity")) {
        executed.push("approval_velocity");
        const found = approvalVelocity(stepRows);
        perDetector["approval_velocity"] = found.length;
        drafts.push(...found);
      }
      if (active.has("segregation_of_duties")) {
        executed.push("segregation_of_duties");
        const found = segregationOfDuties(
          instances.map((i) => ({
            id: i.id,
            startedBy: i.startedBy,
            recordType: i.recordType,
            recordId: i.recordId,
          })),
          stepRows,
        );
        perDetector["segregation_of_duties"] = found.length;
        drafts.push(...found);
      }
    }

    if (active.has("contradicted_claimant")) {
      executed.push("contradicted_claimant");
      const recRows = await app.db
        .select({
          reconciliationId: reconciliations.id,
          result: reconciliations.result,
          claimantId: assertions.claimantId,
        })
        .from(reconciliations)
        .innerJoin(assertions, eq(assertions.id, reconciliations.assertionId))
        .where(
          and(
            eq(reconciliations.companyId, ctx.companyId),
            eq(reconciliations.projectId, ctx.projectId),
          ),
        )
        .limit(20_000);
      const found = contradictedClaimant(recRows);
      perDetector["contradicted_claimant"] = found.length;
      drafts.push(...found);
    }

    if (active.has("backdated_record")) {
      executed.push("backdated_record");
      const windowHours = thresholds.get("backdated_record")?.["windowHours"] ?? 72;
      const evidenceRows = await app.db
        .select({
          id: evidence.id,
          capturedAt: evidence.capturedAt,
          ingestedAt: evidence.ingestedAt,
          submittedBy: evidence.submittedBy,
          kind: evidence.kind,
        })
        .from(evidence)
        .where(
          and(eq(evidence.companyId, ctx.companyId), eq(evidence.projectId, ctx.projectId)),
        )
        .limit(20_000);
      const eventRows = await app.db
        .select({
          id: events.id,
          occurredAt: events.occurredAt,
          createdAt: events.createdAt,
          createdBy: events.createdBy,
          type: events.type,
        })
        .from(events)
        .where(and(eq(events.companyId, ctx.companyId), eq(events.projectId, ctx.projectId)))
        .limit(20_000);
      const found = backdatedRecords(
        [
          ...assertionRows.map((a) => ({
            objectType: "assertion",
            objectId: a.id,
            statedAt: a.assertedAt,
            createdAt: a.createdAt,
            actorId: a.createdBy ?? a.claimantId,
            label: `assertion ${a.id} (${a.kind})`,
          })),
          ...evidenceRows.map((e) => ({
            objectType: "evidence",
            objectId: e.id,
            statedAt: e.capturedAt,
            createdAt: e.ingestedAt,
            actorId: e.submittedBy,
            label: `evidence ${e.id} (${e.kind})`,
          })),
          ...eventRows.map((e) => ({
            objectType: "event",
            objectId: e.id,
            statedAt: e.occurredAt,
            createdAt: e.createdAt,
            actorId: e.createdBy,
            label: `event ${e.id} (${e.type})`,
          })),
        ],
        { windowHours },
      );
      perDetector["backdated_record"] = found.length;
      drafts.push(...found);
    }

    const raised = await raiseSignals(
      ctx.companyId,
      ctx.projectId,
      ctx.actorId,
      drafts,
      runId,
    );
    const stillTrue = new Set(drafts.map((d) => `${d.detector}|${d.fingerprint}`));
    const autoClosed = await autoCloseCleared(
      ctx.companyId,
      ctx.projectId,
      executed,
      stillTrue,
      runId,
    );
    await recordRun(
      ctx,
      "project",
      executed,
      skipped,
      perDetector,
      { ...raised, autoClosed },
      startedAt,
      runId,
    );
    return {
      runId,
      created: raised.created,
      refreshed: raised.refreshed,
      superseded: raised.superseded,
      autoClosed,
      skipped,
      perDetector,
      executed,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  /* ----- company-scoped detectors (payables, approvals, network) ---- */

  /**
   * Approvals, as the detectors want them.
   *
   * Approved invoices are the richest approval stream this platform has: they
   * carry the approver, the moment, the amount, the currency and the supplier
   * — everything the out-of-hours, affinity and authority-limit detectors need
   * — and unlike workflow steps they are attached to money.
   */
  async function loadApprovals(companyId: string): Promise<ApprovalLike[]> {
    const rows = await app.db
      .select({
        id: invoices.id,
        approvedBy: invoices.approvedBy,
        approvedAt: invoices.approvedAt,
        total: invoices.total,
        currency: invoices.currency,
        vendorId: invoices.vendorId,
      })
      .from(invoices)
      .where(eq(invoices.companyId, companyId))
      .limit(20_000);
    const out: ApprovalLike[] = [];
    for (const r of rows) {
      if (!r.approvedBy || !r.approvedAt) continue;
      out.push({
        id: r.id,
        approverId: r.approvedBy,
        decidedAt: r.approvedAt,
        objectType: "invoice",
        objectId: r.id,
        amount: r.total,
        currency: r.currency,
        vendorId: r.vendorId,
      });
    }
    return out;
  }

  async function runCompanyDetectors(ctx: RunContext): Promise<RunResult> {
    const startedAt = new Date();
    const runId = newId("drun");
    const { active, skipped, thresholds } = await planRun(
      ctx.companyId,
      "company",
      ctx.requested,
      startedAt,
    );
    const perDetector: Record<string, number> = {};
    const drafts: SignalDraft[] = [];
    const executed: string[] = [];

    const th = (detector: string, key: string, fallback: number): number =>
      thresholds.get(detector)?.[key] ?? fallback;

    const ghostVendorIds = [
      "sequential_invoice_numbers",
      "split_invoicing",
      "invoice_before_purchase_order",
      "dormant_vendor_reactivated",
      "duplicate_payment",
      "round_sum_invoicing",
      "vendor_concentration",
    ];
    const needsInvoices =
      ghostVendorIds.some((d) => active.has(d)) ||
      active.has("out_of_hours_approval") ||
      active.has("approver_vendor_affinity") ||
      active.has("authority_limit_breach") ||
      active.has("undeclared_conflict") ||
      active.has("shell_company_indicators");

    const vendorRows = needsInvoices || active.has("vendor_person_identity_collision")
      ? await app.db
          .select()
          .from(vendors)
          .where(eq(vendors.companyId, ctx.companyId))
          .limit(20_000)
      : [];
    const vendorNames = new Map(vendorRows.map((v) => [v.id, v.name]));

    const invoiceRows = needsInvoices
      ? await app.db
          .select({
            id: invoices.id,
            reference: invoices.reference,
            vendorId: invoices.vendorId,
            invoiceNumber: invoices.invoiceNumber,
            commitmentId: invoices.commitmentId,
            currency: invoices.currency,
            total: invoices.total,
            billingDate: invoices.billingDate,
            receivedDate: invoices.receivedDate,
            status: invoices.status,
            approvedBy: invoices.approvedBy,
            approvedAt: invoices.approvedAt,
            createdAt: invoices.createdAt,
          })
          .from(invoices)
          .where(eq(invoices.companyId, ctx.companyId))
          .limit(20_000)
      : [];

    if (active.has("vendor_person_identity_collision")) {
      executed.push("vendor_person_identity_collision");
      const userRows = await app.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .innerJoin(projectMemberships, eq(projectMemberships.userId, users.id))
        .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
        .where(eq(projects.companyId, ctx.companyId))
        .limit(5000);
      const contactRows = await app.db
        .select()
        .from(contacts)
        .where(eq(contacts.companyId, ctx.companyId))
        .limit(20_000);
      const workerRows = await app.db
        .select({ id: workers.id, fullName: workers.fullName })
        .from(workers)
        .where(eq(workers.companyId, ctx.companyId))
        .limit(20_000);
      const people = [
        ...new Map(
          userRows.map((u) => [
            u.id,
            { id: u.id, kind: "user" as const, name: u.name, address: null, email: u.email, phone: null },
          ]),
        ).values(),
        ...contactRows.map((c) => ({
          id: c.id,
          kind: "contact" as const,
          name: c.name,
          address: null,
          email: c.email,
          phone: c.phone,
        })),
        ...workerRows.map((w) => ({
          id: w.id,
          kind: "worker" as const,
          name: w.fullName,
          address: null,
          email: null,
          phone: null,
        })),
      ];
      const found = vendorPersonCollisions(
        vendorRows.map((v) => ({
          id: v.id,
          name: v.name,
          address: v.address,
          city: v.city,
          email: v.email,
          phone: v.phone,
          taxId: v.taxId,
          registrationNumber: v.registrationNumber,
          status: v.status,
          createdAt: v.createdAt,
        })),
        people,
      );
      perDetector["vendor_person_identity_collision"] = found.length;
      drafts.push(...found);
    }

    const gvThresholds: GhostVendorThresholds = {
      ...GHOST_VENDOR_DEFAULTS,
      sequentialRun: th("sequential_invoice_numbers", "sequentialRun", 4),
      splitBand: th("split_invoicing", "splitBand", 0.75),
      approvalThreshold: thresholds.get("split_invoicing")?.["approvalThreshold"] ?? null,
      dormantDays: th("dormant_vendor_reactivated", "dormantDays", 365),
      duplicateWindowDays: th("duplicate_payment", "windowDays", 7),
      roundShare: th("round_sum_invoicing", "roundShare", 0.6),
      workingHours: [
        th("out_of_hours_approval", "startHour", 7),
        th("out_of_hours_approval", "endHour", 19),
      ],
      tzOffsetMinutes: th("out_of_hours_approval", "tzOffsetMinutes", 0),
      outOfHoursCount: th("out_of_hours_approval", "minCount", 3),
      affinityShare: th("approver_vendor_affinity", "vendorShare", 0.9),
      concentrationShare: th("vendor_concentration", "concentrationShare", 0.5),
    };

    if (active.has("sequential_invoice_numbers")) {
      executed.push("sequential_invoice_numbers");
      const found = sequentialInvoiceNumbers(invoiceRows, vendorNames, gvThresholds);
      perDetector["sequential_invoice_numbers"] = found.length;
      drafts.push(...found);
    }
    if (active.has("split_invoicing")) {
      const { drafts: found, skippedReason } = splitInvoicing(invoiceRows, gvThresholds);
      if (skippedReason) skipped.push({ detector: "split_invoicing", reason: skippedReason });
      else {
        executed.push("split_invoicing");
        perDetector["split_invoicing"] = found.length;
        drafts.push(...found);
      }
    }
    if (active.has("invoice_before_purchase_order")) {
      executed.push("invoice_before_purchase_order");
      const commitmentRows = await app.db
        .select({
          id: commitments.id,
          reference: commitments.reference,
          vendorId: commitments.vendorId,
          contractDate: commitments.contractDate,
          executionDate: commitments.executionDate,
          currency: commitments.currency,
        })
        .from(commitments)
        .where(eq(commitments.companyId, ctx.companyId))
        .limit(20_000);
      const found = invoiceBeforePurchaseOrder(invoiceRows, commitmentRows);
      perDetector["invoice_before_purchase_order"] = found.length;
      drafts.push(...found);
    }
    if (active.has("dormant_vendor_reactivated")) {
      executed.push("dormant_vendor_reactivated");
      const found = dormantVendorActivity(invoiceRows, vendorNames, gvThresholds);
      perDetector["dormant_vendor_reactivated"] = found.length;
      drafts.push(...found);
    }
    if (active.has("duplicate_payment")) {
      executed.push("duplicate_payment");
      const found = duplicatePayments(invoiceRows, gvThresholds);
      perDetector["duplicate_payment"] = found.length;
      drafts.push(...found);
    }
    if (active.has("round_sum_invoicing")) {
      executed.push("round_sum_invoicing");
      const found = roundSumInvoicing(invoiceRows, vendorNames, gvThresholds);
      perDetector["round_sum_invoicing"] = found.length;
      drafts.push(...found);
    }
    if (active.has("vendor_concentration")) {
      executed.push("vendor_concentration");
      const found = vendorConcentration(invoiceRows, vendorNames, gvThresholds);
      perDetector["vendor_concentration"] = found.length;
      drafts.push(...found);
    }

    const approvals =
      active.has("out_of_hours_approval") ||
      active.has("approver_vendor_affinity") ||
      active.has("authority_limit_breach") ||
      active.has("undeclared_conflict")
        ? await loadApprovals(ctx.companyId)
        : [];

    if (active.has("out_of_hours_approval")) {
      executed.push("out_of_hours_approval");
      const found = outOfHoursApprovals(approvals, gvThresholds);
      perDetector["out_of_hours_approval"] = found.length;
      drafts.push(...found);
    }
    if (active.has("approver_vendor_affinity")) {
      executed.push("approver_vendor_affinity");
      const found = approverVendorAffinity(approvals, vendorNames, gvThresholds);
      perDetector["approver_vendor_affinity"] = found.length;
      drafts.push(...found);
    }
    if (active.has("authority_limit_breach")) {
      const limits = await app.db
        .select()
        .from(authorityLimits)
        .where(eq(authorityLimits.companyId, ctx.companyId))
        .limit(5000);
      if (limits.length === 0) {
        skipped.push({
          detector: "authority_limit_breach",
          reason:
            "no delegation-of-authority limits are recorded, so there is no limit to test an " +
            "approval against",
        });
      } else {
        executed.push("authority_limit_breach");
        const found = authorityLimitBreaches(
          approvals,
          limits.map((l) => ({
            userId: l.userId,
            objectType: l.objectType,
            maxAmount: l.maxAmount,
            currency: l.currency,
          })),
        );
        perDetector["authority_limit_breach"] = found.length;
        drafts.push(...found);
      }
    }

    if (active.has("undeclared_conflict")) {
      const userMap = await userEntityMap(ctx.companyId);
      if (userMap.size === 0) {
        skipped.push({
          detector: "undeclared_conflict",
          reason:
            "no person entity carries an `identifiers.user_id`, so there is no edge from a " +
            "platform user into the entity graph to walk. Mirror approvers into the entity " +
            "register to enable this detector.",
        });
      } else {
        executed.push("undeclared_conflict");
        const edges = await loadGraphEdges(ctx.companyId);
        const vendorMap = await vendorEntityMap(ctx.companyId);
        const entityRows = await app.db
          .select({ id: entities.id, name: entities.name })
          .from(entities)
          .where(eq(entities.companyId, ctx.companyId))
          .limit(20_000);
        const declarations = await app.db
          .select()
          .from(conflictDeclarations)
          .where(eq(conflictDeclarations.companyId, ctx.companyId));
        const found = undeclaredConflicts({
          edges,
          approvals: approvals
            .filter((a) => a.vendorId)
            .map((a) => ({
              id: a.id,
              approverId: a.approverId,
              vendorId: a.vendorId!,
              objectType: a.objectType,
              objectId: a.objectId,
              amount: a.amount,
              currency: a.currency,
              decidedAt: a.decidedAt,
            })),
          userEntityId: userMap,
          vendorEntityId: vendorMap,
          entityNames: new Map(entityRows.map((e) => [e.id, e.name])),
          declarations: declarations.map((d) => ({
            userId: d.userId,
            entityId: d.entityId,
            nature: d.nature,
            endedAt: d.endedAt,
          })),
          maxDepth: th("undeclared_conflict", "maxDepth", 3),
        });
        perDetector["undeclared_conflict"] = found.length;
        drafts.push(...found);
      }
    }

    if (active.has("shell_company_indicators")) {
      executed.push("shell_company_indicators");
      const entityRows = await app.db
        .select()
        .from(entities)
        .where(and(eq(entities.companyId, ctx.companyId), isNull(entities.deletedAt)))
        .limit(20_000);
      const commitmentRows = await app.db
        .select({
          id: commitments.id,
          vendorId: commitments.vendorId,
          contractDate: commitments.contractDate,
          executionDate: commitments.executionDate,
          revised: commitments.revisedCommitmentSum,
          currency: commitments.currency,
        })
        .from(commitments)
        .where(eq(commitments.companyId, ctx.companyId))
        .limit(20_000);
      const found = shellCompanyIndicators({
        entities: entityRows.map((e) => ({
          id: e.id,
          name: e.name,
          kind: e.kind,
          incorporatedOn: e.identifiers["incorporated_on"] ?? null,
        })),
        awards: commitmentRows.map((c) => ({
          entityId: null,
          vendorId: c.vendorId,
          objectId: c.id,
          awardedOn: c.executionDate ?? c.contractDate,
          amount: c.revised,
          currency: c.currency,
        })),
        entityByVendor: await vendorEntityMap(ctx.companyId),
        incorporationWindowDays: th("shell_company_indicators", "incorporationWindowDays", 180),
      });
      perDetector["shell_company_indicators"] = found.length;
      drafts.push(...found);
    }

    if (active.has("administrative_override")) {
      executed.push("administrative_override");
      const since = new Date(startedAt.getTime() - 90 * 86_400_000).toISOString();
      const entries = await app.db
        .select({
          seq: ledgerEntries.seq,
          actorId: ledgerEntries.actorId,
          action: ledgerEntries.action,
          objectType: ledgerEntries.objectType,
          objectId: ledgerEntries.objectId,
          at: ledgerEntries.at,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.companyId, ctx.companyId),
            inArray(ledgerEntries.action, ["update", "delete"]),
            inArray(ledgerEntries.objectType, HIGH_VALUE_OBJECTS),
            gte(ledgerEntries.at, since),
          ),
        )
        .orderBy(desc(ledgerEntries.seq))
        .limit(20_000);
      const grantRows = await app.db
        .select({ userId: assuranceGrants.userId })
        .from(assuranceGrants)
        .where(eq(assuranceGrants.companyId, ctx.companyId));
      const found = overrideActivity(
        entries.map((e) => ({ ...e, seq: Number(e.seq) })),
        {
          highValueTypes: HIGH_VALUE_OBJECTS,
          exemptActorIds: [...new Set(grantRows.map((g) => g.userId)), "system"],
          minCount: th("administrative_override", "minCount", 3),
        },
      );
      perDetector["administrative_override"] = found.length;
      drafts.push(...found);
    }

    const raised = await raiseSignals(ctx.companyId, null, ctx.actorId, drafts, runId);
    const stillTrue = new Set(drafts.map((d) => `${d.detector}|${d.fingerprint}`));
    const autoClosed = await autoCloseCleared(ctx.companyId, null, executed, stillTrue, runId);
    await recordRun(
      { ...ctx, projectId: null },
      "company",
      executed,
      skipped,
      perDetector,
      { ...raised, autoClosed },
      startedAt,
      runId,
    );
    return {
      runId,
      created: raised.created,
      refreshed: raised.refreshed,
      superseded: raised.superseded,
      autoClosed,
      skipped,
      perDetector,
      executed,
      durationMs: Date.now() - startedAt.getTime(),
    };
  }

  /** Runs are for assurance-role holders or operational owners/admins. */
  async function requireDetectorRunner(req: FastifyRequest, projectId: string | null) {
    const privileged =
      req.companyRole === "owner" ||
      req.companyRole === "admin" ||
      (await holdsAssuranceRole(req, ["integrity_reviewer", "auditor", "regulator"], projectId));
    if (!privileged) throw forbidden("Requires an assurance role or company owner/admin");
  }

  app.post("/projects/:projectId/detectors/run", { preHandler: readGate }, async (req) => {
    await requireDetectorRunner(req, req.projectId!);
    const body = detectorsRunSchema.parse(req.body ?? {});
    if (body.detectors) {
      const known = new Set(detectorsForScope("project").map((d) => d.id));
      const unknown = body.detectors.filter((d) => !known.has(d));
      if (unknown.length > 0) {
        throw badRequest(
          `Unknown or out-of-scope detectors for a project run: ${unknown.join(", ")}. ` +
            `Available: ${[...known].join(", ")}.`,
        );
      }
    }
    const result = await runProjectDetectors({
      companyId: req.companyId!,
      projectId: req.projectId!,
      actorId: req.user!.id,
      trigger: "manual",
      requested: body.detectors,
    });
    return result;
  });

  app.post("/detectors/run", { preHandler: companyGate }, async (req) => {
    await requireDetectorRunner(req, null);
    const body = detectorsRunSchema.parse(req.body ?? {});
    if (body.detectors) {
      const known = new Set(detectorsForScope("company").map((d) => d.id));
      const unknown = body.detectors.filter((d) => !known.has(d));
      if (unknown.length > 0) {
        throw badRequest(
          `Unknown or out-of-scope detectors for a company run: ${unknown.join(", ")}. ` +
            `Available: ${[...known].join(", ")}.`,
        );
      }
    }
    return runCompanyDetectors({
      companyId: req.companyId!,
      projectId: null,
      actorId: req.user!.id,
      trigger: "manual",
      requested: body.detectors,
    });
  });

  /* ---------------------------------------------------------------- */
  /* 9. Integrity exposure scores                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Recompute and snapshot exposure scores for every project, entity/vendor
   * and approver that has findings against it.
   *
   * Snapshots rather than a computed view: a trend line needs history, and a
   * score that silently changes when the weighting changes is not evidence of
   * anything. Each row records the components it was built from.
   */
  async function recomputeIntegrityScores(
    db: Db,
    companyId: string,
    now: Date,
  ): Promise<{ scored: number; bySubject: Record<string, number> }> {
    const rows = await db
      .select({
        id: signals.id,
        detector: signals.detector,
        severity: signals.severity,
        disposition: signals.disposition,
        createdAt: signals.createdAt,
        projectId: signals.projectId,
        subjectType: signals.subjectType,
        subjectId: signals.subjectId,
      })
      .from(signals)
      .where(eq(signals.companyId, companyId))
      .limit(50_000);
    const measured = detectorPrecision(
      rows.filter((r) => ["confirmed", "escalated", "false_positive"].includes(r.disposition)),
      { now, windowDays: 180, minReviewed: 10 },
    );
    const precisionByDetector = new Map(measured.map((m) => [m.detector, m.precision]));

    const buckets = new Map<string, { scope: string; subjectId: string; rows: ScorableSignal[] }>();
    const add = (scope: string, subjectId: string, row: ScorableSignal) => {
      const key = `${scope}|${subjectId}`;
      const bucket = buckets.get(key) ?? { scope, subjectId, rows: [] };
      bucket.rows.push(row);
      buckets.set(key, bucket);
    };
    for (const r of rows) {
      const scorable: ScorableSignal = {
        id: r.id,
        detector: r.detector,
        severity: r.severity,
        disposition: r.disposition,
        createdAt: r.createdAt,
      };
      if (r.projectId) add("project", r.projectId, scorable);
      if (r.subjectType === "user") add("approver", r.subjectId!, scorable);
      if ((r.subjectType === "vendor" || r.subjectType === "entity") && r.subjectId) {
        add("entity", r.subjectId, scorable);
      }
    }

    const projectNames = new Map(
      (
        await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.companyId, companyId))
      ).map((p) => [p.id, p.name]),
    );
    const vendorNames = new Map(
      (
        await db
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(eq(vendors.companyId, companyId))
      ).map((v) => [v.id, v.name]),
    );
    const entityNames = new Map(
      (
        await db
          .select({ id: entities.id, name: entities.name })
          .from(entities)
          .where(eq(entities.companyId, companyId))
      ).map((e) => [e.id, e.name]),
    );

    const bySubject: Record<string, number> = {};
    const computedAt = now.toISOString();
    for (const bucket of buckets.values()) {
      const result = integrityScore(bucket.rows, { now, precisionByDetector });
      const label =
        bucket.scope === "project"
          ? (projectNames.get(bucket.subjectId) ?? null)
          : bucket.scope === "entity"
            ? (vendorNames.get(bucket.subjectId) ?? entityNames.get(bucket.subjectId) ?? null)
            : null;
      await db.insert(integrityScores).values({
        id: newId("isc"),
        companyId,
        scope: bucket.scope,
        subjectId: bucket.subjectId,
        subjectLabel: label,
        score: result.score,
        band: result.band,
        openSignals: result.openSignals,
        confirmedSignals: result.confirmedSignals,
        components: result.components,
        computedAt,
      });
      bySubject[bucket.scope] = (bySubject[bucket.scope] ?? 0) + 1;
    }
    return { scored: buckets.size, bySubject };
  }

  app.post("/integrity/recompute", { preHandler: companyGate }, async (req) => {
    await requireDetectorRunner(req, null);
    const result = await recomputeIntegrityScores(app.db, req.companyId!, new Date());
    return result;
  });

  app.get("/integrity/scores", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const q = z
      .object({
        scope: z.enum(INTEGRITY_SCORE_SCOPES).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = await app.db
      .select()
      .from(integrityScores)
      .where(
        and(
          eq(integrityScores.companyId, req.companyId!),
          q.scope ? eq(integrityScores.scope, q.scope) : undefined,
        ),
      )
      .orderBy(desc(integrityScores.computedAt))
      .limit(5000);
    // Latest snapshot per subject.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const key = `${r.scope}|${r.subjectId}`;
      if (!latest.has(key)) latest.set(key, r);
    }
    let items = [...latest.values()];
    if (visible !== "all") {
      // A project-scoped reviewer sees their projects' scores, and the
      // entity/approver scores are tenant-level judgements they cannot see.
      items = items.filter((r) => r.scope === "project" && visible.has(r.subjectId));
    }
    items.sort((a, b) => b.score - a.score);
    return {
      items: items.slice(0, q.limit),
      total: items.length,
      computedAt: items[0]?.computedAt ?? null,
      scale:
        "0..100 EXPOSURE, higher is worse. Weighted by severity and reviewer disposition, " +
        "discounted by each detector's measured precision, decayed with a 90-day half-life.",
      bands: { clear: "<10", watch: "10–30", elevated: "30–60", severe: "≥60" },
    };
  });

  app.get("/integrity/trends", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const q = z
      .object({
        scope: z.enum(INTEGRITY_SCORE_SCOPES).default("project"),
        subjectId: z.string().optional(),
        days: z.coerce.number().int().min(7).max(730).default(90),
      })
      .parse(req.query);
    if (visible !== "all") {
      if (q.scope !== "project") throw forbidden("Entity and approver trends require tenant-wide reach");
      if (!q.subjectId || !visible.has(q.subjectId)) {
        throw forbidden("No assurance visibility of that subject");
      }
    }
    const since = new Date(Date.now() - q.days * 86_400_000).toISOString();
    const rows = await app.db
      .select({
        subjectId: integrityScores.subjectId,
        subjectLabel: integrityScores.subjectLabel,
        score: integrityScores.score,
        band: integrityScores.band,
        computedAt: integrityScores.computedAt,
      })
      .from(integrityScores)
      .where(
        and(
          eq(integrityScores.companyId, req.companyId!),
          eq(integrityScores.scope, q.scope),
          q.subjectId ? eq(integrityScores.subjectId, q.subjectId) : undefined,
          gte(integrityScores.computedAt, since),
        ),
      )
      .orderBy(asc(integrityScores.computedAt))
      .limit(5000);
    const series = new Map<string, Array<{ at: string; score: number; band: string }>>();
    for (const r of rows) {
      if (visible !== "all" && !visible.has(r.subjectId)) continue;
      const list = series.get(r.subjectId) ?? [];
      list.push({ at: r.computedAt, score: r.score, band: r.band });
      series.set(r.subjectId, list);
    }
    return {
      scope: q.scope,
      days: q.days,
      series: [...series.entries()].map(([subjectId, points]) => ({
        subjectId,
        subjectLabel: rows.find((r) => r.subjectId === subjectId)?.subjectLabel ?? null,
        points,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* 10. Integrity cases                                               */
  /* ---------------------------------------------------------------- */

  async function requireCaseWorker(req: FastifyRequest, projectId: string | null): Promise<void> {
    if (req.companyRole === "owner" || req.companyRole === "admin") return;
    if (await holdsAssuranceRole(req, ["integrity_reviewer", "auditor"], projectId)) return;
    throw forbidden(
      "Opening and working integrity cases requires an integrity_reviewer or auditor grant " +
        "covering the case's project, or company owner/admin.",
    );
  }

  app.post("/integrity-cases", { preHandler: companyGate }, async (req, reply) => {
    const body = z
      .object({
        title: z.string().min(1).max(300),
        summary: z.string().max(8000).optional(),
        projectId: z.string().max(64).nullable().optional(),
        severity: z.enum(SIGNAL_SEVERITIES).optional(),
        assignedTo: z.string().max(64).nullable().optional(),
        signalIds: z.array(z.string().max(64)).max(200).optional(),
      })
      .parse(req.body);
    if (body.projectId) {
      const p = await projectOf(req.companyId!, body.projectId);
      if (!p) throw notFound("Project not found in this company");
    }
    await requireCaseWorker(req, body.projectId ?? null);
    const n = await nextRecordNumber(app.db, body.projectId ?? req.companyId!, "integrity_case");
    const id = newId("icase");
    const row = {
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      reference: `CASE-${String(n).padStart(4, "0")}`,
      title: body.title,
      summary: body.summary ?? null,
      status: "open",
      severity: body.severity ?? "medium",
      assignedTo: body.assignedTo ?? null,
      openedBy: req.user!.id,
    };
    await app.db.insert(integrityCases).values(row);
    if (body.signalIds && body.signalIds.length > 0) {
      const owned = await app.db
        .select({ id: signals.id })
        .from(signals)
        .where(and(eq(signals.companyId, req.companyId!), inArray(signals.id, body.signalIds)));
      if (owned.length > 0) {
        await app.db.insert(integrityCaseItems).values(
          owned.map((s) => ({
            id: newId("icit"),
            companyId: req.companyId!,
            caseId: id,
            itemType: "signal",
            itemId: s.id,
            addedBy: req.user!.id,
          })),
        );
      }
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "integrity_case",
      objectId: id,
      payload: { ...row, signalIds: body.signalIds ?? [] },
      storePayload: true,
      projectId: row.projectId,
    });
    return reply.status(201).send(row);
  });

  app.get("/integrity-cases", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const q = pageQuerySchema
      .extend({ status: z.enum(INTEGRITY_CASE_STATUSES).optional() })
      .parse(req.query);
    const scopeFilter =
      visible === "all"
        ? undefined
        : visible.size > 0
          ? inArray(integrityCases.projectId, [...visible])
          : sql`false`;
    const where = and(
      eq(integrityCases.companyId, req.companyId!),
      q.status ? eq(integrityCases.status, q.status) : undefined,
      scopeFilter,
    );
    const items = await app.db
      .select()
      .from(integrityCases)
      .where(where)
      .orderBy(desc(integrityCases.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(integrityCases).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  async function loadCase(req: FastifyRequest, caseId: string) {
    const rows = await app.db
      .select()
      .from(integrityCases)
      .where(and(eq(integrityCases.id, caseId), eq(integrityCases.companyId, req.companyId!)))
      .limit(1);
    if (!rows[0]) throw notFound("Case not found");
    const visible = await visibleAssuranceProjectIds(req);
    if (visible !== "all") {
      const projectId = rows[0].projectId;
      if (!projectId || !visible.has(projectId)) {
        throw forbidden("No assurance visibility of this case");
      }
    }
    return rows[0];
  }

  app.get("/integrity-cases/:caseId", { preHandler: companyGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const record = await loadCase(req, caseId);
    const items = await app.db
      .select()
      .from(integrityCaseItems)
      .where(eq(integrityCaseItems.caseId, caseId))
      .orderBy(asc(integrityCaseItems.createdAt))
      .limit(1000);
    const signalIds = items.filter((i) => i.itemType === "signal" && i.itemId).map((i) => i.itemId!);
    const linkedSignals =
      signalIds.length > 0
        ? await app.db
            .select()
            .from(signals)
            .where(and(eq(signals.companyId, req.companyId!), inArray(signals.id, signalIds)))
        : [];
    const packs = await app.db
      .select()
      .from(evidencePacks)
      .where(and(eq(evidencePacks.companyId, req.companyId!), eq(evidencePacks.caseId, caseId)))
      .orderBy(desc(evidencePacks.generatedAt));
    return { ...record, items, signals: linkedSignals, packs };
  });

  app.patch("/integrity-cases/:caseId", { preHandler: companyGate }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const existing = await loadCase(req, caseId);
    await requireCaseWorker(req, existing.projectId);
    const body = z
      .object({
        title: z.string().min(1).max(300).optional(),
        summary: z.string().max(8000).nullable().optional(),
        status: z.enum(INTEGRITY_CASE_STATUSES).optional(),
        severity: z.enum(SIGNAL_SEVERITIES).optional(),
        assignedTo: z.string().max(64).nullable().optional(),
        referralTarget: z.string().max(300).nullable().optional(),
        closureReason: z.string().max(4000).nullable().optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch["title"] = body.title;
    if (body.summary !== undefined) patch["summary"] = body.summary;
    if (body.severity !== undefined) patch["severity"] = body.severity;
    if (body.assignedTo !== undefined) patch["assignedTo"] = body.assignedTo;
    if (body.referralTarget !== undefined) patch["referralTarget"] = body.referralTarget;
    if (body.status !== undefined) {
      patch["status"] = body.status;
      if (body.status === "referred") patch["referredAt"] = new Date().toISOString();
      if (body.status === "closed" || body.status === "substantiated" || body.status === "unsubstantiated") {
        if (!body.closureReason && !existing.closureReason) {
          throw badRequest("Closing a case requires a closureReason — the record must say why.");
        }
        patch["closedAt"] = new Date().toISOString();
      }
    }
    if (body.closureReason !== undefined) patch["closureReason"] = body.closureReason;
    if (Object.keys(patch).length === 0) return existing;
    await app.db.update(integrityCases).set(patch).where(eq(integrityCases.id, caseId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: body.status ? "state_change" : "update",
      objectType: "integrity_case",
      objectId: caseId,
      payload: { before: existing, after: { ...existing, ...patch } },
      storePayload: true,
      projectId: existing.projectId,
    });
    return { ...existing, ...patch };
  });

  app.post("/integrity-cases/:caseId/items", { preHandler: companyGate }, async (req, reply) => {
    const { caseId } = req.params as { caseId: string };
    const record = await loadCase(req, caseId);
    await requireCaseWorker(req, record.projectId);
    const body = z
      .object({
        itemType: z.enum(INTEGRITY_CASE_ITEM_TYPES),
        itemId: z.string().max(64).nullable().optional(),
        fromSeq: z.number().int().min(0).nullable().optional(),
        toSeq: z.number().int().min(0).nullable().optional(),
        note: z.string().max(4000).optional(),
      })
      .parse(req.body);
    if (body.itemType === "ledger_range" && (body.fromSeq === undefined || body.toSeq === undefined)) {
      throw badRequest("A ledger_range item needs fromSeq and toSeq");
    }
    if (body.itemType !== "ledger_range" && body.itemType !== "note" && !body.itemId) {
      throw badRequest(`A ${body.itemType} item needs an itemId`);
    }
    const id = newId("icit");
    const row = {
      id,
      companyId: req.companyId!,
      caseId,
      itemType: body.itemType,
      itemId: body.itemId ?? null,
      fromSeq: body.fromSeq ?? null,
      toSeq: body.toSeq ?? null,
      note: body.note ?? null,
      addedBy: req.user!.id,
    };
    await app.db.insert(integrityCaseItems).values(row);
    // A signal attached to a case is escalated by that act: the case IS the
    // escalation, and leaving the signal at "new" would understate it.
    if (body.itemType === "signal" && body.itemId) {
      const sig = await app.db
        .select({ id: signals.id, disposition: signals.disposition })
        .from(signals)
        .where(and(eq(signals.id, body.itemId), eq(signals.companyId, req.companyId!)))
        .limit(1);
      if (sig[0] && (sig[0].disposition === "new" || sig[0].disposition === "under_review")) {
        await app.db
          .update(signals)
          .set({ disposition: "escalated", reviewerId: req.user!.id })
          .where(eq(signals.id, body.itemId));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "signal",
          objectId: body.itemId,
          payload: { before: { disposition: sig[0].disposition }, after: { disposition: "escalated" }, caseId },
          storePayload: true,
          projectId: record.projectId,
        });
      }
    }
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "integrity_case",
      objectId: caseId,
      payload: { itemAdded: row },
      storePayload: true,
      projectId: record.projectId,
    });
    return reply.status(201).send(row);
  });

  /* ---------------------------------------------------------------- */
  /* 11. Evidence packs (Merkle-notarised, seal-bound bundles)          */
  /* ---------------------------------------------------------------- */

  /** The newest seal for a company — what the pack is anchored against. */
  async function newestSeal(companyId: string) {
    const rows = await app.db
      .select({
        id: chainSeals.id,
        sequence: chainSeals.sequence,
        headHash: chainSeals.headHash,
        sealedAt: chainSeals.sealedAt,
      })
      .from(chainSeals)
      .where(eq(chainSeals.companyId, companyId))
      .orderBy(desc(chainSeals.sequence))
      .limit(1);
    return rows[0] ?? null;
  }

  async function logPackAccess(
    companyId: string,
    packId: string,
    actorId: string | null,
    action: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await app.db.insert(evidencePackAccess).values({
      id: newId("epa"),
      companyId,
      packId,
      actorId,
      action,
      detail,
    });
  }

  /**
   * Assemble and PERSIST an evidence pack.
   *
   * Three things make this an evidentiary object rather than a download:
   *  • a Merkle root over the item content hashes, with a proof per item, so a
   *    holder can prove any single item belonged to the pack without the rest;
   *  • the ledger head and seal sequence in force at generation, so the pack
   *    is positioned in the chain rather than floating beside it;
   *  • a COMPLETENESS STATEMENT naming what was linked and left out, and why.
   *    A pack that silently omits the inconvenient half is worse than no pack,
   *    and the omission is the first thing an opponent will look for.
   */
  app.post("/projects/:projectId/evidence-packs", { preHandler: readGate }, async (req, reply) => {
    const body = evidencePackSchema.parse(req.body);
    const uniqueIds = [...new Set(body.evidenceIds)];
    const rows = await app.db
      .select()
      .from(evidence)
      .where(
        and(
          inArray(evidence.id, uniqueIds),
          eq(evidence.companyId, req.companyId!),
          eq(evidence.projectId, req.projectId!),
        ),
      );
    if (rows.length !== uniqueIds.length) {
      throw notFound("One or more evidence records not found in this project");
    }
    if (body.caseId) {
      await loadCase(req, body.caseId);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = uniqueIds.map((id) => byId.get(id)!);
    const leaves = ordered.map((r) => r.contentHash);
    const root = merkleRoot(leaves);
    const items = ordered.map((r, i) => ({
      objectType: "evidence",
      objectId: r.id,
      /** kept for the pack's original consumers */
      evidenceId: r.id,
      contentHash: r.contentHash,
      kind: r.kind,
      source: r.source,
      label: `${r.kind} — ${r.source}`,
      proof: merkleProof(leaves, i),
    }));

    // What was linked to this project's assurance record but is NOT in the
    // pack. Named explicitly, with the reason, rather than left to be noticed.
    const [allEvidenceRow] = await app.db
      .select({ n: count() })
      .from(evidence)
      .where(
        and(eq(evidence.companyId, req.companyId!), eq(evidence.projectId, req.projectId!)),
      );
    const totalEvidence = Number(allEvidenceRow?.n ?? 0);
    const exclusions = [
      ...(body.exclusions ?? []),
      ...(totalEvidence > ordered.length
        ? [
            {
              objectType: "evidence",
              objectId: "*",
              reason:
                `${totalEvidence - ordered.length} further evidence record(s) exist on this ` +
                "project and were not selected for this pack. Selection was made by the " +
                "requester, not by the platform.",
            },
          ]
        : []),
    ];

    const seal = await newestSeal(req.companyId!);
    const headRows = await app.db
      .select({ entryHash: ledgerEntries.entryHash })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, req.companyId!))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);

    const packId = newId("epk");
    const generatedAt = new Date().toISOString();
    const statement =
      `This pack contains ${ordered.length} evidence record(s) committed to Merkle root ${root}. ` +
      `Each item carries a proof that it belongs to that root; the root is written into the ` +
      `company's hash-chained ledger by this generation. ` +
      (seal
        ? `The chain was sealed at sequence ${seal.sequence} (${seal.sealedAt}), head ${seal.headHash.slice(0, 16)}….`
        : "The chain carries NO SEAL: nothing outside this database commits to its length or " +
          "content, so this pack proves membership, not that the chain around it is complete.") +
      (exclusions.length > 0
        ? ` ${exclusions.length} exclusion(s) are recorded on this pack and listed with it.`
        : " Nothing linked to this project was excluded.");

    await app.db.insert(evidencePacks).values({
      id: packId,
      companyId: req.companyId!,
      projectId: req.projectId!,
      title: body.title ?? `Evidence pack ${generatedAt.slice(0, 10)}`,
      purpose: body.purpose ?? "audit",
      root,
      itemCount: ordered.length,
      items: items.map((i) => ({
        objectType: i.objectType,
        objectId: i.objectId,
        contentHash: i.contentHash,
        label: i.label,
        proof: i.proof,
      })),
      exclusions,
      caseId: body.caseId ?? null,
      sealId: seal?.id ?? null,
      sealSequence: seal?.sequence ?? null,
      ledgerHeadHash: headRows[0]?.entryHash ?? null,
      statement,
      generatedBy: req.user!.id,
      generatedAt,
    });
    await logPackAccess(req.companyId!, packId, req.user!.id, "create", { root, items: ordered.length });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "evidence_pack",
      objectId: packId,
      payload: {
        root,
        evidenceIds: uniqueIds,
        generatedAt,
        sealSequence: seal?.sequence ?? null,
        exclusions,
      },
      storePayload: true,
      projectId: req.projectId!,
    });
    return reply.status(201).send({
      id: packId,
      root,
      generatedAt,
      items,
      exclusions,
      statement,
      seal: seal ? { id: seal.id, sequence: seal.sequence, sealedAt: seal.sealedAt } : null,
      ledgerHeadHash: headRows[0]?.entryHash ?? null,
    });
  });

  app.get("/projects/:projectId/evidence-packs", { preHandler: readGate }, async (req) => {
    const q = pageQuerySchema.parse(req.query);
    const where = and(
      eq(evidencePacks.companyId, req.companyId!),
      eq(evidencePacks.projectId, req.projectId!),
    );
    const items = await app.db
      .select({
        id: evidencePacks.id,
        title: evidencePacks.title,
        purpose: evidencePacks.purpose,
        root: evidencePacks.root,
        itemCount: evidencePacks.itemCount,
        caseId: evidencePacks.caseId,
        sealSequence: evidencePacks.sealSequence,
        generatedBy: evidencePacks.generatedBy,
        generatedAt: evidencePacks.generatedAt,
      })
      .from(evidencePacks)
      .where(where)
      .orderBy(desc(evidencePacks.generatedAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(evidencePacks).where(where);
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  async function loadPack(req: FastifyRequest, packId: string) {
    const rows = await app.db
      .select()
      .from(evidencePacks)
      .where(and(eq(evidencePacks.id, packId), eq(evidencePacks.companyId, req.companyId!)))
      .limit(1);
    const pack = rows[0];
    if (!pack) throw notFound("Evidence pack not found");
    const visible = await visibleAssuranceProjectIds(req);
    if (visible !== "all" && (!pack.projectId || !visible.has(pack.projectId))) {
      throw forbidden("No assurance visibility of this evidence pack");
    }
    return pack;
  }

  app.get("/evidence-packs/:packId", { preHandler: companyGate }, async (req) => {
    const { packId } = req.params as { packId: string };
    const pack = await loadPack(req, packId);
    await logPackAccess(req.companyId!, packId, req.user!.id, "view");
    // Re-verify the root against the items as stored: a pack whose root no
    // longer matches its own items has been tampered with in place.
    const recomputed = merkleRoot(pack.items.map((i) => i.contentHash));
    return {
      ...pack,
      rootIntact: recomputed === pack.root,
      recomputedRoot: recomputed,
    };
  });

  app.get("/evidence-packs/:packId/download", { preHandler: companyGate }, async (req, reply) => {
    const { packId } = req.params as { packId: string };
    const pack = await loadPack(req, packId);
    await logPackAccess(req.companyId!, packId, req.user!.id, "download");
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "access",
      objectType: "evidence_pack",
      objectId: packId,
      payload: { download: true, root: pack.root },
      storePayload: true,
      projectId: pack.projectId,
    });
    const document = {
      documentType: "constructos.evidence-pack",
      version: 1,
      packId: pack.id,
      title: pack.title,
      purpose: pack.purpose,
      companyId: pack.companyId,
      projectId: pack.projectId,
      root: pack.root,
      itemCount: pack.itemCount,
      items: pack.items,
      exclusions: pack.exclusions,
      completenessStatement: pack.statement,
      ledgerHeadHash: pack.ledgerHeadHash,
      sealSequence: pack.sealSequence,
      generatedAt: pack.generatedAt,
      generatedBy: pack.generatedBy,
      verification:
        "Recompute sha256 over each item's bytes, then fold each proof: hash the item hash with " +
        "each proof node in the stated position; the result must equal `root`.",
    };
    return reply
      .header("content-type", "application/json")
      .header("content-disposition", `attachment; filename="constructos-evidence-pack-${packId}.json"`)
      .send(JSON.stringify(document, null, 2));
  });

  app.get("/evidence-packs/:packId/access", { preHandler: companyGate }, async (req) => {
    const { packId } = req.params as { packId: string };
    await loadPack(req, packId);
    const items = await app.db
      .select()
      .from(evidencePackAccess)
      .where(eq(evidencePackAccess.packId, packId))
      .orderBy(desc(evidencePackAccess.at))
      .limit(500);
    return { items, total: items.length };
  });

  /**
   * A referral pack: every signal, reconciliation and evidence row attached to
   * a case, Merkle-committed as one bundle and bound to the chain head.
   */
  app.post("/integrity-cases/:caseId/referral-pack", { preHandler: companyGate }, async (req, reply) => {
    const { caseId } = req.params as { caseId: string };
    const record = await loadCase(req, caseId);
    await requireCaseWorker(req, record.projectId);
    const body = z.object({ referralTarget: z.string().max(300).optional() }).parse(req.body ?? {});

    const caseItems = await app.db
      .select()
      .from(integrityCaseItems)
      .where(eq(integrityCaseItems.caseId, caseId))
      .limit(1000);
    const signalIds = caseItems.filter((i) => i.itemType === "signal" && i.itemId).map((i) => i.itemId!);
    const signalRows =
      signalIds.length > 0
        ? await app.db
            .select()
            .from(signals)
            .where(and(eq(signals.companyId, req.companyId!), inArray(signals.id, signalIds)))
        : [];
    const linkRows =
      signalIds.length > 0
        ? await app.db
            .select()
            .from(signalEvidence)
            .where(inArray(signalEvidence.signalId, signalIds))
            .limit(2000)
        : [];
    const evidenceIds = [
      ...new Set([
        ...linkRows.filter((l) => l.objectType === "evidence").map((l) => l.objectId),
        ...caseItems.filter((i) => i.itemType === "evidence" && i.itemId).map((i) => i.itemId!),
      ]),
    ];
    const evidenceRows =
      evidenceIds.length > 0
        ? await app.db
            .select()
            .from(evidence)
            .where(and(eq(evidence.companyId, req.companyId!), inArray(evidence.id, evidenceIds)))
        : [];

    // Everything goes in as a leaf: signals and reconciliations by the hash of
    // their canonical content, evidence by its recorded content hash.
    const leafRows: Array<{ objectType: string; objectId: string; contentHash: string; label: string }> = [
      ...signalRows.map((s) => ({
        objectType: "signal",
        objectId: s.id,
        contentHash: hashPayload({
          id: s.id,
          detector: s.detector,
          severity: s.severity,
          title: s.title,
          explanation: s.explanation,
          evidenceRefs: s.evidenceRefs,
          disposition: s.disposition,
          createdAt: s.createdAt,
        }),
        label: `${s.severity} ${s.detector}: ${s.title}`,
      })),
      ...evidenceRows.map((e) => ({
        objectType: "evidence",
        objectId: e.id,
        contentHash: e.contentHash,
        label: `${e.kind} — ${e.source}`,
      })),
    ];
    if (leafRows.length === 0) {
      throw badRequest(
        "This case has no signals or evidence attached. A referral pack with nothing in it " +
          "would misrepresent the case as investigated.",
      );
    }
    const leaves = leafRows.map((l) => l.contentHash);
    const root = merkleRoot(leaves);
    const items = leafRows.map((l, i) => ({ ...l, proof: merkleProof(leaves, i) }));

    const missingEvidence = evidenceIds.filter((id) => !evidenceRows.some((e) => e.id === id));
    const exclusions = [
      ...missingEvidence.map((id) => ({
        objectType: "evidence",
        objectId: id,
        reason: "linked to a signal on this case but no longer present in the evidence register",
      })),
      ...caseItems
        .filter((i) => i.itemType === "ledger_range")
        .map((i) => ({
          objectType: "ledger_range",
          objectId: `${i.fromSeq}-${i.toSeq}`,
          reason:
            "included by reference only: ledger entries are proved by the chain and the seal, " +
            "not by inclusion in this Merkle tree",
        })),
    ];

    const seal = await newestSeal(req.companyId!);
    const headRows = await app.db
      .select({ entryHash: ledgerEntries.entryHash })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, req.companyId!))
      .orderBy(desc(ledgerEntries.seq))
      .limit(1);
    const packId = newId("epk");
    const generatedAt = new Date().toISOString();
    const statement =
      `Referral pack for case ${record.reference} (${record.title}). ` +
      `${signalRows.length} signal(s) and ${evidenceRows.length} evidence record(s), committed ` +
      `to Merkle root ${root}. ` +
      (seal
        ? `Chain sealed at sequence ${seal.sequence} on ${seal.sealedAt}.`
        : "The chain carries NO SEAL — membership is provable, chain completeness is not.") +
      (exclusions.length > 0 ? ` ${exclusions.length} exclusion(s) are listed.` : "");

    await app.db.insert(evidencePacks).values({
      id: packId,
      companyId: req.companyId!,
      projectId: record.projectId,
      title: `Referral pack — ${record.reference}`,
      purpose: "referral",
      root,
      itemCount: items.length,
      items,
      exclusions,
      caseId,
      sealId: seal?.id ?? null,
      sealSequence: seal?.sequence ?? null,
      ledgerHeadHash: headRows[0]?.entryHash ?? null,
      statement,
      generatedBy: req.user!.id,
      generatedAt,
    });
    if (body.referralTarget) {
      await app.db
        .update(integrityCases)
        .set({
          status: "referred",
          referralTarget: body.referralTarget,
          referredAt: generatedAt,
        })
        .where(eq(integrityCases.id, caseId));
    }
    await logPackAccess(req.companyId!, packId, req.user!.id, "create", { referral: true });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "evidence_pack",
      objectId: packId,
      payload: {
        referral: true,
        caseId,
        root,
        signalIds,
        evidenceIds,
        referralTarget: body.referralTarget ?? null,
        sealSequence: seal?.sequence ?? null,
      },
      storePayload: true,
      projectId: record.projectId,
    });
    return reply.status(201).send({
      id: packId,
      caseId,
      root,
      items,
      exclusions,
      statement,
      generatedAt,
      seal: seal ? { id: seal.id, sequence: seal.sequence, sealedAt: seal.sealedAt } : null,
    });
  });

  /* ---------------------------------------------------------------- */
  /* 12. Ledger                                                        */
  /* ---------------------------------------------------------------- */

  async function readWatermark(companyId: string) {
    const rows = await app.db
      .select()
      .from(chainWatermarks)
      .where(eq(chainWatermarks.companyId, companyId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function writeWatermark(
    companyId: string,
    values: {
      lastVerifiedSeq: number;
      lastVerifiedHash: string | null;
      verifiedCount: number;
      lastVerdict: string;
      brokenAtSeq: number | null;
      brokenReason: string | null;
    },
  ): Promise<void> {
    const existing = await readWatermark(companyId);
    const patch = { ...values, verifiedAt: new Date().toISOString() };
    if (existing) {
      await app.db
        .update(chainWatermarks)
        .set(patch)
        .where(eq(chainWatermarks.id, existing.id));
    } else {
      await app.db
        .insert(chainWatermarks)
        .values({ id: newId("cwm"), companyId, deepVerifiedSeq: 0, ...patch })
        .onConflictDoNothing();
    }
  }

  /**
   * Verify the company's chain.
   *
   * Three things changed here, each closing a real hole:
   *  • The walk selects only the hash columns and streams in batches, so
   *    memory is constant rather than proportional to the tenant's history
   *    (payload snapshots dominate row size and are irrelevant to link and
   *    content checks).
   *  • It no longer appends an `access` entry per call. A verification that
   *    grows the thing it verifies makes the chain a function of how closely
   *    it is watched; the outcome is recorded on the watermark instead.
   *  • It is gated on assurance reach, because a full-chain verification is
   *    both privileged and expensive.
   *
   * `?incremental=true` verifies only from the last watermark, which is what
   * the scheduler uses. The DEFAULT is a full walk, deliberately: an
   * incremental pass cannot see an edit inside an already-verified range, and
   * the person clicking "verify" is asking exactly that question.
   */
  app.get("/ledger/verify", { preHandler: companyGate }, async (req) => {
    await requireAssuranceReach(req);
    const q = z
      .object({ incremental: z.coerce.boolean().optional() })
      .parse(req.query);
    const watermark = await readWatermark(req.companyId!);
    const from =
      q.incremental && watermark && watermark.lastVerdict === "ok"
        ? { seq: watermark.lastVerifiedSeq, hash: watermark.lastVerifiedHash }
        : { seq: 0, hash: null };
    const result = await verifyLedgerIncremental(app.db, req.companyId!, from);
    const totalCount = q.incremental
      ? (watermark?.verifiedCount ?? 0) + result.count
      : result.count;

    if (result.valid && result.verifiedToSeq !== null) {
      const headRows = await app.db
        .select({ entryHash: ledgerEntries.entryHash })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.companyId, req.companyId!),
            eq(ledgerEntries.seq, result.verifiedToSeq),
          ),
        )
        .limit(1);
      await writeWatermark(req.companyId!, {
        lastVerifiedSeq: result.verifiedToSeq,
        lastVerifiedHash: headRows[0]?.entryHash ?? null,
        verifiedCount: totalCount,
        lastVerdict: "ok",
        brokenAtSeq: null,
        brokenReason: null,
      });
    } else if (!result.valid) {
      await writeWatermark(req.companyId!, {
        lastVerifiedSeq: watermark?.lastVerifiedSeq ?? 0,
        lastVerifiedHash: watermark?.lastVerifiedHash ?? null,
        verifiedCount: watermark?.verifiedCount ?? 0,
        lastVerdict: "broken",
        brokenAtSeq: result.brokenSeq,
        brokenReason: result.reason,
      });
    }

    return {
      valid: result.valid,
      count: totalCount,
      /** index within the slice that was walked (legacy field) */
      brokenAt: result.brokenAt,
      /** the REAL ledger sequence of the break — `seq` is global, not per-company */
      brokenSeq: result.brokenSeq,
      reason: result.reason,
      mode: q.incremental ? "incremental" : "full",
      verifiedFromSeq: result.verifiedFromSeq,
      verifiedToSeq: result.verifiedToSeq,
      deepVerifiedSeq: watermark?.deepVerifiedSeq ?? 0,
      note:
        "This walk checks every link and every entry hash. It does NOT re-hash stored payload " +
        "snapshots — that is the `anchoring.deep-verify` scheduled job, whose progress is " +
        "`deepVerifiedSeq`.",
    };
  });

  /**
   * The ledger, scoped.
   *
   * Company-wide ledger reads used to be open to every member, `payload`
   * column included — and 300-plus call sites store full snapshots of
   * commercial, payroll and investigative state. On a deployment with
   * subcontractor or guest memberships that is a cross-project data leak
   * wearing an activity-feed costume.
   *
   * So: assurance reach (owner/admin or a grant) gets the company chain with
   * snapshots. Everyone else gets their OWN activity — the entries they
   * caused — without payloads. Both are useful; only one is privileged, and
   * the response says which you got.
   */
  app.get("/ledger", { preHandler: companyGate }, async (req) => {
    const q = ledgerListSchema.parse(req.query);
    const reach = await assuranceReachOf(req);
    const privileged = reach.tenantWide;
    const where = and(
      eq(ledgerEntries.companyId, req.companyId!),
      privileged ? undefined : eq(ledgerEntries.actorId, req.user!.id),
      q.objectType ? eq(ledgerEntries.objectType, q.objectType) : undefined,
      q.objectId ? eq(ledgerEntries.objectId, q.objectId) : undefined,
    );
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(where)
      .orderBy(desc(ledgerEntries.seq))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [totalRow] = await app.db.select({ n: count() }).from(ledgerEntries).where(where);
    const items = privileged ? rows : rows.map(({ payload: _payload, ...rest }) => rest);
    return {
      ...paginate(items, Number(totalRow?.n ?? 0), q),
      scope: privileged ? "company" : "own_activity",
      payloadsIncluded: privileged,
      note: privileged
        ? null
        : "You are seeing the entries you caused, without stored snapshots. Reading the whole " +
          "company chain requires an assurance grant or company owner/admin.",
    };
  });

  app.get("/projects/:projectId/ledger/recent", { preHandler: readGate }, async (req) => {
    // ledger_entries has no projectId column: collect the ids of this
    // project's assurance objects and filter the chain by objectId.
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const idSets = await Promise.all([
      app.db
        .select({ id: assertions.id })
        .from(assertions)
        .where(and(eq(assertions.companyId, companyId), eq(assertions.projectId, projectId)))
        .limit(5000),
      app.db
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, companyId), eq(evidence.projectId, projectId)))
        .limit(5000),
      app.db
        .select({ id: reconciliations.id })
        .from(reconciliations)
        .where(
          and(eq(reconciliations.companyId, companyId), eq(reconciliations.projectId, projectId)),
        )
        .limit(5000),
      app.db
        .select({ id: obligations.id })
        .from(obligations)
        .where(and(eq(obligations.companyId, companyId), eq(obligations.projectId, projectId)))
        .limit(5000),
      app.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.companyId, companyId), eq(events.projectId, projectId)))
        .limit(5000),
      app.db
        .select({ id: signals.id })
        .from(signals)
        .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId)))
        .limit(5000),
    ]);
    const objectIds = idSets.flat().map((r) => r.id);
    if (objectIds.length === 0) return { items: [] };
    const items = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, req.companyId!), inArray(ledgerEntries.objectId, objectIds)),
      )
      .orderBy(desc(ledgerEntries.seq))
      .limit(100);
    return { items };
  });

  /* ---------------------------------------------------------------- */
  /* 13. Summary + health inputs                                       */
  /* ---------------------------------------------------------------- */

  interface Unknowable {
    value: null;
    reasons: string[];
  }

  function unknowable(...reasons: string[]): Unknowable {
    return { value: null, reasons };
  }

  /**
   * The owner-side tiles: what an assurance-minded director looks for first.
   * Every figure is either a number with its basis, or an explicit
   * "not available" with the reason. Nothing is defaulted to zero.
   */
  async function assuranceSummary(companyId: string, projectId: string) {
    const now = Date.now();
    const [signalRows, obligationRows, latestRecon, seal, watermark, scoreRows] = await Promise.all([
      app.db
        .select({ severity: signals.severity, disposition: signals.disposition, n: count() })
        .from(signals)
        .where(and(eq(signals.companyId, companyId), eq(signals.projectId, projectId)))
        .groupBy(signals.severity, signals.disposition),
      app.db
        .select()
        .from(obligations)
        .where(and(eq(obligations.companyId, companyId), eq(obligations.projectId, projectId)))
        .limit(2000),
      app.db
        .select()
        .from(reconciliations)
        .where(
          and(eq(reconciliations.companyId, companyId), eq(reconciliations.projectId, projectId)),
        )
        .orderBy(desc(reconciliations.createdAt))
        .limit(50),
      newestSeal(companyId),
      readWatermark(companyId),
      app.db
        .select()
        .from(integrityScores)
        .where(
          and(
            eq(integrityScores.companyId, companyId),
            eq(integrityScores.scope, "project"),
            eq(integrityScores.subjectId, projectId),
          ),
        )
        .orderBy(desc(integrityScores.computedAt))
        .limit(1),
    ]);

    const openSignals = signalRows
      .filter((r) => r.disposition !== "closed" && r.disposition !== "false_positive")
      .reduce((a, r) => a + Number(r.n), 0);
    const criticalOpen = signalRows
      .filter(
        (r) =>
          (r.severity === "critical" || r.severity === "high") &&
          r.disposition !== "closed" &&
          r.disposition !== "false_positive",
      )
      .reduce((a, r) => a + Number(r.n), 0);

    const openObligations = obligationRows.filter((o) => o.status === "open");
    const breached = obligationRows.filter((o) => o.status === "breached");
    const nextDeadline = openObligations
      .filter((o) => o.deadline && Date.parse(o.deadline) >= now)
      .sort((a, b) => Date.parse(a.deadline!) - Date.parse(b.deadline!))[0];

    const withVariance = latestRecon.filter((r) => r.variancePercent !== null);
    const claimedVsVerified =
      withVariance.length > 0
        ? {
            value: withVariance[0]!.variancePercent,
            basis:
              `Latest reconciliation ${withVariance[0]!.id} (${withVariance[0]!.method}), ` +
              `result ${withVariance[0]!.result}, confidence ` +
              `${(withVariance[0]!.confidence ?? 0).toFixed(2)}.`,
            reconciliationId: withVariance[0]!.id,
          }
        : unknowable(
            latestRecon.length === 0
              ? "no reconciliation has been recorded on this project"
              : "no reconciliation on this project produced a numeric variance (all were manual " +
                "or had insufficient evidence)",
          );

    const sealAgeHours = seal ? (now - Date.parse(seal.sealedAt)) / 3_600_000 : null;
    const evidenceSufficiency =
      latestRecon.length > 0
        ? {
            value:
              latestRecon.reduce((a, r) => a + (r.confidence ?? 0), 0) / latestRecon.length,
            basis: `Mean evidence independence across the last ${latestRecon.length} reconciliation(s).`,
          }
        : unknowable("no reconciliations to measure evidence sufficiency from");

    return {
      projectId,
      openSignals,
      criticalOpen,
      signalMatrix: signalRows.map((r) => ({
        severity: r.severity,
        disposition: r.disposition,
        count: Number(r.n),
      })),
      obligations: {
        open: openObligations.length,
        breached: breached.length,
        nextDeadline: nextDeadline
          ? {
              obligationId: nextDeadline.id,
              deadline: nextDeadline.deadline,
              daysAway: Math.ceil((Date.parse(nextDeadline.deadline!) - now) / 86_400_000),
              sourceClause: nextDeadline.sourceClause,
            }
          : null,
      },
      claimedVsVerified,
      evidenceSufficiency,
      seal: seal
        ? {
            sequence: seal.sequence,
            sealedAt: seal.sealedAt,
            ageHours: sealAgeHours,
            stale: sealAgeHours !== null && sealAgeHours > 48,
          }
        : unknowable(
            "this tenant's chain has never been sealed, so nothing outside the database " +
              "commits to its length or content",
          ),
      chain: watermark
        ? {
            verdict: watermark.lastVerdict,
            lastVerifiedSeq: watermark.lastVerifiedSeq,
            verifiedAt: watermark.verifiedAt,
            brokenAtSeq: watermark.brokenAtSeq,
          }
        : unknowable("the chain has not been verified since this watermark was introduced"),
      integrityScore: scoreRows[0]
        ? {
            value: scoreRows[0].score,
            band: scoreRows[0].band,
            computedAt: scoreRows[0].computedAt,
            basis: `${scoreRows[0].openSignals} open, ${scoreRows[0].confirmedSignals} confirmed.`,
          }
        : unknowable("integrity scores have not been computed for this project yet"),
    };
  }

  app.get("/projects/:projectId/assurance/summary", { preHandler: readGate }, async (req) => {
    return assuranceSummary(req.companyId!, req.projectId!);
  });

  /**
   * Health inputs for the intelligence layer (cross-package contract 3.5).
   * `null` where the input genuinely cannot be computed — never 0.
   */
  app.get("/projects/:projectId/assurance/health-inputs", { preHandler: readGate }, async (req) => {
    const summary = await assuranceSummary(req.companyId!, req.projectId!);
    const reasons: string[] = [];
    const score = "value" in summary.integrityScore ? summary.integrityScore.value : null;
    if (score === null) reasons.push(...(summary.integrityScore as Unknowable).reasons);
    const variance =
      "value" in summary.claimedVsVerified ? summary.claimedVsVerified.value : null;
    if (variance === null) reasons.push(...(summary.claimedVsVerified as Unknowable).reasons);
    const sufficiency =
      "value" in summary.evidenceSufficiency ? summary.evidenceSufficiency.value : null;
    if (sufficiency === null) reasons.push(...(summary.evidenceSufficiency as Unknowable).reasons);
    const sealAge = "ageHours" in summary.seal ? summary.seal.ageHours : null;
    if (sealAge === null) reasons.push(...(summary.seal as Unknowable).reasons);
    return {
      metrics: {
        openSignals: summary.openSignals,
        criticalOpenSignals: summary.criticalOpen,
        breachedObligations: summary.obligations.breached,
        openObligations: summary.obligations.open,
        daysToNextObligation: summary.obligations.nextDeadline?.daysAway ?? null,
        integrityExposure: score,
        claimedVsVerifiedVariancePercent: variance,
        evidenceSufficiency: sufficiency,
        sealAgeHours: sealAge,
      },
      reasons,
    };
  });

  /** Company roll-up: one row per project the caller may actually see. */
  app.get("/assurance/summary", { preHandler: companyGate }, async (req) => {
    const visible = await requireAssuranceReach(req);
    const projectRows = await app.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, req.companyId!))
      .limit(500);
    const scoped = projectRows.filter((p) => visible === "all" || visible.has(p.id));
    const items = [];
    for (const p of scoped.slice(0, 100)) {
      const s = await assuranceSummary(req.companyId!, p.id);
      items.push({ ...s, projectId: p.id, projectName: p.name });
    }
    const seal = await newestSeal(req.companyId!);
    const watermark = await readWatermark(req.companyId!);
    return {
      generatedAt: new Date().toISOString(),
      projects: items,
      totals: {
        projects: items.length,
        openSignals: items.reduce((a, i) => a + i.openSignals, 0),
        criticalOpen: items.reduce((a, i) => a + i.criticalOpen, 0),
        breachedObligations: items.reduce((a, i) => a + i.obligations.breached, 0),
      },
      chain: {
        newestSealSequence: seal?.sequence ?? null,
        newestSealAt: seal?.sealedAt ?? null,
        verdict: watermark?.lastVerdict ?? null,
        verifiedAt: watermark?.verifiedAt ?? null,
      },
      scope: visible === "all" ? "company" : "scoped",
    };
  });

  /* ---------------------------------------------------------------- */
  /* 14. Scheduled sweeps                                              */
  /* ---------------------------------------------------------------- */

  app.scheduler.register({
    name: "assurance.obligation-breach",
    description:
      "Move open obligations past their deadline to breached, attributed to the system rather " +
      "than to whoever happened to open the page",
    everyMs: 15 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let breached = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        breached += await sweepObligationBreaches(db, companyId, now);
      });
      return { ...summary, breached };
    },
  });

  app.scheduler.register({
    name: "assurance.detector-sweep",
    description:
      "Run the company-scoped detector programme (payables, approvals, entity network) for " +
      "every tenant, idempotently",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) => {
      let created = 0;
      let refreshed = 0;
      let autoClosed = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        const result = await runCompanyDetectors({
          companyId,
          projectId: null,
          actorId: null,
          trigger: "scheduled",
        });
        created += result.created;
        refreshed += result.refreshed;
        autoClosed += result.autoClosed;
      });
      return { ...summary, created, refreshed, autoClosed };
    },
  });

  app.scheduler.register({
    name: "assurance.integrity-scores",
    description: "Snapshot integrity exposure scores per project, entity and approver",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db, now }) => {
      let scored = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        const r = await recomputeIntegrityScores(db, companyId, now);
        scored += r.scored;
      });
      return { ...summary, scored };
    },
  });

  app.scheduler.register({
    name: "assurance.entity-screening",
    description:
      "Re-screen entities against the configured screening list snapshots (fixtures until a " +
      "live feed is configured)",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: false,
    run: async ({ db }) => {
      let screened = 0;
      let hits = 0;
      const summary = await forEachCompany(db, async (companyId) => {
        const rows = await db
          .select()
          .from(entities)
          .where(and(eq(entities.companyId, companyId), isNull(entities.deletedAt)))
          .limit(500);
        for (const e of rows) {
          const r = await screenOneEntity(
            companyId,
            { id: e.id, name: e.name, kind: e.kind, jurisdiction: e.jurisdiction },
            null,
          );
          screened += 1;
          if (r.matches.length > 0) hits += 1;
        }
      });
      return { ...summary, screened, hits };
    },
  });
};
