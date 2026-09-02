/**
 * LETTERS — the correspondence register (spec #441 numbering, #444 register,
 * #445 workflow, #446 response tracking) and the inbound email path (#99).
 *
 * The lifecycle is the point. A draft is editable; an ISSUED letter is a
 * contractual act and is frozen — its subject, body, recipients and type
 * cannot be edited afterwards, because a register whose history can be
 * rewritten is worth nothing in a dispute. Corrections happen through a new
 * letter that references the old one, which is also how the thread is built.
 *
 * Segregation of duties: an approval step is never satisfied by the letter's
 * own author, and the generic PATCH refuses every field that has a dedicated
 * transition route.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  companyMemberships,
  contacts,
  correspondenceApprovals,
  correspondenceInboundMessages,
  correspondenceLetters,
  correspondenceRecipients,
  correspondenceTypes,
  users,
} from "@constructos/db";
import {
  CORRESPONDENCE_DIRECTIONS,
  CORRESPONDENCE_PRIORITIES,
  CORRESPONDENCE_STATUSES,
  RECIPIENT_KINDS,
  RECIPIENT_PARTY_TYPES,
} from "@constructos/shared";
import { badRequest, conflict, forbidden, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { addDaysISO } from "../engines/dates.js";
import { parseInboundEmail, routeInbound, type RoutingCandidate } from "../engines/email.js";
import { assessLetter } from "../engines/tracking.js";
import { syncTransmittal, toLetterInput } from "../service.js";
import {
  allocateReference,
  assertContact,
  assertFiles,
  assertVendor,
  buildGates,
  emailSchema,
  fileIdsSchema,
  idSchema,
  isoDateSchema,
  ledger,
  loadType,
  nowISO,
  openObligation,
  settleObligation,
  todayISO,
} from "../shared.js";

/* ------------------------------------------------------------------ */
/* Wire formats                                                        */
/* ------------------------------------------------------------------ */

const recipientBodySchema = z.object({
  kind: z.enum(RECIPIENT_KINDS).default("to"),
  partyType: z.enum(RECIPIENT_PARTY_TYPES).default("external"),
  partyId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  email: emailSchema.nullable().optional(),
  organisation: z.string().max(200).nullable().optional(),
  acknowledgementRequired: z.boolean().default(false),
});

const letterBodySchema = z.object({
  typeId: idSchema,
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(100_000).nullable().optional(),
  direction: z.enum(CORRESPONDENCE_DIRECTIONS).optional(),
  priority: z.enum(CORRESPONDENCE_PRIORITIES).default("normal"),
  letterDate: isoDateSchema.optional(),
  responseRequired: z.boolean().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  inReplyToId: idSchema.nullable().optional(),
  fromName: z.string().max(200).nullable().optional(),
  fromEmail: emailSchema.nullable().optional(),
  fromVendorId: idSchema.nullable().optional(),
  fileIds: fileIdsSchema.default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  recipients: z.array(recipientBodySchema).max(200).default([]),
});

/** A PATCH may only touch the editable body of a DRAFT. */
const letterPatchSchema = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(100_000).nullable().optional(),
  priority: z.enum(CORRESPONDENCE_PRIORITIES).optional(),
  letterDate: isoDateSchema.optional(),
  direction: z.enum(CORRESPONDENCE_DIRECTIONS).optional(),
  responseRequired: z.boolean().optional(),
  responseDueDate: isoDateSchema.nullable().optional(),
  fileIds: fileIdsSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  fromName: z.string().max(200).nullable().optional(),
  fromEmail: emailSchema.nullable().optional(),
});

const listSchema = pageQuerySchema.extend({
  status: z.enum(CORRESPONDENCE_STATUSES).optional(),
  direction: z.enum(CORRESPONDENCE_DIRECTIONS).optional(),
  typeId: idSchema.optional(),
  typeKey: z.string().max(48).optional(),
  priority: z.enum(CORRESPONDENCE_PRIORITIES).optional(),
  threadId: idSchema.optional(),
  contractualOnly: z.coerce.boolean().optional(),
  awaitingResponse: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["reference", "created", "due"]).default("created"),
});

