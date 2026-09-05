import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { bidDocumentAccess, bidInvitations, bidPackages, vendors } from "@constructos/db";
import {
  BID_DECLINE_REASONS,
  BID_DOCUMENT_ACCESS_KINDS,
  BID_INVITATION_STATUSES,
} from "@constructos/shared";
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
  batchVendorPrequalStatus,
  effectiveLimit,
  evaluatePrequalGate,
  sweepPrequalification,
  vendorPrequalStatus,
  type VendorPrequalStatus,
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

/** How long a bidder token outlives the deadline it was issued against. */
export const PORTAL_TOKEN_TAIL_DAYS = 7;

/**
 * When a bidder's portal access ends: the bid deadline plus a tail, or — for
 * a package with no deadline yet — the tail from now. A credential with no
 * expiry outlives the tender it belongs to, and the tender is the only reason
 * the holder was ever trusted.
 */
export function portalTokenExpiry(
  pkg: BidPackageRow,
  tailDays: number = PORTAL_TOKEN_TAIL_DAYS,
  now: Date = new Date(),
): string {
  const base = pkg.bidDueAt ? Date.parse(pkg.bidDueAt) : now.getTime();
  const from = Number.isFinite(base) ? base : now.getTime();
  return new Date(Math.max(from, now.getTime()) + tailDays * 86_400_000).toISOString();
}

/**
 * RESOLVE A BIDDER FROM A TOKEN, AND NOTHING ELSE.
 *
 * `Authorization: Bearer bpt_…` verified by sha256 against the invitation —
 * no JWT, no session, no company membership. Lifted out of the invitations
 * plugin so every portal route in this module resolves the bidder through
 * ONE function: a portal that authenticates in two places authenticates
 * differently in two places, and the second one is where the expiry check
 * gets forgotten.
 *
 * The four refusals, in order: not a portal token; not a live token; the
 * invitation is finished; the token has expired; the tender is over.
 */
export async function resolvePortalSession(
  db: Db,
  rawHeader: string | undefined,
): Promise<{ invitation: BidInvitationRow; pkg: BidPackageRow }> {
  if (!rawHeader?.startsWith("Bearer ")) throw unauthorized("Missing bidder portal token");
  const raw = rawHeader.slice(7).trim();
  if (!raw.startsWith(PORTAL_TOKEN_PREFIX)) throw unauthorized("Not a bidder portal token");
  const rows = await db
    .select()
    .from(bidInvitations)
    .where(eq(bidInvitations.portalTokenHash, sha256Hex(raw)))
    .limit(1);
  const invitation = rows[0];
  if (!invitation) throw unauthorized("Invalid or revoked bidder portal token");
  if (invitation.status === "disqualified" || invitation.status === "withdrawn") {
    throw unauthorized(`This invitation is ${invitation.status}.`);
  }
  if (invitation.portalTokenExpiresAt && Date.parse(invitation.portalTokenExpiresAt) < Date.now()) {
    throw unauthorized(
      `This bidder portal link expired on ${invitation.portalTokenExpiresAt}. A tender access ` +
        "credential that never expires is a credential that outlives the tender; ask the " +
        "buyer for a new one if the package is still live.",
    );
  }
  const pkg = await fetchPackage(db, invitation.packageId, invitation.companyId);
  if (pkg.status === "awarded" || pkg.status === "cancelled") {
    throw unauthorized(
      `${pkg.reference} is ${pkg.status}; the bidder portal for it is closed. The award and ` +
        "the debrief are communicated directly, not through a tender portal that is still " +
        "accepting responses.",
    );
  }
  return { invitation, pkg };
}

