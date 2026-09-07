import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bundleSnapshots,
  contractEvents,
  contracts,
  delayEvents,
  disputeBoardMembers,
  disputeBoardVisits,
  disputeBundles,
  disputeCosts,
  disputeSubmissions,
  disputes,
  documentProductionRequests,
  entities,
  evidence,
  files,
  forensicClaims,
  obligations,
  projects,
  rfis,
  settlementModels,
  settlementOffers,
} from "@constructos/db";
import {
  BUNDLE_ITEM_PRIVILEGE,
  DISPUTE_BOARD_ROLES,
  DISPUTE_COST_CATEGORIES,
  DISPUTE_JURISDICTIONS,
  DISPUTE_KINDS,
  DISPUTE_ROOT_CAUSES,
  DISPUTE_STATUSES,
  ENFORCEMENT_STATUSES,
  PRODUCTION_DECISIONS,
  PRODUCTION_OBJECTION_GROUNDS,
  SETTLEMENT_BRANCH_KINDS,
  SETTLEMENT_OFFER_BASES,
  SUBMISSION_KINDS,
  type DisputeStatus,
} from "@constructos/shared";
import { hashPayload, merkleRoot } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  analyseSettlement,
  evaluateDecisionTree,
  isOfferLive,
  litigationProvision,
  type CostsRules,
  type OfferForAnalysis,
  type TreeBranch,
  type TreeStage,
} from "./settlement.js";
import {
  REGIMES,
  buildNominationRequest,
  generateTimetable,
  regimeFor,
} from "./regimes.js";
import {
  draftingRecommendations,
  outcomeAnalytics,
  type DisputeOutcomeRow,
  type GroupBy,
} from "./analytics.js";
import {
  closeTimetableObligations,
  registerDisputeJobs,
  sweepExpiredOffers,
  sweepMissedDeadlines as sweepDeadlinesShared,
} from "./jobs.js";
import { companyToolGate, visibleProjectIds } from "../governance/gates.js";
import { renderBundleDocumentHtml } from "./bundle.js";

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** A procedural timetable step (#330/#338), stored in disputes.timetable. */
interface TimetableStep {
  id: string;
  name: string;
  dueDate: string | null; // ISO date
  /** materialized assurance Obligation tracking the deadline */
  obligationId: string | null;
  done: boolean;
  doneAt: string | null;
  /** set once by the missed-deadline sweep (idempotency marker) */
  breachedAt: string | null;
  /* ---- provenance when the step came from a statutory regime (#322-333) ---- */
  /** the regime step key, so a regenerated timetable can be diffed */
  key?: string | null;
  /** who must act: referring | responding | adjudicator | both */
  owner?: string | null;
  /** the statutory provision the offset comes from */
  authority?: string | null;
  /** the statutory extension ceiling where the regime allows one */
  extendedDueDate?: string | null;
}

/** A bundle item; tab + sha256 are frozen at generation (#343). */
interface BundleItem {
  id: string;
  tab: string | null;
  title: string;
  date: string | null; // ISO date
  recordType: string | null;
  recordId: string | null;
  fileId: string | null;
  sha256: string | null;
  /** BundleItemPrivilege — "none" for anything produced (#340-342) */
  privilege?: string;
  privilegeReason?: string | null;
}

interface ManifestIndexEntry {
  tab: string;
  title: string;
  date: string | null;
  source: string;
  sha256: string;
}

interface BundleManifest {
  generatedAt: string;
  itemCount: number;
  merkleRoot: string;
  index: ManifestIndexEntry[];
  /** items withheld on grounds of privilege, listed rather than produced (#340-342) */
  privilegeLog?: Array<{
    id: string;
    title: string;
    date: string | null;
    privilege: string;
    reason: string | null;
  }>;
  statement?: string;
}

/** Escalation ladder (#325-338): forward-only procedural statuses. */
const FORWARD_ORDER: DisputeStatus[] = [
  "notified",
  "referred",
  "submissions",
  "hearing",
  "decided",
];
const TERMINAL: DisputeStatus[] = ["decided", "settled", "withdrawn"];
const ACTIVE: DisputeStatus[] = ["notified", "referred", "submissions", "hearing"];

const BUNDLE_RECORD_TYPES = [
  "rfi",
  "delay_event",
  "contract_event",
  "claim",
  "evidence",
] as const;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const timetableStepCreateSchema = z.object({
  name: z.string().min(1).max(300),
  dueDate: isoDateSchema.optional(),
});

const timetableStepPatchSchema = z.object({
  /** id of an existing step to keep; omit for a new step */
  id: z.string().max(64).optional(),
  name: z.string().min(1).max(300),
  dueDate: isoDateSchema.nullable().optional(),
});

const disputeCreateSchema = z.object({
  title: z.string().min(1).max(500),
  kind: z.enum(DISPUTE_KINDS),
  forum: z.string().max(300).nullable().optional(),
  rules: z.string().max(300).nullable().optional(),
  contractId: z.string().min(1).nullable().optional(),
  claimIds: z.array(z.string().min(1)).max(100).optional(),
  counterpartyEntityId: z.string().min(1).nullable().optional(),
  amountInDispute: z.number().nonnegative().nullable().optional(),
  amountClaimed: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  timetable: z.array(timetableStepCreateSchema).max(100).optional(),
  /** generate the procedural timetable from a statutory regime (#322-333) */
  jurisdiction: z.enum(DISPUTE_JURISDICTIONS).optional(),
  triggerDate: isoDateSchema.optional(),
  /** public holidays for the business-day calendar; weekends are always excluded */
  holidays: z.array(isoDateSchema).max(60).optional(),
  contractFamily: z.string().max(200).nullable().optional(),
  governingClause: z.string().max(200).nullable().optional(),
});

const disputePatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  forum: z.string().max(300).nullable().optional(),
  rules: z.string().max(300).nullable().optional(),
  amountInDispute: z.number().nonnegative().nullable().optional(),
  amountClaimed: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  timetable: z.array(timetableStepPatchSchema).max(100).optional(),
  contractFamily: z.string().max(200).nullable().optional(),
  governingClause: z.string().max(200).nullable().optional(),
  rootCause: z.enum(DISPUTE_ROOT_CAUSES).nullable().optional(),
});

/* ---- platform upgrade wave ---- */

const timetableGenerateSchema = z.object({
  jurisdiction: z.enum(DISPUTE_JURISDICTIONS),
  triggerDate: isoDateSchema,
  holidays: z.array(isoDateSchema).max(60).optional(),
  /** true replaces the existing timetable; false appends the regime steps */
  replace: z.boolean().default(false),
});

const outcomeSchema = z.object({
  amountClaimed: z.number().nonnegative().nullable().optional(),
  amountAwarded: z.number().nullable().optional(),
  costsAwarded: z.number().nullable().optional(),
  rootCause: z.enum(DISPUTE_ROOT_CAUSES).nullable().optional(),
  governingClause: z.string().max(200).nullable().optional(),
  contractFamily: z.string().max(200).nullable().optional(),
  resolvedAt: isoDateSchema.nullable().optional(),
  enforcementStatus: z.enum(ENFORCEMENT_STATUSES).optional(),
  complianceDeadline: isoDateSchema.nullable().optional(),
  nodDeadline: isoDateSchema.nullable().optional(),
});

/* Redfern schedule — document production requests (#340-343) */
const productionRequestSchema = z.object({
  requestingParty: z.enum(["claimant", "respondent"]),
  documentsRequested: z.string().min(1).max(20000),
  relevance: z.string().min(1).max(20000),
  productionDueDate: isoDateSchema.nullable().optional(),
});

const productionRequestPatchSchema = z.object({
  documentsRequested: z.string().min(1).max(20000).optional(),
  relevance: z.string().min(1).max(20000).optional(),
  objection: z.string().max(20000).nullable().optional(),
  objectionGrounds: z.array(z.enum(PRODUCTION_OBJECTION_GROUNDS)).max(10).optional(),
  reply: z.string().max(20000).nullable().optional(),
  productionDueDate: isoDateSchema.nullable().optional(),
});

const productionDecisionSchema = z.object({
  decision: z.enum(PRODUCTION_DECISIONS).refine((d) => d !== "pending", {
    message: "A ruling must be granted, granted_in_part, refused or withdrawn",
  }),
  decisionNote: z.string().max(20000).nullable().optional(),
  productionDueDate: isoDateSchema.nullable().optional(),
});

const productionProduceSchema = z.object({
  fileIds: z.array(z.string().min(1)).min(1).max(200),
});

const boardMemberSchema = z.object({
  name: z.string().min(1).max(300),
  boardRole: z.enum(DISPUTE_BOARD_ROLES).default("member"),
  nominatedBy: z.enum(["employer", "contractor", "agreed", "institution"]).nullable().optional(),
  appointedAt: isoDateSchema.nullable().optional(),
  independenceDisclosure: z.string().max(20000).nullable().optional(),
  conflictDeclared: z.boolean().optional(),
  feeBasis: z.string().max(500).nullable().optional(),
});

const boardVisitSchema = z.object({
  visitDate: isoDateSchema,
  attendees: z.array(z.string().max(300)).max(50).optional(),
  summary: z.string().max(50000).nullable().optional(),
  recommendations: z.string().max(50000).nullable().optional(),
  reportFileId: z.string().min(1).nullable().optional(),
});

const costCreateSchema = z.object({
  category: z.enum(DISPUTE_COST_CATEGORIES),
  supplier: z.string().max(300).nullable().optional(),
  description: z.string().min(1).max(2000),
  incurredAt: isoDateSchema,
  budgetAmount: z.number().nonnegative().nullable().optional(),
  actualAmount: z.number().nonnegative(),
  currency: z.string().length(3).optional(),
  recoverable: z.boolean().optional(),
});

const settlementModelSchema = z.object({
  name: z.string().min(1).max(300),
  currency: z.string().length(3).optional(),
  branches: z
    .array(
      z.object({
        id: z.string().max(60).optional(),
        kind: z.enum(SETTLEMENT_BRANCH_KINDS),
        label: z.string().min(1).max(300),
        probability: z.number().min(0).max(1),
        award: z.number().finite(),
      }),
    )
    .min(1)
    .max(20),
  stages: z
    .array(
      z.object({
        id: z.string().max(60).optional(),
        name: z.string().min(1).max(300),
        ownCosts: z.number().nonnegative(),
        opponentCosts: z.number().nonnegative(),
      }),
    )
    .max(20),
  discountRatePercent: z.number().min(0).max(100).default(0),
  yearsToResolution: z.number().min(0).max(50).default(0),
  costsRules: z
    .object({
      enabled: z.boolean(),
      indemnityCostsPercent: z.number().min(0).max(200).default(0),
      enhancedInterestPercent: z.number().min(0).max(100).default(0),
      ownOfferAmount: z.number().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
});

const bundleItemPrivilegeSchema = z.object({
  itemId: z.string().min(1),
  privilege: z.enum(BUNDLE_ITEM_PRIVILEGE),
  reason: z.string().max(2000).nullable().optional(),
});

const privilegePutSchema = z.object({
  entries: z.array(bundleItemPrivilegeSchema).max(500),
});

const analyticsQuery = z.object({
  groupBy: z
    .enum(["forum", "kind", "jurisdiction", "rootCause", "contractFamily", "governingClause"])
    .default("rootCause"),
  projectId: z.string().min(1).optional(),
});

const disputeListQuery = pageQuerySchema.extend({
  kind: z.enum(DISPUTE_KINDS).optional(),
  status: z.enum(DISPUTE_STATUSES).optional(),
});

const statusChangeSchema = z.object({
  status: z.enum(DISPUTE_STATUSES),
  outcome: z.string().max(4000).optional(),
  /* structured outcome captured at the terminal transition (#356-357) */
  amountAwarded: z.number().nullable().optional(),
  costsAwarded: z.number().nullable().optional(),
  rootCause: z.enum(DISPUTE_ROOT_CAUSES).nullable().optional(),
  /** when the decision must be complied with, and when the NOD window closes */
  complianceDeadline: isoDateSchema.optional(),
  nodDeadline: isoDateSchema.optional(),
});

const submissionCreateSchema = z.object({
  kind: z.enum(SUBMISSION_KINDS),
  title: z.string().min(1).max(500),
  party: z.enum(["claimant", "respondent", "tribunal"]),
  servedAt: isoDateSchema,
  fileId: z.string().min(1).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
});

const bundleCreateSchema = z.object({ name: z.string().min(1).max(300) });

const bundleItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  date: isoDateSchema.nullable().optional(),
  recordType: z.enum(BUNDLE_RECORD_TYPES).optional(),
  recordId: z.string().min(1).optional(),
  fileId: z.string().min(1).optional(),
  /** privileged items are excluded from production and listed in the privilege log (#340-342) */
  privilege: z.enum(BUNDLE_ITEM_PRIVILEGE).default("none"),
  privilegeReason: z.string().max(2000).nullable().optional(),
});

