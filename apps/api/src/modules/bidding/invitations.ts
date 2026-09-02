import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { bidInvitations, bidPackages } from "@constructos/db";
import { BID_DECLINE_REASONS, BID_INVITATION_STATUSES } from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound, unauthorized } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import type { Db } from "../../lib/db.js";
import {
  assertVendor,
  detailSchema,
  fetchInvitation,
  fetchPackage,
  ledger,
  reasonSchema,
  requireBiddingLevel,
  type BidInvitationRow,
  type BidPackageRow,
} from "./shared.js";
import { addendaOf, requirementsOf, timetableOf } from "./packages.js";
import {
  effectiveLimit,
  evaluatePrequalGate,
  sweepPrequalification,
  vendorPrequalStatus,
} from "./prequal-status.js";
import { checkContractAgainstLimit } from "./financial-limits.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const oneInvitationSchema = z.object({
  vendorId: z.string().min(1).max(64),
  contactId: z.string().min(1).max(64).nullable().optional(),
  contactName: z.string().trim().min(1).max(200).nullable().optional(),
  contactEmail: z.string().trim().email().max(320).nullable().optional(),
  detail: detailSchema.optional(),
});

const invitationCreateSchema = z.union([
  oneInvitationSchema,
  z.object({ invitations: z.array(oneInvitationSchema).min(1).max(200) }),
]);

const invitationsListQuery = pageQuerySchema.extend({
  status: z.enum(BID_INVITATION_STATUSES).optional(),
  vendorId: z.string().min(1).max(64).optional(),
});

const declineSchema = z.object({
  reason: z.enum(BID_DECLINE_REASONS),
  note: z.string().max(4000).nullable().optional(),
});

const deliverySchema = z.union([
  z.object({ delivered: z.literal(true) }),
  z.object({ bounced: z.literal(true), bounceReason: reasonSchema }),
]);

const ackSchema = z.object({ addendumRef: z.string().trim().min(1).max(60) });

/** Live enough that the vendor may still bid, or already has. */
const LIVE = ["draft", "sent", "delivered", "viewed", "downloaded", "intent_to_bid", "submitted"];

/* ------------------------------------------------------------------ */
/* Portal tokens — only the hash is ever stored                        */
/* ------------------------------------------------------------------ */

/**
 * A bidder portal token is a machine credential handed to a company that has
 * no login on this platform, so it follows exactly the discipline
 * `api_tokens` follows: `bpt_` + 40 hex characters, of which we keep only the
 * sha256. The raw value appears in the response that mints it and NEVER
 * again — not in the invitation detail, not in the list, not in the ledger,
 * not in a support tool. Losing it means minting a new one, which is the
 * correct cost.
 */
export const PORTAL_TOKEN_PREFIX = "bpt_";

export function mintPortalToken(): { raw: string; hash: string; display: string } {
  const raw = `${PORTAL_TOKEN_PREFIX}${randomBytes(20).toString("hex")}`;
  return { raw, hash: sha256Hex(raw), display: `${raw.slice(0, 8)}...` };
}