const inboundSchema = z.object({
  email: z.object({
    from: z.string().min(3).max(320),
    to: z.array(z.string().max(320)).max(100).optional(),
    cc: z.array(z.string().max(320)).max(100).optional(),
    subject: z.string().max(998).default(""),
    text: z.string().max(500_000).optional(),
    html: z.string().max(1_000_000).optional(),
    messageId: z.string().max(300).optional(),
    inReplyTo: z.string().max(300).optional(),
    receivedAt: z.string().max(64).optional(),
    attachments: z
      .array(
        z.object({
          fileId: idSchema.nullable().optional(),
          filename: z.string().max(300).nullable().optional(),
          contentType: z.string().max(200).nullable().optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
  /** the type new inbound letters land under; defaults to the tenant's first inbound-capable type */
  typeId: idSchema.optional(),
  /** the transport verified its own signature; recorded, never trusted blindly */
  signatureVerified: z.boolean().optional(),
});

const EDITABLE_STATUSES = ["draft"] as const;

export const letterRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  async function loadLetter(companyId: string, projectId: string, letterId: string) {
    const [row] = await app.db
      .select()
      .from(correspondenceLetters)
      .where(
        and(
          eq(correspondenceLetters.id, letterId),
          eq(correspondenceLetters.companyId, companyId),
          eq(correspondenceLetters.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Letter not found");
    return row;
  }

  async function resolveRecipient(
    companyId: string,
    input: z.infer<typeof recipientBodySchema>,
  ): Promise<{ name: string; email: string | null; organisation: string | null; partyId: string | null }> {
    if (input.partyType === "user") {
      if (!input.partyId) throw badRequest("A user recipient needs a partyId.");
      const [row] = await app.db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
        .where(and(eq(companyMemberships.companyId, companyId), eq(users.id, input.partyId)))
        .limit(1);
      if (!row) throw badRequest(`User ${input.partyId} is not a member of this company.`);
      return {
        name: input.name ?? row.name,
        email: input.email ?? row.email,
        organisation: input.organisation ?? null,
        partyId: row.id,
      };
    }
    if (input.partyType === "contact") {
      if (!input.partyId) throw badRequest("A contact recipient needs a partyId.");
      const [row] = await app.db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.companyId, companyId), eq(contacts.id, input.partyId)))
        .limit(1);
      if (!row) throw badRequest(`Contact ${input.partyId} not found in this company.`);
      return {
        name: input.name ?? row.name,
        email: input.email ?? row.email,
        organisation: input.organisation ?? null,
        partyId: row.id,
      };
    }
    if (input.partyType === "vendor") {
      if (!input.partyId) throw badRequest("A vendor recipient needs a partyId.");
      await assertVendor(app.db, companyId, input.partyId);
      if (!input.name) throw badRequest("A vendor recipient needs a contact name.");
      return {
        name: input.name,
        email: input.email ?? null,
        organisation: input.organisation ?? null,
        partyId: input.partyId,
      };
    }
    if (!input.name) throw badRequest("An external recipient needs a name.");
    return {
      name: input.name,
      email: input.email ?? null,
      organisation: input.organisation ?? null,
      partyId: input.partyId ?? null,
    };
  }

  async function insertRecipients(
    companyId: string,
    projectId: string,
    recordType: "letter" | "transmittal",
    recordId: string,
    actorId: string,
    inputs: readonly z.infer<typeof recipientBodySchema>[],
  ) {
    const rows = [];
    for (const input of inputs) {
      const resolved = await resolveRecipient(companyId, input);
      rows.push({
        id: newId("crc"),
        companyId,
        projectId,
        recordType,
        recordId,
        kind: input.kind,
        partyType: input.partyType,
        partyId: resolved.partyId,
        name: resolved.name,
        email: resolved.email,
        organisation: resolved.organisation,
        acknowledgementRequired: input.acknowledgementRequired ? 1 : 0,
      });
    }
    if (rows.length > 0) {
      await app.db.insert(correspondenceRecipients).values(rows);
      for (const row of rows) {
        await ledger(app.db, {
          companyId,
          projectId,
          actorId,
          action: "create",
          objectType: "correspondence_recipient",
          objectId: row.id,
          payload: { recordType, recordId, name: row.name, kind: row.kind },
        });
      }
    }
    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/correspondence/letters", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = listSchema.parse(req.query);
    const today = todayISO();
    const where = and(
      eq(correspondenceLetters.companyId, req.companyId!),
      eq(correspondenceLetters.projectId, projectId),
      q.status ? eq(correspondenceLetters.status, q.status) : undefined,
      q.direction ? eq(correspondenceLetters.direction, q.direction) : undefined,
      q.typeId ? eq(correspondenceLetters.typeId, q.typeId) : undefined,
      q.typeKey ? eq(correspondenceLetters.typeKey, q.typeKey) : undefined,
      q.priority ? eq(correspondenceLetters.priority, q.priority) : undefined,
      q.threadId ? eq(correspondenceLetters.threadId, q.threadId) : undefined,
      q.contractualOnly ? eq(correspondenceLetters.isContractual, 1) : undefined,
      q.awaitingResponse
        ? and(
            eq(correspondenceLetters.responseRequired, 1),
            isNull(correspondenceLetters.respondedAt),
            inArray(correspondenceLetters.status, ["issued", "acknowledged"]),
          )
        : undefined,
      q.overdue
        ? and(
            eq(correspondenceLetters.responseRequired, 1),
            isNull(correspondenceLetters.respondedAt),
            isNotNull(correspondenceLetters.responseDueDate),
            sql`${correspondenceLetters.responseDueDate} < ${today}`,
            inArray(correspondenceLetters.status, ["issued", "acknowledged"]),
          )
        : undefined,
      q.q
        ? or(
            ilike(correspondenceLetters.subject, `%${q.q}%`),
            ilike(correspondenceLetters.reference, `%${q.q}%`),
            ilike(correspondenceLetters.body, `%${q.q}%`),
          )
        : undefined,
    );
    const order =
      q.sort === "reference"
        ? [asc(correspondenceLetters.reference)]
        : q.sort === "due"
          ? [asc(correspondenceLetters.responseDueDate), desc(correspondenceLetters.createdAt)]
          : [desc(correspondenceLetters.createdAt)];
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(correspondenceLetters)
        .where(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(correspondenceLetters).where(where),
    ]);
    const ids = rows.map((r) => r.id);
    const recipientRows =
      ids.length === 0
        ? []
        : await app.db
            .select()
            .from(correspondenceRecipients)
            .where(
              and(
                eq(correspondenceRecipients.companyId, req.companyId!),
                eq(correspondenceRecipients.recordType, "letter"),
                inArray(correspondenceRecipients.recordId, ids),
              ),
            );
    const byLetter = new Map<string, typeof recipientRows>();
    for (const r of recipientRows) {
      const list = byLetter.get(r.recordId) ?? [];
      list.push(r);
      byLetter.set(r.recordId, list);
    }
    return paginate(
      rows.map((row) => ({
        ...row,
        assessment: assessLetter(toLetterInput(row), today),
        recipients: (byLetter.get(row.id) ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          acknowledgedAt: r.acknowledgedAt,
        })),
      })),
      total?.n ?? 0,
      q,
    );
  });

  app.post("/projects/:projectId/correspondence/letters", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = letterBodySchema.parse(req.body);
    const companyId = req.companyId!;
    const type = await loadType(app.db, companyId, projectId, body.typeId);
    await assertFiles(app.db, companyId, projectId, body.fileIds);
    if (body.fromVendorId) await assertVendor(app.db, companyId, body.fromVendorId);

    let threadId: string | null = null;
    if (body.inReplyToId) {
      const parent = await loadLetter(companyId, projectId, body.inReplyToId);
      threadId = parent.threadId;
    }

    const id = newId("clt");
    const { number, reference } = await allocateReference(
      app.db,
      projectId,
      `correspondence:${type.key}`,
      type.prefix,
    );
    const responseRequired = body.responseRequired ?? type.requiresResponse === 1;
    const letterDate = body.letterDate ?? todayISO();
    const responseDueDate =
      body.responseDueDate !== undefined
        ? body.responseDueDate
        : responseRequired && type.responseDays !== null
          ? addDaysISO(letterDate, type.responseDays)
          : null;

    const [row] = await app.db
      .insert(correspondenceLetters)
      .values({
        id,
        companyId,
        projectId,
        typeId: type.id,
        typeKey: type.key,
        number,
        reference,
        subject: body.subject,
        body: body.body ?? null,
        direction: body.direction ?? type.defaultDirection,
        status: "draft",
        priority: body.priority,
        source: "manual",
        isContractual: type.isContractual,
        threadId: threadId ?? id,
        inReplyToId: body.inReplyToId ?? null,
        fromName: body.fromName ?? null,
        fromEmail: body.fromEmail ?? null,
        fromUserId: req.user!.id,
        fromVendorId: body.fromVendorId ?? null,
        letterDate,
        responseRequired: responseRequired ? 1 : 0,
        responseDueDate,
        fileIds: body.fileIds,
        tags: body.tags,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "correspondence_letter",
      objectId: id,
      payload: { reference, typeKey: type.key, subject: body.subject, threadId: threadId ?? id },
    });
    const recipients = await insertRecipients(
      companyId,
      projectId,
      "letter",
      id,
      req.user!.id,
      body.recipients,
    );
    return reply.code(201).send({ ...row, recipients });
  });

  app.get("/projects/:projectId/correspondence/letters/:letterId", { preHandler: readGate }, async (req) => {
    const { projectId, letterId } = req.params as { projectId: string; letterId: string };
    const companyId = req.companyId!;
    const letter = await loadLetter(companyId, projectId, letterId);
    const [recipients, approvals, thread, type, inbound] = await Promise.all([
      app.db
        .select()
        .from(correspondenceRecipients)
        .where(
          and(
            eq(correspondenceRecipients.companyId, companyId),
            eq(correspondenceRecipients.recordType, "letter"),
            eq(correspondenceRecipients.recordId, letterId),
          ),
        )
        .orderBy(asc(correspondenceRecipients.createdAt)),
      app.db
        .select()
        .from(correspondenceApprovals)
        .where(
          and(
            eq(correspondenceApprovals.companyId, companyId),
            eq(correspondenceApprovals.letterId, letterId),
          ),
        )
        .orderBy(asc(correspondenceApprovals.seq)),
      app.db
        .select({
          id: correspondenceLetters.id,
          reference: correspondenceLetters.reference,
          subject: correspondenceLetters.subject,
          direction: correspondenceLetters.direction,
          status: correspondenceLetters.status,
          letterDate: correspondenceLetters.letterDate,
          issuedAt: correspondenceLetters.issuedAt,
          createdAt: correspondenceLetters.createdAt,
        })
        .from(correspondenceLetters)
        .where(
          and(
            eq(correspondenceLetters.companyId, companyId),
            eq(correspondenceLetters.threadId, letter.threadId),
          ),
        )
        .orderBy(asc(correspondenceLetters.createdAt)),
      app.db
        .select()
        .from(correspondenceTypes)
        .where(eq(correspondenceTypes.id, letter.typeId))
        .limit(1),
      letter.inboundMessageId
        ? app.db
            .select()
            .from(correspondenceInboundMessages)
            .where(eq(correspondenceInboundMessages.id, letter.inboundMessageId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    return {
      ...letter,
      assessment: assessLetter(toLetterInput(letter), todayISO()),
      recipients,
      approvals,
      thread,
      type: type[0] ?? null,
      inboundMessage: inbound[0] ?? null,
    };
  });

  app.patch("/projects/:projectId/correspondence/letters/:letterId", { preHandler: standardGate }, async (req) => {
    const { projectId, letterId } = req.params as { projectId: string; letterId: string };
    const body = letterPatchSchema.parse(req.body);
    const companyId = req.companyId!;
    const letter = await loadLetter(companyId, projectId, letterId);
    if (!(EDITABLE_STATUSES as readonly string[]).includes(letter.status)) {
      throw conflict(
        `${letter.reference} is ${letter.status}; an issued letter is a contractual act and cannot be edited. Reply to it or void it and reissue.`,
      );
    }
    if (body.fileIds) await assertFiles(app.db, companyId, projectId, body.fileIds);

    const set: Record<string, unknown> = { updatedAt: nowISO() };
    for (const key of [
      "subject",
      "body",
      "priority",
      "letterDate",
      "direction",
      "responseDueDate",
      "fileIds",
      "tags",
      "fromName",
      "fromEmail",
    ] as const) {
      if (body[key] !== undefined) set[key] = body[key];
    }
    if (body.responseRequired !== undefined) set["responseRequired"] = body.responseRequired ? 1 : 0;

    const [row] = await app.db
      .update(correspondenceLetters)
      .set(set)
      .where(eq(correspondenceLetters.id, letterId))
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "update",
      objectType: "correspondence_letter",
      objectId: letterId,
      payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
    });
    return row;
  });

  /* ---------------------------------------------------------------- */
  /* Recipients (#443 acknowledgement, read receipts)                  */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/recipients",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const body = recipientBodySchema.parse(req.body);
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status !== "draft") {
        throw conflict(`${letter.reference} has been issued; its distribution list is frozen.`);
      }
      const [row] = await insertRecipients(companyId, projectId, "letter", letterId, req.user!.id, [body]);
      return reply.code(201).send(row);
    },
  );

  app.delete(
    "/projects/:projectId/correspondence/recipients/:recipientId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, recipientId } = req.params as { projectId: string; recipientId: string };
      const companyId = req.companyId!;
      const [recipient] = await app.db
        .select()
        .from(correspondenceRecipients)
        .where(
          and(
            eq(correspondenceRecipients.id, recipientId),
            eq(correspondenceRecipients.companyId, companyId),
            eq(correspondenceRecipients.projectId, projectId),
          ),
        )
        .limit(1);
      if (!recipient) throw notFound("Recipient not found");
      if (recipient.acknowledgedAt !== null) {
        throw conflict(
          "This recipient has acknowledged receipt; removing them would erase that acknowledgement from the record.",
        );
      }
      await app.db.delete(correspondenceRecipients).where(eq(correspondenceRecipients.id, recipientId));
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "correspondence_recipient",
        objectId: recipientId,
        payload: { recordType: recipient.recordType, recordId: recipient.recordId, name: recipient.name },
      });
      if (recipient.recordType === "transmittal") {
        await syncTransmittal(
          app.db,
          companyId,
          projectId,
          recipient.recordId,
          req.user!.id,
          todayISO(),
        );
      }
      return { deleted: true };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/recipients/:recipientId/read",
    { preHandler: readGate },
    async (req) => {
      const { projectId, recipientId } = req.params as { projectId: string; recipientId: string };
      const companyId = req.companyId!;
      const [recipient] = await app.db
        .select()
        .from(correspondenceRecipients)
        .where(
          and(
            eq(correspondenceRecipients.id, recipientId),
            eq(correspondenceRecipients.companyId, companyId),
            eq(correspondenceRecipients.projectId, projectId),
          ),
        )
        .limit(1);
      if (!recipient) throw notFound("Recipient not found");
      const now = nowISO();
      const [row] = await app.db
        .update(correspondenceRecipients)
        .set({
          firstReadAt: recipient.firstReadAt ?? now,
          lastReadAt: now,
          readCount: recipient.readCount + 1,
          deliveryStatus:
            recipient.deliveryStatus === "pending" || recipient.deliveryStatus === "sent"
              ? "delivered"
              : recipient.deliveryStatus,
        })
        .where(eq(correspondenceRecipients.id, recipientId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "access",
        objectType: "correspondence_recipient",
        objectId: recipientId,
        payload: { recordType: recipient.recordType, recordId: recipient.recordId, readCount: recipient.readCount + 1 },
      });
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/recipients/:recipientId/acknowledge",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, recipientId } = req.params as { projectId: string; recipientId: string };
      const bodySchema = z.object({ note: z.string().max(2000).optional() });
      const body = bodySchema.parse(req.body ?? {});
      const companyId = req.companyId!;
      const [recipient] = await app.db
        .select()
        .from(correspondenceRecipients)
        .where(
          and(
            eq(correspondenceRecipients.id, recipientId),
            eq(correspondenceRecipients.companyId, companyId),
            eq(correspondenceRecipients.projectId, projectId),
          ),
        )
        .limit(1);
      if (!recipient) throw notFound("Recipient not found");
      if (recipient.acknowledgedAt !== null) {
        throw conflict(`${recipient.name} already acknowledged receipt on ${recipient.acknowledgedAt}.`);
      }
      const now = nowISO();
      const [row] = await app.db
        .update(correspondenceRecipients)
        .set({
          acknowledgedAt: now,
          acknowledgedBy: req.user!.id,
          acknowledgementNote: body.note ?? null,
          firstReadAt: recipient.firstReadAt ?? now,
          lastReadAt: now,
          deliveryStatus: recipient.deliveryStatus === "pending" ? "delivered" : recipient.deliveryStatus,
        })
        .where(eq(correspondenceRecipients.id, recipientId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_recipient",
        objectId: recipientId,
        payload: { acknowledged: true, recordType: recipient.recordType, recordId: recipient.recordId },
      });
      if (recipient.recordType === "transmittal") {
        // Keep the parent's denormalised counters and derived status honest at
        // once: the register scan reads them, and a sweep is up to an hour away.
        await syncTransmittal(
          app.db,
          companyId,
          projectId,
          recipient.recordId,
          req.user!.id,
          todayISO(),
        );
      }
      if (recipient.recordType === "letter") {
        const [letter] = await app.db
          .select()
          .from(correspondenceLetters)
          .where(eq(correspondenceLetters.id, recipient.recordId))
          .limit(1);
        if (letter && letter.status === "issued") {
          await app.db
            .update(correspondenceLetters)
            .set({ status: "acknowledged", updatedAt: nowISO() })
            .where(eq(correspondenceLetters.id, letter.id));
          await ledger(app.db, {
            companyId,
            projectId,
            actorId: req.user!.id,
            action: "state_change",
            objectType: "correspondence_letter",
            objectId: letter.id,
            payload: { from: "issued", to: "acknowledged", by: recipient.name },
          });
        }
      }
      return row;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Workflow (#445)                                                   */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/submit",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status !== "draft") throw conflict(`${letter.reference} is already ${letter.status}.`);
      const type = await loadType(app.db, companyId, projectId, letter.typeId);
      const steps = type.approvalSteps ?? [];
      if (steps.length === 0) {
        throw badRequest(
          `The type "${type.name}" has no approval workflow configured, so there is nothing to submit to. Issue the letter directly.`,
        );
      }
      const rows = steps.map((step, index) => ({
        id: newId("cap"),
        companyId,
        projectId,
        letterId,
        seq: index + 1,
        name: step.name,
        role: step.role ?? null,
        userId: step.userId ?? null,
      }));
      await app.db.insert(correspondenceApprovals).values(rows);
      const [updated] = await app.db
        .update(correspondenceLetters)
        .set({ status: "pending_approval", updatedAt: nowISO() })
        .where(eq(correspondenceLetters.id, letterId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_letter",
        objectId: letterId,
        payload: { from: "draft", to: "pending_approval", steps: rows.length },
      });
      const named = rows.map((r) => r.userId).filter((id): id is string => !!id);
      await pushNotifications(
        app.db,
        named.map((userId) => ({
          companyId,
          userId,
          projectId,
          kind: "workflow_step" as const,
          title: `${letter.reference} needs your approval`,
          body: letter.subject,
          recordType: "correspondence_letter",
          recordId: letterId,
        })),
      );
      return { ...updated, approvals: rows };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/approvals/:approvalId/decide",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId, approvalId } = req.params as {
        projectId: string;
        letterId: string;
        approvalId: string;
      };
      const body = z
        .object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(2000).optional() })
        .parse(req.body);
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      const [approval] = await app.db
        .select()
        .from(correspondenceApprovals)
        .where(
          and(
            eq(correspondenceApprovals.id, approvalId),
            eq(correspondenceApprovals.companyId, companyId),
            eq(correspondenceApprovals.letterId, letterId),
          ),
        )
        .limit(1);
      if (!approval) throw notFound("Approval step not found");
      if (approval.status !== "pending") {
        throw conflict(`Step ${approval.seq} was already ${approval.status}.`);
      }
      // Segregation of duties: the author may never approve their own letter.
      if (letter.createdBy === req.user!.id) {
        throw forbidden(
          "The author of a letter cannot approve it. An approval by the requester is not an approval.",
        );
      }
      if (approval.userId && approval.userId !== req.user!.id) {
        throw forbidden(`Step ${approval.seq} is assigned to another person.`);
      }
      if (approval.role && req.companyRole !== approval.role) {
        throw forbidden(`Step ${approval.seq} requires the company role "${approval.role}".`);
      }
      const earlier = await app.db
        .select({ seq: correspondenceApprovals.seq, status: correspondenceApprovals.status })
        .from(correspondenceApprovals)
        .where(
          and(
            eq(correspondenceApprovals.letterId, letterId),
            sql`${correspondenceApprovals.seq} < ${approval.seq}`,
          ),
        );
      const blocking = earlier.find((e) => e.status === "pending");
      if (blocking) throw conflict(`Step ${blocking.seq} has not been decided yet.`);

      const [row] = await app.db
        .update(correspondenceApprovals)
        .set({
          status: body.decision,
          decidedAt: nowISO(),
          decidedBy: req.user!.id,
          comment: body.comment ?? null,
        })
        .where(eq(correspondenceApprovals.id, approvalId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_approval",
        objectId: approvalId,
        payload: { letterId, seq: approval.seq, decision: body.decision },
      });

      let letterStatus = letter.status;
      if (body.decision === "rejected") {
        letterStatus = "draft";
        await app.db
          .update(correspondenceLetters)
          .set({ status: "draft", updatedAt: nowISO() })
          .where(eq(correspondenceLetters.id, letterId));
        await app.db
          .delete(correspondenceApprovals)
          .where(
            and(
              eq(correspondenceApprovals.letterId, letterId),
              eq(correspondenceApprovals.status, "pending"),
            ),
          );
        await ledger(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "correspondence_letter",
          objectId: letterId,
          payload: { from: "pending_approval", to: "draft", reason: "approval rejected", seq: approval.seq },
        });
        await pushNotifications(app.db, [
          {
            companyId,
            userId: letter.createdBy,
            projectId,
            kind: "status_change",
            title: `${letter.reference} was sent back to draft`,
            body: body.comment ?? `Step ${approval.seq} (${approval.name}) was rejected.`,
            recordType: "correspondence_letter",
            recordId: letterId,
          },
        ]);
      }
      const remaining = await app.db
        .select({ n: count() })
        .from(correspondenceApprovals)
        .where(
          and(
            eq(correspondenceApprovals.letterId, letterId),
            eq(correspondenceApprovals.status, "pending"),
          ),
        );
      return {
        approval: row,
        letterStatus,
        approvalsRemaining: remaining[0]?.n ?? 0,
        readyToIssue: body.decision === "approved" && (remaining[0]?.n ?? 0) === 0,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Transitions                                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const body = z
        .object({
          issueDate: isoDateSchema.optional(),
          responseDueDate: isoDateSchema.nullable().optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status !== "draft" && letter.status !== "pending_approval") {
        throw conflict(`${letter.reference} is already ${letter.status}.`);
      }
      const pending = await app.db
        .select({ n: count() })
        .from(correspondenceApprovals)
        .where(
          and(
            eq(correspondenceApprovals.letterId, letterId),
            eq(correspondenceApprovals.status, "pending"),
          ),
        );
      if ((pending[0]?.n ?? 0) > 0) {
        throw conflict(
          `${letter.reference} still has ${pending[0]?.n} approval step(s) outstanding. A letter cannot be issued around its own workflow.`,
        );
      }
      const recipients = await app.db
        .select()
        .from(correspondenceRecipients)
        .where(
          and(
            eq(correspondenceRecipients.companyId, companyId),
            eq(correspondenceRecipients.recordType, "letter"),
            eq(correspondenceRecipients.recordId, letterId),
          ),
        );
      if (recipients.length === 0) {
        throw badRequest(
          `${letter.reference} has no recipients. A letter issued to nobody is not a letter — add at least one recipient first.`,
        );
      }
      const type = await loadType(app.db, companyId, projectId, letter.typeId);
      const issueDate = body.issueDate ?? todayISO();
      const responseDueDate =
        body.responseDueDate !== undefined
          ? body.responseDueDate
          : (letter.responseDueDate ??
            (letter.responseRequired === 1 && type.responseDays !== null
              ? addDaysISO(issueDate, type.responseDays)
              : null));

      let obligationId = letter.obligationId;
      if (
        letter.responseRequired === 1 &&
        responseDueDate !== null &&
        type.createsObligation === 1 &&
        obligationId === null
      ) {
        obligationId = await openObligation(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          sourceClause: `${letter.reference} — ${type.name}`,
          trigger: `A response to ${letter.reference} ("${letter.subject}") is due by ${responseDueDate}.${type.isContractual === 1 ? " This is a contractual record; an unanswered notice is relied on." : ""}`,
          deadlineDate: responseDueDate,
          warnDaysBefore: 3,
          evidenceRequirement: `The response recorded against ${letter.reference}, or the reply letter that answers it.`,
          objectType: "correspondence_letter",
          objectId: letterId,
        });
      }

      const now = nowISO();
      const [row] = await app.db
        .update(correspondenceLetters)
        .set({
          status: "issued",
          issuedAt: `${issueDate}T00:00:00.000Z`,
          issuedBy: req.user!.id,
          responseDueDate,
          obligationId,
          updatedAt: now,
        })
        .where(eq(correspondenceLetters.id, letterId))
        .returning();
      await app.db
        .update(correspondenceRecipients)
        .set({ deliveryStatus: "sent", sentAt: now })
        .where(
          and(
            eq(correspondenceRecipients.recordType, "letter"),
            eq(correspondenceRecipients.recordId, letterId),
            eq(correspondenceRecipients.deliveryStatus, "pending"),
          ),
        );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_letter",
        objectId: letterId,
        payload: {
          from: letter.status,
          to: "issued",
          issueDate,
          responseDueDate,
          recipients: recipients.length,
          obligationId,
        },
      });
      await pushNotifications(
        app.db,
        recipients
          .filter((r) => r.partyType === "user" && r.partyId)
          .map((r) => ({
            companyId,
            userId: r.partyId!,
            projectId,
            kind: "correspondence" as const,
            title: `${letter.reference} was issued to you`,
            body: letter.subject,
            recordType: "correspondence_letter",
            recordId: letterId,
          })),
      );
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/respond",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const body = z
        .object({
          note: z.string().max(20_000).optional(),
          responseLetterId: idSchema.nullable().optional(),
          respondedOn: isoDateSchema.optional(),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status !== "issued" && letter.status !== "acknowledged") {
        throw conflict(`${letter.reference} is ${letter.status}; only an issued letter can be answered.`);
      }
      if (body.responseLetterId) {
        const responseLetter = await loadLetter(companyId, projectId, body.responseLetterId);
        if (responseLetter.id === letter.id) {
          throw badRequest("A letter cannot be its own response.");
        }
      }
      const respondedAt = body.respondedOn ? `${body.respondedOn}T00:00:00.000Z` : nowISO();
      const [row] = await app.db
        .update(correspondenceLetters)
        .set({
          status: "responded",
          respondedAt,
          respondedBy: req.user!.id,
          responseLetterId: body.responseLetterId ?? null,
          updatedAt: nowISO(),
        })
        .where(eq(correspondenceLetters.id, letterId))
        .returning();
      await settleObligation(
        app.db,
        companyId,
        projectId,
        req.user!.id,
        letter.obligationId,
        "satisfied",
        `${letter.reference} was answered on ${respondedAt.slice(0, 10)}.`,
      );
      if (letter.obligationId) {
        await app.db
          .update(correspondenceLetters)
          .set({ obligationId: null })
          .where(eq(correspondenceLetters.id, letterId));
      }
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_letter",
        objectId: letterId,
        payload: { to: "responded", respondedAt, responseLetterId: body.responseLetterId ?? null, note: body.note ?? null },
      });
      await pushNotifications(app.db, [
        {
          companyId,
          userId: letter.createdBy,
          projectId,
          kind: "status_change",
          title: `${letter.reference} has been answered`,
          body: body.note ?? letter.subject,
          recordType: "correspondence_letter",
          recordId: letterId,
        },
      ]);
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/close",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status === "draft" || letter.status === "void" || letter.status === "closed") {
        throw conflict(`${letter.reference} is ${letter.status} and cannot be closed.`);
      }
      const [row] = await app.db
        .update(correspondenceLetters)
        .set({ status: "closed", closedAt: nowISO(), closedBy: req.user!.id, updatedAt: nowISO() })
        .where(eq(correspondenceLetters.id, letterId))
        .returning();
      await settleObligation(
        app.db,
        companyId,
        projectId,
        req.user!.id,
        letter.obligationId,
        "waived",
        `${letter.reference} was closed without a recorded response.`,
      );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_letter",
        objectId: letterId,
        payload: { from: letter.status, to: "closed" },
      });
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/void",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const body = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      const letter = await loadLetter(companyId, projectId, letterId);
      if (letter.status === "void") throw conflict(`${letter.reference} is already void.`);
      const [row] = await app.db
        .update(correspondenceLetters)
        .set({ status: "void", voidReason: body.reason, updatedAt: nowISO() })
        .where(eq(correspondenceLetters.id, letterId))
        .returning();
      await settleObligation(
        app.db,
        companyId,
        projectId,
        req.user!.id,
        letter.obligationId,
        "waived",
        `${letter.reference} was voided: ${body.reason}`,
      );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "correspondence_letter",
        objectId: letterId,
        payload: { from: letter.status, to: "void", reason: body.reason },
      });
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/letters/:letterId/reply",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId, letterId } = req.params as { projectId: string; letterId: string };
      const body = z
        .object({
          typeId: idSchema.optional(),
          subject: z.string().trim().min(1).max(300).optional(),
          body: z.string().max(100_000).nullable().optional(),
          copyRecipients: z.boolean().default(true),
        })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const parent = await loadLetter(companyId, projectId, letterId);
      const type = await loadType(app.db, companyId, projectId, body.typeId ?? parent.typeId);
      const id = newId("clt");
      const { number, reference } = await allocateReference(
        app.db,
        projectId,
        `correspondence:${type.key}`,
        type.prefix,
      );
      const direction = parent.direction === "outbound" ? "inbound" : "outbound";
      const letterDate = todayISO();
      const responseRequired = type.requiresResponse === 1;
      const [row] = await app.db
        .insert(correspondenceLetters)
        .values({
          id,
          companyId,
          projectId,
          typeId: type.id,
          typeKey: type.key,
          number,
          reference,
          subject: body.subject ?? `Re: ${parent.subject}`.slice(0, 300),
          body: body.body ?? null,
          direction,
          status: "draft",
          priority: parent.priority,
          source: "manual",
          isContractual: type.isContractual,
          threadId: parent.threadId,
          inReplyToId: parent.id,
          fromUserId: req.user!.id,
          letterDate,
          responseRequired: responseRequired ? 1 : 0,
          responseDueDate:
            responseRequired && type.responseDays !== null
              ? addDaysISO(letterDate, type.responseDays)
              : null,
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "correspondence_letter",
        objectId: id,
        payload: { reference, replyTo: parent.reference, threadId: parent.threadId },
      });
      if (body.copyRecipients) {
        const parentRecipients = await app.db
          .select()
          .from(correspondenceRecipients)
          .where(
            and(
              eq(correspondenceRecipients.companyId, companyId),
              eq(correspondenceRecipients.recordType, "letter"),
              eq(correspondenceRecipients.recordId, parent.id),
            ),
          );
        const copies = parentRecipients.map((r) => ({
          id: newId("crc"),
          companyId,
          projectId,
          recordType: "letter",
          recordId: id,
          kind: r.kind,
          partyType: r.partyType,
          partyId: r.partyId,
          name: r.name,
          email: r.email,
          organisation: r.organisation,
          acknowledgementRequired: r.acknowledgementRequired,
        }));
        if (copies.length > 0) await app.db.insert(correspondenceRecipients).values(copies);
      }
      return reply.code(201).send(row);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Inbound email (#99)                                               */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/correspondence/inbound", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = pageQuerySchema.extend({ status: z.string().max(24).optional() }).parse(req.query);
    const where = and(
      eq(correspondenceInboundMessages.companyId, req.companyId!),
      eq(correspondenceInboundMessages.projectId, projectId),
      q.status ? eq(correspondenceInboundMessages.status, q.status) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(correspondenceInboundMessages)
        .where(where)
        .orderBy(desc(correspondenceInboundMessages.receivedAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(correspondenceInboundMessages).where(where),
    ]);
    return paginate(rows, total?.n ?? 0, q);
  });

  app.post("/projects/:projectId/correspondence/inbound", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const payload = inboundSchema.parse(req.body);
    const companyId = req.companyId!;

    const availableTypes = await app.db
      .select()
      .from(correspondenceTypes)
      .where(
        and(
          eq(correspondenceTypes.companyId, companyId),
          eq(correspondenceTypes.isActive, 1),
          or(isNull(correspondenceTypes.projectId), eq(correspondenceTypes.projectId, projectId)),
        ),
      );
    if (availableTypes.length === 0) {
      throw badRequest(
        "This company has no active correspondence types, so an inbound message cannot be filed. Seed the type library first (POST /correspondence/types/seed).",
      );
    }
    const targetType =
      (payload.typeId ? availableTypes.find((t) => t.id === payload.typeId) : undefined) ??
      availableTypes.find((t) => t.key === "letter") ??
      availableTypes[0]!;
    if (payload.typeId && targetType.id !== payload.typeId) {
      throw badRequest(`Correspondence type ${payload.typeId} is not available on this project.`);
    }

    const parsed = parseInboundEmail(
      payload.email,
      availableTypes.map((t) => t.prefix),
      nowISO(),
    );

    // Idempotency: the same messageId must produce one record, not two.
    if (parsed.messageId) {
      const [existing] = await app.db
        .select()
        .from(correspondenceInboundMessages)
        .where(
          and(
            eq(correspondenceInboundMessages.companyId, companyId),
            eq(correspondenceInboundMessages.projectId, projectId),
            eq(correspondenceInboundMessages.messageId, parsed.messageId),
          ),
        )
        .limit(1);
      if (existing) {
        return reply.code(200).send({
          action: "duplicate",
          message: existing,
          letterId: existing.letterId,
          reason: `Message ${parsed.messageId} was already captured on ${existing.createdAt}; nothing was created.`,
        });
      }
    }

    const attachedFileIds = parsed.fileIds;
    if (attachedFileIds.length > 0) await assertFiles(app.db, companyId, projectId, attachedFileIds);

    let byReference: RoutingCandidate | null = null;
    if (parsed.reference) {
      const type = availableTypes.find(
        (t) => t.prefix.toUpperCase() === parsed.reference!.prefix.toUpperCase(),
      );
      if (type) {
        const [hit] = await app.db
          .select()
          .from(correspondenceLetters)
          .where(
            and(
              eq(correspondenceLetters.companyId, companyId),
              eq(correspondenceLetters.projectId, projectId),
              eq(correspondenceLetters.typeId, type.id),
              eq(correspondenceLetters.number, parsed.reference.number),
            ),
          )
          .limit(1);
        if (hit) {
          byReference = {
            id: hit.id,
            reference: hit.reference,
            typeKey: hit.typeKey,
            threadId: hit.threadId,
            status: hit.status,
            responseRequired: hit.responseRequired === 1,
          };
        }
      }
    }

    let byMessageId: RoutingCandidate | null = null;
    if (parsed.inReplyTo) {
      const [prior] = await app.db
        .select({ letterId: correspondenceInboundMessages.letterId })
        .from(correspondenceInboundMessages)
        .where(
          and(
            eq(correspondenceInboundMessages.companyId, companyId),
            eq(correspondenceInboundMessages.projectId, projectId),
            eq(correspondenceInboundMessages.messageId, parsed.inReplyTo),
          ),
        )
        .limit(1);
      if (prior?.letterId) {
        const [hit] = await app.db
          .select()
          .from(correspondenceLetters)
          .where(eq(correspondenceLetters.id, prior.letterId))
          .limit(1);
        if (hit) {
          byMessageId = {
            id: hit.id,
            reference: hit.reference,
            typeKey: hit.typeKey,
            threadId: hit.threadId,
            status: hit.status,
            responseRequired: hit.responseRequired === 1,
          };
        }
      }
    }

    const decision = routeInbound({ reference: parsed.reference, byReference, byMessageId });

    const [senderUser] = await app.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(companyMemberships, eq(companyMemberships.userId, users.id))
      .where(and(eq(companyMemberships.companyId, companyId), eq(users.email, parsed.sender.email)))
      .limit(1);
    const [senderContact] = await app.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.email, parsed.sender.email)))
      .limit(1);

    const messageId = newId("cim");
    await app.db.insert(correspondenceInboundMessages).values({
      id: messageId,
      companyId,
      projectId,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      fromAddress: parsed.sender.email,
      fromName: parsed.sender.name,
      toAddresses: parsed.to.map((a) => a.email),
      ccAddresses: parsed.cc.map((a) => a.email),
      subject: parsed.subject,
      bodyText: parsed.body,
      receivedAt: parsed.receivedAt,
      attachments: parsed.attachments,
      status: decision.action === "reply" ? "linked" : decision.action === "unmatched" ? "unmatched" : "created",
      routingReason: decision.reason,
      detectedReference: parsed.reference ? `${parsed.reference.prefix}-${parsed.reference.number}` : null,
      senderUserId: senderUser?.id ?? null,
      senderContactId: senderContact?.id ?? null,
      signatureVerified:
        payload.signatureVerified === undefined ? null : payload.signatureVerified ? 1 : 0,
      ingestedBy: req.user!.id,
    });

    const type = decision.target
      ? (availableTypes.find((t) => t.key === decision.target!.typeKey) ?? targetType)
      : targetType;
    const letterId = newId("clt");
    const { number, reference } = await allocateReference(
      app.db,
      projectId,
      `correspondence:${type.key}`,
      type.prefix,
    );
    const letterDate = parsed.receivedAt.slice(0, 10);
    const responseRequired = decision.action === "reply" ? false : type.requiresResponse === 1;
    await app.db.insert(correspondenceLetters).values({
      id: letterId,
      companyId,
      projectId,
      typeId: type.id,
      typeKey: type.key,
      number,
      reference,
      subject: parsed.cleanedSubject,
      body: parsed.body,
      direction: "inbound",
      status: "issued",
      priority: "normal",
      source: "inbound_email",
      isContractual: type.isContractual,
      threadId: decision.threadId ?? letterId,
      inReplyToId: decision.target?.id ?? null,
      fromName: parsed.sender.name,
      fromEmail: parsed.sender.email,
      fromUserId: senderUser?.id ?? null,
      letterDate,
      issuedAt: parsed.receivedAt,
      issuedBy: senderUser?.id ?? null,
      responseRequired: responseRequired ? 1 : 0,
      responseDueDate:
        responseRequired && type.responseDays !== null ? addDaysISO(letterDate, type.responseDays) : null,
      fileIds: attachedFileIds,
      inboundMessageId: messageId,
      createdBy: req.user!.id,
    });
    await app.db
      .update(correspondenceInboundMessages)
      .set({ letterId })
      .where(eq(correspondenceInboundMessages.id, messageId));
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "correspondence_inbound",
      objectId: messageId,
      payload: {
        action: decision.action,
        reason: decision.reason,
        from: parsed.sender.email,
        letterId,
        reference,
        target: decision.target?.reference ?? null,
      },
    });
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "correspondence_letter",
      objectId: letterId,
      payload: { reference, source: "inbound_email", inboundMessageId: messageId },
    });

    // A reply answers the letter it quotes — that is the response #446 chases.
    if (decision.action === "reply" && decision.target) {
      const [target] = await app.db
        .select()
        .from(correspondenceLetters)
        .where(eq(correspondenceLetters.id, decision.target.id))
        .limit(1);
      if (
        target &&
        target.responseRequired === 1 &&
        target.respondedAt === null &&
        (target.status === "issued" || target.status === "acknowledged")
      ) {
        await app.db
          .update(correspondenceLetters)
          .set({
            status: "responded",
            respondedAt: parsed.receivedAt,
            respondedBy: senderUser?.id ?? null,
            responseLetterId: letterId,
            obligationId: null,
            updatedAt: nowISO(),
          })
          .where(eq(correspondenceLetters.id, target.id));
        await settleObligation(
          app.db,
          companyId,
          projectId,
          req.user!.id,
          target.obligationId,
          "satisfied",
          `${target.reference} was answered by an inbound email from ${parsed.sender.email}.`,
        );
        await ledger(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          action: "state_change",
          objectType: "correspondence_letter",
          objectId: target.id,
          payload: { to: "responded", by: "inbound_email", responseLetterId: letterId },
        });
        await pushNotifications(app.db, [
          {
            companyId,
            userId: target.createdBy,
            projectId,
            kind: "correspondence",
            title: `${target.reference} was answered by email`,
            body: `From ${parsed.sender.email}: ${parsed.cleanedSubject}`,
            recordType: "correspondence_letter",
            recordId: target.id,
          },
        ]);
      }
    }

    return reply.code(201).send({
      action: decision.action,
      reason: decision.reason,
      messageId,
      letterId,
      reference,
      target: decision.target,
      senderResolved: senderUser?.id ? "user" : senderContact?.id ? "contact" : "external",
    });
  });
};
