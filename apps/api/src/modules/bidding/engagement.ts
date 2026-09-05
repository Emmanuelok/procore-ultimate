import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  bidBonds,
  bidDocumentAccess,
  bidInvitations,
  bidMeetingAttendees,
  bidMeetings,
  bidPackages,
  bidQuestions,
  bidSubmissions,
  obligations,
  vendors,
} from "@constructos/db";
import {
  BID_BOND_STATUSES,
  BID_MEETING_ATTENDANCE,
  BID_MEETING_KINDS,
  BID_QUESTION_CATEGORIES,
  BID_QUESTION_STATUSES,
  BOND_TYPES,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { epochMs } from "../../lib/time.js";
import type { Db } from "../../lib/db.js";
import {
  assertVendor,
  currencySchema,
  detailSchema,
  fetchPackage,
  isoDateSchema,
  isoTimestampSchema,
  justificationSchema,
  ledger,
  nonNegativeMoneySchema,
  pad4,
  percentSchema,
  reasonSchema,
  round2,
  todayIso,
  type BidPackageRow,
} from "./shared.js";
import { addendaOf } from "./packages.js";
import { ledgerPortalAction, resolvePortalSession } from "./invitations.js";

/**
 * WHAT HAPPENS BETWEEN ISSUING A TENDER AND RECEIVING THE BIDS.
 *
 * Three registers, and one control runs through all of them: EVERY BIDDER
 * MUST BE ANSWERING THE SAME QUESTION.
 *
 *  TENDER QUERIES (#182). A bidder asks; the buyer answers; and the answer
 *    goes to EVERYONE. An answer given to one bidder and not the others is
 *    not a favour, it is a defect in the procurement — the others priced a
 *    different job. So the question is anonymised (the fact that the
 *    incumbent asked about the existing services tells the others something)
 *    and publishing it issues an addendum, which is the mechanism the rest of
 *    the module already uses to say "the question changed".
 *
 *  PRE-BID MEETINGS AND SITE VISITS (#181). Attendance is the record that
 *    matters, because a mandatory site visit somebody did not attend is a
 *    compliance finding on their bid, and "they were all told the same thing
 *    on the day" is only defensible with a minute and a register.
 *
 *  BID BONDS (#183). The security against a winning bidder walking away. It
 *    has an expiry, and an expired bid bond on a live tender is a hole in the
 *    arrangement rather than a filing problem — so expiry is swept and raises
 *    an obligation before it raises a surprise.
 *
 * DELIBERATELY NOT HERE: the buyer's own internal Q&A, and any answer that
 * cannot be published. A private answer is supported (`isPrivate`) but it
 * requires a stated reason, because the default has to be that everyone hears
 * it.
 */

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const questionCreateSchema = z.object({
  question: z.string().trim().min(5).max(8000),
  category: z.enum(BID_QUESTION_CATEGORIES).default("scope"),
  invitationId: z.string().min(1).max(64).nullable().optional(),
  vendorId: z.string().min(1).max(64).nullable().optional(),
  askedAt: isoTimestampSchema.nullable().optional(),
  specSectionId: z.string().min(1).max(64).nullable().optional(),
  drawingSheetId: z.string().min(1).max(64).nullable().optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  detail: detailSchema.optional(),
});

const answerSchema = z.object({
  answer: z.string().trim().min(5).max(20000),
  /** the question as it will be published — names and hints removed */
  anonymisedQuestion: z.string().trim().min(5).max(8000).nullable().optional(),
  isPrivate: z.boolean().default(false),
  /** REQUIRED when the answer is not published to every bidder */
  privateReason: justificationSchema.nullable().optional(),
});

const publishSchema = z.object({
  addendumReference: z.string().trim().min(1).max(60),
  description: z.string().max(8000).optional(),
  questionIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  newBidDueAt: isoTimestampSchema.nullable().optional(),
});

const meetingCreateSchema = z.object({
  kind: z.enum(BID_MEETING_KINDS).default("pre_bid"),
  title: z.string().trim().min(1).max(300),
  scheduledAt: isoTimestampSchema,
  durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  location: z.string().max(400).nullable().optional(),
  meetingUrl: z.string().max(1000).nullable().optional(),
  isMandatory: z.boolean().default(false),
  agenda: z.string().max(20000).nullable().optional(),
  chairedBy: z.string().min(1).max(64).nullable().optional(),
  detail: detailSchema.optional(),
});

const attendanceSchema = z.object({
  attendees: z
    .array(
      z.object({
        vendorId: z.string().min(1).max(64).nullable().optional(),
        invitationId: z.string().min(1).max(64).nullable().optional(),
        attendeeName: z.string().trim().min(1).max(200).nullable().optional(),
        attendeeEmail: z.string().trim().email().max(320).nullable().optional(),
        attendance: z.enum(BID_MEETING_ATTENDANCE).default("attended"),
        note: z.string().max(2000).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const bondCreateSchema = z.object({
  vendorId: z.string().min(1).max(64),
  invitationId: z.string().min(1).max(64).nullable().optional(),
  submissionId: z.string().min(1).max(64).nullable().optional(),
  bondType: z.enum(BOND_TYPES).default("bid"),
  requiredPercent: percentSchema.nullable().optional(),
  requiredAmount: nonNegativeMoneySchema.nullable().optional(),
  providedAmount: nonNegativeMoneySchema.nullable().optional(),
  currency: currencySchema.optional(),
  provider: z.string().max(300).nullable().optional(),
  bondNumber: z.string().max(200).nullable().optional(),
  issuedAt: isoDateSchema.nullable().optional(),
  validFrom: isoDateSchema.nullable().optional(),
  expiresAt: isoDateSchema.nullable().optional(),
  fileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  detail: detailSchema.optional(),
});

export const questionReference = (n: number): string => `TQ-${pad4(n)}`;

/* ------------------------------------------------------------------ */
/* Bid bond expiry sweep                                               */
/* ------------------------------------------------------------------ */

export interface BondSweepResult {
  expired: string[];
  obligationsRaised: string[];
  notes: string[];
}

/**
 * Bid bonds that have run out, and those about to.
 *
 * A bid bond that expires before the award means the security the tender was
 * conducted on no longer exists: if the winner walks away there is nothing to
 * draw on and nothing to fund the re-tender. Idempotent — an obligation is
 * raised once per bond and an already-expired bond is not expired twice.
 */
export async function sweepBidBonds(
  db: Db,
  companyId: string,
  actorId: string | null,
  asOf: string = todayIso(),
): Promise<BondSweepResult> {
  const result: BondSweepResult = { expired: [], obligationsRaised: [], notes: [] };
  const horizon = new Date(`${asOf}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  const rows = await db
    .select()
    .from(bidBonds)
    .where(
      and(
        eq(bidBonds.companyId, companyId),
        isNotNull(bidBonds.expiresAt),
        lte(bidBonds.expiresAt, horizon.toISOString().slice(0, 10)),
        inArray(bidBonds.status, ["received", "verified", "requested", "required"]),
      ),
    );
  if (rows.length === 0) return result;

  for (const bond of rows) {
    const expiry = bond.expiresAt;
    if (!expiry) continue;
    if (expiry < asOf) {
      const flipped = await db
        .update(bidBonds)
        .set({ status: "expired", updatedAt: new Date().toISOString() })
        .where(and(eq(bidBonds.id, bond.id), inArray(bidBonds.status, ["received", "verified"])))
        .returning({ id: bidBonds.id });
      if (flipped.length > 0) {
        result.expired.push(bond.id);
        await appendLedger(db, {
          companyId,
          projectId: bond.projectId,
          actorId,
          action: "state_change",
          objectType: "bid_bond",
          objectId: bond.id,
          payload: {
            to: "expired",
            expiresAt: expiry,
            vendorId: bond.vendorId,
            packageId: bond.packageId,
            derived: true,
          },
        });
      }
      if (bond.obligationId) {
        await db
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, bond.obligationId), eq(obligations.status, "open")));
      }
      continue;
    }
    if (!bond.obligationId) {
      const obligationId = newId("obl");
      await db.insert(obligations).values({
        id: obligationId,
        companyId,
        projectId: bond.projectId,
        sourceClause: `bid bond ${bond.bondNumber ?? bond.id} — expiry`,
        trigger:
          `The bid bond lodged by this bidder expires on ${expiry}, before the tender is ` +
          "concluded. Extend it or replace it: a tender running on an expired bond has no " +
          "security behind it at the moment it most needs one.",
        deadline: `${expiry}T23:59:59Z`,
        warnDaysBefore: 14,
        evidenceRequirement: "An extended or replacement bond instrument, verified by somebody other than the bidder",
        status: "open",
        createdBy: actorId ?? "system",
      });
      await db
        .update(bidBonds)
        .set({ obligationId, updatedAt: new Date().toISOString() })
        .where(eq(bidBonds.id, bond.id));
      result.obligationsRaised.push(obligationId);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export const engagementRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("bidding", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("bidding", "standard"),
  ];

  async function vendorNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(inArray(vendors.id, unique));
    return new Map(rows.map((v) => [v.id, v.name] as const));
  }

  /* ================================================================ */
  /* Tender queries (#182)                                            */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/questions",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = questionCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package cannot take new tender queries.`);
      }
      let vendorId = body.vendorId ?? null;
      if (body.invitationId) {
        const [inv] = await app.db
          .select()
          .from(bidInvitations)
          .where(
            and(
              eq(bidInvitations.id, body.invitationId),
              eq(bidInvitations.companyId, companyId),
              eq(bidInvitations.packageId, packageId),
            ),
          )
          .limit(1);
        if (!inv) {
          throw badRequest("That invitation is not on this package in this company.");
        }
        vendorId = inv.vendorId;
      }
      if (vendorId) await assertVendor(app.db, vendorId, companyId);

      const askedAt = body.askedAt ?? new Date().toISOString();
      const lateWarning =
        pkg.questionsDueAt && (epochMs(askedAt) ?? 0) > (epochMs(pkg.questionsDueAt) ?? 0)
          ? `This query arrived after the questions deadline of ${pkg.questionsDueAt}. It is ` +
            "recorded, but answering it now hands one bidder information the others had no " +
            "chance to ask for — publish the answer to everyone or refuse the query."
          : null;

      /*
       * ATOMIC, NOT count()+1. `bid_questions` carries a unique index on
       * (package_id, number), so two queries logged in the same second — one
       * by staff, one arriving through the bidder portal — computed the same
       * number and the second insert died on the index with an unhandled 500.
       * A tender query that vanishes because two bidders asked at once is the
       * exact failure the register exists to prevent.
       */
      const number = await nextRecordNumber(app.db, packageId, "bid_question");
      const id = newId("bqn");
      await app.db.insert(bidQuestions).values({
        id,
        companyId,
        projectId,
        packageId,
        invitationId: body.invitationId ?? null,
        vendorId,
        number,
        reference: questionReference(number),
        category: body.category,
        question: body.question,
        askedAt,
        status: "submitted",
        specSectionId: body.specSectionId ?? null,
        drawingSheetId: body.drawingSheetId ?? null,
        fileIds: body.fileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      if (body.invitationId) {
        const [inv] = await app.db
          .select({ questionsAsked: bidInvitations.questionsAsked })
          .from(bidInvitations)
          .where(eq(bidInvitations.id, body.invitationId))
          .limit(1);
        await app.db
          .update(bidInvitations)
          .set({
            questionsAsked: (inv?.questionsAsked ?? 0) + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(bidInvitations.id, body.invitationId));
      }
      await ledger(app.db, req, "create", "bid_question", id, {
        projectId,
        packageId,
        packageReference: pkg.reference,
        reference: questionReference(number),
        category: body.category,
        vendorId,
        askedAfterDeadline: Boolean(lateWarning),
      }, projectId, true);
      const [created] = await app.db
        .select()
        .from(bidQuestions)
        .where(eq(bidQuestions.id, id))
        .limit(1);
      return reply.status(201).send({ ...created, lateWarning });
    },
  );

  /**
   * THE BIDDER'S OWN QUESTION (#182, #168).
   *
   * A tender query asked through the bidder portal, with no platform account:
   * the vendor and the invitation come from the token, never from the body,
   * so a bidder cannot log a question against somebody else's invitation.
   *
   * It lands in the SAME register as a query taken by phone and typed in by
   * the buyer, at status `submitted`, and it is answered and published through
   * the same route — because the control that matters is that every bidder
   * ends up answering the same question, and that control cannot depend on
   * which door the question came through.
   */
  app.post("/bid-portal/questions", async (req, reply) => {
    const body = z
      .object({
        question: z.string().trim().min(1).max(20000),
        category: z.enum(BID_QUESTION_CATEGORIES).default("scope"),
        specSectionId: z.string().min(1).max(64).nullable().optional(),
        drawingSheetId: z.string().min(1).max(64).nullable().optional(),
        fileIds: z.array(z.string().min(1).max(64)).max(20).optional(),
      })
      .parse(req.body);
    const { invitation, pkg } = await resolvePortalSession(app.db, req.headers.authorization);
    if (pkg.status === "draft") {
      throw conflict(
        `${pkg.reference} has not been issued, so there is nothing to ask about yet.`,
      );
    }
    const askedAt = new Date().toISOString();
    const lateWarning =
      pkg.questionsDueAt && (epochMs(askedAt) ?? 0) > (epochMs(pkg.questionsDueAt) ?? 0)
        ? `The questions deadline for ${pkg.reference} passed at ${pkg.questionsDueAt}. Your ` +
          "query is recorded, but the buyer may decline to answer it: an answer given after " +
          "the deadline hands one bidder information the others had no chance to ask for."
        : null;

    const number = await nextRecordNumber(app.db, pkg.id, "bid_question");
    const id = newId("bqn");
    await app.db.insert(bidQuestions).values({
      id,
      companyId: invitation.companyId,
      projectId: invitation.projectId,
      packageId: pkg.id,
      invitationId: invitation.id,
      vendorId: invitation.vendorId,
      number,
      reference: questionReference(number),
      category: body.category,
      question: body.question,
      askedAt,
      status: "submitted",
      specSectionId: body.specSectionId ?? null,
      drawingSheetId: body.drawingSheetId ?? null,
      fileIds: body.fileIds ?? [],
      detail: { via: "portal_token" },
      // A bidder is not a platform user; the pathway stands in for the actor.
      createdBy: null,
    });
    const now = new Date().toISOString();
    await app.db
      .update(bidInvitations)
      .set({
        questionsAsked: invitation.questionsAsked + 1,
        portalLastAccessAt: now,
        updatedAt: now,
      })
      .where(eq(bidInvitations.id, invitation.id));
    await ledgerPortalAction(app.db, invitation, "create", {
      packageId: pkg.id,
      packageReference: pkg.reference,
      event: "portal_question_asked",
      questionId: id,
      reference: questionReference(number),
      category: body.category,
      askedAfterDeadline: Boolean(lateWarning),
    });
    return reply.status(201).send({
      id,
      reference: questionReference(number),
      status: "submitted",
      askedAt,
      lateWarning,
      note:
        "Your question is with the buyer. When it is answered, the answer is published to " +
        "every bidder on this package as an addendum — anonymised, so the fact that you asked " +
        "it does not tell your competitors anything.",
    });
  });

  /**
   * What was issued with this tender, from the bidder's side: the documents,
   * the addenda, and which of them this bidder has already recorded opening.
   * The platform does not serve the files themselves, so what comes back is
   * the manifest — the thing a bidder needs in order to notice that they are
   * missing addendum 3.
   */
  app.get("/bid-portal/documents", async (req) => {
    const { invitation, pkg } = await resolvePortalSession(app.db, req.headers.authorization);
    const opened = await app.db
      .select({ fileId: bidDocumentAccess.fileId, accessedAt: bidDocumentAccess.accessedAt })
      .from(bidDocumentAccess)
      .where(
        and(
          eq(bidDocumentAccess.packageId, pkg.id),
          eq(bidDocumentAccess.invitationId, invitation.id),
        ),
      );
    const firstSeen = new Map<string, string>();
    for (const row of opened) {
      const prior = firstSeen.get(row.fileId);
      if (!prior || row.accessedAt < prior) firstSeen.set(row.fileId, row.accessedAt);
    }
    const acknowledged = new Set(
      ((invitation.addendaAcknowledged as { addendumRef?: string }[]) ?? []).map(
        (a) => a.addendumRef,
      ),
    );
    const files = [
      ...((pkg.documentFileIds as string[]) ?? []).map((fileId) => ({
        fileId,
        documentKind: "tender_document" as const,
        addendumRef: null as string | null,
        requiresAcknowledgement: false,
        acknowledged: null as boolean | null,
      })),
      ...addendaOf(pkg).flatMap((a) =>
        (a.fileIds ?? []).map((fileId) => ({
          fileId,
          documentKind: "addendum" as const,
          addendumRef: a.reference,
          requiresAcknowledgement: a.requiresAcknowledgement,
          acknowledged: acknowledged.has(a.reference),
        })),
      ),
    ].map((f) => ({ ...f, firstOpenedAt: firstSeen.get(f.fileId) ?? null }));
    return {
      package: { reference: pkg.reference, title: pkg.title },
      files,
      total: files.length,
      unopened: files.filter((f) => f.firstOpenedAt === null).length,
      outstandingAcknowledgements: files
        .filter((f) => f.requiresAcknowledgement && f.acknowledged === false)
        .map((f) => f.addendumRef)
        .filter((r): r is string => r !== null),
      note:
        "Record each download through /bid-portal/document-access. The log is what answers " +
        "'did every bidder receive the same documents' if this award is ever challenged.",
    };
  });

  app.get(
    "/projects/:projectId/bid-packages/:packageId/questions",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const q = pageQuerySchema
        .extend({ status: z.enum(BID_QUESTION_STATUSES).optional() })
        .parse(req.query);
      await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const filters = [eq(bidQuestions.packageId, packageId)];
      if (q.status) filters.push(eq(bidQuestions.status, q.status));
      const where = and(...filters);
      const [totalRow] = await app.db.select({ n: count() }).from(bidQuestions).where(where);
      const rows = await app.db
        .select()
        .from(bidQuestions)
        .where(where)
        .orderBy(asc(bidQuestions.number))
        .limit(q.pageSize)
        .offset(pageOffset(q));
      const names = await vendorNames(
        app.db,
        rows.map((r) => r.vendorId ?? ""),
      );
      const unanswered = rows.filter(
        (r) => r.status === "submitted" || r.status === "under_review",
      ).length;
      const answeredNotPublished = rows.filter((r) => r.status === "answered").length;
      return {
        ...paginate(
          rows.map((r) => ({
            ...r,
            vendorName: r.vendorId ? (names.get(r.vendorId) ?? null) : null,
            isPrivate: r.isPrivate === 1,
          })),
          Number(totalRow?.n ?? 0),
          q,
        ),
        summary: {
          unanswered,
          answeredNotPublished,
          published: rows.filter((r) => r.status === "published").length,
        },
        note:
          answeredNotPublished > 0
            ? `${answeredNotPublished} query(ies) are answered but not yet published. Until they ` +
              "are, one bidder holds an answer the others do not, and the bids are not " +
              "comparable."
            : "An answer published as an addendum reaches every live invitation; that is what " +
              "keeps the bidders answering the same question.",
      };
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/questions/:questionId/answer",
    { preHandler: standardGate },
    async (req) => {
      const { packageId, questionId } = req.params as { packageId: string; questionId: string };
      const body = answerSchema.parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const [question] = await app.db
        .select()
        .from(bidQuestions)
        .where(
          and(
            eq(bidQuestions.id, questionId),
            eq(bidQuestions.companyId, req.companyId!),
            eq(bidQuestions.packageId, packageId),
          ),
        )
        .limit(1);
      if (!question) throw notFound("Tender query not found on this package");
      if (question.status === "published") {
        throw conflict(
          `${question.reference} has already been published as ${question.publishedAddendumRef}. ` +
            "Re-answering a published query would leave two answers on the record and the " +
            "bidders holding different ones.",
        );
      }
      if (body.isPrivate && !body.privateReason) {
        throw badRequest(
          "An answer that is not published to every bidder needs a stated reason. The default " +
            "is that everyone hears it: an answer given to one bidder and withheld from the " +
            "others means the others priced a different job, and that is the finding a losing " +
            "bidder's challenge is built on.",
        );
      }
      const now = new Date().toISOString();
      await app.db
        .update(bidQuestions)
        .set({
          answer: body.answer,
          anonymisedQuestion: body.anonymisedQuestion ?? question.anonymisedQuestion,
          answeredBy: req.user!.id,
          answeredAt: now,
          isPrivate: body.isPrivate ? 1 : 0,
          privateReason: body.isPrivate ? (body.privateReason ?? null) : null,
          status: "answered",
          updatedAt: now,
        })
        .where(eq(bidQuestions.id, questionId));
      await ledger(app.db, req, "update", "bid_question", questionId, {
        projectId: req.projectId!,
        packageId,
        packageReference: pkg.reference,
        reference: question.reference,
        event: "answered",
        isPrivate: body.isPrivate,
        privateReason: body.privateReason ?? null,
        answeredBy: req.user!.id,
      }, req.projectId!, true);
      const [updated] = await app.db
        .select()
        .from(bidQuestions)
        .where(eq(bidQuestions.id, questionId))
        .limit(1);
      return {
        ...updated,
        isPrivate: body.isPrivate,
        note: body.isPrivate
          ? "Recorded as a private answer with its reason. It is not published, and the reason " +
            "is on the ledger where a challenge will find it."
          : "Answered. It is not yet with the other bidders — publish it as an addendum so that " +
            "everyone is answering the same question.",
      };
    },
  );

  /**
   * PUBLISHING THE ANSWERS. One addendum carrying several anonymised
   * questions and their answers, issued to the package so every live
   * invitation must acknowledge it.
   */
  app.post(
    "/projects/:projectId/bid-packages/:packageId/questions/publish",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = publishSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      if (pkg.status === "awarded" || pkg.status === "cancelled") {
        throw conflict(`A ${pkg.status} package cannot take an addendum.`);
      }
      const rows = await app.db
        .select()
        .from(bidQuestions)
        .where(
          and(
            eq(bidQuestions.companyId, companyId),
            eq(bidQuestions.packageId, packageId),
            inArray(bidQuestions.id, body.questionIds),
          ),
        );
      if (rows.length !== body.questionIds.length) {
        throw badRequest("One or more of those queries is not on this package.");
      }
      const unanswered = rows.filter((r) => !r.answer);
      if (unanswered.length > 0) {
        throw badRequest(
          `${unanswered.length} of the selected queries has no answer yet: ` +
            `${unanswered.map((r) => r.reference).join(", ")}. Publishing a question with no ` +
            "answer tells the other bidders what was asked and nothing about the answer, which " +
            "is worse than publishing neither.",
        );
      }
      const priv = rows.filter((r) => r.isPrivate === 1);
      if (priv.length > 0) {
        throw badRequest(
          `${priv.map((r) => r.reference).join(", ")} were answered privately with a stated ` +
            "reason. Publishing them now would contradict that record; clear the private flag " +
            "first if the decision has changed.",
        );
      }
      const existing = addendaOf(pkg);
      if (existing.some((a) => a.reference === body.addendumReference)) {
        throw conflict(
          `Addendum "${body.addendumReference}" has already been issued on this package.`,
        );
      }
      if (
        body.newBidDueAt &&
        pkg.bidDueAt &&
        (epochMs(body.newBidDueAt) ?? 0) < (epochMs(pkg.bidDueAt) ?? 0)
      ) {
        throw badRequest(
          "An addendum may extend the bid deadline but never shorten it — bidders have already " +
            "planned around the published date.",
        );
      }

      const now = new Date().toISOString();
      const description =
        body.description ??
        rows
          .map(
            (r, i) =>
              `${i + 1}. (${r.category}) ${r.anonymisedQuestion ?? r.question}\n   Answer: ${r.answer}`,
          )
          .join("\n\n");
      const addendum = {
        reference: body.addendumReference,
        description,
        fileIds: rows.flatMap((r) => (r.fileIds as string[]) ?? []),
        issuedAt: now,
        issuedBy: req.user!.id,
        requiresAcknowledgement: true,
        previousBidDueAt: pkg.bidDueAt,
        newBidDueAt: body.newBidDueAt ?? null,
      };
      await app.db
        .update(bidPackages)
        .set({
          addendaCount: existing.length + 1,
          bidDueAt: body.newBidDueAt ?? pkg.bidDueAt,
          detail: { ...(pkg.detail as Record<string, unknown>), addenda: [...existing, addendum] },
          updatedAt: now,
        })
        .where(eq(bidPackages.id, packageId));
      await app.db
        .update(bidQuestions)
        .set({
          status: "published",
          publishedAddendumRef: body.addendumReference,
          publishedAt: now,
          updatedAt: now,
        })
        .where(inArray(bidQuestions.id, body.questionIds));

      await ledger(app.db, req, "update", "bid_package", packageId, {
        projectId,
        event: "tender_queries_published",
        addendum: { reference: addendum.reference, issuedAt: now, newBidDueAt: addendum.newBidDueAt },
        questionIds: body.questionIds,
        questionReferences: rows.map((r) => r.reference),
      }, projectId, true);

      return reply.status(201).send({
        addendum,
        published: rows.length,
        addendaCount: existing.length + 1,
        bidDueAt: body.newBidDueAt ?? pkg.bidDueAt,
        note:
          "Published as an addendum. Every live invitation must now acknowledge it — a bid " +
          "submitted without acknowledging it was priced against a different scope from the " +
          "one the other bidders answered.",
      });
    },
  );

  /* ================================================================ */
  /* Pre-bid meetings and site visits (#181)                           */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/meetings",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = meetingCreateSchema.parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      if (
        pkg.bidDueAt &&
        (epochMs(body.scheduledAt) ?? 0) > (epochMs(pkg.bidDueAt) ?? 0) &&
        body.kind !== "debrief" &&
        body.kind !== "post_tender_negotiation"
      ) {
        throw badRequest(
          `The meeting is scheduled for ${body.scheduledAt}, after bids are due on ` +
            `${pkg.bidDueAt}. A pre-bid meeting held after the bids are in informs nobody's ` +
            "price. Record it as a clarification or a post-tender negotiation instead.",
        );
      }
      const id = newId("bmt");
      await app.db.insert(bidMeetings).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        packageId,
        kind: body.kind,
        title: body.title,
        scheduledAt: body.scheduledAt,
        durationMinutes: body.durationMinutes ?? null,
        location: body.location ?? null,
        meetingUrl: body.meetingUrl ?? null,
        isMandatory: body.isMandatory ? 1 : 0,
        agenda: body.agenda ?? null,
        chairedBy: body.chairedBy ?? req.user!.id,
        status: "scheduled",
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      // A mandatory site visit is a fact about the package, not only about
      // the meeting: the compliance report reads it from there.
      if (body.kind === "site_visit") {
        await app.db
          .update(bidPackages)
          .set({
            siteVisitAt: pkg.siteVisitAt ?? body.scheduledAt,
            isSiteVisitMandatory: body.isMandatory ? 1 : pkg.isSiteVisitMandatory,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(bidPackages.id, packageId));
      }
      await ledger(app.db, req, "create", "bid_meeting", id, {
        projectId: req.projectId!,
        packageId,
        packageReference: pkg.reference,
        kind: body.kind,
        scheduledAt: body.scheduledAt,
        isMandatory: body.isMandatory,
      }, req.projectId!, true);
      const [created] = await app.db
        .select()
        .from(bidMeetings)
        .where(eq(bidMeetings.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/bid-packages/:packageId/meetings",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const meetings = await app.db
        .select()
        .from(bidMeetings)
        .where(eq(bidMeetings.packageId, packageId))
        .orderBy(asc(bidMeetings.scheduledAt));
      const attendees = meetings.length
        ? await app.db
            .select()
            .from(bidMeetingAttendees)
            .where(
              inArray(
                bidMeetingAttendees.meetingId,
                meetings.map((m) => m.id),
              ),
            )
        : [];
      const invites = await app.db
        .select()
        .from(bidInvitations)
        .where(eq(bidInvitations.packageId, packageId));
      const names = await vendorNames(app.db, [
        ...attendees.map((a) => a.vendorId ?? ""),
        ...invites.map((i) => i.vendorId),
      ]);
      return {
        items: meetings.map((m) => {
          const mine = attendees.filter((a) => a.meetingId === m.id);
          const attendedVendorIds = new Set(
            mine.filter((a) => a.attendance === "attended" && a.vendorId).map((a) => a.vendorId!),
          );
          const missing = m.isMandatory
            ? invites
                .filter(
                  (inv) =>
                    !attendedVendorIds.has(inv.vendorId) &&
                    inv.status !== "declined" &&
                    inv.status !== "withdrawn" &&
                    inv.status !== "disqualified",
                )
                .map((inv) => ({
                  vendorId: inv.vendorId,
                  vendorName: names.get(inv.vendorId) ?? null,
                  status: inv.status,
                }))
            : [];
          return {
            ...m,
            isMandatory: m.isMandatory === 1,
            attendees: mine.map((a) => ({
              ...a,
              vendorName: a.vendorId ? (names.get(a.vendorId) ?? null) : null,
            })),
            attendedCount: attendedVendorIds.size,
            missingMandatory: missing,
            compliance:
              m.isMandatory && m.status === "held" && missing.length > 0
                ? `${missing.length} invited bidder(s) did not attend a MANDATORY ${m.kind}. ` +
                  "A bid from a company that never saw the site is a bid priced on the drawings " +
                  "alone, and it is a compliance finding on that bid rather than a scheduling " +
                  "detail."
                : null,
          };
        }),
        total: meetings.length,
      };
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/meetings/:meetingId/attendance",
    { preHandler: standardGate },
    async (req) => {
      const { packageId, meetingId } = req.params as { packageId: string; meetingId: string };
      const body = attendanceSchema.parse(req.body);
      await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const [meeting] = await app.db
        .select()
        .from(bidMeetings)
        .where(
          and(
            eq(bidMeetings.id, meetingId),
            eq(bidMeetings.companyId, req.companyId!),
            eq(bidMeetings.packageId, packageId),
          ),
        )
        .limit(1);
      if (!meeting) throw notFound("Meeting not found on this package");
      const now = new Date().toISOString();
      const recorded: string[] = [];
      for (const attendee of body.attendees) {
        if (!attendee.vendorId && !attendee.attendeeName) {
          throw badRequest(
            "An attendance record needs either a vendor or a named person. An unattributed " +
              "attendance proves nothing about who was told what.",
          );
        }
        if (attendee.vendorId) await assertVendor(app.db, attendee.vendorId, req.companyId!);
        const [existing] = await app.db
          .select({ id: bidMeetingAttendees.id })
          .from(bidMeetingAttendees)
          .where(
            and(
              eq(bidMeetingAttendees.meetingId, meetingId),
              attendee.vendorId
                ? eq(bidMeetingAttendees.vendorId, attendee.vendorId)
                : eq(bidMeetingAttendees.attendeeName, attendee.attendeeName ?? ""),
            ),
          )
          .limit(1);
        if (existing) {
          await app.db
            .update(bidMeetingAttendees)
            .set({
              attendance: attendee.attendance,
              note: attendee.note ?? null,
              recordedBy: req.user!.id,
              recordedAt: now,
              updatedAt: now,
            })
            .where(eq(bidMeetingAttendees.id, existing.id));
          recorded.push(existing.id);
        } else {
          const id = newId("bma");
          await app.db.insert(bidMeetingAttendees).values({
            id,
            companyId: req.companyId!,
            projectId: req.projectId!,
            meetingId,
            packageId,
            vendorId: attendee.vendorId ?? null,
            invitationId: attendee.invitationId ?? null,
            attendeeName: attendee.attendeeName ?? null,
            attendeeEmail: attendee.attendeeEmail ?? null,
            attendance: attendee.attendance,
            recordedBy: req.user!.id,
            recordedAt: now,
            note: attendee.note ?? null,
          });
          recorded.push(id);
        }
        if (
          attendee.vendorId &&
          attendee.attendance === "attended" &&
          meeting.kind === "site_visit"
        ) {
          await app.db
            .update(bidInvitations)
            .set({ attendedSiteVisit: 1, updatedAt: now })
            .where(
              and(
                eq(bidInvitations.packageId, packageId),
                eq(bidInvitations.vendorId, attendee.vendorId),
              ),
            );
        }
      }
      await ledger(app.db, req, "update", "bid_meeting", meetingId, {
        projectId: req.projectId!,
        packageId,
        event: "attendance_recorded",
        kind: meeting.kind,
        isMandatory: meeting.isMandatory === 1,
        recorded: recorded.length,
        attendees: body.attendees.map((a) => ({
          vendorId: a.vendorId ?? null,
          attendeeName: a.attendeeName ?? null,
          attendance: a.attendance,
        })),
      }, req.projectId!, true);
      return { recorded: recorded.length, meetingId };
    },
  );

  app.post(
    "/projects/:projectId/bid-packages/:packageId/meetings/:meetingId/minutes",
    { preHandler: standardGate },
    async (req) => {
      const { packageId, meetingId } = req.params as { packageId: string; meetingId: string };
      const body = z
        .object({
          minutes: z.string().trim().min(20).max(50000),
          minutesFileIds: z.array(z.string().min(1).max(64)).max(50).optional(),
          heldAt: isoTimestampSchema.nullable().optional(),
          publishAsAddendum: z.string().trim().min(1).max(60).nullable().optional(),
        })
        .parse(req.body);
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const [meeting] = await app.db
        .select()
        .from(bidMeetings)
        .where(
          and(
            eq(bidMeetings.id, meetingId),
            eq(bidMeetings.companyId, req.companyId!),
            eq(bidMeetings.packageId, packageId),
          ),
        )
        .limit(1);
      if (!meeting) throw notFound("Meeting not found on this package");
      const now = new Date().toISOString();
      let addendumRef: string | null = null;
      if (body.publishAsAddendum) {
        const existing = addendaOf(pkg);
        if (existing.some((a) => a.reference === body.publishAsAddendum)) {
          throw conflict(`Addendum "${body.publishAsAddendum}" already exists on this package.`);
        }
        addendumRef = body.publishAsAddendum;
        await app.db
          .update(bidPackages)
          .set({
            addendaCount: existing.length + 1,
            detail: {
              ...(pkg.detail as Record<string, unknown>),
              addenda: [
                ...existing,
                {
                  reference: addendumRef,
                  description: `Minutes of ${meeting.title} (${meeting.kind}) held ${body.heldAt ?? meeting.scheduledAt}.\n\n${body.minutes}`,
                  fileIds: body.minutesFileIds ?? [],
                  issuedAt: now,
                  issuedBy: req.user!.id,
                  requiresAcknowledgement: true,
                  previousBidDueAt: pkg.bidDueAt,
                  newBidDueAt: null,
                },
              ],
            },
            updatedAt: now,
          })
          .where(eq(bidPackages.id, packageId));
      }
      await app.db
        .update(bidMeetings)
        .set({
          minutes: body.minutes,
          minutesFileIds: body.minutesFileIds ?? [],
          heldAt: body.heldAt ?? meeting.heldAt ?? meeting.scheduledAt,
          status: "held",
          minutesPublishedAt: addendumRef ? now : meeting.minutesPublishedAt,
          publishedAddendumRef: addendumRef ?? meeting.publishedAddendumRef,
          updatedAt: now,
        })
        .where(eq(bidMeetings.id, meetingId));
      await ledger(app.db, req, "update", "bid_meeting", meetingId, {
        projectId: req.projectId!,
        packageId,
        event: "minutes_recorded",
        publishedAddendumRef: addendumRef,
        heldAt: body.heldAt ?? meeting.scheduledAt,
      }, req.projectId!, true);
      const [updated] = await app.db
        .select()
        .from(bidMeetings)
        .where(eq(bidMeetings.id, meetingId))
        .limit(1);
      return {
        ...updated,
        note: addendumRef
          ? `Minutes published as addendum ${addendumRef}. Every live invitation must ` +
            "acknowledge it — what was said at the meeting changed the question, and a bidder " +
            "who was not there is entitled to the same answer."
          : "Minutes recorded but not published. A pre-bid meeting whose minutes reach only the " +
            "attendees leaves the absentees pricing a different job; publish them as an " +
            "addendum unless nothing said there affected the price.",
      };
    },
  );

  /* ================================================================ */
  /* Bid bonds (#183)                                                  */
  /* ================================================================ */

  app.post(
    "/projects/:projectId/bid-packages/:packageId/bonds",
    { preHandler: standardGate },
    async (req, reply) => {
      const { packageId } = req.params as { packageId: string };
      const body = bondCreateSchema.parse(req.body);
      const companyId = req.companyId!;
      const projectId = req.projectId!;
      const pkg = await fetchPackage(app.db, packageId, companyId, projectId);
      await assertVendor(app.db, body.vendorId, companyId);
      const [existing] = await app.db
        .select({ id: bidBonds.id })
        .from(bidBonds)
        .where(
          and(
            eq(bidBonds.packageId, packageId),
            eq(bidBonds.vendorId, body.vendorId),
            eq(bidBonds.bondType, body.bondType),
          ),
        )
        .limit(1);
      if (existing) {
        throw conflict(
          `A ${body.bondType} is already recorded for this bidder on ${pkg.reference}. Update it ` +
            "rather than recording a second instrument for the same security.",
        );
      }
      if (body.validFrom && body.expiresAt && body.expiresAt < body.validFrom) {
        throw badRequest("The bond expires before it starts.");
      }
      const id = newId("bbd");
      await app.db.insert(bidBonds).values({
        id,
        companyId,
        projectId,
        packageId,
        vendorId: body.vendorId,
        invitationId: body.invitationId ?? null,
        submissionId: body.submissionId ?? null,
        bondType: body.bondType,
        status: body.providedAmount !== undefined && body.providedAmount !== null ? "received" : "required",
        requiredPercent: body.requiredPercent ?? null,
        requiredAmount: body.requiredAmount ?? null,
        providedAmount: body.providedAmount ?? null,
        currency: body.currency ?? pkg.currency,
        provider: body.provider ?? null,
        bondNumber: body.bondNumber ?? null,
        issuedAt: body.issuedAt ?? null,
        validFrom: body.validFrom ?? null,
        expiresAt: body.expiresAt ?? null,
        receivedAt: body.providedAmount !== undefined && body.providedAmount !== null ? new Date().toISOString() : null,
        fileIds: body.fileIds ?? [],
        detail: body.detail ?? {},
        createdBy: req.user!.id,
      });
      await ledger(app.db, req, "create", "bid_bond", id, {
        projectId,
        packageId,
        packageReference: pkg.reference,
        vendorId: body.vendorId,
        bondType: body.bondType,
        requiredAmount: body.requiredAmount ?? null,
        providedAmount: body.providedAmount ?? null,
        currency: body.currency ?? pkg.currency,
        expiresAt: body.expiresAt ?? null,
      }, projectId, true);
      const [created] = await app.db
        .select()
        .from(bidBonds)
        .where(eq(bidBonds.id, id))
        .limit(1);
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/projects/:projectId/bid-packages/:packageId/bonds",
    { preHandler: readGate },
    async (req) => {
      const { packageId } = req.params as { packageId: string };
      const pkg = await fetchPackage(app.db, packageId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(bidBonds)
        .where(eq(bidBonds.packageId, packageId))
        .orderBy(asc(bidBonds.createdAt));
      const subs = await app.db
        .select({
          id: bidSubmissions.id,
          vendorId: bidSubmissions.vendorId,
          totalAmount: bidSubmissions.totalAmount,
          currency: bidSubmissions.currency,
          status: bidSubmissions.status,
        })
        .from(bidSubmissions)
        .where(eq(bidSubmissions.packageId, packageId));
      const names = await vendorNames(
        app.db,
        rows.map((r) => r.vendorId),
      );
      const asOf = todayIso();
      return {
        items: rows.map((bond) => {
          const sub = subs.find((s) => s.vendorId === bond.vendorId);
          /*
           * A bid bond is usually a PERCENT of the bid, so the required
           * amount can only be checked once the bid is in — and only where
           * the two are in the same currency. Cross-currency comparison is
           * refused rather than converted.
           */
          const derivedRequired =
            bond.requiredAmount ??
            (bond.requiredPercent !== null &&
            sub?.totalAmount !== null &&
            sub?.totalAmount !== undefined &&
            sub.currency.toUpperCase() === bond.currency.toUpperCase()
              ? round2((sub.totalAmount * bond.requiredPercent) / 100)
              : null);
          const shortfall =
            derivedRequired !== null && bond.providedAmount !== null
              ? round2(derivedRequired - bond.providedAmount)
              : null;
          return {
            ...bond,
            vendorName: names.get(bond.vendorId) ?? null,
            derivedRequiredAmount: derivedRequired,
            shortfall,
            expired: bond.expiresAt !== null && bond.expiresAt < asOf,
            daysToExpiry:
              bond.expiresAt === null
                ? null
                : Math.round(
                    (Date.parse(`${bond.expiresAt}T00:00:00Z`) -
                      Date.parse(`${asOf}T00:00:00Z`)) /
                      86_400_000,
                  ),
            note:
              bond.expiresAt !== null && bond.expiresAt < asOf
                ? `This bond expired on ${bond.expiresAt}. The tender is running with no ` +
                  "security behind this bidder: if they win and walk away there is nothing to " +
                  "draw on and nothing to fund the re-tender."
                : shortfall !== null && shortfall > 0
                  ? `The bond is ${bond.currency} ${shortfall} short of the ` +
                    `${derivedRequired} this package requires against their bid.`
                  : bond.status === "received"
                    ? "Received but not independently verified. An unverified instrument is a " +
                      "photocopy until somebody checks it with the surety."
                    : null,
          };
        }),
        total: rows.length,
        packageRequirements: pkg.requiredBonds,
        asOf,
      };
    },
  );

  app.post("/bid-bonds/:bondId/status", { preHandler: [app.authenticate, app.requireCompany] }, async (req, reply) => {
    const { bondId } = req.params as { bondId: string };
    const body = z
      .object({
        status: z.enum(BID_BOND_STATUSES),
        note: z.string().max(4000).nullable().optional(),
        providedAmount: nonNegativeMoneySchema.nullable().optional(),
        expiresAt: isoDateSchema.nullable().optional(),
        reason: reasonSchema.optional(),
      })
      .parse(req.body);
    const [bond] = await app.db
      .select()
      .from(bidBonds)
      .where(and(eq(bidBonds.id, bondId), eq(bidBonds.companyId, req.companyId!)))
      .limit(1);
    if (!bond) throw notFound("Bid bond not found");
    (req.params as Record<string, string>)["projectId"] = bond.projectId;
    await app.requireTool("bidding", "standard")(req, reply);

    if (body.status === "verified" && bond.createdBy === req.user!.id) {
      throw badRequest(
        "The person who recorded a bond may not be the person who verifies it. Verification is " +
          "the act of checking the instrument with the surety; doing it yourself checks nothing.",
      );
    }
    if ((body.status === "called" || body.status === "rejected") && !body.reason) {
      throw badRequest(`A bond marked "${body.status}" needs a stated reason.`);
    }
    const now = new Date().toISOString();
    await app.db
      .update(bidBonds)
      .set({
        status: body.status,
        ...(body.providedAmount !== undefined ? { providedAmount: body.providedAmount } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.status === "received" ? { receivedAt: bond.receivedAt ?? now } : {}),
        ...(body.status === "verified"
          ? { verifiedBy: req.user!.id, verifiedAt: now, verificationNote: body.note ?? null }
          : {}),
        ...(body.status === "released"
          ? { releasedAt: now, releasedBy: req.user!.id, releaseReason: body.reason ?? null }
          : {}),
        ...(body.status === "called" ? { calledAt: now, calledReason: body.reason ?? null } : {}),
        ...(body.status === "rejected" ? { rejectedReason: body.reason ?? null } : {}),
        updatedAt: now,
      })
      .where(eq(bidBonds.id, bondId));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      projectId: bond.projectId,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "bid_bond",
      objectId: bondId,
      payload: {
        packageId: bond.packageId,
        vendorId: bond.vendorId,
        from: bond.status,
        to: body.status,
        reason: body.reason ?? null,
        note: body.note ?? null,
        providedAmount: body.providedAmount ?? bond.providedAmount,
      },
      storePayload: true,
    });
    const [updated] = await app.db
      .select()
      .from(bidBonds)
      .where(eq(bidBonds.id, bondId))
      .limit(1);
    return updated;
  });

  /** Bond expiry sweep, on demand (the scheduler runs it hourly). */
  app.post(
    "/companies/current/bid-bonds/sweep",
    {
      preHandler: [
        app.authenticate,
        app.requireCompany,
        app.requireCompanyRole(["owner", "admin"]),
      ],
    },
    async (req) => {
      const result = await sweepBidBonds(app.db, req.companyId!, req.user!.id);
      return {
        ...result,
        note:
          result.expired.length === 0 && result.obligationsRaised.length === 0
            ? "No bid bond expired or entered its warning window."
            : `${result.expired.length} bond(s) expired and ${result.obligationsRaised.length} ` +
              "renewal obligation(s) were raised.",
      };
    },
  );
};

export type BidPackageForEngagement = BidPackageRow;
