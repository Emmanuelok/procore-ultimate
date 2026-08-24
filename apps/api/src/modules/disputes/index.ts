import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  contractEvents,
  contracts,
  delayEvents,
  disputeBundles,
  disputeSubmissions,
  disputes,
  entities,
  evidence,
  files,
  forensicClaims,
  obligations,
  rfis,
  settlementOffers,
  signals,
} from "@constructos/db";
import {
  DISPUTE_KINDS,
  DISPUTE_STATUSES,
  SETTLEMENT_OFFER_BASES,
  SUBMISSION_KINDS,
  type DisputeStatus,
} from "@constructos/shared";
import { hashPayload, merkleRoot } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import { analyseSettlement, type OfferForAnalysis } from "./settlement.js";

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
  /** set once by the lazy missed-deadline sweep (idempotency marker) */
  breachedAt: string | null;
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
  currency: z.string().length(3).optional(),
  timetable: z.array(timetableStepCreateSchema).max(100).optional(),
});

const disputePatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  forum: z.string().max(300).nullable().optional(),
  rules: z.string().max(300).nullable().optional(),
  amountInDispute: z.number().nonnegative().nullable().optional(),
  currency: z.string().length(3).optional(),
  timetable: z.array(timetableStepPatchSchema).max(100).optional(),
});

const disputeListQuery = pageQuerySchema.extend({
  kind: z.enum(DISPUTE_KINDS).optional(),
  status: z.enum(DISPUTE_STATUSES).optional(),
});