/** Invitations never leave this module carrying the token hash. */
export function viewInvitation(row: BidInvitationRow) {
  const { portalTokenHash, ...rest } = row;
  return {
    ...rest,
    portalAccessIssued: Boolean(portalTokenHash),
    intentToBid: row.intentToBid === 1,
    isPrequalified: row.isPrequalified === 1,
    attendedSiteVisit: row.attendedSiteVisit === 1,
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];
  const companyGate = [app.authenticate, app.requireCompany];

  /** Recount the package rollups from the invitation table — never increment. */
  async function recountInvitations(db: Db, packageId: string): Promise<void> {
    const rows = await db
      .select({ status: bidInvitations.status })
      .from(bidInvitations)
      .where(eq(bidInvitations.packageId, packageId));
    await db
      .update(bidPackages)
      .set({
        invitationCount: rows.length,
        declineCount: rows.filter((r) => r.status === "declined").length,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(bidPackages.id, packageId));
  }

  /**
   * Decorate an invitation with the two facts a tender manager needs next to
   * it: where this vendor's prequalification actually stands right now, and
   * whether the value of this package is inside the capacity they were
   * approved for.
   */
  async function decorate(db: Db, companyId: string, pkg: BidPackageRow, inv: BidInvitationRow) {
    const status = await vendorPrequalStatus(db, companyId, inv.vendorId);
    const gate = evaluatePrequalGate(pkg, status, "Invitation", false);
    const cap = effectiveLimit(status);
    const capacity = checkContractAgainstLimit({
      contractValue: pkg.estimatedValue ?? pkg.engineersEstimate,
      contractCurrency: pkg.currency,
      limit: cap.limit,
      limitCurrency: cap.currency,
      vendorName: status.vendorName ?? inv.vendorId,
      basis: cap.basis,
    });
    const acknowledged = new Set(
      ((inv.addendaAcknowledged as { addendumRef?: string }[]) ?? []).map((a) => a.addendumRef),
    );
    const outstandingAddenda = addendaOf(pkg)
      .filter((a) => a.requiresAcknowledgement && !acknowledged.has(a.reference))
      .map((a) => a.reference);
    return {
      ...viewInvitation(inv),
      vendorName: status.vendorName,
      prequalification: {
        state: status.state,
        reference: status.reference,
        expiresAt: status.expiresAt,
        daysToExpiry: status.daysToExpiry,
        singleProjectLimit: status.singleProjectLimit,
        currency: status.currency,
        ok: gate.ok,
        /** populated whenever this vendor's standing is not clean */
        flag: gate.message,
        note: status.note,
      },
      capacity,
      outstandingAddenda,
      engagement: {
        sent: Boolean(inv.sentAt),
        delivered: Boolean(inv.deliveredAt),
        viewed: Boolean(inv.viewedAt),
        downloaded: inv.downloadCount > 0,
        responded: Boolean(inv.respondedAt),
        silent:
          Boolean(inv.sentAt) && !inv.respondedAt && !inv.viewedAt && inv.remindersSent > 0,
        remindersSent: inv.remindersSent,
      },
    };
  }

  async function invitationContext(
    req: FastifyRequest,
  ): Promise<{ invitation: BidInvitationRow; pkg: BidPackageRow }> {
    const { invitationId } = req.params as { invitationId: string };
    const invitation = await fetchInvitation(app.db, invitationId, req.companyId!);
    const pkg = await fetchPackage(app.db, invitation.packageId, req.companyId!);
    return { invitation, pkg };
  }

  /* ---------------------------------------------------------------- */
  /* Create + list                                                     */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/invitations",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const parsed = invitationCreateSchema.parse(req.body);
      const wanted = "invitations" in parsed ? parsed.invitations : [parsed];
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package cannot take new invitations.`);
      }

      const created: string[] = [];
      const warnings: { vendorId: string; message: string }[] = [];
      for (const item of wanted) {
        const vendor = await assertVendor(app.db, item.vendorId, companyId);
        const [existing] = await app.db
          .select({ id: bidInvitations.id })
          .from(bidInvitations)
          .where(
            and(
              eq(bidInvitations.packageId, packageId),
              eq(bidInvitations.vendorId, item.vendorId),
            ),
          )
          .limit(1);
        if (existing) {
          throw conflict(`${vendor.name} has already been invited to ${pkg.reference}.`);
        }

        // The prequalification gate at invitation FLAGS but never refuses:
        // a vendor whose approval lapsed last week may renew before the
        // deadline, and telling them to is the entire point of the flag.
        const status = await vendorPrequalStatus(app.db, companyId, item.vendorId);
        const gate = evaluatePrequalGate(pkg, status, "Invitation", false);
        if (!gate.ok && gate.message) warnings.push({ vendorId: item.vendorId, message: gate.message });

        const id = newId("bin");
        await app.db.insert(bidInvitations).values({
          id,
          companyId,
          projectId,
          packageId,
          vendorId: item.vendorId,
          contactId: item.contactId ?? null,
          contactName: item.contactName ?? null,
          contactEmail: item.contactEmail ?? null,
          status: "draft",
          isPrequalified: gate.ok && status.state === "approved" ? 1 : 0,
          prequalificationSubmissionId: status.submissionId,
          prequalificationExpiresAt: status.expiresAt,
          detail: { ...(item.detail ?? {}), prequalificationAtInvitation: status.state },
          createdBy: req.user!.id,
        });
        await ledger(app.db, req, "create", "bid_invitation", id, {
          projectId,
          packageId,
          packageReference: pkg.reference,
          vendorId: item.vendorId,
          vendorName: vendor.name,
          prequalificationState: status.state,
          prequalificationFlag: gate.message,
        }, projectId, true);
        created.push(id);
      }

      await recountInvitations(app.db, packageId);
      const rows = await app.db
        .select()
        .from(bidInvitations)
        .where(inArray(bidInvitations.id, created));
      const items = await Promise.all(rows.map((r) => decorate(app.db, companyId, pkg, r)));
      return reply.status(201).send({ items, total: items.length, warnings });
    },
  );

  app.get(
    "/projects/:projectId/bid-packages/:packageId/invitations",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const q = invitationsListQuery.parse(req.query);
      await sweepPrequalification(app.db, req.companyId!, req.user!.id);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const filters = [eq(bidInvitations.packageId, packageId)];
      if (q.status) filters.push(eq(bidInvitations.status, q.status));
      if (q.vendorId) filters.push(eq(bidInvitations.vendorId, q.vendorId));
      const where = and(...filters);
      const [totalRow] = await app.db.select({ n: count() }).from(bidInvitations).where(where);
      const rows = await app.db
        .select()
        .from(bidInvitations)
        .where(where)
        .orderBy(asc(bidInvitations.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const items = await Promise.all(rows.map((r) => decorate(app.db, req.companyId!, pkg, r)));
      return {
        ...paginate(items, Number(totalRow?.n ?? 0), q),
        summary: {
          flagged: items.filter((i) => !i.prequalification.ok).length,
          declined: items.filter((i) => i.status === "declined").length,
          silent: items.filter((i) => i.engagement.silent).length,
        },
      };
    },
  );

  app.get("/bid-invitations/:invitationId", { preHandler: companyGate }, async (req, reply) => {
    const { invitation, pkg } = await invitationContext(req);
    await requireBiddingLevel(app, req, reply, invitation.projectId, "read");
    return decorate(app.db, req.companyId!, pkg, invitation);
  });

  /* ---------------------------------------------------------------- */
  /* Delivery + engagement tracking                                    */
  /* ---------------------------------------------------------------- */

  async function mutate(
    req: FastifyRequest,
    reply: FastifyReply,
    apply: (
      invitation: BidInvitationRow,
      pkg: BidPackageRow,
    ) => Promise<{
      patch: Partial<typeof bidInvitations.$inferInsert>;
      payload: Record<string, unknown>;
    }>,
    action: "update" | "state_change" = "state_change",
  ) {
    const { invitation, pkg } = await invitationContext(req);
    await requireBiddingLevel(app, req, reply, invitation.projectId, "standard");
    const { patch, payload } = await apply(invitation, pkg);
    await app.db
      .update(bidInvitations)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(bidInvitations.id, invitation.id));
    await recountInvitations(app.db, invitation.packageId);
    await ledger(
      app.db,
      req,
      action,
      "bid_invitation",
      invitation.id,
      { projectId: invitation.projectId, packageId: invitation.packageId, ...payload },
      invitation.projectId,
    );
    const fresh = await fetchInvitation(app.db, invitation.id, invitation.companyId);
    return decorate(app.db, invitation.companyId, pkg, fresh);
  }

  app.post("/bid-invitations/:invitationId/send", { preHandler: companyGate }, async (req, reply) =>
    mutate(req, reply, async (inv, pkg) => {
      if (inv.status !== "draft") throw conflict(`This invitation is already ${inv.status}.`);
      if (!pkg.issuedAt) {
        throw conflict(
          "The package has not been issued yet. Approve and issue it before inviting bidders — " +
            "an invitation to an unapproved scope is an invitation to price the wrong job.",
        );
      }
      const now = new Date().toISOString();
      return {
        patch: { status: "sent", invitedAt: now, sentAt: now },
        payload: { to: "sent", contactEmail: inv.contactEmail },
      };
    }),
  );

  app.post(
    "/bid-invitations/:invitationId/delivery",
    { preHandler: companyGate },
    async (req, reply) =>
      mutate(req, reply, async (inv) => {
        const body = deliverySchema.parse(req.body);
        if (!inv.sentAt) throw conflict("This invitation has not been sent yet.");
        if ("delivered" in body) {
          return {
            patch: { status: "delivered", deliveredAt: new Date().toISOString(), bounceReason: null },
            payload: { to: "delivered" },
          };
        }
        return {
          patch: { status: "bounced", bounceReason: body.bounceReason },
          payload: { to: "bounced", bounceReason: body.bounceReason },
        };
      }),
  );

  app.post("/bid-invitations/:invitationId/view", { preHandler: companyGate }, async (req, reply) =>
    mutate(req, reply, async (inv) => {
      const now = new Date().toISOString();
      return {
        patch: {
          viewedAt: inv.viewedAt ?? now,
          status: inv.status === "sent" || inv.status === "delivered" ? "viewed" : inv.status,
        },
        payload: { event: "viewed" },
      };
    }, "update"),
  );

  app.post(
    "/bid-invitations/:invitationId/download",
    { preHandler: companyGate },
    async (req, reply) =>
      mutate(req, reply, async (inv) => {
        const now = new Date().toISOString();
        return {
          patch: {
            firstDownloadAt: inv.firstDownloadAt ?? now,
            downloadCount: inv.downloadCount + 1,
            viewedAt: inv.viewedAt ?? now,
            status: LIVE.includes(inv.status) && inv.status !== "intent_to_bid" && inv.status !== "submitted"
              ? "downloaded"
              : inv.status,
          },
          payload: { event: "downloaded", downloadCount: inv.downloadCount + 1 },
        };
      }, "update"),
  );

  app.post("/bid-invitations/:invitationId/intent", { preHandler: companyGate }, async (req, reply) =>
    mutate(req, reply, async (inv) => {
      const body = z.object({ intentToBid: z.boolean() }).parse(req.body);
      if (inv.status === "declined") {
        throw conflict("This bidder has already declined. Record a fresh invitation if they changed their mind.");
      }
      const now = new Date().toISOString();
      return {
        patch: {
          intentToBid: body.intentToBid ? 1 : 0,
          respondedAt: now,
          status: body.intentToBid ? "intent_to_bid" : inv.status,
        },
        payload: { event: "intent", intentToBid: body.intentToBid },
      };
    }),
  );

  /**
   * A decline always carries a reason from the fixed vocabulary, because the
   * PATTERN is the finding: a package where four of six bidders cite
   * `insufficient_time` is a procurement failure on our side, and that only
   * becomes visible if the reason is a value rather than a sentence.
   */
  app.post("/bid-invitations/:invitationId/decline", { preHandler: companyGate }, async (req, reply) =>
    mutate(req, reply, async (inv) => {
      const body = declineSchema.parse(req.body);
      if (inv.status === "submitted") {
        throw conflict("This bidder has already submitted; a submitted bid cannot then be declined.");
      }
      return {
        patch: {
          status: "declined",
          declineReason: body.reason,
          declineNote: body.note ?? null,
          respondedAt: new Date().toISOString(),
          intentToBid: 0,
        },
        payload: { to: "declined", reason: body.reason, note: body.note ?? null },
      };
    }),
  );

  app.post("/bid-invitations/:invitationId/remind", { preHandler: companyGate }, async (req, reply) =>
    mutate(req, reply, async (inv) => {
      if (inv.status === "declined" || inv.status === "submitted" || inv.status === "withdrawn") {
        throw conflict(`This bidder is ${inv.status}; there is nothing to remind them about.`);
      }
      return {
        patch: {
          remindersSent: inv.remindersSent + 1,
          lastReminderAt: new Date().toISOString(),
        },
        payload: { event: "reminder", remindersSent: inv.remindersSent + 1 },
      };
    }, "update"),
  );

  app.post(
    "/bid-invitations/:invitationId/acknowledge-addendum",
    { preHandler: companyGate },
    async (req, reply) =>
      mutate(req, reply, async (inv, pkg) => {
        const body = ackSchema.parse(req.body);
        const addenda = addendaOf(pkg);
        if (!addenda.some((a) => a.reference === body.addendumRef)) {
          throw badRequest(
            `Addendum "${body.addendumRef}" has not been issued on ${pkg.reference}.`,
          );
        }
        const existing = (inv.addendaAcknowledged as { addendumRef?: string }[]) ?? [];
        if (existing.some((a) => a.addendumRef === body.addendumRef)) {
          throw conflict(`This bidder has already acknowledged ${body.addendumRef}.`);
        }
        return {
          patch: {
            addendaAcknowledged: [
              ...existing,
              { addendumRef: body.addendumRef, acknowledgedAt: new Date().toISOString() },
            ],
          },
          payload: { event: "addendum_acknowledged", addendumRef: body.addendumRef },
        };
      }, "update"),
  );

  app.post(
    "/bid-invitations/:invitationId/disqualify",
    { preHandler: companyGate },
    async (req, reply) =>
      mutate(req, reply, async (inv) => {
        const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
        if (inv.status === "disqualified") throw conflict("This bidder is already disqualified.");
        return {
          patch: {
            status: "disqualified",
            disqualifiedReason: reason,
            disqualifiedBy: req.user!.id,
            disqualifiedAt: new Date().toISOString(),
          },
          payload: { to: "disqualified", reason },
        };
      }),
  );

  /* ---------------------------------------------------------------- */
  /* Bidder portal access — hashed, shown once                         */
  /* ---------------------------------------------------------------- */

  app.post(
    "/bid-invitations/:invitationId/portal-token",
    { preHandler: companyGate },
    async (req, reply) => {
      const { invitation } = await invitationContext(req);
      await requireBiddingLevel(app, req, reply, invitation.projectId, "standard");
      const token = mintPortalToken();
      await app.db
        .update(bidInvitations)
        .set({ portalTokenHash: token.hash, updatedAt: new Date().toISOString() })
        .where(eq(bidInvitations.id, invitation.id));
      await ledger(app.db, req, "create", "bid_invitation", invitation.id, {
        projectId: invitation.projectId,
        packageId: invitation.packageId,
        event: "portal_token_issued",
        // the DISPLAY prefix only; the token itself never reaches the ledger
        tokenPrefix: token.display,
        replacedPrevious: Boolean(invitation.portalTokenHash),
      }, invitation.projectId, true);
      return reply.status(201).send({
        token: token.raw,
        tokenPrefix: token.display,
        invitationId: invitation.id,
        note:
          "This token is shown once and is not recoverable. Only its sha256 is stored, exactly " +
          "as the platform's API tokens are, so nobody — including us — can read it back. " +
          "Issuing a new one replaces this immediately.",
      });
    },
  );

  app.delete(
    "/bid-invitations/:invitationId/portal-token",
    { preHandler: companyGate },
    async (req, reply) => {
      const { invitation } = await invitationContext(req);
      await requireBiddingLevel(app, req, reply, invitation.projectId, "standard");
      if (!invitation.portalTokenHash) throw notFound("No portal token has been issued.");
      await app.db
        .update(bidInvitations)
        .set({ portalTokenHash: null, updatedAt: new Date().toISOString() })
        .where(eq(bidInvitations.id, invitation.id));
      await ledger(app.db, req, "delete", "bid_invitation", invitation.id, {
        projectId: invitation.projectId,
        event: "portal_token_revoked",
      }, invitation.projectId);
      return reply.status(204).send();
    },
  );

  /**
   * The bidder's own view. No JWT, no session, no company membership:
   * `Authorization: Bearer bpt_…` verified by sha256 against the invitation,
   * exactly as the ingestion push endpoint verifies a machine caller.
   *
   * What comes back is deliberately narrow — the package, the timetable, the
   * requirements, the addenda they must acknowledge, and their own status.
   * Never the engineer's estimate, never another bidder's name, never a
   * price. A portal that leaks the estimate has priced the job for them.
   */
  async function portalSession(rawHeader: string | undefined) {
    if (!rawHeader?.startsWith("Bearer ")) throw unauthorized("Missing bidder portal token");
    const raw = rawHeader.slice(7).trim();
    if (!raw.startsWith(PORTAL_TOKEN_PREFIX)) throw unauthorized("Not a bidder portal token");
    const rows = await app.db
      .select()
      .from(bidInvitations)
      .where(eq(bidInvitations.portalTokenHash, sha256Hex(raw)))
      .limit(1);
    const invitation = rows[0];
    if (!invitation) throw unauthorized("Invalid or revoked bidder portal token");
    if (invitation.status === "disqualified" || invitation.status === "withdrawn") {
      throw unauthorized(`This invitation is ${invitation.status}.`);
    }
    const pkg = await fetchPackage(app.db, invitation.packageId, invitation.companyId);
    return { invitation, pkg };
  }

  function bidderView(invitation: BidInvitationRow, pkg: BidPackageRow) {
    const acknowledged = new Set(
      ((invitation.addendaAcknowledged as { addendumRef?: string }[]) ?? []).map(
        (a) => a.addendumRef,
      ),
    );
    return {
      invitation: {
        id: invitation.id,
        status: invitation.status,
        contactName: invitation.contactName,
        intentToBid: invitation.intentToBid === 1,
        declineReason: invitation.declineReason,
        addendaAcknowledged: invitation.addendaAcknowledged,
        submissionId: invitation.submissionId,
      },
      package: {
        reference: pkg.reference,
        title: pkg.title,
        scopeDescription: pkg.scopeDescription,
        packageKind: pkg.packageKind,
        currency: pkg.currency,
        documentFileIds: pkg.documentFileIds,
        specSectionIds: pkg.specSectionIds,
        drawingSheetIds: pkg.drawingSheetIds,
        isSealed: pkg.isSealed === 1,
      },
      timetable: timetableOf(pkg),
      requirements: requirementsOf(pkg),
      addenda: addendaOf(pkg).map((a) => ({
        reference: a.reference,
        description: a.description,
        fileIds: a.fileIds,
        issuedAt: a.issuedAt,
        requiresAcknowledgement: a.requiresAcknowledgement,
        acknowledged: acknowledged.has(a.reference),
      })),
      note:
        "This view shows your invitation only. It never shows the pre-tender estimate, the " +
        "other bidders, or any price.",
    };
  }

  app.post("/bid-portal/session", async (req) => {
    const { invitation, pkg } = await portalSession(req.headers.authorization);
    const now = new Date().toISOString();
    await app.db
      .update(bidInvitations)
      .set({
        portalLastAccessAt: now,
        viewedAt: invitation.viewedAt ?? now,
        status:
          invitation.status === "sent" || invitation.status === "delivered"
            ? "viewed"
            : invitation.status,
        updatedAt: now,
      })
      .where(eq(bidInvitations.id, invitation.id));
    // The bidder is not a platform user, so the ledger records the pathway
    // rather than an actor id — exactly as a machine push does.
    await appendLedger(app.db, {
      companyId: invitation.companyId,
      actorId: null,
      action: "access",
      objectType: "bid_invitation",
      objectId: invitation.id,
      payload: { event: "portal_access", via: "portal_token", vendorId: invitation.vendorId },
      projectId: invitation.projectId,
    });
    const fresh = await fetchInvitation(app.db, invitation.id, invitation.companyId);
    return bidderView(fresh, pkg);
  });

  app.post("/bid-portal/intent", async (req) => {
    const body = z
      .object({
        intentToBid: z.boolean(),
        declineReason: z.enum(BID_DECLINE_REASONS).optional(),
        declineNote: z.string().max(4000).optional(),
      })
      .parse(req.body);
    const { invitation, pkg } = await portalSession(req.headers.authorization);
    if (!body.intentToBid && !body.declineReason) {
      throw badRequest(
        "Declining requires a reason. A package that everyone declines for the same reason is a " +
          "failure on the buyer's side, and that only shows up if the reason is recorded.",
      );
    }
    const now = new Date().toISOString();
    await app.db
      .update(bidInvitations)
      .set({
        intentToBid: body.intentToBid ? 1 : 0,
        respondedAt: now,
        status: body.intentToBid ? "intent_to_bid" : "declined",
        declineReason: body.intentToBid ? null : (body.declineReason ?? null),
        declineNote: body.intentToBid ? null : (body.declineNote ?? null),
        portalLastAccessAt: now,
        updatedAt: now,
      })
      .where(eq(bidInvitations.id, invitation.id));
    await recountInvitations(app.db, invitation.packageId);
    const fresh = await fetchInvitation(app.db, invitation.id, invitation.companyId);
    return bidderView(fresh, pkg);
  });

  app.post("/bid-portal/acknowledge-addendum", async (req) => {
    const body = ackSchema.parse(req.body);
    const { invitation, pkg } = await portalSession(req.headers.authorization);
    const addenda = addendaOf(pkg);
    if (!addenda.some((a) => a.reference === body.addendumRef)) {
      throw badRequest(`Addendum "${body.addendumRef}" has not been issued on this package.`);
    }
    const existing = (invitation.addendaAcknowledged as { addendumRef?: string }[]) ?? [];
    if (!existing.some((a) => a.addendumRef === body.addendumRef)) {
      await app.db
        .update(bidInvitations)
        .set({
          addendaAcknowledged: [
            ...existing,
            { addendumRef: body.addendumRef, acknowledgedAt: new Date().toISOString() },
          ],
          portalLastAccessAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bidInvitations.id, invitation.id));
    }
    const fresh = await fetchInvitation(app.db, invitation.id, invitation.companyId);
    return bidderView(fresh, pkg);
  });
};
