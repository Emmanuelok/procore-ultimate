import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  billingPeriods,
  changeQuoteRequests,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  invoiceLineItems,
  invoices,
  lienWaivers,
  projects,
  vendorPortalTokens,
  vendors,
} from "@constructos/db";
import { VENDOR_PORTAL_SCOPES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";
import { computeLine, type LineBasis, type LineInput, type LineIssue } from "./arithmetic.js";
import { createInvoice, invoiceLines, recomputeInvoice } from "./invoices.js";
import {
  CENT,
  certifiedOf,
  formatMoney,
  isoDateSchema,
  ledger,
  nowIso,
  outstandingOf,
  round2,
  todayIso,
} from "./shared.js";

/**
 * SUBCONTRACTOR SELF-SERVICE PORTAL (spec #567–568; RFQ scope for #548).
 *
 * A vendor gets a TOKEN — bound to one vendor on one project, optionally to
 * one commitment, with explicit scopes, an expiry and a revocation switch —
 * and with it can see their commitments and schedule of values, raise and
 * submit their own progress invoice against the schedule, watch their
 * invoices and payments (with remittance detail), return a lien waiver, and
 * answer an RFQ with their price. The raw token is shown once at creation;
 * only its hash is stored.
 *
 * Everything the vendor does goes through the SAME rules as an internal
 * user: `createInvoice` and `computeLine` refuse over-billing and regression
 * exactly as the invoice routes do, and the actor recorded on the invoice is
 * `portal:<tokenId>` — a distinct identity, so segregation of duties holds
 * (nobody inside the company can be both the sub and the approver).
 */

const tokenCreateSchema = z.object({
  vendorId: z.string().min(1).max(64),
  commitmentId: z.string().min(1).max(64).nullable().optional(),
  label: z.string().min(1).max(200),
  scopes: z.array(z.enum(VENDOR_PORTAL_SCOPES)).min(1).max(VENDOR_PORTAL_SCOPES.length).optional(),
  contactEmail: z.string().email().max(300).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

const portalInvoiceSchema = z.object({
  commitmentId: z.string().min(1).max(64),
  billingPeriodId: z.string().min(1).max(64).nullable().optional(),
  invoiceNumber: z.string().max(100).nullable().optional(),
  lines: z
    .array(
      z.object({
        sovLineId: z.string().min(1).max(64),
        thisPeriodWork: z.number().finite().min(0).optional(),
        percentComplete: z.number().finite().min(0).max(100).optional(),
        materialsPresentlyStored: z.number().finite().min(0).optional(),
        notes: z.string().max(2000).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
  notes: z.string().max(4000).nullable().optional(),
  /** submit immediately after creating; false leaves a draft the vendor can finish */
  submit: z.boolean().optional(),
});

const quoteRespondSchema = z.object({
  quotedAmount: z.number().finite(),
  quotedScheduleImpactDays: z.number().int().min(0).max(3650).optional(),
  quoteNotes: z.string().max(20000).nullable().optional(),
  quoteValidUntil: isoDateSchema.nullable().optional(),
});

const waiverReturnSchema = z.object({
  signedByName: z.string().min(1).max(300),
  signatureMethod: z.enum(["wet_ink", "e_signature", "notarized"]).default("e_signature"),
  signatureReference: z.string().max(300).nullable().optional(),
});

const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

type TokenRow = typeof vendorPortalTokens.$inferSelect;

export const portalRoutes: FastifyPluginAsync = async (app) => {
  const companyGate = [app.authenticate, app.requireCompany];
  const adminGate = [...companyGate, app.requireTool("invoicing", "admin")];
  const readGate = [...companyGate, app.requireTool("invoicing", "read")];

  /* ---------------------------------------------------------------- */
  /* Token administration (invoicing admin)                            */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/vendor-portal/tokens", { preHandler: adminGate }, async (req, reply) => {
    const body = tokenCreateSchema.parse(req.body);
    const vendor = (
      await app.db.select({ id: vendors.id, name: vendors.name, email: vendors.email }).from(vendors).where(and(eq(vendors.id, body.vendorId), eq(vendors.companyId, req.companyId!))).limit(1)
    )[0];
    if (!vendor) throw badRequest("vendorId does not reference a vendor in this company");
    if (body.commitmentId) {
      const c = (
        await app.db.select({ id: commitments.id, vendorId: commitments.vendorId }).from(commitments).where(and(eq(commitments.id, body.commitmentId), eq(commitments.projectId, req.projectId!))).limit(1)
      )[0];
      if (!c) throw badRequest("commitmentId does not reference a commitment on this project");
      if (c.vendorId !== body.vendorId) throw badRequest("commitmentId is with a different vendor");
    }
    const raw = `vp_${randomBytes(24).toString("base64url")}`;
    const id = newId("vpt");
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null;
    await app.db.insert(vendorPortalTokens).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      vendorId: body.vendorId,
      commitmentId: body.commitmentId ?? null,
      label: body.label,
      tokenHash: hashToken(raw),
      scopes: body.scopes ?? ["invoices"],
      contactEmail: body.contactEmail ?? vendor.email ?? null,
      expiresAt,
      createdBy: req.user!.id,
    });
    await ledger(app.db, req, "create", "vendor_portal_token", id, { vendorId: body.vendorId, commitmentId: body.commitmentId ?? null, scopes: body.scopes ?? ["invoices"], expiresAt }, req.projectId!);
    const row = (await app.db.select().from(vendorPortalTokens).where(eq(vendorPortalTokens.id, id)).limit(1))[0]!;
    return reply.status(201).send({ ...publicToken(row), token: raw, portalPath: `/api/v1/vendor-portal/${raw}` });
  });

  app.get("/projects/:projectId/vendor-portal/tokens", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(vendorPortalTokens)
      .where(and(eq(vendorPortalTokens.companyId, req.companyId!), eq(vendorPortalTokens.projectId, req.projectId!)))
      .orderBy(desc(vendorPortalTokens.createdAt));
    const vendorIds = [...new Set(rows.map((r) => r.vendorId))];
    const names = vendorIds.length ? await app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const nameBy = new Map(names.map((n) => [n.id, n.name]));
    return { items: rows.map((r) => ({ ...publicToken(r), vendorName: nameBy.get(r.vendorId) ?? null })), total: rows.length };
  });

  app.post("/projects/:projectId/vendor-portal/tokens/:tokenId/revoke", { preHandler: adminGate }, async (req) => {
    const { tokenId } = req.params as { tokenId: string };
    const row = (
      await app.db.select().from(vendorPortalTokens).where(and(eq(vendorPortalTokens.id, tokenId), eq(vendorPortalTokens.projectId, req.projectId!))).limit(1)
    )[0];
    if (!row) throw notFound("Token not found");
    if (row.revokedAt) throw conflict("Already revoked");
    const now = nowIso();
    await app.db.update(vendorPortalTokens).set({ revokedAt: now, updatedAt: now }).where(eq(vendorPortalTokens.id, tokenId));
    await ledger(app.db, req, "state_change", "vendor_portal_token", tokenId, { revoked: true }, req.projectId!);
    return publicToken({ ...row, revokedAt: now });
  });

  function publicToken(r: TokenRow) {
    return {
      id: r.id,
      vendorId: r.vendorId,
      commitmentId: r.commitmentId,
      label: r.label,
      scopes: r.scopes,
      contactEmail: r.contactEmail,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      lastUsedAt: r.lastUsedAt,
      useCount: r.useCount,
      createdAt: r.createdAt,
      active: r.revokedAt === null && (r.expiresAt === null || r.expiresAt > nowIso()),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Token-authenticated vendor routes                                  */
  /* ---------------------------------------------------------------- */

  async function resolveToken(req: FastifyRequest, scope: (typeof VENDOR_PORTAL_SCOPES)[number]): Promise<TokenRow> {
    const { token } = req.params as { token: string };
    if (!token || token.length < 16 || token.length > 200) throw new AppError(401, "Invalid portal token");
    const row = (await app.db.select().from(vendorPortalTokens).where(eq(vendorPortalTokens.tokenHash, hashToken(token))).limit(1))[0];
    if (!row) throw new AppError(401, "Invalid portal token");
    if (row.revokedAt) throw new AppError(401, "This portal link has been revoked");
    if (row.expiresAt && row.expiresAt < nowIso()) throw new AppError(401, "This portal link has expired");
    if (!row.scopes.includes(scope)) throw new AppError(403, `This portal link does not allow ${scope}`);
    await app.db
      .update(vendorPortalTokens)
      .set({ lastUsedAt: nowIso(), useCount: row.useCount + 1 })
      .where(eq(vendorPortalTokens.id, row.id));
    return row;
  }

  async function vendorCommitments(t: TokenRow) {
    return app.db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.companyId, t.companyId),
          eq(commitments.projectId, t.projectId),
          eq(commitments.vendorId, t.vendorId),
          ...(t.commitmentId ? [eq(commitments.id, t.commitmentId)] : []),
          inArray(commitments.status, ["approved", "complete", "out_for_signature"]),
        ),
      )
      .orderBy(asc(commitments.number));
  }

  app.get("/vendor-portal/:token", async (req) => {
    const t = await resolveToken(req, "invoices");
    const [vendor, project, mine] = await Promise.all([
      app.db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.id, t.vendorId)).limit(1),
      app.db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, t.projectId)).limit(1),
      vendorCommitments(t),
    ]);
    const ids = mine.map((c) => c.id);
    const [sov, inv, pays, periods] = await Promise.all([
      ids.length ? app.db.select().from(commitmentSovLines).where(inArray(commitmentSovLines.commitmentId, ids)).orderBy(asc(commitmentSovLines.sortOrder)) : [],
      ids.length ? app.db.select().from(invoices).where(and(inArray(invoices.commitmentId, ids), eq(invoices.kind, "subcontractor_invoice"))).orderBy(desc(invoices.number)) : [],
      ids.length ? app.db.select().from(commitmentPayments).where(inArray(commitmentPayments.commitmentId, ids)).orderBy(desc(commitmentPayments.number)) : [],
      app.db.select().from(billingPeriods).where(and(eq(billingPeriods.projectId, t.projectId), eq(billingPeriods.status, "open"))).orderBy(desc(billingPeriods.number)),
    ]);
    const waivers = inv.length
      ? await app.db.select().from(lienWaivers).where(and(eq(lienWaivers.vendorId, t.vendorId), eq(lienWaivers.projectId, t.projectId), inArray(lienWaivers.status, ["requested", "sent"])))
      : [];
    return {
      vendor: vendor[0] ?? null,
      project: project[0] ?? null,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      commitments: mine.map((c) => ({
        id: c.id,
        reference: c.reference,
        title: c.title,
        status: c.status,
        executed: c.executed === 1,
        currency: c.currency,
        revisedCommitmentSum: c.revisedCommitmentSum,
        totalInvoiced: c.totalInvoiced,
        totalPaid: c.totalPaid,
        retainageHeld: c.retainageHeld,
        requiresLienWaiver: c.requiresLienWaiver === 1,
        sov: sov
          .filter((l) => l.commitmentId === c.id)
          .map((l) => ({
            id: l.id,
            lineNumber: l.lineNumber,
            description: l.description,
            revisedScheduledValue: l.revisedScheduledValue,
            previousBilled: l.previousBilled,
            previousStoredMaterials: l.previousStoredMaterials,
            percentComplete: l.percentComplete,
            balanceToFinish: l.balanceToFinish,
            retainagePercent: l.retainagePercent,
            retainageHeld: l.retainageHeld,
          })),
      })),
      invoices: inv.map((i) => ({
        id: i.id,
        reference: i.reference,
        invoiceNumber: i.invoiceNumber,
        commitmentId: i.commitmentId,
        status: i.status,
        currency: i.currency,
        billingDate: i.billingDate,
        dueDate: i.dueDate,
        currentPaymentDue: i.currentPaymentDue,
        certified: certifiedOf(i),
        amountPaid: i.amountPaid,
        outstanding: outstandingOf(i),
        lienWaiverStatus: i.lienWaiverStatus,
        reviewNotes: i.status === "revise_and_resubmit" || i.status === "rejected" ? i.reviewNotes ?? i.rejectionReason : null,
      })),
      payments: pays
        .filter((p) => p.status !== "voided")
        .map((p) => ({
          id: p.id,
          reference: p.reference,
          invoiceId: p.invoiceId,
          status: p.status,
          amount: p.amount,
          currency: p.currency,
          method: p.method,
          paymentDate: p.paymentDate,
          checkNumber: p.checkNumber,
          transactionReference: p.transactionReference,
          retainageReleased: p.retainageReleasedAmount,
          holdReason: p.status === "on_hold" ? "Held — the project will contact you about the documents required" : null,
        })),
      openPeriods: periods.map((p) => ({ id: p.id, reference: p.reference, name: p.name, startDate: p.startDate, endDate: p.endDate, subcontractorSubmitStart: p.subcontractorSubmitStart, subcontractorSubmitEnd: p.subcontractorSubmitEnd })),
      waiversRequested: waivers.map((w) => ({ id: w.id, reference: w.reference, waiverType: w.waiverType, status: w.status, amount: w.amount, currency: w.currency, throughDate: w.throughDate, invoiceId: w.invoiceId })),
    };
  });

  /** Raise (and optionally submit) a progress invoice against the vendor's own schedule of values. */
  app.post("/vendor-portal/:token/invoices", async (req, reply) => {
    const t = await resolveToken(req, "invoices");
    const body = portalInvoiceSchema.parse(req.body);
    const mine = await vendorCommitments(t);
    const commitment = mine.find((c) => c.id === body.commitmentId);
    if (!commitment) throw badRequest("commitmentId is not one of your commitments on this project");
    const actorId = `portal:${t.id}`;
    const { invoice } = await createInvoice(app.db, {
      companyId: t.companyId,
      projectId: t.projectId,
      kind: "subcontractor_invoice",
      contractId: commitment.id,
      actorId,
      billingPeriodId: body.billingPeriodId ?? null,
      title: null,
      invoiceNumber: body.invoiceNumber ?? null,
      billingDate: null,
      dueDate: null,
      periodStart: null,
      periodEnd: null,
      receivedDate: todayIso(),
      requiresLienWaiver: undefined,
      retainagePercent: undefined,
      generateLines: true,
      detail: { source: "vendor_portal", portalTokenId: t.id, vendorNotes: body.notes ?? null },
    });
    const lines = await invoiceLines(app.db, invoice.id);
    const bySov = new Map(lines.map((l) => [l.commitmentSovLineId ?? "", l]));
    const issues: LineIssue[] = [];
    const updates: Array<{ id: string; computed: ReturnType<typeof computeLine>["computed"]; notes: string | null | undefined }> = [];
    for (const input of body.lines) {
      const row = bySov.get(input.sovLineId);
      if (!row) throw badRequest(`sovLineId ${input.sovLineId} is not on ${commitment.reference}'s schedule of values`);
      const basis: LineBasis = {
        lineNumber: row.lineNumber,
        description: row.description,
        scheduledValue: row.scheduledValue,
        previousBilled: row.previousBilled,
        previousStoredMaterials: row.previousStoredMaterials,
        retainagePercent: row.retainagePercent,
        taxPercent: row.taxPercent,
      };
      const lineInput: LineInput = {
        thisPeriodWork: input.thisPeriodWork,
        percentComplete: input.percentComplete,
        materialsPresentlyStored: input.materialsPresentlyStored,
      };
      const result = computeLine(basis, lineInput);
      issues.push(...result.issues);
      updates.push({ id: row.id, computed: result.computed, notes: input.notes });
    }
    if (issues.length > 0) {
      await app.db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
      await app.db.delete(invoices).where(eq(invoices.id, invoice.id));
      throw badRequest(
        issues.length === 1 ? issues[0]!.message : `${issues.length} lines were refused: ${issues.map((i) => i.message).join(" ")}`,
        { issues },
      );
    }
    const projected = round2(
      updates.reduce((s, u) => s + u.computed.totalCompletedAndStored, 0) +
        lines.filter((l) => !updates.some((u) => u.id === l.id)).reduce((s, l) => s + l.totalCompletedAndStored, 0),
    );
    if (projected - invoice.revisedContractSum > CENT) {
      await app.db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id));
      await app.db.delete(invoices).where(eq(invoices.id, invoice.id));
      throw badRequest(
        `This billing totals ${formatMoney(projected)} ${invoice.currency} against a revised commitment sum of ` +
          `${formatMoney(invoice.revisedContractSum)} ${invoice.currency} — over by ${formatMoney(round2(projected - invoice.revisedContractSum))}.`,
      );
    }
    const now = nowIso();
    for (const u of updates) {
      const c = u.computed;
      await app.db
        .update(invoiceLineItems)
        .set({
          thisPeriodWork: c.thisPeriodWork,
          thisPeriodStoredMaterials: c.thisPeriodStoredMaterials,
          materialsPresentlyStored: c.materialsPresentlyStored,
          totalCompletedAndStored: c.totalCompletedAndStored,
          percentComplete: c.percentComplete,
          balanceToFinish: c.balanceToFinish,
          retainageThisPeriod: c.retainageThisPeriod,
          retainageHeldToDate: c.retainageHeldToDate,
          retainageReleased: c.retainageReleased,
          amount: c.amount,
          taxAmount: c.taxAmount,
          ...(u.notes !== undefined ? { notes: u.notes } : {}),
          updatedAt: now,
        })
        .where(eq(invoiceLineItems.id, u.id));
    }
    let refreshed = await recomputeInvoice(app.db, invoice.id);
    if (body.submit !== false) {
      if (refreshed.currentPaymentDue < -CENT) {
        throw conflict(`This invoice computes a negative payment due (${formatMoney(refreshed.currentPaymentDue)}); a credit is raised by the project, not through the portal.`);
      }
      await app.db
        .update(invoices)
        .set({ status: "submitted", submittedBy: actorId, submittedAt: now, updatedAt: now })
        .where(eq(invoices.id, invoice.id));
      refreshed = await recomputeInvoice(app.db, invoice.id);
    }
    await appendLedger(app.db, {
      companyId: t.companyId,
      actorId: null,
      action: "create",
      objectType: "invoice",
      objectId: invoice.id,
      projectId: t.projectId,
      payload: { source: "vendor_portal", portalTokenId: t.id, vendorId: t.vendorId, reference: refreshed.reference, status: refreshed.status, currentPaymentDue: refreshed.currentPaymentDue },
      storePayload: true,
    });
    return reply.status(201).send({
      invoice: { id: refreshed.id, reference: refreshed.reference, status: refreshed.status, currency: refreshed.currency, currentPaymentDue: refreshed.currentPaymentDue, totalRetainage: refreshed.totalRetainage, totalCompletedAndStored: refreshed.totalCompletedAndStored },
      lines: await invoiceLines(app.db, invoice.id),
    });
  });

  /** Return a requested waiver: the vendor signs it; the project still receives and verifies. */
  app.post("/vendor-portal/:token/lien-waivers/:waiverId/sign", async (req) => {
    const t = await resolveToken(req, "invoices");
    const { waiverId } = req.params as { waiverId: string };
    const body = waiverReturnSchema.parse(req.body);
    const w = (
      await app.db.select().from(lienWaivers).where(and(eq(lienWaivers.id, waiverId), eq(lienWaivers.projectId, t.projectId), eq(lienWaivers.vendorId, t.vendorId))).limit(1)
    )[0];
    if (!w) throw notFound("Lien waiver not found");
    if (!["requested", "sent"].includes(w.status)) throw conflict(`Waiver ${w.reference} is ${w.status} and is not awaiting your signature`);
    const now = nowIso();
    await app.db
      .update(lienWaivers)
      .set({ status: "signed", signedAt: now, signedByName: body.signedByName, signatureMethod: body.signatureMethod, signatureReference: body.signatureReference ?? null, detail: { ...(w.detail as Record<string, unknown>), signedViaPortal: t.id }, updatedAt: now })
      .where(eq(lienWaivers.id, waiverId));
    await appendLedger(app.db, { companyId: t.companyId, actorId: null, action: "state_change", objectType: "lien_waiver", objectId: waiverId, projectId: t.projectId, payload: { from: w.status, to: "signed", viaPortal: t.id, signedByName: body.signedByName }, storePayload: true });
    return { id: waiverId, status: "signed", signedAt: now };
  });

  /* ---- RFQ scope (#548): the vendor's own quote requests ---- */

  app.get("/vendor-portal/:token/quote-requests", async (req) => {
    const t = await resolveToken(req, "rfqs");
    const rows = await app.db
      .select()
      .from(changeQuoteRequests)
      .where(and(eq(changeQuoteRequests.projectId, t.projectId), eq(changeQuoteRequests.vendorId, t.vendorId), inArray(changeQuoteRequests.status, ["sent", "viewed", "quoted"])))
      .orderBy(desc(changeQuoteRequests.number));
    const now = nowIso();
    const unseen = rows.filter((r) => r.status === "sent" && r.viewedAt === null).map((r) => r.id);
    if (unseen.length > 0) {
      await app.db.update(changeQuoteRequests).set({ status: "viewed", viewedAt: now, updatedAt: now }).where(and(inArray(changeQuoteRequests.id, unseen), isNull(changeQuoteRequests.viewedAt)));
    }
    return {
      items: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        title: r.title,
        scopeDescription: r.scopeDescription,
        status: unseen.includes(r.id) ? "viewed" : r.status,
        dueDate: r.dueDate,
        sentAt: r.sentAt,
        quotedAmount: r.quotedAmount,
        quotedScheduleImpactDays: r.quotedScheduleImpactDays,
        quoteValidUntil: r.quoteValidUntil,
      })),
    };
  });

  app.post("/vendor-portal/:token/quote-requests/:quoteId/respond", async (req) => {
    const t = await resolveToken(req, "rfqs");
    const { quoteId } = req.params as { quoteId: string };
    const body = quoteRespondSchema.parse(req.body);
    const q = (
      await app.db.select().from(changeQuoteRequests).where(and(eq(changeQuoteRequests.id, quoteId), eq(changeQuoteRequests.projectId, t.projectId), eq(changeQuoteRequests.vendorId, t.vendorId))).limit(1)
    )[0];
    if (!q) throw notFound("Quote request not found");
    if (!["sent", "viewed", "quoted"].includes(q.status)) throw conflict(`${q.reference} is ${q.status} and no longer takes a quote`);
    const now = nowIso();
    await app.db
      .update(changeQuoteRequests)
      .set({
        status: "quoted",
        respondedAt: now,
        viewedAt: q.viewedAt ?? now,
        quotedAmount: round2(body.quotedAmount),
        quotedScheduleImpactDays: body.quotedScheduleImpactDays ?? null,
        quoteNotes: body.quoteNotes ?? null,
        quoteValidUntil: body.quoteValidUntil ?? null,
        detail: { ...(q.detail as Record<string, unknown>), quotedViaPortal: t.id, previousQuote: q.quotedAmount },
        updatedAt: now,
      })
      .where(eq(changeQuoteRequests.id, quoteId));
    await appendLedger(app.db, { companyId: t.companyId, actorId: null, action: "state_change", objectType: "change_quote_request", objectId: quoteId, projectId: t.projectId, payload: { from: q.status, to: "quoted", viaPortal: t.id, quotedAmount: body.quotedAmount, sentAt: q.sentAt, respondedAt: now }, storePayload: true });
    return { id: quoteId, status: "quoted", quotedAmount: round2(body.quotedAmount), respondedAt: now };
  });
};