/** Ledger an action a BIDDER took, with the pathway instead of an actor. */
export async function ledgerPortalAction(
  db: Db,
  invitation: BidInvitationRow,
  action: "access" | "create" | "update" | "state_change",
  payload: Record<string, unknown>,
): Promise<void> {
  await appendLedger(db, {
    companyId: invitation.companyId,
    actorId: null,
    action,
    objectType: "bid_invitation",
    objectId: invitation.id,
    payload: { via: "portal_token", vendorId: invitation.vendorId, ...payload },
    projectId: invitation.projectId,
    storePayload: true,
  });
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
   *
   * `standing` is passed in rather than fetched, because this used to run
   * four queries per invitation: a list of 200 invitations issued roughly 600
   * statements and got slower every time the supply chain grew. See
   * `decorateMany`.
   */
  function decorateOne(
    pkg: BidPackageRow,
    inv: BidInvitationRow,
    status: VendorPrequalStatus,
  ) {
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
      portal: {
        issued: Boolean(inv.portalTokenHash),
        expiresAt: inv.portalTokenExpiresAt,
        expired:
          Boolean(inv.portalTokenHash) &&
          inv.portalTokenExpiresAt !== null &&
          Date.parse(inv.portalTokenExpiresAt) < Date.now(),
        lastAccessAt: inv.portalLastAccessAt,
      },
    };
  }

  /** Standing for every vendor in one batch, then decorate in memory. */
  async function decorateMany(
    db: Db,
    companyId: string,
    pkg: BidPackageRow,
    rows: readonly BidInvitationRow[],
  ) {
    const standing = await batchVendorPrequalStatus(
      db,
      companyId,
      rows.map((r) => r.vendorId),
    );
    return rows.map((row) =>
      decorateOne(
        pkg,
        row,
        standing.get(row.vendorId) ?? {
          vendorId: row.vendorId,
          vendorName: null,
          submissionId: null,
          reference: null,
          questionnaireId: null,
          status: null,
          outcome: null,
          state: "none",
          validFrom: null,
          expiresAt: null,
          daysToExpiry: null,
          singleProjectLimit: null,
          aggregateLimit: null,
          currency: null,
          tradeScopeApproved: [],
          conditions: null,
          knockoutFailed: false,
          knockoutReason: null,
          recommendedLimit: null,
          note: "This vendor is not in the directory for this company.",
        },
      ),
    );
  }

  async function decorate(db: Db, companyId: string, pkg: BidPackageRow, inv: BidInvitationRow) {
    const [only] = await decorateMany(db, companyId, pkg, [inv]);
    return only!;
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
      const standing = await batchVendorPrequalStatus(
        app.db,
        companyId,
        wanted.map((w) => w.vendorId),
      );
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
        const status =
          standing.get(item.vendorId) ??
          (await vendorPrequalStatus(app.db, companyId, item.vendorId));
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
          /*
           * A vendor whose approval is valid but inside its 60-day renewal
           * window is state "expiring" — the gate passes them, they may bid,
           * and they may be awarded. Recording them as NOT prequalified made
           * every downstream consumer of `is_prequalified` misread them. The
           * expiry is recorded separately, which is where the urgency lives.
           */
          isPrequalified: gate.ok ? 1 : 0,
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
      const items = await decorateMany(app.db, companyId, pkg, rows);
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
      const items = await decorateMany(app.db, req.companyId!, pkg, rows);
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
      const pkg = await fetchPackage(app.db, invitation.packageId, req.companyId!);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(
          `${pkg.reference} is ${pkg.status}. A bidder portal token issued now would open a ` +
            "tender that is over.",
        );
      }
      const body = z
        .object({ validityDays: z.number().int().min(1).max(365).optional() })
        .parse(req.body ?? {});
      const token = mintPortalToken();
      /*
       * A BIDDER TOKEN EXPIRES. It used to be permanent: valid after the
       * deadline, after the award and after the package was cancelled, so a
       * tender that closed in March was still readable in November by anyone
       * holding the link. The default life is the bid deadline plus a tail
       * long enough to cover the debrief.
       */
      const expiresAt = portalTokenExpiry(pkg, body.validityDays ?? PORTAL_TOKEN_TAIL_DAYS);
      await app.db
        .update(bidInvitations)
        .set({
          portalTokenHash: token.hash,
          portalTokenExpiresAt: expiresAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(bidInvitations.id, invitation.id));
      await ledger(app.db, req, "create", "bid_invitation", invitation.id, {
        projectId: invitation.projectId,
        packageId: invitation.packageId,
        event: "portal_token_issued",
        // the DISPLAY prefix only; the token itself never reaches the ledger
        tokenPrefix: token.display,
        expiresAt,
        replacedPrevious: Boolean(invitation.portalTokenHash),
      }, invitation.projectId, true);
      return reply.status(201).send({
        token: token.raw,
        tokenPrefix: token.display,
        invitationId: invitation.id,
        expiresAt,
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
  const portalSession = (rawHeader: string | undefined) =>
    resolvePortalSession(app.db, rawHeader);

  const ledgerPortal = (
    invitation: BidInvitationRow,
    action: "access" | "update" | "state_change",
    payload: Record<string, unknown>,
  ) => ledgerPortalAction(app.db, invitation, action, payload);

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
    /*
     * A BIDDER WHO HAS SUBMITTED CANNOT THEN DECLINE. The staff-side route
     * refuses exactly this; the portal did not, so a bidder could withdraw a
     * bid the buyer already held by flipping a boolean, with no reason, no
     * withdrawal record and no ledger entry.
     */
    if (
      !body.intentToBid &&
      (invitation.status === "submitted" ||
        invitation.status === "disqualified" ||
        invitation.status === "withdrawn")
    ) {
      throw conflict(
        `This invitation is ${invitation.status}. A bid that has been submitted is withdrawn ` +
          "through the buyer, with a reason on the record — not by changing an intention.",
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
    await ledgerPortal(invitation, "state_change", {
      packageId: invitation.packageId,
      packageReference: pkg.reference,
      event: body.intentToBid ? "portal_intent_to_bid" : "portal_declined",
      intentToBid: body.intentToBid,
      declineReason: body.intentToBid ? null : (body.declineReason ?? null),
      declineNote: body.intentToBid ? null : (body.declineNote ?? null),
      from: invitation.status,
    });
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
      await ledgerPortal(invitation, "update", {
        packageId: invitation.packageId,
        packageReference: pkg.reference,
        event: "portal_addendum_acknowledged",
        addendumRef: body.addendumRef,
      });
    }
    const fresh = await fetchInvitation(app.db, invitation.id, invitation.companyId);
    return bidderView(fresh, pkg);
  });

  /* ---------------------------------------------------------------- */
  /* Bidder document access — logged per file, per bidder (#169)       */
  /* ---------------------------------------------------------------- */

  /**
   * A bidder telling us they opened a document.
   *
   * The log answers the two questions a procurement challenge asks: did every
   * bidder receive the same documents, and did the one complaining about the
   * addendum ever open it. It is deliberately an assertion by the portal
   * rather than a proxied download — this platform does not serve the tender
   * files itself — so what it proves is that the bidder's client said it
   * fetched them, which is exactly what a download log ever proves.
   */
  app.post("/bid-portal/document-access", async (req, reply) => {
    const body = z
      .object({
        fileId: z.string().min(1).max(64),
        fileName: z.string().max(400).nullable().optional(),
        documentKind: z
          .enum(["tender_document", "addendum", "drawing", "specification", "other"])
          .default("tender_document"),
        addendumRef: z.string().max(60).nullable().optional(),
        accessKind: z.enum(BID_DOCUMENT_ACCESS_KINDS).default("download"),
      })
      .parse(req.body);
    const { invitation, pkg } = await portalSession(req.headers.authorization);
    const known = new Set<string>([
      ...((pkg.documentFileIds as string[]) ?? []),
      ...addendaOf(pkg).flatMap((a) => a.fileIds ?? []),
    ]);
    if (!known.has(body.fileId)) {
      throw badRequest(
        `File ${body.fileId} is not one of the documents issued with ${pkg.reference}. A bidder ` +
          "cannot record access to a file the tender never carried.",
      );
    }
    const now = new Date().toISOString();
    await app.db.insert(bidDocumentAccess).values({
      id: newId("bda"),
      companyId: invitation.companyId,
      projectId: invitation.projectId,
      packageId: invitation.packageId,
      invitationId: invitation.id,
      vendorId: invitation.vendorId,
      fileId: body.fileId,
      fileName: body.fileName ?? null,
      documentKind: body.documentKind,
      addendumRef: body.addendumRef ?? null,
      accessKind: body.accessKind,
      via: "portal_token",
      actorId: null,
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 400) || null,
      accessedAt: now,
    });
    if (body.accessKind === "download") {
      await app.db
        .update(bidInvitations)
        .set({
          downloadCount: invitation.downloadCount + 1,
          firstDownloadAt: invitation.firstDownloadAt ?? now,
          viewedAt: invitation.viewedAt ?? now,
          portalLastAccessAt: now,
          status:
            LIVE.includes(invitation.status) &&
            invitation.status !== "intent_to_bid" &&
            invitation.status !== "submitted"
              ? "downloaded"
              : invitation.status,
          updatedAt: now,
        })
        .where(eq(bidInvitations.id, invitation.id));
    }
    await ledgerPortal(invitation, "access", {
      packageId: invitation.packageId,
      packageReference: pkg.reference,
      event: "portal_document_access",
      fileId: body.fileId,
      documentKind: body.documentKind,
      addendumRef: body.addendumRef ?? null,
      accessKind: body.accessKind,
    });
    return reply.status(201).send({
      recorded: true,
      fileId: body.fileId,
      accessKind: body.accessKind,
      at: now,
    });
  });

  /**
   * The access log for one package — who opened what, and who never did.
   * `neverAccessed` is the useful half: a bidder who submitted a price
   * without ever opening the drawings priced something else.
   */
  app.get(
    "/projects/:projectId/bid-packages/:packageId/document-access",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(bidDocumentAccess)
        .where(eq(bidDocumentAccess.packageId, packageId))
        .orderBy(desc(bidDocumentAccess.accessedAt))
        .limit(1000);
      const invites = await app.db
        .select()
        .from(bidInvitations)
        .where(eq(bidInvitations.packageId, packageId));
      const vendorIds = [...new Set(invites.map((i) => i.vendorId))];
      const vendorRows = vendorIds.length
        ? await app.db
            .select({ id: vendors.id, name: vendors.name })
            .from(vendors)
            .where(inArray(vendors.id, vendorIds))
        : [];
      const names = new Map(vendorRows.map((v) => [v.id, v.name] as const));
      const files = [
        ...((pkg.documentFileIds as string[]) ?? []).map((fileId) => ({
          fileId,
          documentKind: "tender_document" as const,
          addendumRef: null as string | null,
        })),
        ...addendaOf(pkg).flatMap((a) =>
          (a.fileIds ?? []).map((fileId) => ({
            fileId,
            documentKind: "addendum" as const,
            addendumRef: a.reference,
          })),
        ),
      ];
      return {
        items: rows.map((r) => ({ ...r, vendorName: names.get(r.vendorId ?? "") ?? null })),
        total: rows.length,
        files,
        byVendor: invites.map((inv) => {
          const mine = rows.filter((r) => r.vendorId === inv.vendorId);
          const opened = new Set(mine.map((r) => r.fileId));
          return {
            vendorId: inv.vendorId,
            vendorName: names.get(inv.vendorId) ?? null,
            invitationId: inv.id,
            status: inv.status,
            accesses: mine.length,
            filesOpened: opened.size,
            filesIssued: files.length,
            neverAccessed: files.filter((f) => !opened.has(f.fileId)).map((f) => f.fileId),
            firstAccessAt: mine.length ? (mine[mine.length - 1]?.accessedAt ?? null) : null,
            lastAccessAt: mine.length ? (mine[0]?.accessedAt ?? null) : null,
          };
        }),
        note:
          "A bidder who priced a package without ever opening its drawings priced something " +
          "else. The log records what each bidder's portal reported fetching; where a bidder " +
          "received the documents by another route, that route is not in here and the gap is " +
          "not evidence on its own.",
      };
    },
  );
};
