import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { commitments, invoices, obligations, signals, statutoryLiens, vendors } from "@constructos/db";
import { STATUTORY_LIEN_KINDS, STATUTORY_LIEN_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { isoDateSchema, todayISO } from "../field/dates.js";

/**
 * STATUTORY LIENS AND LIEN NOTICES (spec Vol II F #373–380).
 *
 * A mechanic's lien, a preliminary notice, a stop notice, a payment-bond
 * claim: each is a claim against the project by somebody down the chain,
 * governed by a statutory deadline — the date it must be filed, enforced or
 * released by. The deadline is an OBLIGATION in the assurance register the
 * moment the lien is recorded, so the payment clock and the assurance layer
 * see the same date, and the hourly sweep breaches it and raises a signal
 * when it passes without a release or a bond.
 *
 * Deliberately not done: computing the statutory deadline from the
 * jurisdiction. Lien statutes vary by state and by tier; the user records the
 * deadline and its basis, and the platform holds them to it.
 */

const createSchema = z.object({
  kind: z.enum(STATUTORY_LIEN_KINDS),
  claimantName: z.string().min(1).max(300),
  claimantVendorId: z.string().min(1).max(64).nullable().optional(),
  tier: z.number().int().min(1).max(9).optional(),
  amount: z.number().finite().min(0),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  jurisdiction: z.string().max(200).nullable().optional(),
  servedAt: isoDateSchema.nullable().optional(),
  filedAt: isoDateSchema.nullable().optional(),
  lastFurnishedAt: isoDateSchema.nullable().optional(),
  deadlineAt: isoDateSchema.nullable().optional(),
  deadlineBasis: z.string().max(500).nullable().optional(),
  propertyDescription: z.string().max(4000).nullable().optional(),
  relatedCommitmentId: z.string().min(1).max(64).nullable().optional(),
  relatedInvoiceId: z.string().min(1).max(64).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = createSchema.partial();

const listQuery = pageQuerySchema.extend({
  status: z.enum(STATUTORY_LIEN_STATUSES).optional(),
  kind: z.enum(STATUTORY_LIEN_KINDS).optional(),
});

const daysUntil = (iso: string, today: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/**
 * Sweep: every noticed/filed/disputed lien whose deadline has passed breaches
 * its obligation and raises one high signal — once, keyed on the lien.
 */
export async function sweepLienDeadlines(
  db: Db,
  companyId: string,
  today: string = todayISO(),
): Promise<{ breached: number }> {
  const overdue = await db
    .select()
    .from(statutoryLiens)
    .where(
      and(
        eq(statutoryLiens.companyId, companyId),
        inArray(statutoryLiens.status, ["noticed", "filed", "disputed"]),
        isNotNull(statutoryLiens.deadlineAt),
        lt(statutoryLiens.deadlineAt, today),
      ),
    );
  let breached = 0;
  for (const lien of overdue) {
    const detail = (lien.detail ?? {}) as Record<string, unknown>;
    if (detail["deadlineBreachedAt"]) continue;
    const now = new Date().toISOString();
    const flipped = await db
      .update(statutoryLiens)
      .set({ detail: { ...detail, deadlineBreachedAt: now }, updatedAt: now })
      .where(and(eq(statutoryLiens.id, lien.id), eq(statutoryLiens.status, lien.status)))
      .returning({ id: statutoryLiens.id });
    if (flipped.length === 0) continue;
    breached += 1;
    if (lien.obligationId) {
      await db
        .update(obligations)
        .set({ status: "breached" })
        .where(and(eq(obligations.id, lien.obligationId), eq(obligations.status, "open")));
    }
    await db.insert(signals).values({
      id: newId("sig"),
      companyId,
      projectId: lien.projectId,
      detector: "lien_deadline_passed",
      severity: "high",
      confidence: 1,
      title: `${lien.reference}: statutory deadline ${lien.deadlineAt} passed while the lien is ${lien.status}`,
      explanation:
        `${lien.claimantName} (tier ${lien.tier}) has a ${lien.kind.replace(/_/g, " ")} for ${lien.currency} ${lien.amount} ` +
        `against the project. Its statutory deadline (${lien.deadlineBasis ?? "recorded on the lien"}) was ${lien.deadlineAt} ` +
        `and no release, bond-off or expiry has been recorded.`,
    });
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "statutory_lien",
      objectId: lien.id,
      projectId: lien.projectId,
      payload: { deadlineBreached: true, deadlineAt: lien.deadlineAt, status: lien.status },
    });
  }
  return { breached };
}

export const lienRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("payments", "standard")];

  app.scheduler.register({
    name: "payments.lien-deadlines",
    description: "Breach the obligation and raise a signal for every statutory lien whose deadline passed without release",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      let breached = 0;
      const r = await forEachCompany(db, async (companyId) => {
        breached += (await sweepLienDeadlines(db, companyId, now.toISOString().slice(0, 10))).breached;
      });
      return { breached, companies: r.companies, failed: r.failed };
    },
  });

  async function fetchLien(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(statutoryLiens)
      .where(and(eq(statutoryLiens.id, id), eq(statutoryLiens.companyId, companyId), eq(statutoryLiens.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw notFound("Lien not found");
    return rows[0];
  }

  async function validateLinks(companyId: string, projectId: string, body: { claimantVendorId?: string | null; relatedCommitmentId?: string | null; relatedInvoiceId?: string | null }) {
    if (body.claimantVendorId) {
      const v = await app.db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, body.claimantVendorId), eq(vendors.companyId, companyId))).limit(1);
      if (!v[0]) throw badRequest("claimantVendorId does not reference a vendor in this company");
    }
    if (body.relatedCommitmentId) {
      const c = await app.db.select({ id: commitments.id }).from(commitments).where(and(eq(commitments.id, body.relatedCommitmentId), eq(commitments.projectId, projectId))).limit(1);
      if (!c[0]) throw badRequest("relatedCommitmentId does not reference a commitment on this project");
    }
    if (body.relatedInvoiceId) {
      const i = await app.db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, body.relatedInvoiceId), eq(invoices.projectId, projectId))).limit(1);
      if (!i[0]) throw badRequest("relatedInvoiceId does not reference an invoice on this project");
    }
  }

  /** The deadline is an Obligation; keep the two in step on create and patch. */
  async function syncObligation(lien: typeof statutoryLiens.$inferSelect, actorId: string): Promise<string | null> {
    if (!lien.deadlineAt) return lien.obligationId;
    const deadline = `${lien.deadlineAt}T23:59:59Z`;
    if (lien.obligationId) {
      await app.db
        .update(obligations)
        .set({ deadline, trigger: `${lien.reference}: ${lien.kind.replace(/_/g, " ")} by ${lien.claimantName}` })
        .where(and(eq(obligations.id, lien.obligationId), eq(obligations.status, "open")));
      return lien.obligationId;
    }
    const id = newId("obl");
    await app.db.insert(obligations).values({
      id,
      companyId: lien.companyId,
      projectId: lien.projectId,
      sourceClause: lien.deadlineBasis ?? `Statutory lien deadline (${lien.jurisdiction ?? "jurisdiction not recorded"})`,
      trigger: `${lien.reference}: ${lien.kind.replace(/_/g, " ")} by ${lien.claimantName}`,
      deadline,
      warnDaysBefore: 7,
      evidenceRequirement: "Release, bond-off or expiry recorded on the lien",
      status: "open",
      createdBy: actorId,
    });
    await app.db.update(statutoryLiens).set({ obligationId: id }).where(eq(statutoryLiens.id, lien.id));
    return id;
  }

  app.post("/projects/:projectId/liens", { preHandler: standardGate }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    await validateLinks(req.companyId!, req.projectId!, body);
    const number = await nextRecordNumber(app.db, req.projectId!, "statutory_lien");
    const id = newId("lien");
    const reference = `LIEN-${String(number).padStart(3, "0")}`;
    await app.db.insert(statutoryLiens).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      number,
      reference,
      kind: body.kind,
      status: body.filedAt ? "filed" : "noticed",
      claimantName: body.claimantName,
      claimantVendorId: body.claimantVendorId ?? null,
      tier: body.tier ?? 1,
      amount: body.amount,
      currency: (body.currency ?? "USD").toUpperCase(),
      jurisdiction: body.jurisdiction ?? null,
      servedAt: body.servedAt ?? null,
      filedAt: body.filedAt ?? null,
      lastFurnishedAt: body.lastFurnishedAt ?? null,
      deadlineAt: body.deadlineAt ?? null,
      deadlineBasis: body.deadlineBasis ?? null,
      propertyDescription: body.propertyDescription ?? null,
      relatedCommitmentId: body.relatedCommitmentId ?? null,
      relatedInvoiceId: body.relatedInvoiceId ?? null,
      notes: body.notes ?? null,
      detail: body.detail ?? {},
      createdBy: req.user!.id,
    });
    const lien = await fetchLien(id, req.companyId!, req.projectId!);
    await syncObligation(lien, req.user!.id);
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "statutory_lien",
      objectId: id,
      projectId: req.projectId!,
      payload: { reference, kind: body.kind, claimantName: body.claimantName, amount: body.amount, currency: body.currency ?? "USD", deadlineAt: body.deadlineAt ?? null },
      storePayload: true,
    });
    return reply.status(201).send(await fetchLien(id, req.companyId!, req.projectId!));
  });

  app.get("/projects/:projectId/liens", { preHandler: readGate }, async (req) => {
    const q = listQuery.parse(req.query);
    const clauses = [eq(statutoryLiens.companyId, req.companyId!), eq(statutoryLiens.projectId, req.projectId!)];
    if (q.status) clauses.push(eq(statutoryLiens.status, q.status));
    if (q.kind) clauses.push(eq(statutoryLiens.kind, q.kind));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(statutoryLiens).where(where);
    const rows = await app.db.select().from(statutoryLiens).where(where).orderBy(desc(statutoryLiens.number)).limit(q.pageSize).offset(pageOffset(q));
    const today = todayISO();
    const items = rows.map((l) => ({ ...l, daysToDeadline: l.deadlineAt ? daysUntil(l.deadlineAt, today) : null }));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  /** Open exposure by currency and tier — never one number across currencies. */
  app.get("/projects/:projectId/liens/summary", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(statutoryLiens)
      .where(and(eq(statutoryLiens.companyId, req.companyId!), eq(statutoryLiens.projectId, req.projectId!)))
      .orderBy(asc(statutoryLiens.deadlineAt));
    const open = rows.filter((l) => ["noticed", "filed", "disputed"].includes(l.status));
    const today = todayISO();
    const byCurrency = new Map<string, { currency: string; count: number; amount: number; tier2Plus: number }>();
    for (const l of open) {
      const b = byCurrency.get(l.currency) ?? { currency: l.currency, count: 0, amount: 0, tier2Plus: 0 };
      b.count += 1;
      b.amount = Math.round((b.amount + l.amount) * 100) / 100;
      if (l.tier > 1) b.tier2Plus += 1;
      byCurrency.set(l.currency, b);
    }
    return {
      open: open.length,
      byCurrency: [...byCurrency.values()],
      overdue: open.filter((l) => l.deadlineAt && l.deadlineAt < today).length,
      dueWithin14: open.filter((l) => l.deadlineAt && daysUntil(l.deadlineAt, today) >= 0 && daysUntil(l.deadlineAt, today) <= 14).length,
      next: open.filter((l) => l.deadlineAt).slice(0, 5).map((l) => ({ id: l.id, reference: l.reference, claimantName: l.claimantName, deadlineAt: l.deadlineAt, daysToDeadline: daysUntil(l.deadlineAt!, today) })),
      total: rows.length,
    };
  });

  app.get("/projects/:projectId/liens/:lienId", { preHandler: readGate }, async (req) => {
    const { lienId } = req.params as { lienId: string };
    const lien = await fetchLien(lienId, req.companyId!, req.projectId!);
    return { ...lien, daysToDeadline: lien.deadlineAt ? daysUntil(lien.deadlineAt, todayISO()) : null };
  });

  app.patch("/projects/:projectId/liens/:lienId", { preHandler: standardGate }, async (req) => {
    const { lienId } = req.params as { lienId: string };
    const body = patchSchema.parse(req.body);
    const lien = await fetchLien(lienId, req.companyId!, req.projectId!);
    if (["released", "expired", "void"].includes(lien.status)) throw conflict(`A ${lien.status} lien is closed; raise a new record`);
    await validateLinks(req.companyId!, req.projectId!, body);
    const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) set[k] = k === "currency" && typeof v === "string" ? v.toUpperCase() : v;
    await app.db.update(statutoryLiens).set(set).where(eq(statutoryLiens.id, lienId));
    const updated = await fetchLien(lienId, req.companyId!, req.projectId!);
    await syncObligation(updated, req.user!.id);
    await appendLedger(app.db, { companyId: req.companyId!, actorId: req.user!.id, action: "update", objectType: "statutory_lien", objectId: lienId, projectId: req.projectId!, payload: { changed: Object.keys(body) } });
    return fetchLien(lienId, req.companyId!, req.projectId!);
  });

  const transitions: Record<string, { from: string[]; to: string; body: z.ZodTypeAny }> = {
    file: { from: ["noticed"], to: "filed", body: z.object({ filedAt: isoDateSchema.optional() }) },
    dispute: { from: ["noticed", "filed"], to: "disputed", body: z.object({ reason: z.string().min(1).max(4000) }) },
    "bond-off": { from: ["noticed", "filed", "disputed"], to: "bonded_off", body: z.object({ bondReference: z.string().min(1).max(200) }) },
    release: { from: ["noticed", "filed", "disputed", "bonded_off"], to: "released", body: z.object({ releaseDocumentId: z.string().max(64).nullable().optional(), releasedAt: isoDateSchema.optional() }) },
    expire: { from: ["noticed", "filed", "disputed"], to: "expired", body: z.object({ reason: z.string().min(1).max(4000) }) },
    void: { from: ["noticed", "filed", "disputed"], to: "void", body: z.object({ reason: z.string().min(1).max(4000) }) },
  };

  for (const [action, t] of Object.entries(transitions)) {
    app.post(`/projects/:projectId/liens/:lienId/${action}`, { preHandler: standardGate }, async (req) => {
      const { lienId } = req.params as { lienId: string };
      const body = t.body.parse(req.body ?? {}) as Record<string, unknown>;
      const lien = await fetchLien(lienId, req.companyId!, req.projectId!);
      if (!t.from.includes(lien.status)) throw conflict(`Cannot ${action} a lien that is ${lien.status}`);
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { status: t.to, updatedAt: now };
      if (t.to === "filed") set["filedAt"] = (body["filedAt"] as string | undefined) ?? todayISO();
      if (t.to === "disputed") set["disputeReason"] = body["reason"];
      if (t.to === "bonded_off") set["bondReference"] = body["bondReference"];
      if (t.to === "released") {
        set["releasedAt"] = (body["releasedAt"] as string | undefined) ?? todayISO();
        set["releaseDocumentId"] = body["releaseDocumentId"] ?? null;
      }
      if (t.to === "expired" || t.to === "void") set["notes"] = `${lien.notes ?? ""}\n[${t.to}] ${String(body["reason"])}`.trim();
      await app.db.update(statutoryLiens).set(set).where(eq(statutoryLiens.id, lienId));
      /* a closed lien satisfies its deadline obligation; a bonded-off lien too */
      if (["released", "bonded_off", "expired", "void"].includes(t.to) && lien.obligationId) {
        await app.db.update(obligations).set({ status: "satisfied" }).where(and(eq(obligations.id, lien.obligationId), eq(obligations.status, "open")));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "statutory_lien",
        objectId: lienId,
        projectId: req.projectId!,
        payload: { from: lien.status, to: t.to, ...body },
        storePayload: true,
      });
      return fetchLien(lienId, req.companyId!, req.projectId!);
    });
  }
};