const statusChangeSchema = z.object({
  status: z.enum(DISPUTE_STATUSES),
  outcome: z.string().max(4000).optional(),
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
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("disputes", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("disputes", "standard"),
  ];

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

  async function validateFileId(companyId: string, fileId: string): Promise<void> {
    const rows = await app.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.companyId, companyId)))
      .limit(1);
    if (!rows[0]) throw badRequest("fileId does not belong to this company");
  }

  /**
   * The adjudication/arbitration timetable engine (#330, #338): every dated
   * step materializes as an assurance Obligation so the dispute clock and
   * the obligation register agree on the deadline.
   */
  async function materializeStepObligation(
    companyId: string,
    projectId: string,
    actorId: string,
    dispute: { kind: string; number: number },
    step: { name: string; dueDate: string },
  ): Promise<string> {
    const id = newId("obl");
    await app.db.insert(obligations).values({
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
   * Lazy missed-deadline sweep (#338, payments-module pattern): a timetable
   * step past its due date and not done breaches its obligation and raises
   * a high signal — exactly once, guarded by the step's breachedAt marker.
   */
  async function sweepMissedDeadlines(
    companyId: string,
    projectId: string,
    actorId: string,
  ): Promise<void> {
    const today = todayISO();
    const rows = await app.db
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.companyId, companyId),
          eq(disputes.projectId, projectId),
          inArray(disputes.status, ACTIVE),
        ),
      );
    for (const d of rows) {
      const steps = d.timetable as TimetableStep[];
      const overdue = steps.filter(
        (s) => s.dueDate !== null && !s.done && !s.breachedAt && s.dueDate < today,
      );
      if (overdue.length === 0) continue;
      const now = new Date().toISOString();
      for (const step of overdue) {
        step.breachedAt = now;
        if (step.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
        }
        await app.db.insert(signals).values({
          id: newId("sig"),
          companyId,
          projectId,
          detector: "dispute_deadline_missed",
          severity: "high",
          confidence: 1,
          title: `Dispute timetable deadline missed — ${step.name} (dispute #${d.number})`,
          explanation:
            `Procedural timetable step "${step.name}" of ${d.kind} dispute #${d.number} ` +
            `("${d.title}") was due on ${step.dueDate} and has not been completed. Missing a ` +
            `procedural deadline can be fatal in adjudication and arbitration: the tribunal may ` +
            `disregard late submissions or draw adverse inferences.`,
        });
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "dispute_timetable_step",
          objectId: step.id,
          payload: {
            disputeId: d.id,
            step: step.name,
            dueDate: step.dueDate,
            status: "breached",
            obligationId: step.obligationId,
          },
        });
      }
      await app.db.update(disputes).set({ timetable: steps }).where(eq(disputes.id, d.id));
    }
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
   * Content hash for a bundle item. File-backed items reuse the files row's
   * sha256 — storage is content-addressed, so that IS the content hash.
   * Record-backed items hash the record's canonical JSON. Returns null when
   * the underlying file/record no longer exists.
   */
  async function itemContentHash(
    item: { fileId: string | null; recordType: string | null; recordId: string | null },
    companyId: string,
    projectId: string,
  ): Promise<string | null> {
    if (item.fileId) {
      const rows = await app.db
        .select({ sha256: files.sha256 })
        .from(files)
        .where(and(eq(files.id, item.fileId), eq(files.companyId, companyId)))
        .limit(1);
      return rows[0]?.sha256 ?? null;
    }
    if (item.recordType && item.recordId) {
      const resolved = await resolveRecord(item.recordType, item.recordId, companyId, projectId);
      return resolved ? hashPayload(resolved.row) : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Dispute register (#321, #329, #334-337)                           */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/disputes", { preHandler: standardGate }, async (req, reply) => {
    const body = disputeCreateSchema.parse(req.body);
    await validateLinks(req.companyId!, req.projectId!, body);
    const number = await nextRecordNumber(app.db, req.projectId!, "dispute");
    const id = newId("dsp");

    const steps: TimetableStep[] = [];
    for (const s of body.timetable ?? []) {
      const stepId = newId("stp");
      let obligationId: string | null = null;
      if (s.dueDate) {
        obligationId = await materializeStepObligation(
          req.companyId!,
          req.projectId!,
          req.user!.id,
          { kind: body.kind, number },
          { name: s.name, dueDate: s.dueDate },
        );
      }
      steps.push({
        id: stepId,
        name: s.name,
        dueDate: s.dueDate ?? null,
        obligationId,
        done: false,
        doneAt: null,
        breachedAt: null,
      });
    }

    await app.db.insert(disputes).values({
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
      currency: body.currency ?? "GBP",
      status: "notified",
      timetable: steps,
      createdBy: req.user!.id,
    });
    await appendLedger(app.db, {
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
        amountInDispute: body.amountInDispute ?? null,
        currency: body.currency ?? "GBP",
        timetable: steps.map((s) => ({ id: s.id, name: s.name, dueDate: s.dueDate })),
      },
      storePayload: true,
    });
    const created = await fetchDispute(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/disputes", { preHandler: readGate }, async (req) => {
    const q = disputeListQuery.parse(req.query);
    await sweepMissedDeadlines(req.companyId!, req.projectId!, req.user!.id);
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
    await sweepMissedDeadlines(req.companyId!, req.projectId!, req.user!.id);
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
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) set["title"] = body.title;
    if (body.forum !== undefined) set["forum"] = body.forum;
    if (body.rules !== undefined) set["rules"] = body.rules;
    if (body.amountInDispute !== undefined) set["amountInDispute"] = body.amountInDispute;
    if (body.currency !== undefined) set["currency"] = body.currency;

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
            );
          } else if (dueDate && prior.obligationId && dueDate !== prior.dueDate) {
            await app.db
              .update(obligations)
              .set({ deadline: `${dueDate}T23:59:59Z` })
              .where(and(eq(obligations.id, prior.obligationId), eq(obligations.status, "open")));
          } else if (!dueDate && prior.obligationId) {
            await app.db
              .update(obligations)
              .set({ status: "waived" })
              .where(and(eq(obligations.id, prior.obligationId), eq(obligations.status, "open")));
            obligationId = null;
          }
          next.push({ ...prior, name: s.name, dueDate: dueDate ?? null, obligationId });
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
          await app.db
            .update(obligations)
            .set({ status: "waived" })
            .where(and(eq(obligations.id, prior.obligationId), eq(obligations.status, "open")));
        }
      }
      set["timetable"] = next;
    }

    await app.db.update(disputes).set(set).where(eq(disputes.id, disputeId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "dispute",
      objectId: disputeId,
      payload: { changed: Object.keys(body) },
    });
    return fetchDispute(disputeId, req.companyId!, req.projectId!);
  });

  /* ---------------------------------------------------------------- */
  /* Status transitions (#325-333, #349)                               */
  /* ---------------------------------------------------------------- */

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
      const set: Record<string, unknown> = { status: to, updatedAt: now };
      if (body.outcome?.trim()) set["outcome"] = body.outcome.trim();
      if (to === "decided") set["decidedAt"] = now;
      await app.db.update(disputes).set(set).where(eq(disputes.id, disputeId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "dispute",
        objectId: disputeId,
        payload: { from, to, outcome: body.outcome ?? null },
        storePayload: true,
      });
      return fetchDispute(disputeId, req.companyId!, req.projectId!);
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
      if (step.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: "satisfied" })
          .where(and(eq(obligations.id, step.obligationId), eq(obligations.status, "open")));
      }
      await app.db
        .update(disputes)
        .set({ timetable: steps, updatedAt: now })
        .where(eq(disputes.id, disputeId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "dispute_timetable_step",
        objectId: stepId,
        payload: { disputeId, step: step.name, status: "done", obligationId: step.obligationId },
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
      if (body.fileId) await validateFileId(req.companyId!, body.fileId);
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
          const fileRows = await app.db
            .select({ id: files.id, name: files.name })
            .from(files)
            .where(and(eq(files.id, raw.fileId), eq(files.companyId, req.companyId!)))
            .limit(1);
          if (!fileRows[0]) {
            throw badRequest(`Item ${i + 1}: fileId does not belong to this company`);
          }
          if (!title) title = fileRows[0].name;
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
        items.push({
          id: newId("bit"),
          tab: null,
          title: title ?? "Untitled",
          date,
          recordType: raw.recordType ?? null,
          recordId: raw.recordId ?? null,
          fileId: raw.fileId ?? null,
          sha256: null,
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
   * Freeze the bundle (#343): sequential tab numbers, per-item content
   * hashes, Merkle root over the hashes — the manifest is the tamper-evident
   * commitment to exactly what was produced to the tribunal.
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

      const index: ManifestIndexEntry[] = [];
      for (const [i, item] of items.entries()) {
        const sha256 = await itemContentHash(item, req.companyId!, req.projectId!);
        if (!sha256) {
          throw badRequest(
            `Item "${item.title}" no longer resolves to a file or record; remove it and retry`,
          );
        }
        item.tab = `A${i + 1}`;
        item.sha256 = sha256;
        index.push({
          tab: item.tab,
          title: item.title,
          date: item.date,
          source: item.fileId ? `file:${item.fileId}` : `${item.recordType}:${item.recordId}`,
          sha256,
        });
      }
      const root = merkleRoot(index.map((e) => e.sha256));
      const manifest: BundleManifest = {
        generatedAt: new Date().toISOString(),
        itemCount: index.length,
        merkleRoot: root,
        index,
      };
      await app.db
        .update(disputeBundles)
        .set({
          items,
          manifest: manifest as unknown as Record<string, unknown>,
          status: "generated",
          updatedAt: manifest.generatedAt,
        })
        .where(eq(disputeBundles.id, bundleId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { from: "draft", to: "generated", manifest },
        storePayload: true,
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
          [csvCell(e.tab), csvCell(e.title), csvCell(e.date), csvCell(e.source), csvCell(e.sha256)].join(
            ",",
          ),
        );
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="bundle-${bundle.id}-manifest.csv"`,
        )
        .send(lines.join("\n") + "\n");
    },
  );

  /**
   * Tamper-evidence check (#862-style): recompute every item's content hash
   * from today's files/records and compare against the frozen manifest.
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
      const mismatches: { tab: string; title: string; expected: string; actual: string | null }[] =
        [];
      for (const entry of manifest.index) {
        const item = byTab.get(entry.tab);
        const actual = item
          ? await itemContentHash(item, req.companyId!, req.projectId!)
          : null;
        if (actual !== entry.sha256) {
          mismatches.push({ tab: entry.tab, title: entry.title, expected: entry.sha256, actual });
        }
      }
      const recomputedRoot = merkleRoot(manifest.index.map((e) => e.sha256));
      const intact = mismatches.length === 0 && recomputedRoot === manifest.merkleRoot;
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "access",
        objectType: "dispute_bundle",
        objectId: bundleId,
        payload: { verify: true, intact, mismatchCount: mismatches.length },
      });
      return { intact, merkleRoot: manifest.merkleRoot, itemCount: manifest.itemCount, mismatches };
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
      if (body.status === "accepted" && !ACTIVE.includes(dispute.status as DisputeStatus)) {
        throw badRequest(
          `Cannot accept an offer on a ${dispute.status} dispute — it is no longer live`,
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(settlementOffers)
        .set({ status: body.status, updatedAt: now })
        .where(eq(settlementOffers.id, offerId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "settlement_offer",
        objectId: offerId,
        payload: { from: "open", to: body.status, disputeId: offer.disputeId },
        storePayload: true,
      });

      if (body.status === "accepted") {
        // Acceptance settles the dispute (#350): status settled + outcome.
        const outcome = `Settled at ${offer.currency} ${offer.amount}`;
        await app.db
          .update(disputes)
          .set({ status: "settled", outcome, updatedAt: now })
          .where(eq(disputes.id, dispute.id));
        await appendLedger(app.db, {
          companyId: req.companyId!,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "dispute",
          objectId: dispute.id,
          payload: { from: dispute.status, to: "settled", outcome, offerId },
          storePayload: true,
        });
      }
      const updated = (
        await app.db.select().from(settlementOffers).where(eq(settlementOffers.id, offerId)).limit(1)
      )[0];
      return updated;
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
      const offers = await app.db
        .select()
        .from(settlementOffers)
        .where(
          and(
            eq(settlementOffers.disputeId, disputeId),
            eq(settlementOffers.companyId, req.companyId!),
          ),
        );
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
          }),
        ),
      );
      return { disputeId, currency: dispute.currency, ...analysis };
    },
  );
};

// re-export for colocated tests and the web layer
export { analyseSettlement } from "./settlement.js";