const bundleItemsSchema = z.object({ items: z.array(bundleItemSchema).min(1).max(500) });

const offerCreateSchema = z.object({
  direction: z.enum(["made", "received"]),
  basis: z.enum(SETTLEMENT_OFFER_BASES),
  amount: z.number().positive(),
  currency: z.string().length(3).optional(),
  terms: z.string().max(4000).nullable().optional(),
  offeredAt: isoDateSchema,
  expiresAt: isoDateSchema.nullable().optional(),
});

const offerStatusSchema = z.object({
  status: z.enum(["accepted", "rejected", "lapsed", "withdrawn"]),
});

const settlementAnalysisQuery = z.object({
  winProbability: z.coerce.number().min(0).max(1).default(0.5),
  expectedAward: z.coerce.number().nonnegative().optional(),
  legalCosts: z.coerce.number().nonnegative().default(0),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Whole days from today (UTC) to an ISO date; negative = already past. */
function daysUntil(isoDate: string): number {
  return Math.round(
    (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
}

/** Earliest not-done timetable deadline, for the register view. */
function nextDeadlineOf(steps: TimetableStep[]): string | null {
  const open = steps.filter((s) => !s.done && s.dueDate).map((s) => s.dueDate!);
  return open.length === 0 ? null : open.sort()[0]!;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

const csvCell = (v: string | null | undefined): string => {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Dispute avoidance & resolution — spec Vol II Domain E / M15 (#321-357
 * subset): dispute register across resolution forums with institutional
 * rules (#321, #329, #334-337), procedural timetable engine whose deadlines
 * materialize as assurance Obligations (#325, #330, #338), pleadings
 * register (#339), tamper-evident hearing bundles with sequential tab
 * numbering, chronological ordering and a Merkle-rooted manifest (#343-344),
 * settlement offer register with acceptance settling the dispute (#350-351)
 * and expected-value settlement modelling (#352).
 */
export const disputesModule: FastifyPluginAsync = async (app) => {
  /**
   * Either the pooled handle or a transaction's handle. Helpers that may be
   * called from inside a transaction take one of these so their writes join
   * the caller's transaction instead of escaping it.
   */
  type TxHandle = typeof app.db | Parameters<Parameters<typeof app.db.transaction>[0]>[0];

  const readGate = [app.authenticate, app.requireCompany, app.requireTool("disputes", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("disputes", "standard"),
  ];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("disputes", "admin"),
  ];
  const companyReadGate = [
    app.authenticate,
    app.requireCompany,
    companyToolGate(app, "disputes", "read"),
  ];
  registerDisputeJobs(app);

  async function fetchDispute(disputeId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.id, disputeId),
          eq(disputes.companyId, companyId),
          eq(disputes.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Dispute not found");
    return rows[0];
  }

  async function fetchBundle(bundleId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(disputeBundles)
      .where(
        and(
          eq(disputeBundles.id, bundleId),
          eq(disputeBundles.companyId, companyId),
          eq(disputeBundles.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Bundle not found");
    return rows[0];
  }

  async function validateLinks(
    companyId: string,
    projectId: string,
    body: { contractId?: string | null; claimIds?: string[]; counterpartyEntityId?: string | null },
  ): Promise<void> {
    if (body.contractId) {
      const rows = await app.db
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, body.contractId),
            eq(contracts.companyId, companyId),
            eq(contracts.projectId, projectId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("contractId does not belong to this project");
    }
    if (body.claimIds && body.claimIds.length > 0) {
      const unique = [...new Set(body.claimIds)];
      const rows = await app.db
        .select({ id: forensicClaims.id })
        .from(forensicClaims)
        .where(
          and(
            inArray(forensicClaims.id, unique),
            eq(forensicClaims.companyId, companyId),
            eq(forensicClaims.projectId, projectId),
          ),
        );
      if (rows.length !== unique.length) {
        throw badRequest("One or more claimIds are not forensic claims in this project");
      }
    }
    if (body.counterpartyEntityId) {
      const rows = await app.db
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.id, body.counterpartyEntityId),
            eq(entities.companyId, companyId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw badRequest("counterpartyEntityId is not an entity of this company");
    }
  }

  /**
   * A file cited in a pleadings register or a hearing bundle must belong
   * to THIS project, not merely to the company.
   *
   * Checking companyId alone let a user with disputes:standard on project
   * P attach and hash any file from any other project of the same company
   * into P’s bundle — and the bundle manifest publishes its name to the
   * tribunal. Files with no project (company-level documents) are allowed
   * deliberately: a corporate insurance policy is legitimately citable.
   */
  async function validateFileId(
    companyId: string,
    projectId: string,
    fileId: string,
  ): Promise<{ id: string; name: string; sha256: string }> {
    const rows = await app.db
      .select({
        id: files.id,
        name: files.name,
        sha256: files.sha256,
        projectId: files.projectId,
      })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw badRequest("fileId does not belong to this company");
    if (row.projectId && row.projectId !== projectId) {
      throw badRequest(
        "fileId belongs to another project — a dispute record may only cite files from its own project or company-level files",
      );
    }
    return { id: row.id, name: row.name, sha256: row.sha256 };
  }

  /**
   * The adjudication/arbitration timetable engine (#330, #338): every dated
   * step materializes as an assurance Obligation so the dispute clock and
   * the obligation register agree on the deadline.
   *
   * `handle` lets a caller that is already inside a transaction write the
   * obligation on the same handle. Writing it on `app.db` from inside a
   * transaction would both escape the atomicity the caller wants and, on a
   * single-connection deployment, deadlock against the open transaction.
   */
  async function materializeStepObligation(
    companyId: string,
    projectId: string,
    actorId: string,
    dispute: { kind: string; number: number },
    step: { name: string; dueDate: string },
    handle: TxHandle = app.db,
  ): Promise<string> {
    const id = newId("obl");
    await handle.insert(obligations).values({
      id,
      companyId,
      projectId,
      sourceClause: `${dispute.kind} — ${step.name}`,
      trigger: `Dispute #${dispute.number} procedural timetable: ${step.name}`,
      deadline: `${step.dueDate}T23:59:59Z`,
      warnDaysBefore: 3,
      evidenceRequirement: "Served submission / completed procedural step",
      status: "open",
      createdBy: actorId,
    });
    return id;
  }

  /**
   * Refresh missed procedural deadlines before a read.
   *
   * The arithmetic moved to jobs.ts so it runs on a schedule — a platform
   * whose product is "the deadline was missed and here is the record" cannot
   * wait for a browser tab to notice — and so the transition is attributed
   * to the system rather than to whoever happened to open the page. The read
   * path still calls it so a page opened between cycles is current.
   */
  async function sweepMissedDeadlines(companyId: string, projectId: string): Promise<void> {
    await sweepDeadlinesShared(app.db, companyId, todayISO(), projectId);
  }

  /**
   * Resolve a bundle-item record reference to its row + display title.
   * Returns null when the record does not exist in this tenant/project.
   */
  async function resolveRecord(
    recordType: string,
    recordId: string,
    companyId: string,
    projectId: string,
  ): Promise<{ row: unknown; title: string; date: string | null } | null> {
    switch (recordType) {
      case "rfi": {
        const rows = await app.db
          .select()
          .from(rfis)
          .where(
            and(eq(rfis.id, recordId), eq(rfis.companyId, companyId), eq(rfis.projectId, projectId)),
          )
          .limit(1);
        const r = rows[0];
        return r ? { row: r, title: `RFI-${r.number}: ${r.subject}`, date: r.dueDate } : null;
      }
      case "delay_event": {
        const rows = await app.db
          .select()
          .from(delayEvents)
          .where(
            and(
              eq(delayEvents.id, recordId),
              eq(delayEvents.companyId, companyId),
              eq(delayEvents.projectId, projectId),
            ),
          )
          .limit(1);
        const r = rows[0];
        return r ? { row: r, title: r.title, date: r.startDate } : null;
      }
      case "contract_event": {
        const rows = await app.db
          .select()
          .from(contractEvents)
          .where(
            and(
              eq(contractEvents.id, recordId),
              eq(contractEvents.companyId, companyId),
              eq(contractEvents.projectId, projectId),
            ),
          )
          .limit(1);
        const r = rows[0];
        return r ? { row: r, title: r.title, date: r.eventDate } : null;
      }
      case "claim": {
        const rows = await app.db
          .select()
          .from(forensicClaims)
          .where(
            and(
              eq(forensicClaims.id, recordId),
              eq(forensicClaims.companyId, companyId),
              eq(forensicClaims.projectId, projectId),
            ),
          )
          .limit(1);
        const r = rows[0];
        return r ? { row: r, title: r.title, date: null } : null;
      }
      case "evidence": {
        const rows = await app.db
          .select()
          .from(evidence)
          .where(
            and(
              eq(evidence.id, recordId),
              eq(evidence.companyId, companyId),
              eq(evidence.projectId, projectId),
            ),
          )
          .limit(1);
        const r = rows[0];
        return r ? { row: r, title: `Evidence: ${r.source}`, date: r.capturedAt?.slice(0, 10) ?? null } : null;
      }
      default:
        return null;
    }
  }

  /**
   * Content hash AND snapshot for a bundle item. File-backed items reuse the files row's
   * sha256 — storage is content-addressed, so that IS the content hash.
   * Record-backed items hash the record's canonical JSON. Returns null when
   * the underlying file/record no longer exists.
   */
  async function itemContent(
    item: { fileId: string | null; recordType: string | null; recordId: string | null },
    companyId: string,
    projectId: string,
  ): Promise<{
    sha256: string;
    kind: "record" | "file";
    snapshot: Record<string, unknown> | null;
  } | null> {
    if (item.fileId) {
      const rows = await app.db
        .select({ sha256: files.sha256, name: files.name, projectId: files.projectId })
        .from(files)
        .where(and(eq(files.id, item.fileId), eq(files.companyId, companyId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      if (row.projectId && row.projectId !== projectId) return null;
      // A file is content-addressed in storage, so its sha256 IS the
      // content hash; the snapshot records the reference, not the bytes.
      return {
        sha256: row.sha256,
        kind: "file",
        snapshot: { fileId: item.fileId, name: row.name, sha256: row.sha256 },
      };
    }
    if (item.recordType && item.recordId) {
      const resolved = await resolveRecord(item.recordType, item.recordId, companyId, projectId);
      if (!resolved) return null;
      return {
        sha256: hashPayload(resolved.row),
        kind: "record",
        snapshot: {
          recordType: item.recordType,
          recordId: item.recordId,
          title: resolved.title,
          date: resolved.date,
          row: resolved.row as Record<string, unknown>,
        },
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Dispute register (#321, #329, #334-337)                           */
  /* ---------------------------------------------------------------- */

  /**
   * Open a dispute (#321, #322-333).
   *
   * Two changes:
   *
   *  1. TIMETABLE FROM THE STATUTE. Give the dispute a `jurisdiction` and a
   *     `triggerDate` and the procedural timetable is generated from the
   *     regime's own offsets — 7 days to refer under the UK Scheme, 10
   *     business days for a NSW payment schedule — instead of being typed in
   *     from memory. Explicit `timetable` steps still win where they are
   *     given, because contracts vary the statute.
   *  2. ATOMICITY. Creating a dispute materialises one obligation per dated
   *     step. That used to be N inserts followed by the dispute insert with
   *     no transaction: a failure part-way left obligations with no owning
   *     record on the assurance register and returned a 500 having partly
   *     committed. The whole thing is now one transaction.
   */
  app.post("/projects/:projectId/disputes", { preHandler: standardGate }, async (req, reply) => {
    const body = disputeCreateSchema.parse(req.body);
    await validateLinks(req.companyId!, req.projectId!, body);
    const number = await nextRecordNumber(app.db, req.projectId!, "dispute");
    const id = newId("dsp");

    // Generated regime steps first, then any explicit ones the caller gave.
    let generated: ReturnType<typeof generateTimetable> = null;
    if (body.jurisdiction && body.jurisdiction !== "custom") {
      if (!body.triggerDate) {
        throw badRequest(
          "A statutory jurisdiction needs a triggerDate — every offset in the regime is measured from it",
        );
      }
      generated = generateTimetable(body.jurisdiction, body.triggerDate, body.holidays ?? []);
      if (!generated) throw badRequest(`Unknown dispute jurisdiction ${body.jurisdiction}`);
    }

    const planned: Array<{
      name: string;
      dueDate: string | null;
      key: string | null;
      owner: string | null;
      authority: string | null;
      extendedDueDate: string | null;
    }> = [
      ...(generated?.steps ?? []).map((s) => ({
        name: s.name,
        dueDate: s.dueDate,
        key: s.key,
        owner: s.owner,
        authority: s.authority,
        extendedDueDate: s.extendedDueDate,
      })),
      ...(body.timetable ?? []).map((s) => ({
        name: s.name,
        dueDate: s.dueDate ?? null,
        key: null,
        owner: null,
        authority: null,
        extendedDueDate: null,
      })),
    ];

    await app.db.transaction(async (tx) => {
      const steps: TimetableStep[] = [];
      for (const s of planned) {
        const stepId = newId("stp");
        let obligationId: string | null = null;
        if (s.dueDate) {
          obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: s.authority ?? `${body.kind} — ${s.name}`,
            trigger: `Dispute #${number} procedural timetable: ${s.name}`,
            deadline: `${s.dueDate}T23:59:59Z`,
            warnDaysBefore: 3,
            evidenceRequirement: "Served submission / completed procedural step",
            status: "open",
            createdBy: req.user!.id,
          });
        }
        steps.push({
          id: stepId,
          name: s.name,
          dueDate: s.dueDate,
          obligationId,
          done: false,
          doneAt: null,
          breachedAt: null,
          key: s.key,
          owner: s.owner,
          authority: s.authority,
          extendedDueDate: s.extendedDueDate,
        });
      }

      await tx.insert(disputes).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        number,
        title: body.title,
        kind: body.kind,
        forum: body.forum ?? null,
        rules: body.rules ?? null,
        contractId: body.contractId ?? null,
        claimIds: body.claimIds ? [...new Set(body.claimIds)] : [],
        counterpartyEntityId: body.counterpartyEntityId ?? null,
        amountInDispute: body.amountInDispute ?? null,
        amountClaimed: body.amountClaimed ?? body.amountInDispute ?? null,
        currency: body.currency ?? "GBP",
        status: "notified",
        timetable: steps,
        jurisdiction: body.jurisdiction ?? null,
        triggerDate: body.triggerDate ?? null,
        contractFamily: body.contractFamily ?? null,
        governingClause: body.governingClause ?? null,
        createdBy: req.user!.id,
      });
      await appendLedger(tx as never, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute",
        objectId: id,
        payload: {
          number,
          title: body.title,
          kind: body.kind,
          forum: body.forum ?? null,
          rules: body.rules ?? null,
          jurisdiction: body.jurisdiction ?? null,
          triggerDate: body.triggerDate ?? null,
          amountInDispute: body.amountInDispute ?? null,
          currency: body.currency ?? "GBP",
          timetable: steps.map((s) => ({ id: s.id, name: s.name, dueDate: s.dueDate })),
        },
        storePayload: true,
        projectId: req.projectId!,
      });
    });
    const created = await fetchDispute(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/disputes", { preHandler: readGate }, async (req) => {
    const q = disputeListQuery.parse(req.query);
    await sweepMissedDeadlines(req.companyId!, req.projectId!);
    await sweepExpiredOffers(app.db, req.companyId!, todayISO());
    const clauses = [eq(disputes.companyId, req.companyId!), eq(disputes.projectId, req.projectId!)];
    if (q.kind) clauses.push(eq(disputes.kind, q.kind));
    if (q.status) clauses.push(eq(disputes.status, q.status));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(disputes).where(where);
    const rows = await app.db
      .select()
      .from(disputes)
      .where(where)
      .orderBy(desc(disputes.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const items = rows.map((d) => {
      const nextDeadline = nextDeadlineOf(d.timetable as TimetableStep[]);
      return {
        ...d,
        nextDeadline,
        daysToNext: nextDeadline ? daysUntil(nextDeadline) : null,
      };
    });
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/projects/:projectId/disputes/:disputeId", { preHandler: readGate }, async (req) => {
    const { disputeId } = req.params as { disputeId: string };
    await fetchDispute(disputeId, req.companyId!, req.projectId!); // 404 before sweeping
    await sweepMissedDeadlines(req.companyId!, req.projectId!);
    await sweepExpiredOffers(app.db, req.companyId!, todayISO());
    const d = await fetchDispute(disputeId, req.companyId!, req.projectId!);
    const claimRows =
      d.claimIds.length > 0
        ? await app.db
            .select({
              id: forensicClaims.id,
              number: forensicClaims.number,
              title: forensicClaims.title,
            })
            .from(forensicClaims)
            .where(
              and(
                inArray(forensicClaims.id, d.claimIds),
                eq(forensicClaims.companyId, req.companyId!),
              ),
            )
        : [];
    const submissions = await app.db
      .select()
      .from(disputeSubmissions)
      .where(eq(disputeSubmissions.disputeId, disputeId))
      .orderBy(asc(disputeSubmissions.servedAt), asc(disputeSubmissions.createdAt));
    const bundles = await app.db
      .select()
      .from(disputeBundles)
      .where(eq(disputeBundles.disputeId, disputeId))
      .orderBy(desc(disputeBundles.createdAt));
    const offers = await app.db
      .select()
      .from(settlementOffers)
      .where(eq(settlementOffers.disputeId, disputeId))
      .orderBy(asc(settlementOffers.offeredAt), asc(settlementOffers.createdAt));
    const nextDeadline = nextDeadlineOf(d.timetable as TimetableStep[]);
    return {
      ...d,
      nextDeadline,
      daysToNext: nextDeadline ? daysUntil(nextDeadline) : null,
      claims: claimRows,
      submissions,
      bundles,
      offers,
    };
  });

  app.patch("/projects/:projectId/disputes/:disputeId", { preHandler: standardGate }, async (req) => {
    const { disputeId } = req.params as { disputeId: string };
    const body = disputePatchSchema.parse(req.body);
    const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
    if (TERMINAL.includes(dispute.status as DisputeStatus)) {
      throw badRequest(`A ${dispute.status} dispute can no longer be edited`);
    }
    // A dispute's currency denominates amountInDispute, amountClaimed,
    // amountAwarded and costsAwarded, and it decides which offers and cost
    // rows are "comparable" in the settlement analysis and the company
    // outcome database. Relabelling it once money exists restates the claim
    // and silently drops or admits rows, so it is refused — the same rule
    // the module already applies to a terminal dispute.
    if (body.currency !== undefined && body.currency !== dispute.currency) {
      const [offerCount] = await app.db
        .select({ n: count() })
        .from(settlementOffers)
        .where(eq(settlementOffers.disputeId, disputeId));
      const [costCount] = await app.db
        .select({ n: count() })
        .from(disputeCosts)
        .where(eq(disputeCosts.disputeId, disputeId));
      const blockers: string[] = [];
      if (Number(offerCount?.n ?? 0) > 0) blockers.push(`${offerCount!.n} settlement offer(s)`);
      if (Number(costCount?.n ?? 0) > 0) blockers.push(`${costCount!.n} recorded cost(s)`);
      if (dispute.amountAwarded != null) blockers.push("an award");
      if (dispute.costsAwarded != null) blockers.push("a costs award");
      if (blockers.length > 0) {
        throw conflict(
          `The currency of this dispute cannot be changed from ${dispute.currency} to ${body.currency}: ` +
            `it already holds ${blockers.join(", ")} denominated in ${dispute.currency}. ` +
            `Changing it would relabel every recorded amount and change which offers and costs the ` +
            `settlement analysis treats as comparable. Correct the amounts on a new dispute, or ` +
            `record the conversion explicitly.`,
        );
      }
    }

    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.forum !== undefined) set["forum"] = body.forum;
    if (body.rules !== undefined) set["rules"] = body.rules;
    if (body.amountInDispute !== undefined) set["amountInDispute"] = body.amountInDispute;
    if (body.amountClaimed !== undefined) set["amountClaimed"] = body.amountClaimed;
    if (body.currency !== undefined) set["currency"] = body.currency;
    if (body.contractFamily !== undefined) set["contractFamily"] = body.contractFamily;
    if (body.governingClause !== undefined) set["governingClause"] = body.governingClause;
    if (body.rootCause !== undefined) set["rootCause"] = body.rootCause;

    const extensionsCleared: Array<{
      stepId: string;
      from: string | null;
      to: string;
      obligationId: string;
    }> = [];
    // Everything below — obligations materialised, extended, waived, the
    // dispute row itself and the ledger entry — is one act. Written as loose
    // statements, a failure part-way left the timetable and the obligation
    // register disagreeing about the same deadlines.
    await app.db.transaction(async (tx) => {
    if (body.timetable !== undefined) {
      const existing = dispute.timetable as TimetableStep[];
      const byId = new Map(existing.map((s) => [s.id, s]));
      const kept = new Set<string>();
      const next: TimetableStep[] = [];
      for (const s of body.timetable) {
        const prior = s.id ? byId.get(s.id) : undefined;
        if (prior) {
          kept.add(prior.id);
          const dueDate = s.dueDate === undefined ? prior.dueDate : s.dueDate;
          let obligationId = prior.obligationId;
          if (dueDate && !prior.obligationId && !prior.done) {
            // step gains a deadline → materialize its obligation
            obligationId = await materializeStepObligation(
              req.companyId!,
              req.projectId!,
              req.user!.id,
              { kind: dispute.kind, number: dispute.number },
              { name: s.name, dueDate },
              tx,
            );
          } else if (dueDate && prior.obligationId && dueDate !== prior.dueDate) {
            // A tribunal that grants an extension has moved the deadline,
            // not forgiven a breach that happened. When the new date is in
            // the FUTURE the step is no longer missed: the breach marker is
            // cleared and the obligation returns to open with the new
            // deadline. Previously the step kept its red "Missed" badge and
            // its breached obligation forever, with no way back short of
            // deleting and re-adding the step.
            const extendedIntoFuture = dueDate >= todayISO();
            await tx
              .update(obligations)
              .set({
                deadline: `${dueDate}T23:59:59Z`,
                ...(extendedIntoFuture ? { status: "open" as const } : {}),
              })
              .where(
                and(
                  eq(obligations.id, prior.obligationId),
                  inArray(
                    obligations.status,
                    extendedIntoFuture ? ["open", "breached"] : ["open"],
                  ),
                ),
              );
            if (extendedIntoFuture && prior.breachedAt) {
              extensionsCleared.push({
                stepId: prior.id,
                from: prior.dueDate,
                to: dueDate,
                obligationId: prior.obligationId,
              });
            }
          } else if (!dueDate && prior.obligationId) {
            await tx
              .update(obligations)
              .set({ status: "waived" })
              .where(and(eq(obligations.id, prior.obligationId), eq(obligations.status, "open")));
            obligationId = null;
          }
          const clearedBreach =
            Boolean(dueDate) && dueDate! >= todayISO() && prior.breachedAt !== null;
          next.push({
            ...prior,
            name: s.name,
            dueDate: dueDate ?? null,
            obligationId,
            breachedAt: clearedBreach ? null : prior.breachedAt,
          });
        } else {
          const stepId = newId("stp");
          let obligationId: string | null = null;
          if (s.dueDate) {
            obligationId = await materializeStepObligation(
              req.companyId!,
              req.projectId!,
              req.user!.id,
              { kind: dispute.kind, number: dispute.number },
              { name: s.name, dueDate: s.dueDate },
              tx,
            );
          }
          next.push({
            id: stepId,
            name: s.name,
            dueDate: s.dueDate ?? null,
            obligationId,
            done: false,
            doneAt: null,
            breachedAt: null,
          });
        }
      }
      // steps dropped from the timetable release their open obligations
      for (const prior of existing) {
        if (!kept.has(prior.id) && prior.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "waived" })
            .where(and(eq(obligations.id, prior.obligationId), eq(obligations.status, "open")));
        }
      }
      set["timetable"] = next;
    }

    await tx.update(disputes).set(set).where(eq(disputes.id, disputeId));
    await appendLedger(tx as never, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "dispute",
      objectId: disputeId,
      payload: {
        changed: Object.keys(body),
        ...(extensionsCleared.length > 0 ? { extensionsCleared } : {}),
      },
      storePayload: extensionsCleared.length > 0,
      projectId: req.projectId!,
    });
    });
    return fetchDispute(disputeId, req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Status transitions (#325-333, #349)                               */
  /* ---------------------------------------------------------------- */

  /**
   * Move the dispute along its escalation ladder (#325-333, #349).
   *
   * The terminal transitions now CLOSE OUT the timetable. A settled or
   * withdrawn dispute used to leave every not-done step's obligation open
   * forever: the sweep only scanned ACTIVE disputes, so those rows never
   * breached, never satisfied and never closed — orphans sitting on the
   * assurance register that the timeline UI told users would "stay there
   * until waived", with no waive action anywhere. On a terminal transition
   * the remaining obligations are resolved: `satisfied` where the dispute
   * was decided (the process ran its course) and `waived` where it settled
   * or was withdrawn (the process stopped by agreement).
   */
  app.post(
    "/projects/:projectId/disputes/:disputeId/status",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = statusChangeSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const from = dispute.status as DisputeStatus;
      const to = body.status;

      if (TERMINAL.includes(from)) {
        throw badRequest(`A ${from} dispute cannot change status`);
      }
      if (to === "settled" || to === "withdrawn") {
        // allowed from any pre-decided status (guard above already ensures it)
      } else {
        const fromIdx = FORWARD_ORDER.indexOf(from);
        const toIdx = FORWARD_ORDER.indexOf(to);
        if (toIdx <= fromIdx) {
          throw badRequest(
            `Dispute status moves forward only (${FORWARD_ORDER.join(" → ")}); ` +
              `cannot move from ${from} to ${to}`,
          );
        }
        if (to === "decided" && !body.outcome?.trim()) {
          throw badRequest("Recording a decision requires an outcome");
        }
      }

      const now = new Date().toISOString();
      const terminal = TERMINAL.includes(to);
      const steps = dispute.timetable as TimetableStep[];
      let closed: { resolved: number; to: string } = { resolved: 0, to: "" };

      await app.db.transaction(async (tx) => {
        const set: Record<string, unknown> = { status: to, updatedAt: now };
        if (body.outcome?.trim()) set["outcome"] = body.outcome.trim();
        if (to === "decided") {
          set["decidedAt"] = now;
          set["resolvedAt"] = now.slice(0, 10);
          if (body.complianceDeadline) set["complianceDeadline"] = body.complianceDeadline;
          if (body.nodDeadline) set["nodDeadline"] = body.nodDeadline;
          set["enforcementStatus"] = "awaiting_compliance";
        }
        if (to === "settled" || to === "withdrawn") set["resolvedAt"] = now.slice(0, 10);
        if (body.amountAwarded !== undefined) set["amountAwarded"] = body.amountAwarded;
        if (body.costsAwarded !== undefined) set["costsAwarded"] = body.costsAwarded;
        if (body.rootCause !== undefined) set["rootCause"] = body.rootCause;
        await tx.update(disputes).set(set).where(eq(disputes.id, disputeId));

        if (terminal) {
          closed = await closeTimetableObligations(tx as never, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            disputeId,
            steps,
            terminalStatus: to,
          });
          // Sibling offers on a dispute that has ended are no longer on the
          // table either.
          await tx
            .update(settlementOffers)
            .set({ status: "lapsed", updatedAt: now })
            .where(
              and(
                eq(settlementOffers.disputeId, disputeId),
                eq(settlementOffers.companyId, req.companyId!),
                eq(settlementOffers.status, "open"),
              ),
            );
        }

        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "dispute",
          objectId: disputeId,
          payload: {
            from,
            to,
            outcome: body.outcome ?? null,
            ...(terminal
              ? { obligationsResolved: closed.resolved, obligationStatus: closed.to }
              : {}),
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return {
        ...(await fetchDispute(disputeId, req.companyId!, req.projectId!)),
        obligationsResolved: terminal ? closed.resolved : 0,
      };
    },
  );

  app.post(
    "/projects/:projectId/disputes/:disputeId/timetable/:stepId/complete",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId, stepId } = req.params as { disputeId: string; stepId: string };
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const steps = dispute.timetable as TimetableStep[];
      const step = steps.find((s) => s.id === stepId);
      if (!step) throw notFound("Timetable step not found");
      if (step.done) throw badRequest("Timetable step is already completed");
      const now = new Date().toISOString();
      step.done = true;
      step.doneAt = now;
      // The obligation, the timetable and the ledger move together: a step
      // recorded as done whose obligation stayed open would leave the
      // assurance register contradicting the dispute record.
      await app.db.transaction(async (tx) => {
        if (step.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "satisfied" })
            .where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
        }
        await tx
          .update(disputes)
          .set({ timetable: steps, updatedAt: now })
          .where(eq(disputes.id, disputeId));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "dispute_timetable_step",
          objectId: stepId,
          payload: { disputeId, step: step.name, status: "done", obligationId: step.obligationId },
          projectId: req.projectId!,
        });
      });
      return fetchDispute(disputeId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Pleadings / submissions register (#339)                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/disputes/:disputeId/submissions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = submissionCreateSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      if (body.fileId) await validateFileId(req.companyId!, req.projectId!, body.fileId);
      const id = newId("dsb");
      await app.db.insert(disputeSubmissions).values({
        id,
        disputeId,
        companyId: req.companyId!,
        kind: body.kind,
        title: body.title,
        party: body.party,
        servedAt: body.servedAt,
        fileId: body.fileId ?? null,
        note: body.note ?? null,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute_submission",
        objectId: id,
        payload: {
          disputeId,
          kind: body.kind,
          title: body.title,
          party: body.party,
          servedAt: body.servedAt,
        },
        storePayload: true,
      });
      const created = (
        await app.db.select().from(disputeSubmissions).where(eq(disputeSubmissions.id, id)).limit(1)
      )[0];
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/submissions",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const q = pageQuerySchema.parse(req.query);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const where = and(
        eq(disputeSubmissions.disputeId, disputeId),
        eq(disputeSubmissions.companyId, req.companyId!),
      );
      const [totalRow] = await app.db.select({ n: count() }).from(disputeSubmissions).where(where);
      const items = await app.db
        .select()
        .from(disputeSubmissions)
        .where(where)
        .orderBy(asc(disputeSubmissions.servedAt), asc(disputeSubmissions.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      return paginate(items, Number(totalRow?.n ?? 0), q);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Hearing bundles (#343-344)                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/disputes/:disputeId/bundles",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = bundleCreateSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const id = newId("bdl");
      await app.db.insert(disputeBundles).values({
        id,
        disputeId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        status: "draft",
        items: [],
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute_bundle",
        objectId: id,
        payload: { disputeId, name: body.name },
      });
      const created = await fetchBundle(id, req.companyId!, req.projectId!);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/bundles",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(disputeBundles)
        .where(
          and(
            eq(disputeBundles.disputeId, disputeId),
            eq(disputeBundles.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(disputeBundles.createdAt));
      return { items, total: items.length };
    },
  );

  app.get("/projects/:projectId/dispute-bundles/:bundleId", { preHandler: readGate }, async (req) => {
    const { bundleId } = req.params as { bundleId: string };
    return fetchBundle(bundleId, req.companyId!, req.projectId!);
  });

  app.put(
    "/projects/:projectId/dispute-bundles/:bundleId/items",
    { preHandler: standardGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const body = bundleItemsSchema.parse(req.body);
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      if (bundle.status !== "draft") {
        throw badRequest("Only a draft bundle's items can be edited; generated bundles are frozen");
      }
      const items: BundleItem[] = [];
      for (const [i, raw] of body.items.entries()) {
        if (!raw.fileId && !(raw.recordType && raw.recordId)) {
          throw badRequest(
            `Item ${i + 1}: each bundle item needs a fileId or a recordType + recordId`,
          );
        }
        if ((raw.recordType && !raw.recordId) || (!raw.recordType && raw.recordId)) {
          throw badRequest(`Item ${i + 1}: recordType and recordId must be provided together`);
        }
        let title = raw.title ?? null;
        let date = raw.date ?? null;
        if (raw.fileId) {
          // Project-scoped, not merely company-scoped: a bundle manifest is
          // served to a tribunal and publishes the file name.
          const file = await validateFileId(req.companyId!, req.projectId!, raw.fileId).catch(
            (err: unknown) => {
              throw badRequest(
                `Item ${i + 1}: ${err instanceof Error ? err.message : "invalid fileId"}`,
              );
            },
          );
          if (!title) title = file.name;
        }
        if (raw.recordType && raw.recordId) {
          const resolved = await resolveRecord(
            raw.recordType,
            raw.recordId,
            req.companyId!,
            req.projectId!,
          );
          if (!resolved) {
            throw badRequest(
              `Item ${i + 1}: ${raw.recordType} ${raw.recordId} not found in this project`,
            );
          }
          if (!title) title = resolved.title;
          if (!date) date = resolved.date;
        }
        if (raw.privilege !== "none" && !raw.privilegeReason) {
          throw badRequest(
            `Item ${i + 1}: an item marked privileged needs a reason for the privilege log`,
          );
        }
        items.push({
          id: newId("bit"),
          tab: null,
          title: title ?? "Untitled",
          date,
          recordType: raw.recordType ?? null,
          recordId: raw.recordId ?? null,
          fileId: raw.fileId ?? null,
          sha256: null,
          privilege: raw.privilege,
          privilegeReason: raw.privilegeReason ?? null,
        });
      }
      const now = new Date().toISOString();
      await app.db
        .update(disputeBundles)
        .set({ items, updatedAt: now })
        .where(eq(disputeBundles.id, bundleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { itemCount: items.length },
      });
      return fetchBundle(bundleId, req.companyId!, req.projectId!);
    },
  );

  /** Chronological bundle ordering (#344): draft items sorted by date. */
  app.post(
    "/projects/:projectId/dispute-bundles/:bundleId/chronological",
    { preHandler: standardGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      if (bundle.status !== "draft") {
        throw badRequest("Only a draft bundle can be reordered");
      }
      const items = [...(bundle.items as BundleItem[])];
      // stable: dated items ascending, undated items keep relative order at the end
      const sorted = items
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => {
          if (a.item.date === null && b.item.date === null) return a.idx - b.idx;
          if (a.item.date === null) return 1;
          if (b.item.date === null) return -1;
          return a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : a.idx - b.idx;
        })
        .map((x) => x.item);
      await app.db
        .update(disputeBundles)
        .set({ items: sorted, updatedAt: new Date().toISOString() })
        .where(eq(disputeBundles.id, bundleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { reordered: "chronological", itemCount: sorted.length },
      });
      return fetchBundle(bundleId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Freeze the bundle (#340-343).
   *
   * What generation now does, and why:
   *
   *  - CONTENT SNAPSHOTS. Each item's canonical JSON (or its file's hash
   *    reference) is stored in `bundle_snapshots`. Without them `verify`
   *    could not tell tampering from an ordinary lifecycle change on the
   *    source record — an RFI answered after the bundle was served made the
   *    bundle look forged — and a produced bundle could never be re-rendered
   *    as it was served.
   *  - PRIVILEGE. Items marked privileged are EXCLUDED from production and
   *    listed in a privilege log instead. Producing a privileged document is
   *    a waiver you cannot take back.
   *  - PAGINATION. Every produced item is assigned a page span, so the index
   *    can say "tab A7, page 214" rather than just naming the tab.
   */
  app.post(
    "/projects/:projectId/dispute-bundles/:bundleId/generate",
    { preHandler: standardGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      if (bundle.status !== "draft") {
        throw badRequest(`A ${bundle.status} bundle cannot be generated again`);
      }
      const items = bundle.items as BundleItem[];
      if (items.length === 0) throw badRequest("Cannot generate an empty bundle");

      const produced = items.filter((i) => (i.privilege ?? "none") === "none");
      const withheld = items.filter((i) => (i.privilege ?? "none") !== "none");
      if (produced.length === 0) {
        throw badRequest(
          "Every item in this bundle is marked privileged, so there is nothing to produce",
        );
      }

      const index: ManifestIndexEntry[] = [];
      const snapshots: Array<{
        itemId: string;
        tab: string;
        kind: "record" | "file";
        sha256: string;
        snapshot: Record<string, unknown> | null;
      }> = [];
      for (const [i, item] of produced.entries()) {
        const resolved = await itemContent(item, req.companyId!, req.projectId!);
        if (!resolved) {
          throw badRequest(
            `Item "${item.title}" no longer resolves to a file or record; remove it and retry`,
          );
        }
        item.tab = `A${i + 1}`;
        item.sha256 = resolved.sha256;
        index.push({
          tab: item.tab,
          title: item.title,
          date: item.date,
          source: item.fileId ? `file:${item.fileId}` : `${item.recordType}:${item.recordId}`,
          sha256: resolved.sha256,
        });
        snapshots.push({
          itemId: item.id,
          tab: item.tab,
          kind: resolved.kind,
          sha256: resolved.sha256,
          snapshot: resolved.snapshot,
        });
      }
      // Withheld items keep no tab and no hash — they are not in the bundle.
      for (const item of withheld) {
        item.tab = null;
        item.sha256 = null;
      }

      const root = merkleRoot(index.map((e) => e.sha256));
      const generatedAt = new Date().toISOString();
      const manifest: BundleManifest = {
        generatedAt,
        itemCount: index.length,
        merkleRoot: root,
        index,
        privilegeLog: withheld.map((i) => ({
          id: i.id,
          title: i.title,
          date: i.date,
          privilege: i.privilege ?? "none",
          reason: i.privilegeReason ?? null,
        })),
        statement:
          `${index.length} item(s) produced under Merkle root ${root}; ` +
          (withheld.length > 0
            ? `${withheld.length} item(s) withheld on grounds of privilege and listed in the privilege log. `
            : "nothing withheld. ") +
          `Each produced item's content is snapshotted at generation, so verification distinguishes ` +
          `tampering from an ordinary later change to the source record. Items are addressed by tab: ` +
          `page numbers are set by the printer, because the extent of an attached file is not ` +
          `something this platform holds.`,
      };

      await app.db.transaction(async (tx) => {
        await tx
          .update(disputeBundles)
          .set({
            items,
            manifest: manifest as unknown as Record<string, unknown>,
            status: "generated",
            updatedAt: generatedAt,
          })
          .where(eq(disputeBundles.id, bundleId));
        await tx.delete(bundleSnapshots).where(eq(bundleSnapshots.bundleId, bundleId));
        if (snapshots.length > 0) {
          await tx.insert(bundleSnapshots).values(
            snapshots.map((snap) => ({
              id: newId("bsn"),
              bundleId,
              companyId: req.companyId!,
              projectId: req.projectId!,
              itemId: snap.itemId,
              tab: snap.tab,
              kind: snap.kind,
              sha256: snap.sha256,
              snapshot: snap.snapshot,
            })),
          );
        }
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "dispute_bundle",
          objectId: bundleId,
          payload: { from: "draft", to: "generated", manifest },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return fetchBundle(bundleId, req.companyId!, req.projectId!);
    },
  );

  /**
   * Mark items privileged before generation (#340-342). A privileged item
   * stays in the working bundle — the team still needs to see it — but is
   * withheld from production and listed in the privilege log instead.
   */
  app.put(
    "/projects/:projectId/dispute-bundles/:bundleId/privilege",
    { preHandler: standardGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const body = privilegePutSchema.parse(req.body);
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      if (bundle.status !== "draft") {
        throw badRequest("Privilege can only be set while the bundle is draft");
      }
      const items = bundle.items as BundleItem[];
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const entry of body.entries) {
        const item = byId.get(entry.itemId);
        if (!item) throw badRequest(`Item ${entry.itemId} is not in this bundle`);
        if (entry.privilege !== "none" && !entry.reason) {
          throw badRequest(
            `Item ${entry.itemId} is marked privileged without a reason — a privilege log entry must say why`,
          );
        }
        item.privilege = entry.privilege;
        item.privilegeReason = entry.reason ?? null;
      }
      await app.db
        .update(disputeBundles)
        .set({ items, updatedAt: new Date().toISOString() })
        .where(eq(disputeBundles.id, bundleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { privilege: body.entries },
        storePayload: true,
        projectId: req.projectId!,
      });
      return fetchBundle(bundleId, req.companyId!, req.projectId!);
    },
  );

  /** Hyperlinked-index export (#343): the frozen manifest as CSV. */
  app.get(
    "/projects/:projectId/dispute-bundles/:bundleId/manifest.csv",
    { preHandler: readGate },
    async (req, reply) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      const manifest = bundle.manifest as BundleManifest | null;
      if (!manifest) throw badRequest("Bundle has not been generated yet");
      const lines = ["tab,title,date,source,sha256"];
      for (const e of manifest.index) {
        lines.push(
          [
            csvCell(e.tab),
            csvCell(e.title),
            csvCell(e.date),
            csvCell(e.source),
            csvCell(e.sha256),
          ].join(","),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="bundle-${bundle.id}-manifest.csv"`)
        .send(lines.join("\n") + "\n");
    },
  );

  /**
   * The produced bundle itself (#343): cover, hyperlinked index, one section
   * per item rendered FROM THE SNAPSHOT, and the privilege log — print-ready,
   * so the browser's "save as PDF" produces the served document. There is no
   * PDF writer in this runtime, so the platform renders the document rather
   * than claiming a PDF it cannot produce, and addresses items by tab rather
   * than printing page numbers it cannot know.
   */
  app.get(
    "/projects/:projectId/dispute-bundles/:bundleId/document.html",
    { preHandler: readGate },
    async (req, reply) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      const manifest = bundle.manifest as BundleManifest | null;
      if (!manifest) throw badRequest("Bundle has not been generated yet");
      const dispute = await fetchDispute(bundle.disputeId, req.companyId!, req.projectId!);
      const projectRow = (
        await app.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, req.projectId!))
          .limit(1)
      )[0];
      const snaps = await app.db
        .select()
        .from(bundleSnapshots)
        .where(eq(bundleSnapshots.bundleId, bundleId));
      const snapByTab = new Map(snaps.map((sn) => [sn.tab, sn]));
      const html = renderBundleDocumentHtml({
        bundleName: bundle.name,
        disputeReference: `Dispute #${dispute.number}`,
        disputeTitle: dispute.title,
        projectName: projectRow?.name ?? null,
        generatedAt: manifest.generatedAt,
        merkleRoot: manifest.merkleRoot,
        statement: manifest.statement ?? "",
        items: manifest.index.map((e) => {
          const snap = snapByTab.get(e.tab);
          return {
            tab: e.tab,
            title: e.title,
            date: e.date,
            source: e.source,
            sha256: e.sha256,
            kind: (snap?.kind as "record" | "file" | undefined) ?? null,
            snapshot: (snap?.snapshot as Record<string, unknown> | null) ?? null,
          };
        }),
        privilegeLog: (manifest.privilegeLog ?? []).map((p) => ({
          title: p.title,
          date: p.date,
          privilege: p.privilege,
          reason: p.reason,
        })),
      });
      return reply
        .type("text/html; charset=utf-8")
        .header("content-disposition", `inline; filename="bundle-${bundle.id}.html"`)
        .send(html);
    },
  );

  /**
   * Tamper-evidence check.
   *
   * Comparing today's content hash against the manifest cannot tell a forged
   * bundle from a legitimately-updated source record. With snapshots it can:
   * an item whose source has CHANGED is reported as `changed` with the
   * snapshot available for comparison; an item that no longer RESOLVES is
   * reported as `missing`; and the Merkle root still proves the manifest
   * itself has not been rewritten.
   */
  app.post(
    "/projects/:projectId/dispute-bundles/:bundleId/verify",
    { preHandler: readGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      const manifest = bundle.manifest as BundleManifest | null;
      if (!manifest) throw badRequest("Bundle has not been generated yet");
      const items = bundle.items as BundleItem[];
      const byTab = new Map(items.map((it) => [it.tab, it]));
      const snaps = await app.db
        .select()
        .from(bundleSnapshots)
        .where(eq(bundleSnapshots.bundleId, bundleId));
      const snapByTab = new Map(snaps.map((s) => [s.tab, s]));

      const findings: Array<{
        tab: string;
        title: string;
        state: "intact" | "changed" | "missing" | "unsnapshotted" | "manifest_rewritten";
        expected: string;
        actual: string | null;
        note: string;
      }> = [];
      for (const entry of manifest.index) {
        const item = byTab.get(entry.tab);
        const resolved = item ? await itemContent(item, req.companyId!, req.projectId!) : null;
        const snap = snapByTab.get(entry.tab);
        // FIRST: does the manifest still agree with the INDEPENDENT record?
        // Recomputing the Merkle root from the manifest's own index only
        // catches an index edited without recomputing the root. bundle_
        // snapshots was written in the generation transaction and is not
        // reachable from the manifest, so a coordinated rewrite of index +
        // root shows up here and nowhere else.
        if (snap && snap.sha256 !== entry.sha256) {
          findings.push({
            tab: entry.tab,
            title: entry.title,
            state: "manifest_rewritten",
            expected: snap.sha256,
            actual: entry.sha256,
            note:
              `The manifest now records ${entry.sha256} for this tab, but the snapshot written ` +
              `when the bundle was produced records ${snap.sha256}. The manifest has been rewritten ` +
              `since generation` +
              (resolved
                ? `; the source currently hashes to ${resolved.sha256}.`
                : `, and the source no longer resolves.`),
          });
          continue;
        }
        if (!resolved) {
          findings.push({
            tab: entry.tab,
            title: entry.title,
            state: "missing",
            expected: entry.sha256,
            actual: null,
            note: snap
              ? "The source no longer resolves, but the snapshot taken at generation is retained, so the produced content can still be reproduced."
              : "The source no longer resolves and no snapshot was taken; this item cannot be reproduced.",
          });
          continue;
        }
        if (resolved.sha256 === entry.sha256) {
          findings.push({
            tab: entry.tab,
            title: entry.title,
            state: "intact",
            expected: entry.sha256,
            actual: resolved.sha256,
            note: "The source is byte-for-byte what was produced.",
          });
          continue;
        }
        findings.push({
          tab: entry.tab,
          title: entry.title,
          state: snap ? "changed" : "unsnapshotted",
          expected: entry.sha256,
          actual: resolved.sha256,
          note: snap
            ? "The source record has changed since the bundle was produced. The snapshot holds what was served, so this is a lifecycle change and not necessarily tampering — compare the two."
            : "The source has changed and no snapshot was taken, so what was produced cannot be recovered.",
        });
      }

      const recomputedRoot = merkleRoot(manifest.index.map((e) => e.sha256));
      const rewritten = findings.filter((f) => f.state === "manifest_rewritten");
      // The manifest is intact only when it recomputes AND agrees with the
      // independent snapshot record. A rewrite of index+root passes the
      // first test and fails the second — which is the whole point of
      // keeping the snapshots outside the manifest.
      const manifestIntact = recomputedRoot === manifest.merkleRoot && rewritten.length === 0;
      const changed = findings.filter((f) => f.state === "changed" || f.state === "unsnapshotted");
      const missing = findings.filter((f) => f.state === "missing");
      const intact = manifestIntact && changed.length === 0 && missing.length === 0;
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: {
          verify: true,
          intact,
          manifestIntact,
          changed: changed.length,
          missing: missing.length,
          rewritten: rewritten.length,
        },
        projectId: req.projectId!,
      });
      return {
        intact,
        manifestIntact,
        merkleRoot: manifest.merkleRoot,
        recomputedRoot,
        itemCount: manifest.itemCount,
        snapshotCount: snaps.length,
        rewrittenCount: rewritten.length,
        findings,
        // kept for the existing UI: a plain mismatch list
        mismatches: [...rewritten, ...changed, ...missing].map((f) => ({
          tab: f.tab,
          title: f.title,
          expected: f.expected,
          actual: f.actual,
        })),
        statement: manifestIntact
          ? `The manifest's Merkle root recomputes to the value recorded at generation and every ` +
            `index entry matches the snapshot written when the bundle was produced, so the index ` +
            `itself has not been rewritten. ${changed.length} source record(s) have changed since ` +
            `production and ${missing.length} no longer resolve; the snapshots taken at generation ` +
            `hold what was actually served.`
          : rewritten.length > 0
            ? `${rewritten.length} index entr(y/ies) disagree with the snapshot written when the ` +
              `bundle was produced. The manifest has been rewritten since generation — the Merkle ` +
              `root ${recomputedRoot === manifest.merkleRoot ? "was recomputed to match, which is what a deliberate rewrite looks like" : "no longer recomputes either"} — and this bundle cannot be relied on.`
            : `The manifest's Merkle root does NOT recompute to the recorded value. The index has ` +
              `been altered since generation and this bundle cannot be relied on.`,
      };
    },
  );

  app.post(
    "/projects/:projectId/dispute-bundles/:bundleId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { bundleId } = req.params as { bundleId: string };
      const bundle = await fetchBundle(bundleId, req.companyId!, req.projectId!);
      if (bundle.status !== "generated") {
        throw badRequest(`Only a generated bundle can be issued (this bundle is ${bundle.status})`);
      }
      const now = new Date().toISOString();
      await app.db
        .update(disputeBundles)
        .set({ status: "issued", updatedAt: now })
        .where(eq(disputeBundles.id, bundleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { from: "generated", to: "issued" },
      });
      return fetchBundle(bundleId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Settlement offers (#350-352)                                      */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/disputes/:disputeId/offers",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = offerCreateSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      if (dispute.status === "settled" || dispute.status === "withdrawn") {
        throw badRequest(`A ${dispute.status} dispute cannot receive new offers`);
      }
      const id = newId("sof");
      await app.db.insert(settlementOffers).values({
        id,
        disputeId,
        companyId: req.companyId!,
        direction: body.direction,
        basis: body.basis,
        amount: body.amount,
        currency: body.currency ?? dispute.currency,
        terms: body.terms ?? null,
        offeredAt: body.offeredAt,
        expiresAt: body.expiresAt ?? null,
        status: "open",
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "settlement_offer",
        objectId: id,
        payload: {
          disputeId,
          direction: body.direction,
          basis: body.basis,
          amount: body.amount,
          currency: body.currency ?? dispute.currency,
          offeredAt: body.offeredAt,
        },
        storePayload: true,
      });
      const created = (
        await app.db.select().from(settlementOffers).where(eq(settlementOffers.id, id)).limit(1)
      )[0];
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/offers",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(settlementOffers)
        .where(
          and(
            eq(settlementOffers.disputeId, disputeId),
            eq(settlementOffers.companyId, req.companyId!),
          ),
        )
        .orderBy(asc(settlementOffers.offeredAt), asc(settlementOffers.createdAt));
      return { items, total: items.length };
    },
  );

  /**
   * Move an offer through its lifecycle (#350-352).
   *
   * Three holes closed:
   *  - An EXPIRED offer could still be accepted, settling the dispute at a
   *    price the counterparty had withdrawn months earlier. Expiry is now
   *    checked, and the offer is lapsed rather than accepted.
   *  - Accepting an offer left every SIBLING offer "open" on a dispute that
   *    had just settled, so the settlement analysis kept reporting a best
   *    open offer on a closed matter. Siblings are now lapsed with the
   *    acceptance.
   *  - Any offer on a TERMINAL dispute could still be rejected or lapsed by
   *    hand. Terminal means terminal.
   */
  app.post(
    "/projects/:projectId/settlement-offers/:offerId/status",
    { preHandler: standardGate },
    async (req) => {
      const { offerId } = req.params as { offerId: string };
      const body = offerStatusSchema.parse(req.body);
      const rows = await app.db
        .select()
        .from(settlementOffers)
        .where(and(eq(settlementOffers.id, offerId), eq(settlementOffers.companyId, req.companyId!)))
        .limit(1);
      const offer = rows[0];
      if (!offer) throw notFound("Settlement offer not found");
      const dispute = await fetchDispute(offer.disputeId, req.companyId!, req.projectId!);
      if (offer.status !== "open") {
        throw badRequest(`A ${offer.status} offer cannot change status`);
      }
      if (TERMINAL.includes(dispute.status as DisputeStatus)) {
        throw badRequest(
          `Offers on a ${dispute.status} dispute can no longer change status — the matter has ended`,
        );
      }
      const today = todayISO();
      if (offer.expiresAt && offer.expiresAt < today) {
        // Record the truth rather than the requested transition.
        await app.db
          .update(settlementOffers)
          .set({ status: "lapsed", updatedAt: new Date().toISOString() })
          .where(and(eq(settlementOffers.id, offerId), eq(settlementOffers.status, "open")));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "settlement_offer",
          objectId: offerId,
          payload: { from: "open", to: "lapsed", expiresAt: offer.expiresAt, requested: body.status },
          storePayload: true,
          projectId: req.projectId!,
        });
        throw conflict(
          `This offer expired on ${offer.expiresAt} and has been marked lapsed; it cannot be ` +
            `${body.status}. Ask the counterparty to re-offer if the price still stands.`,
        );
      }
      if (body.status === "accepted" && !ACTIVE.includes(dispute.status as DisputeStatus)) {
        throw badRequest(
          `Cannot accept an offer on a ${dispute.status} dispute — it is no longer live`,
        );
      }

      const now = new Date().toISOString();
      const steps = dispute.timetable as TimetableStep[];
      let closed: { resolved: number; to: string } = { resolved: 0, to: "" };

      await app.db.transaction(async (tx) => {
        await tx
          .update(settlementOffers)
          .set({ status: body.status, updatedAt: now })
          .where(and(eq(settlementOffers.id, offerId), eq(settlementOffers.status, "open")));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "settlement_offer",
          objectId: offerId,
          payload: { from: "open", to: body.status, disputeId: offer.disputeId },
          storePayload: true,
          projectId: req.projectId!,
        });

        if (body.status === "accepted") {
          // Acceptance settles the dispute (#350): status settled + outcome.
          const outcome = `Settled at ${offer.currency} ${offer.amount}`;
          await tx
            .update(disputes)
            .set({
              status: "settled",
              outcome,
              resolvedAt: now.slice(0, 10),
              amountAwarded: offer.amount,
              updatedAt: now,
            })
            .where(eq(disputes.id, dispute.id));
          // Every other open offer goes off the table with it.
          const lapsed = await tx
            .update(settlementOffers)
            .set({ status: "lapsed", updatedAt: now })
            .where(
              and(
                eq(settlementOffers.disputeId, dispute.id),
                eq(settlementOffers.companyId, req.companyId!),
                eq(settlementOffers.status, "open"),
              ),
            )
            .returning({ id: settlementOffers.id });
          closed = await closeTimetableObligations(tx as never, {
            companyId: req.companyId!,
            projectId: req.projectId!,
            actorId: req.user!.id,
            disputeId: dispute.id,
            steps,
            terminalStatus: "settled",
          });
          await appendLedger(tx as never, {
            companyId: req.companyId!,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "dispute",
            objectId: dispute.id,
            payload: {
              from: dispute.status,
              to: "settled",
              outcome,
              offerId,
              siblingOffersLapsed: lapsed.length,
              obligationsResolved: closed.resolved,
            },
            storePayload: true,
            projectId: req.projectId!,
          });
        }
      });
      const updated = (
        await app.db.select().from(settlementOffers).where(eq(settlementOffers.id, offerId)).limit(1)
      )[0];
      return { ...updated, obligationsResolved: closed.resolved };
    },
  );

  /** Expected-value settlement modelling (#352). */
  app.get(
    "/projects/:projectId/disputes/:disputeId/settlement-analysis",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const q = settlementAnalysisQuery.parse(req.query);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      await sweepExpiredOffers(app.db, req.companyId!, todayISO(), [disputeId]);
      const offers = await app.db
        .select()
        .from(settlementOffers)
        .where(
          and(
            eq(settlementOffers.disputeId, disputeId),
            eq(settlementOffers.companyId, req.companyId!),
          ),
        );
      // Expired offers and offers in another currency are excluded, and
      // the exclusions are reported: a USD 400,000 offer does not beat a
      // GBP 350,000 expected value, and an offer that lapsed three months
      // ago is not a price anybody is still offering.
      const analysis = analyseSettlement(
        {
          winProbability: q.winProbability,
          expectedAward: q.expectedAward ?? dispute.amountInDispute ?? 0,
          legalCosts: q.legalCosts,
        },
        offers.map(
          (o): OfferForAnalysis => ({
            id: o.id,
            direction: o.direction,
            status: o.status,
            amount: o.amount,
            currency: o.currency,
            basis: o.basis,
            offeredAt: o.offeredAt,
            expiresAt: o.expiresAt,
          }),
        ),
        { today: todayISO(), disputeCurrency: dispute.currency },
      );
      return { disputeId, currency: dispute.currency, ...analysis };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Statutory timetables (#322-333)                                   */
  /* ---------------------------------------------------------------- */

  /** The regime library, read-only: the statutes, with their authorities. */
  app.get("/disputes/regimes", { preHandler: companyReadGate }, async () => ({
    regimes: REGIMES,
    note:
      "These are the published statutory and contractual timetables, encoded as offsets from a " +
      "trigger date. They are not legal advice and they do not know your contract: a contract that " +
      "varies the statute is handled by editing the generated steps.",
  }));

  /**
   * Generate (or regenerate) a dispute's procedural timetable from its
   * regime. Existing steps that are already DONE are always kept — a
   * regeneration must not erase what has actually happened.
   */
  app.post(
    "/projects/:projectId/disputes/:disputeId/timetable/generate",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = timetableGenerateSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      if (TERMINAL.includes(dispute.status as DisputeStatus)) {
        throw badRequest(`A ${dispute.status} dispute's timetable can no longer be regenerated`);
      }
      const generated = generateTimetable(body.jurisdiction, body.triggerDate, body.holidays ?? []);
      if (!generated) throw badRequest(`Unknown dispute jurisdiction ${body.jurisdiction}`);
      const regime = regimeFor(body.jurisdiction)!;
      if (regime.kinds.length > 0 && !regime.kinds.includes(dispute.kind)) {
        throw badRequest(
          `${regime.label} applies to ${regime.kinds.join(" / ")} disputes; this one is a ${dispute.kind}. ` +
            `Record the timetable by hand if the contract adopts the regime anyway.`,
        );
      }

      const existing = dispute.timetable as TimetableStep[];
      const keptDone = existing.filter((s) => s.done);
      const keptOther = body.replace ? [] : existing.filter((s) => !s.done);
      const keptKeys = new Set(
        [...keptDone, ...keptOther].map((s) => s.key).filter((k): k is string => Boolean(k)),
      );

      const now = new Date().toISOString();
      const next: TimetableStep[] = [...keptDone, ...keptOther];
      await app.db.transaction(async (tx) => {
        // Steps being replaced release their open obligations.
        if (body.replace) {
          for (const s of existing) {
            if (s.done || !s.obligationId) continue;
            await tx
              .update(obligations)
              .set({ status: "waived" })
              .where(and(eq(obligations.id, s.obligationId), eq(obligations.status, "open")));
          }
        }
        for (const step of generated.steps) {
          if (keptKeys.has(step.key)) continue;
          const obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: step.authority,
            trigger: `Dispute #${dispute.number} procedural timetable: ${step.name}`,
            deadline: `${step.dueDate}T23:59:59Z`,
            warnDaysBefore: 3,
            evidenceRequirement: "Served submission / completed procedural step",
            status: "open",
            createdBy: req.user!.id,
          });
          next.push({
            id: newId("stp"),
            name: step.name,
            dueDate: step.dueDate,
            obligationId,
            done: false,
            doneAt: null,
            breachedAt: null,
            key: step.key,
            owner: step.owner,
            authority: step.authority,
            extendedDueDate: step.extendedDueDate,
          });
        }
        next.sort((a, b) => {
          const ad = a.dueDate ?? "9999-12-31";
          const bd = b.dueDate ?? "9999-12-31";
          return ad < bd ? -1 : ad > bd ? 1 : 0;
        });
        await tx
          .update(disputes)
          .set({
            timetable: next,
            jurisdiction: body.jurisdiction,
            triggerDate: body.triggerDate,
            updatedAt: now,
          })
          .where(eq(disputes.id, disputeId));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "dispute",
          objectId: disputeId,
          payload: {
            event: "timetable_generated",
            jurisdiction: body.jurisdiction,
            triggerDate: body.triggerDate,
            statute: generated.statute,
            steps: next.length,
            replaced: body.replace,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      return {
        ...(await fetchDispute(disputeId, req.companyId!, req.projectId!)),
        regime: {
          label: generated.label,
          statute: generated.statute,
          triggerName: generated.triggerName,
          weekendsOnly: generated.weekendsOnly,
          notes: generated.notes,
        },
      };
    },
  );

  /**
   * Assemble the adjudicator nomination request (#328). Document ASSEMBLY,
   * not drafting: every sentence is built from a recorded field, and what
   * is missing is named rather than invented.
   */
  app.get(
    "/projects/:projectId/disputes/:disputeId/nomination-request",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const projectRow = (
        await app.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, req.projectId!))
          .limit(1)
      )[0];
      // Both lookups are company-filtered as well as id-filtered. The ids
      // were validated against this company when the dispute was written,
      // but a query on a tenant table that trusts a stored id is one data
      // migration away from reading another tenant's row.
      const counterparty = dispute.counterpartyEntityId
        ? (
            await app.db
              .select({ name: entities.name })
              .from(entities)
              .where(
                and(
                  eq(entities.id, dispute.counterpartyEntityId),
                  eq(entities.companyId, req.companyId!),
                ),
              )
              .limit(1)
          )[0]
        : null;
      const contract = dispute.contractId
        ? (
            await app.db
              .select({ name: contracts.name, form: contracts.form })
              .from(contracts)
              .where(
                and(
                  eq(contracts.id, dispute.contractId),
                  eq(contracts.companyId, req.companyId!),
                  eq(contracts.projectId, req.projectId!),
                ),
              )
              .limit(1)
          )[0]
        : null;
      return buildNominationRequest({
        disputeNumber: dispute.number,
        disputeTitle: dispute.title,
        jurisdiction: dispute.jurisdiction ?? "custom",
        forum: dispute.forum,
        rules: dispute.rules,
        contractReference: contract?.name ?? null,
        contractFamily: dispute.contractFamily,
        projectName: projectRow?.name ?? "(project name not recorded)",
        referringParty: "The referring party (record it on the dispute before sending)",
        respondingParty: counterparty?.name ?? "(counterparty not recorded)",
        amountInDispute: dispute.amountInDispute,
        currency: dispute.currency,
        triggerDate: dispute.triggerDate,
        natureOfDispute: dispute.title,
        requestedAt: new Date().toISOString(),
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Outcome and enforcement (#333, #356-357)                          */
  /* ---------------------------------------------------------------- */

  app.patch(
    "/projects/:projectId/disputes/:disputeId/outcome",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = outcomeSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      if (Object.keys(set).length === 1) throw badRequest("Nothing to update");
      await app.db.update(disputes).set(set).where(eq(disputes.id, disputeId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "dispute",
        objectId: disputeId,
        payload: { outcomeFields: body, previousStatus: dispute.status },
        storePayload: true,
        projectId: req.projectId!,
      });
      return fetchDispute(disputeId, req.companyId!, req.projectId!);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Standing dispute board (#331-332)                                 */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/disputes/:disputeId/board-members",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = boardMemberSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const id = newId("dbm");
      await app.db.insert(disputeBoardMembers).values({
        id,
        disputeId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        name: body.name,
        boardRole: body.boardRole,
        nominatedBy: body.nominatedBy ?? null,
        appointedAt: body.appointedAt ?? null,
        independenceDisclosure: body.independenceDisclosure ?? null,
        conflictDeclared: body.conflictDeclared ? 1 : 0,
        feeBasis: body.feeBasis ?? null,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute_board_member",
        objectId: id,
        payload: {
          disputeId,
          name: body.name,
          boardRole: body.boardRole,
          conflictDeclared: Boolean(body.conflictDeclared),
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(disputeBoardMembers)
        .where(eq(disputeBoardMembers.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/board",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const members = await app.db
        .select()
        .from(disputeBoardMembers)
        .where(
          and(
            eq(disputeBoardMembers.disputeId, disputeId),
            eq(disputeBoardMembers.companyId, req.companyId!),
          ),
        )
        .orderBy(asc(disputeBoardMembers.boardRole), asc(disputeBoardMembers.name));
      const visits = await app.db
        .select()
        .from(disputeBoardVisits)
        .where(
          and(
            eq(disputeBoardVisits.disputeId, disputeId),
            eq(disputeBoardVisits.companyId, req.companyId!),
          ),
        )
        .orderBy(desc(disputeBoardVisits.visitDate));
      const warnings: string[] = [];
      const undisclosed = members.filter((m) => !m.independenceDisclosure);
      if (undisclosed.length > 0) {
        warnings.push(
          `${undisclosed.length} board member(s) have no independence disclosure on record. A board ` +
            `member with an undeclared connection to a party is a challengeable appointment.`,
        );
      }
      if (members.length > 0 && !members.some((m) => m.boardRole === "chair")) {
        warnings.push("No chair is recorded for this board.");
      }
      return { members, visits, warnings };
    },
  );

  app.post(
    "/projects/:projectId/disputes/:disputeId/board-visits",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = boardVisitSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      if (body.reportFileId) {
        await validateFileId(req.companyId!, req.projectId!, body.reportFileId);
      }
      const id = newId("dbv");
      await app.db.insert(disputeBoardVisits).values({
        id,
        disputeId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        visitDate: body.visitDate,
        attendees: body.attendees ?? [],
        summary: body.summary ?? null,
        recommendations: body.recommendations ?? null,
        reportFileId: body.reportFileId ?? null,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute_board_visit",
        objectId: id,
        payload: { disputeId, visitDate: body.visitDate },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(disputeBoardVisits)
        .where(eq(disputeBoardVisits.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Cost of recovery (#354)                                           */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/disputes/:disputeId/costs",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = costCreateSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const id = newId("dcs");
      await app.db.insert(disputeCosts).values({
        id,
        disputeId,
        companyId: req.companyId!,
        projectId: req.projectId!,
        category: body.category,
        supplier: body.supplier ?? null,
        description: body.description,
        incurredAt: body.incurredAt,
        budgetAmount: body.budgetAmount ?? null,
        actualAmount: body.actualAmount,
        currency: body.currency ?? dispute.currency,
        recoverable: body.recoverable ? 1 : 0,
        recordedBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "dispute_cost",
        objectId: id,
        payload: {
          disputeId,
          category: body.category,
          actualAmount: body.actualAmount,
          currency: body.currency ?? dispute.currency,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(disputeCosts)
        .where(eq(disputeCosts.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  /**
   * The cost of recovery, next to the recovery (#354). Money is bucketed by
   * currency and never summed across them; a claim worth 200k pursued for
   * 260k of fees is a loss, and nothing else on the platform can say so.
   */
  app.get(
    "/projects/:projectId/disputes/:disputeId/costs",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const items = await app.db
        .select()
        .from(disputeCosts)
        .where(
          and(eq(disputeCosts.disputeId, disputeId), eq(disputeCosts.companyId, req.companyId!)),
        )
        .orderBy(asc(disputeCosts.incurredAt), asc(disputeCosts.createdAt));
      const currencies = [...new Set(items.map((c) => c.currency))].sort();
      const byCurrency = currencies.map((currency) => {
        const rows = items.filter((c) => c.currency === currency);
        const actual = round2(rows.reduce((sum, c) => sum + c.actualAmount, 0));
        const budgeted = rows.some((c) => c.budgetAmount !== null)
          ? round2(rows.reduce((sum, c) => sum + (c.budgetAmount ?? 0), 0))
          : null;
        return {
          currency,
          actual,
          budgeted,
          variance: budgeted === null ? null : round2(actual - budgeted),
          recoverable: round2(
            rows.filter((c) => c.recoverable === 1).reduce((sum, c) => sum + c.actualAmount, 0),
          ),
        };
      });
      const byCategory = [...new Set(items.map((c) => c.category))].sort().map((category) => ({
        category,
        byCurrency: [...new Set(items.filter((c) => c.category === category).map((c) => c.currency))]
          .sort()
          .map((currency) => ({
            currency,
            actual: round2(
              items
                .filter((c) => c.category === category && c.currency === currency)
                .reduce((sum, c) => sum + c.actualAmount, 0),
            ),
          })),
      }));
      const inDisputeCurrency = byCurrency.find((b) => b.currency === dispute.currency) ?? null;
      const costOfRecovery =
        inDisputeCurrency === null || dispute.amountAwarded === null || dispute.amountAwarded <= 0
          ? {
              ratio: null,
              reason:
                dispute.amountAwarded === null
                  ? "No award has been recorded on this dispute, so the cost of recovery cannot be expressed as a ratio."
                  : dispute.amountAwarded <= 0
                    ? "Nothing was recovered, so every unit of cost is unrecovered."
                    : `No costs are recorded in the dispute's own currency (${dispute.currency}); costs in other currencies are not converted.`,
            }
          : {
              ratio: round4(inDisputeCurrency.actual / dispute.amountAwarded),
              reason: null,
            };
      return {
        items,
        total: items.length,
        byCurrency,
        byCategory,
        awarded: dispute.amountAwarded,
        currency: dispute.currency,
        costOfRecovery,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Decision-tree settlement modelling (#351-355)                     */
  /* ---------------------------------------------------------------- */

  async function loadOffersForAnalysis(
    disputeId: string,
    companyId: string,
  ): Promise<OfferForAnalysis[]> {
    const rows = await app.db
      .select()
      .from(settlementOffers)
      .where(
        and(eq(settlementOffers.disputeId, disputeId), eq(settlementOffers.companyId, companyId)),
      );
    return rows.map((o) => ({
      id: o.id,
      direction: o.direction,
      status: o.status,
      amount: o.amount,
      currency: o.currency,
      basis: o.basis,
      offeredAt: o.offeredAt,
      expiresAt: o.expiresAt,
    }));
  }

  app.put(
    "/projects/:projectId/disputes/:disputeId/settlement-model",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = settlementModelSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const currency = body.currency ?? dispute.currency;
      const branches: TreeBranch[] = body.branches.map((b) => ({
        id: b.id ?? newId("brh"),
        kind: b.kind,
        label: b.label,
        probability: b.probability,
        award: b.award,
      }));
      const stages: TreeStage[] = body.stages.map((st) => ({
        id: st.id ?? newId("stg"),
        name: st.name,
        ownCosts: st.ownCosts,
        opponentCosts: st.opponentCosts,
      }));
      const costsRules: CostsRules | null = body.costsRules
        ? {
            enabled: body.costsRules.enabled,
            indemnityCostsPercent: body.costsRules.indemnityCostsPercent,
            enhancedInterestPercent: body.costsRules.enhancedInterestPercent,
            ownOfferAmount: body.costsRules.ownOfferAmount,
          }
        : null;
      const offers = await loadOffersForAnalysis(disputeId, req.companyId!);
      const computed = evaluateDecisionTree(
        {
          branches,
          stages,
          discountRatePercent: body.discountRatePercent,
          yearsToResolution: body.yearsToResolution,
          costsRules,
          currency,
        },
        offers,
        { today: todayISO(), disputeCurrency: dispute.currency },
      );
      const provision = litigationProvision(computed);

      const existing = await app.db
        .select({ id: settlementModels.id })
        .from(settlementModels)
        .where(
          and(
            eq(settlementModels.disputeId, disputeId),
            eq(settlementModels.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const id = existing[0]?.id ?? newId("smd");
      const values = {
        name: body.name,
        currency,
        branches: branches as unknown as unknown[],
        stages: stages as unknown as unknown[],
        discountRatePercent: body.discountRatePercent,
        yearsToResolution: body.yearsToResolution,
        costsRules: costsRules as unknown as Record<string, unknown> | null,
        computed: { ...computed, provision } as unknown as Record<string, unknown>,
        updatedAt: new Date().toISOString(),
      };
      if (existing[0]) {
        await app.db.update(settlementModels).set(values).where(eq(settlementModels.id, id));
      } else {
        await app.db.insert(settlementModels).values({
          id,
          disputeId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          createdBy: req.user!.id,
          ...values,
        });
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: existing[0] ? "update" : "create",
        objectType: "settlement_model",
        objectId: id,
        payload: {
          disputeId,
          branches: branches.length,
          expectedValue: computed.expectedValue,
          valid: computed.valid,
          provision: provision.provision,
        },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(settlementModels)
        .where(eq(settlementModels.id, id))
        .limit(1);
      return row;
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/settlement-model",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      await sweepExpiredOffers(app.db, req.companyId!, todayISO(), [disputeId]);
      const rows = await app.db
        .select()
        .from(settlementModels)
        .where(
          and(
            eq(settlementModels.disputeId, disputeId),
            eq(settlementModels.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const model = rows[0];
      if (!model) {
        return {
          model: null,
          reason:
            "No decision tree has been built for this dispute. The single-probability view is " +
            "available on the settlement-analysis endpoint in the meantime.",
        };
      }
      // Recompute against today's offers: the stored `computed` block is a
      // snapshot of the last write, and offers move.
      const offers = await loadOffersForAnalysis(disputeId, req.companyId!);
      const computed = evaluateDecisionTree(
        {
          branches: model.branches as TreeBranch[],
          stages: model.stages as TreeStage[],
          discountRatePercent: model.discountRatePercent,
          yearsToResolution: model.yearsToResolution,
          costsRules: (model.costsRules ?? null) as CostsRules | null,
          currency: model.currency,
        },
        offers,
        { today: todayISO(), disputeCurrency: dispute.currency },
      );
      return { model, computed, provision: litigationProvision(computed) };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Outcome analytics (#356-357) — company-level                       */
  /* ---------------------------------------------------------------- */

  async function outcomeRows(
    companyId: string,
    scope: string[] | null,
    projectId?: string,
  ): Promise<DisputeOutcomeRow[]> {
    // The caller's visible scope is ALWAYS applied. A `projectId` filter
    // narrows within that scope — it never widens it: asking for a project
    // the caller holds no disputes access on must return nothing, not that
    // project's outcome database.
    const clauses = [eq(disputes.companyId, companyId)];
    if (scope !== null) clauses.push(inArray(disputes.projectId, scope));
    if (projectId) clauses.push(eq(disputes.projectId, projectId));
    const rows = await app.db
      .select()
      .from(disputes)
      .where(and(...clauses));
    if (rows.length === 0) return [];
    const costs = await app.db
      .select()
      .from(disputeCosts)
      .where(
        inArray(
          disputeCosts.disputeId,
          rows.map((d) => d.id),
        ),
      );
    return rows.map((d) => {
      // Only costs in the dispute's own currency roll into its own-cost
      // figure — mixing currencies would fabricate a number.
      const own = costs.filter((c) => c.disputeId === d.id && c.currency === d.currency);
      return {
        id: d.id,
        projectId: d.projectId,
        number: d.number,
        title: d.title,
        kind: d.kind,
        forum: d.forum,
        status: d.status,
        jurisdiction: d.jurisdiction,
        contractFamily: d.contractFamily,
        governingClause: d.governingClause,
        rootCause: d.rootCause,
        currency: d.currency,
        amountClaimed: d.amountClaimed ?? d.amountInDispute,
        amountAwarded: d.amountAwarded,
        costsAwarded: d.costsAwarded,
        notifiedAt: d.createdAt.slice(0, 10),
        resolvedAt: d.resolvedAt,
        ownCosts:
          own.length === 0 ? null : round2(own.reduce((sum, c) => sum + c.actualAmount, 0)),
      };
    });
  }

  app.get("/disputes/analytics", { preHandler: companyReadGate }, async (req) => {
    const q = analyticsQuery.parse(req.query);
    const scope = await visibleProjectIds(app, req, "disputes");
    if (scope !== null && scope.length === 0) {
      return {
        overall: null,
        groups: [],
        reason: "You do not hold disputes access on any project in this company.",
      };
    }
    const rows = await outcomeRows(req.companyId!, scope, q.projectId);
    return { ...outcomeAnalytics(rows, q.groupBy as GroupBy), scoped: scope !== null };
  });

  /**
   * What the outcome database says the contract should have said (#357).
   * Every recommendation cites the disputes behind it, so nothing here is
   * asserted that cannot be clicked through to.
   */
  app.get("/disputes/drafting-recommendations", { preHandler: companyReadGate }, async (req) => {
    const scope = await visibleProjectIds(app, req, "disputes");
    if (scope !== null && scope.length === 0) {
      return { recommendations: [], reason: "You do not hold disputes access on any project." };
    }
    const rows = await outcomeRows(req.companyId!, scope);
    const recommendations = draftingRecommendations(rows);
    return {
      recommendations,
      disputesConsidered: rows.length,
      reason:
        recommendations.length === 0
          ? "Not enough terminal disputes carry a governing clause or a root cause to draw a pattern from yet."
          : null,
      scoped: scope !== null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Health inputs (contract 3.5)                                      */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* Redfern schedule — document production (#340-343)                  */
  /* ---------------------------------------------------------------- */

  /**
   * The Redfern schedule is the four-column table a tribunal expects for
   * document production: what is asked for, why it is relevant and
   * material, the objection, and the ruling. It is kept as records rather
   * than a spreadsheet so the ruling has a date, an author and a ledger
   * entry, and so a granted request with a production date lands on the
   * obligation register like every other deadline the platform tracks.
   *
   * Deliberately not modelled: automatic production. Granting a request
   * tells a human which documents to add to the bundle; the platform will
   * not decide on its own which files answer a category request.
   */
  app.post(
    "/projects/:projectId/disputes/:disputeId/production-requests",
    { preHandler: standardGate },
    async (req, reply) => {
      const { disputeId } = req.params as { disputeId: string };
      const body = productionRequestSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      if (!ACTIVE.includes(dispute.status as DisputeStatus)) {
        throw badRequest(
          `Document production belongs to a live reference; dispute #${dispute.number} is ${dispute.status}`,
        );
      }
      const id = newId("dpr");
      // Numbering is per dispute and must not collide: the dispute row is
      // locked so two clerks filing requests at once get 3 and 4, not two 3s.
      await app.db.transaction(async (tx) => {
        const locked = (
          await tx.select().from(disputes).where(eq(disputes.id, disputeId)).for("update")
        )[0];
        if (!locked) throw notFound("Dispute not found");
        const [maxRow] = await tx
          .select({ n: sql<number>`coalesce(max(${documentProductionRequests.number}), 0)` })
          .from(documentProductionRequests)
          .where(eq(documentProductionRequests.disputeId, disputeId));
        const next = Number(maxRow?.n ?? 0) + 1;
        await tx.insert(documentProductionRequests).values({
          id,
          disputeId,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number: next,
          requestingParty: body.requestingParty,
          documentsRequested: body.documentsRequested,
          relevance: body.relevance,
          productionDueDate: body.productionDueDate ?? null,
          createdBy: req.user!.id,
        });
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "create",
          objectType: "document_production_request",
          objectId: id,
          payload: {
            disputeId,
            number: next,
            requestingParty: body.requestingParty,
            documentsRequested: body.documentsRequested,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      const [row] = await app.db
        .select()
        .from(documentProductionRequests)
        .where(eq(documentProductionRequests.id, id))
        .limit(1);
      return reply.status(201).send(row);
    },
  );

  app.get(
    "/projects/:projectId/disputes/:disputeId/production-requests",
    { preHandler: readGate },
    async (req) => {
      const { disputeId } = req.params as { disputeId: string };
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(documentProductionRequests)
        .where(
          and(
            eq(documentProductionRequests.disputeId, disputeId),
            eq(documentProductionRequests.companyId, req.companyId!),
            eq(documentProductionRequests.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(documentProductionRequests.number));
      const outstanding = rows.filter(
        (r) => r.decision === "granted" || r.decision === "granted_in_part",
      ).filter((r) => r.producedFileIds.length === 0);
      return {
        items: rows,
        summary: {
          total: rows.length,
          pending: rows.filter((r) => r.decision === "pending").length,
          granted: rows.filter((r) => r.decision === "granted").length,
          grantedInPart: rows.filter((r) => r.decision === "granted_in_part").length,
          refused: rows.filter((r) => r.decision === "refused").length,
          withdrawn: rows.filter((r) => r.decision === "withdrawn").length,
          objected: rows.filter((r) => r.objection !== null).length,
          awaitingProduction: outstanding.length,
        },
      };
    },
  );

  /**
   * The objecting party's column, and the requesting party's reply to it.
   * Kept separate from the ruling: whoever objects is not whoever decides.
   */
  app.patch(
    "/projects/:projectId/disputes/:disputeId/production-requests/:requestId",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId, requestId } = req.params as { disputeId: string; requestId: string };
      const body = productionRequestPatchSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const existing = (
        await app.db
          .select()
          .from(documentProductionRequests)
          .where(
            and(
              eq(documentProductionRequests.id, requestId),
              eq(documentProductionRequests.disputeId, disputeId),
              eq(documentProductionRequests.companyId, req.companyId!),
              eq(documentProductionRequests.projectId, req.projectId!),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw notFound("Document production request not found");
      if (existing.decision !== "pending") {
        throw conflict(
          `Request ${existing.number} has been ruled on (${existing.decision}); the schedule is closed for edits`,
        );
      }
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = v;
      if (Object.keys(set).length === 1) throw badRequest("Nothing to update");
      await app.db
        .update(documentProductionRequests)
        .set(set)
        .where(eq(documentProductionRequests.id, requestId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "document_production_request",
        objectId: requestId,
        payload: { changed: Object.keys(body) },
        storePayload: true,
        projectId: req.projectId!,
      });
      const [row] = await app.db
        .select()
        .from(documentProductionRequests)
        .where(eq(documentProductionRequests.id, requestId))
        .limit(1);
      return row;
    },
  );

  /**
   * The ruling. A grant with a production date raises an obligation so the
   * production deadline is on the same register as every other deadline;
   * a refusal or a withdrawal closes the row without one.
   */
  app.post(
    "/projects/:projectId/disputes/:disputeId/production-requests/:requestId/decide",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId, requestId } = req.params as { disputeId: string; requestId: string };
      const body = productionDecisionSchema.parse(req.body);
      const dispute = await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const existing = (
        await app.db
          .select()
          .from(documentProductionRequests)
          .where(
            and(
              eq(documentProductionRequests.id, requestId),
              eq(documentProductionRequests.disputeId, disputeId),
              eq(documentProductionRequests.companyId, req.companyId!),
              eq(documentProductionRequests.projectId, req.projectId!),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw notFound("Document production request not found");
      if (existing.decision !== "pending") {
        throw conflict(`Request ${existing.number} has already been ruled ${existing.decision}`);
      }
      const grants = body.decision === "granted" || body.decision === "granted_in_part";
      const dueDate = body.productionDueDate ?? existing.productionDueDate;
      if (grants && !dueDate) {
        throw badRequest(
          "A granted production request needs a production date — a direction without a deadline is not enforceable",
        );
      }
      const decidedAt = todayISO();
      await app.db.transaction(async (tx) => {
        let obligationId: string | null = existing.obligationId;
        if (grants && dueDate && !obligationId) {
          obligationId = newId("obl");
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `${dispute.kind} — document production request ${existing.number}`,
            trigger: `Dispute #${dispute.number}: produce documents ordered on ${decidedAt}`,
            deadline: `${dueDate}T23:59:59Z`,
            warnDaysBefore: 3,
            evidenceRequirement: existing.documentsRequested.slice(0, 500),
            status: "open",
            createdBy: req.user!.id,
          });
        }
        if (!grants && existing.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "waived" })
            .where(
              and(eq(obligations.id, existing.obligationId), eq(obligations.status, "open")),
            );
        }
        await tx
          .update(documentProductionRequests)
          .set({
            decision: body.decision,
            decisionNote: body.decisionNote ?? null,
            decidedAt,
            decidedBy: req.user!.id,
            productionDueDate: grants ? dueDate : existing.productionDueDate,
            obligationId,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(documentProductionRequests.id, requestId));
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "document_production_request",
          objectId: requestId,
          payload: {
            from: "pending",
            to: body.decision,
            productionDueDate: grants ? dueDate : null,
            obligationId,
            note: body.decisionNote ?? null,
          },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      const [row] = await app.db
        .select()
        .from(documentProductionRequests)
        .where(eq(documentProductionRequests.id, requestId))
        .limit(1);
      return row;
    },
  );

  /** Record which files answered a granted request, satisfying its obligation. */
  app.post(
    "/projects/:projectId/disputes/:disputeId/production-requests/:requestId/produce",
    { preHandler: standardGate },
    async (req) => {
      const { disputeId, requestId } = req.params as { disputeId: string; requestId: string };
      const body = productionProduceSchema.parse(req.body);
      await fetchDispute(disputeId, req.companyId!, req.projectId!);
      const existing = (
        await app.db
          .select()
          .from(documentProductionRequests)
          .where(
            and(
              eq(documentProductionRequests.id, requestId),
              eq(documentProductionRequests.disputeId, disputeId),
              eq(documentProductionRequests.companyId, req.companyId!),
              eq(documentProductionRequests.projectId, req.projectId!),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw notFound("Document production request not found");
      if (existing.decision !== "granted" && existing.decision !== "granted_in_part") {
        throw badRequest(
          `Only a granted request can be answered with documents (request ${existing.number} is ${existing.decision})`,
        );
      }
      for (const fileId of body.fileIds) {
        await validateFileId(req.companyId!, req.projectId!, fileId);
      }
      const merged = [...new Set([...existing.producedFileIds, ...body.fileIds])];
      await app.db.transaction(async (tx) => {
        await tx
          .update(documentProductionRequests)
          .set({ producedFileIds: merged, updatedAt: new Date().toISOString() })
          .where(eq(documentProductionRequests.id, requestId));
        if (existing.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "satisfied" })
            .where(
              and(eq(obligations.id, existing.obligationId), eq(obligations.status, "open")),
            );
        }
        await appendLedger(tx as never, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "update",
          objectType: "document_production_request",
          objectId: requestId,
          payload: { producedFileIds: merged, obligationId: existing.obligationId },
          storePayload: true,
          projectId: req.projectId!,
        });
      });
      const [row] = await app.db
        .select()
        .from(documentProductionRequests)
        .where(eq(documentProductionRequests.id, requestId))
        .limit(1);
      return row;
    },
  );

  app.get("/projects/:projectId/disputes/health-inputs", { preHandler: readGate }, async (req) => {
    const companyId = req.companyId!;
    const projectId = req.projectId!;
    const today = todayISO();
    await sweepMissedDeadlines(companyId, projectId);
    await sweepExpiredOffers(app.db, companyId, today);
    const rows = await app.db
      .select()
      .from(disputes)
      .where(and(eq(disputes.companyId, companyId), eq(disputes.projectId, projectId)));
    const reasons: string[] = [];
    if (rows.length === 0) reasons.push("No disputes are recorded on this project.");
    const live = rows.filter((d) => ACTIVE.includes(d.status as DisputeStatus));
    let missedDeadlines = 0;
    let nextDeadline: string | null = null;
    for (const d of live) {
      for (const s of d.timetable as TimetableStep[]) {
        if (s.breachedAt) missedDeadlines += 1;
        if (!s.done && s.dueDate && (nextDeadline === null || s.dueDate < nextDeadline)) {
          nextDeadline = s.dueDate;
        }
      }
    }
    const costs = rows.length
      ? await app.db
          .select()
          .from(disputeCosts)
          .where(
            inArray(
              disputeCosts.disputeId,
              rows.map((d) => d.id),
            ),
          )
      : [];
    const productionRows = rows.length
      ? await app.db
          .select({
            decision: documentProductionRequests.decision,
            producedFileIds: documentProductionRequests.producedFileIds,
          })
          .from(documentProductionRequests)
          .where(
            and(
              eq(documentProductionRequests.companyId, companyId),
              eq(documentProductionRequests.projectId, projectId),
            ),
          )
      : [];
    const currencies = new Set(rows.map((d) => d.currency));
    let amountInDisputeTotal: number | null = null;
    if (currencies.size > 1) {
      reasons.push(
        `Live disputes span ${[...currencies].join(", ")}; a single amount-in-dispute total would require an exchange rate this platform does not hold.`,
      );
    } else if (live.length > 0) {
      const quantified = live.filter((d) => d.amountInDispute !== null);
      amountInDisputeTotal =
        quantified.length > 0
          ? round2(quantified.reduce((sum, d) => sum + (d.amountInDispute ?? 0), 0))
          : null;
      if (amountInDisputeTotal === null) {
        reasons.push("No live dispute carries a quantified amount in dispute.");
      }
    }
    return {
      metrics: {
        totalDisputes: rows.length,
        liveDisputes: live.length,
        adjudications: live.filter((d) => d.kind === "adjudication").length,
        missedDeadlines,
        daysToNextDeadline:
          nextDeadline === null
            ? null
            : Math.round(
                (Date.parse(`${nextDeadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
                  86_400_000,
              ),
        amountInDisputeTotal,
        awaitingCompliance: rows.filter((d) => d.enforcementStatus === "awaiting_compliance").length,
        costsRecorded: costs.length,
        /* granted document production still outstanding — an unanswered
           tribunal direction is an adverse-inference risk, not a chore */
        productionOutstanding: productionRows.filter(
          (p) =>
            (p.decision === "granted" || p.decision === "granted_in_part") &&
            p.producedFileIds.length === 0,
        ).length,
      },
      reasons,
    };
  });
};

// re-export for colocated tests and the web layer
export { analyseSettlement } from "./settlement.js";
