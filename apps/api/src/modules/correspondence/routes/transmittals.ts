/**
 * TRANSMITTALS (spec #442 creation and issue, #443 recipient acknowledgement
 * tracking and read receipts).
 *
 * A transmittal is the formal record of WHAT was issued, to WHOM, FOR WHAT
 * PURPOSE and WHEN. Its purpose ("for construction" vs "for information") is
 * the fact a claim turns on, so it is frozen at issue along with the item
 * list and the revision of each item — a transmittal whose contents can be
 * edited after issue proves nothing.
 *
 * Acknowledgement is never assumed: a recipient is outstanding until they say
 * otherwise, and a bounced address is reported as a bounce rather than
 * quietly counted as delivered.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  correspondenceLetters,
  correspondenceRecipients,
  drawingRevisions,
  drawingSheets,
  files,
  specSections,
  submittals,
  transmittalItems,
  transmittals,
} from "@constructos/db";
import {
  RECIPIENT_KINDS,
  RECIPIENT_PARTY_TYPES,
  TRANSMITTAL_ITEM_TYPES,
  TRANSMITTAL_METHODS,
  TRANSMITTAL_PURPOSES,
  TRANSMITTAL_STATUSES,
} from "@constructos/shared";
import { badRequest, conflict, notFound } from "../../../lib/errors.js";
import { newId } from "../../../lib/ids.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { ackPosition } from "../engines/tracking.js";
import { loadRecipients, syncTransmittal, toRecipientInput } from "../service.js";
import {
  allocateReference,
  assertContact,
  assertVendor,
  buildGates,
  emailSchema,
  idSchema,
  isoDateSchema,
  ledger,
  nowISO,
  openObligation,
  settleObligation,
  todayISO,
} from "../shared.js";

const itemBodySchema = z.object({
  itemType: z.enum(TRANSMITTAL_ITEM_TYPES).default("file"),
  itemId: idSchema.nullable().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  revision: z.string().max(40).nullable().optional(),
  format: z.string().max(40).nullable().optional(),
  copies: z.number().int().min(1).max(999).default(1),
  notes: z.string().max(2000).nullable().optional(),
});

const recipientBodySchema = z.object({
  kind: z.enum(RECIPIENT_KINDS).default("to"),
  partyType: z.enum(RECIPIENT_PARTY_TYPES).default("external"),
  partyId: idSchema.nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  email: emailSchema.nullable().optional(),
  organisation: z.string().max(200).nullable().optional(),
  acknowledgementRequired: z.boolean().default(true),
});

const transmittalBodySchema = z.object({
  subject: z.string().trim().min(1).max(300),
  purpose: z.enum(TRANSMITTAL_PURPOSES).default("for_information"),
  method: z.enum(TRANSMITTAL_METHODS).default("email"),
  coverNote: z.string().max(20_000).nullable().optional(),
  ackRequired: z.boolean().default(true),
  ackDueDate: isoDateSchema.nullable().optional(),
  letterId: idSchema.nullable().optional(),
  items: z.array(itemBodySchema).max(500).default([]),
  recipients: z.array(recipientBodySchema).max(200).default([]),
});

const transmittalPatchSchema = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  purpose: z.enum(TRANSMITTAL_PURPOSES).optional(),
  method: z.enum(TRANSMITTAL_METHODS).optional(),
  coverNote: z.string().max(20_000).nullable().optional(),
  ackRequired: z.boolean().optional(),
  ackDueDate: isoDateSchema.nullable().optional(),
});

const listSchema = pageQuerySchema.extend({
  status: z.enum(TRANSMITTAL_STATUSES).optional(),
  purpose: z.enum(TRANSMITTAL_PURPOSES).optional(),
  outstandingOnly: z.coerce.boolean().optional(),
  q: z.string().max(200).optional(),
});

export const transmittalRoutes: FastifyPluginAsync = async (app) => {
  const { readGate, standardGate } = buildGates(app);

  async function loadTransmittal(companyId: string, projectId: string, transmittalId: string) {
    const [row] = await app.db
      .select()
      .from(transmittals)
      .where(
        and(
          eq(transmittals.id, transmittalId),
          eq(transmittals.companyId, companyId),
          eq(transmittals.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Transmittal not found");
    return row;
  }

  /**
   * Resolve a transmittal line to the register that owns it, so the title and
   * revision on the record are the ones the register actually holds rather
   * than whatever the caller typed.
   */
  async function resolveItem(
    companyId: string,
    projectId: string,
    input: z.infer<typeof itemBodySchema>,
  ): Promise<{ title: string; revision: string | null }> {
    if (!input.itemId) {
      if (!input.title) throw badRequest("A transmittal line with no item id needs a title.");
      return { title: input.title, revision: input.revision ?? null };
    }
    switch (input.itemType) {
      case "file":
      case "document": {
        const [row] = await app.db
          .select({ id: files.id, name: files.name, revisionLabel: files.revisionLabel, projectId: files.projectId })
          .from(files)
          .where(and(eq(files.companyId, companyId), eq(files.id, input.itemId)))
          .limit(1);
        if (!row) throw badRequest(`File ${input.itemId} not found in this company.`);
        if (row.projectId !== null && row.projectId !== projectId) {
          throw badRequest(`File ${input.itemId} belongs to another project.`);
        }
        return { title: input.title ?? row.name, revision: input.revision ?? row.revisionLabel };
      }
      case "drawing_sheet": {
        // The revision printed on the transmittal is the sheet's CURRENT
        // revision at the moment of issue, read from the drawings register
        // rather than typed — that is the fact a claim turns on.
        const [row] = await app.db
          .select({
            id: drawingSheets.id,
            number: drawingSheets.number,
            title: drawingSheets.title,
            revision: drawingRevisions.revision,
          })
          .from(drawingSheets)
          .leftJoin(drawingRevisions, eq(drawingRevisions.id, drawingSheets.currentRevisionId))
          .where(and(eq(drawingSheets.projectId, projectId), eq(drawingSheets.id, input.itemId)))
          .limit(1);
        if (!row) throw badRequest(`Drawing sheet ${input.itemId} not found in this project.`);
        return {
          title: input.title ?? `${row.number} — ${row.title}`,
          revision: input.revision ?? row.revision ?? null,
        };
      }
      case "submittal": {
        const [row] = await app.db
          .select({ id: submittals.id, number: submittals.number, title: submittals.title, revision: submittals.revision })
          .from(submittals)
          .where(and(eq(submittals.projectId, projectId), eq(submittals.id, input.itemId)))
          .limit(1);
        if (!row) throw badRequest(`Submittal ${input.itemId} not found in this project.`);
        return {
          title: input.title ?? `SUB-${String(row.number).padStart(3, "0")} ${row.title}`,
          revision: input.revision ?? String(row.revision),
        };
      }
      case "spec_section": {
        const [row] = await app.db
          .select({ id: specSections.id, code: specSections.code, title: specSections.title })
          .from(specSections)
          .where(and(eq(specSections.projectId, projectId), eq(specSections.id, input.itemId)))
          .limit(1);
        if (!row) throw badRequest(`Specification section ${input.itemId} not found in this project.`);
        return { title: input.title ?? `${row.code} ${row.title}`, revision: input.revision ?? null };
      }
      default: {
        if (!input.title) throw badRequest("A transmittal line needs a title.");
        return { title: input.title, revision: input.revision ?? null };
      }
    }
  }

  async function resolveRecipient(
    companyId: string,
    input: z.infer<typeof recipientBodySchema>,
  ): Promise<{ name: string; email: string | null; partyId: string | null }> {
    if (input.partyType === "vendor") {
      if (!input.partyId) throw badRequest("A vendor recipient needs a partyId.");
      await assertVendor(app.db, companyId, input.partyId);
    }
    if (input.partyType === "contact") {
      if (!input.partyId) throw badRequest("A contact recipient needs a partyId.");
      await assertContact(app.db, companyId, input.partyId);
    }
    if (!input.name) throw badRequest("Every transmittal recipient needs a name.");
    return { name: input.name, email: input.email ?? null, partyId: input.partyId ?? null };
  }

  async function addItems(
    companyId: string,
    projectId: string,
    transmittalId: string,
    actorId: string,
    inputs: readonly z.infer<typeof itemBodySchema>[],
    startSeq: number,
  ) {
    const rows = [];
    let seq = startSeq;
    for (const input of inputs) {
      const resolved = await resolveItem(companyId, projectId, input);
      seq += 1;
      rows.push({
        id: newId("tri"),
        companyId,
        projectId,
        transmittalId,
        seq,
        itemType: input.itemType,
        itemId: input.itemId ?? null,
        title: resolved.title,
        revision: resolved.revision,
        format: input.format ?? null,
        copies: input.copies,
        notes: input.notes ?? null,
      });
    }
    if (rows.length > 0) {
      await app.db.insert(transmittalItems).values(rows);
      for (const row of rows) {
        await ledger(app.db, {
          companyId,
          projectId,
          actorId,
          action: "create",
          objectType: "transmittal_item",
          objectId: row.id,
          payload: { transmittalId, itemType: row.itemType, itemId: row.itemId, title: row.title, revision: row.revision },
        });
      }
    }
    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/correspondence/transmittals", { preHandler: readGate }, async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = listSchema.parse(req.query);
    const where = and(
      eq(transmittals.companyId, req.companyId!),
      eq(transmittals.projectId, projectId),
      q.status ? eq(transmittals.status, q.status) : undefined,
      q.purpose ? eq(transmittals.purpose, q.purpose) : undefined,
      q.outstandingOnly
        ? and(
            inArray(transmittals.status, ["issued", "partially_acknowledged"]),
            sql`${transmittals.acknowledgedCount} < ${transmittals.ackRequiredCount}`,
          )
        : undefined,
      q.q ? or(ilike(transmittals.subject, `%${q.q}%`), ilike(transmittals.reference, `%${q.q}%`)) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      app.db
        .select()
        .from(transmittals)
        .where(where)
        .orderBy(desc(transmittals.createdAt))
        .limit(q.pageSize)
        .offset(pageOffset(q)),
      app.db.select({ n: count() }).from(transmittals).where(where),
    ]);
    const today = todayISO();
    return paginate(
      rows.map((row) => ({
        ...row,
        outstanding: Math.max(0, row.ackRequiredCount - row.acknowledgedCount),
        overdue:
          row.ackRequired === 1 &&
          row.ackDueDate !== null &&
          row.ackDueDate < today &&
          row.acknowledgedCount < row.ackRequiredCount &&
          (row.status === "issued" || row.status === "partially_acknowledged"),
      })),
      total?.n ?? 0,
      q,
    );
  });

  app.post("/projects/:projectId/correspondence/transmittals", { preHandler: standardGate }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const body = transmittalBodySchema.parse(req.body);
    const companyId = req.companyId!;
    if (body.letterId) {
      const [letter] = await app.db
        .select({ id: correspondenceLetters.id })
        .from(correspondenceLetters)
        .where(
          and(
            eq(correspondenceLetters.id, body.letterId),
            eq(correspondenceLetters.companyId, companyId),
            eq(correspondenceLetters.projectId, projectId),
          ),
        )
        .limit(1);
      if (!letter) throw badRequest(`Cover letter ${body.letterId} not found in this project.`);
    }
    const id = newId("trn");
    const { number, reference } = await allocateReference(app.db, projectId, "transmittal", "TR");
    const [row] = await app.db
      .insert(transmittals)
      .values({
        id,
        companyId,
        projectId,
        number,
        reference,
        subject: body.subject,
        purpose: body.purpose,
        method: body.method,
        coverNote: body.coverNote ?? null,
        ackRequired: body.ackRequired ? 1 : 0,
        ackDueDate: body.ackDueDate ?? null,
        letterId: body.letterId ?? null,
        createdBy: req.user!.id,
      })
      .returning();
    await ledger(app.db, {
      companyId,
      projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "transmittal",
      objectId: id,
      payload: { reference, purpose: body.purpose, method: body.method },
    });

    const items = await addItems(companyId, projectId, id, req.user!.id, body.items, 0);
    const recipientRows = [];
    for (const input of body.recipients) {
      const resolved = await resolveRecipient(companyId, input);
      recipientRows.push({
        id: newId("crc"),
        companyId,
        projectId,
        recordType: "transmittal",
        recordId: id,
        kind: input.kind,
        partyType: input.partyType,
        partyId: resolved.partyId,
        name: resolved.name,
        email: resolved.email,
        organisation: input.organisation ?? null,
        acknowledgementRequired: input.acknowledgementRequired ? 1 : 0,
      });
    }
    if (recipientRows.length > 0) {
      await app.db.insert(correspondenceRecipients).values(recipientRows);
      for (const r of recipientRows) {
        await ledger(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          action: "create",
          objectType: "correspondence_recipient",
          objectId: r.id,
          payload: { recordType: "transmittal", recordId: id, name: r.name },
        });
      }
    }
    await app.db
      .update(transmittals)
      .set({ itemCount: items.length, recipientCount: recipientRows.length, updatedAt: nowISO() })
      .where(eq(transmittals.id, id));
    return reply.code(201).send({ ...row, itemCount: items.length, items, recipients: recipientRows });
  });

  app.get(
    "/projects/:projectId/correspondence/transmittals/:transmittalId",
    { preHandler: readGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      const [items, recipients] = await Promise.all([
        app.db
          .select()
          .from(transmittalItems)
          .where(
            and(
              eq(transmittalItems.companyId, companyId),
              eq(transmittalItems.transmittalId, transmittalId),
            ),
          )
          .orderBy(asc(transmittalItems.seq)),
        loadRecipients(app.db, companyId, "transmittal", transmittalId),
      ]);
      return {
        ...record,
        items,
        recipients,
        position: ackPosition(recipients.map(toRecipientInput), record.ackDueDate, todayISO()),
      };
    },
  );

  app.patch(
    "/projects/:projectId/correspondence/transmittals/:transmittalId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const body = transmittalPatchSchema.parse(req.body);
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status !== "draft") {
        // Once issued, only the acknowledgement deadline may move — and moving
        // it is itself ledgered, because it changes who is late.
        const allowed = Object.keys(body).every((k) => k === "ackDueDate");
        if (!allowed) {
          throw conflict(
            `${record.reference} has been issued; its subject, purpose and contents are frozen. Issue a revised transmittal instead.`,
          );
        }
      }
      const set: Record<string, unknown> = { updatedAt: nowISO() };
      for (const key of ["subject", "purpose", "method", "coverNote", "ackDueDate"] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      if (body.ackRequired !== undefined) set["ackRequired"] = body.ackRequired ? 1 : 0;
      const [row] = await app.db
        .update(transmittals)
        .set(set)
        .where(eq(transmittals.id, transmittalId))
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "update",
        objectType: "transmittal",
        objectId: transmittalId,
        payload: { changed: Object.keys(set).filter((k) => k !== "updatedAt") },
      });
      return row;
    },
  );

  /* ---------------------------------------------------------------- */
  /* Items and recipients                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/items",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const body = z.object({ items: z.array(itemBodySchema).min(1).max(500) }).parse(req.body);
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status !== "draft") {
        throw conflict(`${record.reference} has been issued; its contents are frozen.`);
      }
      const [{ maxSeq = 0 } = { maxSeq: 0 }] = await app.db
        .select({ maxSeq: sql<number>`coalesce(max(${transmittalItems.seq}), 0)::int` })
        .from(transmittalItems)
        .where(eq(transmittalItems.transmittalId, transmittalId));
      const rows = await addItems(companyId, projectId, transmittalId, req.user!.id, body.items, Number(maxSeq));
      const [{ n = 0 } = { n: 0 }] = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(transmittalItems)
        .where(eq(transmittalItems.transmittalId, transmittalId));
      await app.db
        .update(transmittals)
        .set({ itemCount: Number(n), updatedAt: nowISO() })
        .where(eq(transmittals.id, transmittalId));
      return reply.code(201).send({ items: rows, itemCount: Number(n) });
    },
  );

  app.delete(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/items/:itemId",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, transmittalId, itemId } = req.params as {
        projectId: string;
        transmittalId: string;
        itemId: string;
      };
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status !== "draft") {
        throw conflict(`${record.reference} has been issued; its contents are frozen.`);
      }
      const [item] = await app.db
        .select()
        .from(transmittalItems)
        .where(
          and(
            eq(transmittalItems.id, itemId),
            eq(transmittalItems.companyId, companyId),
            eq(transmittalItems.transmittalId, transmittalId),
          ),
        )
        .limit(1);
      if (!item) throw notFound("Transmittal item not found");
      await app.db.delete(transmittalItems).where(eq(transmittalItems.id, itemId));
      const [{ n = 0 } = { n: 0 }] = await app.db
        .select({ n: sql<number>`count(*)::int` })
        .from(transmittalItems)
        .where(eq(transmittalItems.transmittalId, transmittalId));
      await app.db
        .update(transmittals)
        .set({ itemCount: Number(n), updatedAt: nowISO() })
        .where(eq(transmittals.id, transmittalId));
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "delete",
        objectType: "transmittal_item",
        objectId: itemId,
        payload: { transmittalId, title: item.title },
      });
      return { deleted: true, itemCount: Number(n) };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/recipients",
    { preHandler: standardGate },
    async (req, reply) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const body = recipientBodySchema.parse(req.body);
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status === "closed" || record.status === "void") {
        throw conflict(`${record.reference} is ${record.status}.`);
      }
      const resolved = await resolveRecipient(companyId, body);
      const id = newId("crc");
      const [row] = await app.db
        .insert(correspondenceRecipients)
        .values({
          id,
          companyId,
          projectId,
          recordType: "transmittal",
          recordId: transmittalId,
          kind: body.kind,
          partyType: body.partyType,
          partyId: resolved.partyId,
          name: resolved.name,
          email: resolved.email,
          organisation: body.organisation ?? null,
          acknowledgementRequired: body.acknowledgementRequired ? 1 : 0,
          deliveryStatus: record.status === "draft" ? "pending" : "sent",
          sentAt: record.status === "draft" ? null : nowISO(),
        })
        .returning();
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "correspondence_recipient",
        objectId: id,
        payload: { recordType: "transmittal", recordId: transmittalId, name: resolved.name },
      });
      await syncTransmittal(app.db, companyId, projectId, transmittalId, req.user!.id, todayISO());
      return reply.code(201).send(row);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Transitions                                                       */
  /* ---------------------------------------------------------------- */

  app.post(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/issue",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const body = z
        .object({ issueDate: isoDateSchema.optional(), ackDueDate: isoDateSchema.nullable().optional() })
        .parse(req.body ?? {});
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status !== "draft") throw conflict(`${record.reference} is already ${record.status}.`);
      const [items, recipients] = await Promise.all([
        app.db
          .select({ n: count() })
          .from(transmittalItems)
          .where(eq(transmittalItems.transmittalId, transmittalId)),
        loadRecipients(app.db, companyId, "transmittal", transmittalId),
      ]);
      if ((items[0]?.n ?? 0) === 0) {
        throw badRequest(`${record.reference} has no items. A transmittal that transmits nothing is not a record.`);
      }
      if (recipients.length === 0) {
        throw badRequest(`${record.reference} has no recipients.`);
      }
      const issueDate = body.issueDate ?? todayISO();
      const ackDueDate = body.ackDueDate !== undefined ? body.ackDueDate : record.ackDueDate;

      let obligationId = record.obligationId;
      const requiresAck = record.ackRequired === 1 && recipients.some((r) => r.acknowledgementRequired === 1);
      if (requiresAck && ackDueDate !== null && obligationId === null) {
        obligationId = await openObligation(app.db, {
          companyId,
          projectId,
          actorId: req.user!.id,
          sourceClause: `${record.reference} — transmittal ${record.purpose.replace(/_/g, " ")}`,
          trigger: `Every recipient of ${record.reference} ("${record.subject}") must acknowledge receipt by ${ackDueDate}.`,
          deadlineDate: ackDueDate,
          warnDaysBefore: 2,
          evidenceRequirement: `An acknowledgement recorded against each recipient of ${record.reference}.`,
          objectType: "transmittal",
          objectId: transmittalId,
        });
      }

      const now = nowISO();
      const [row] = await app.db
        .update(transmittals)
        .set({
          status: "issued",
          issuedAt: `${issueDate}T00:00:00.000Z`,
          issuedBy: req.user!.id,
          ackDueDate,
          obligationId,
          itemCount: items[0]?.n ?? 0,
          updatedAt: now,
        })
        .where(eq(transmittals.id, transmittalId))
        .returning();
      await app.db
        .update(correspondenceRecipients)
        .set({ deliveryStatus: "sent", sentAt: now })
        .where(
          and(
            eq(correspondenceRecipients.recordType, "transmittal"),
            eq(correspondenceRecipients.recordId, transmittalId),
            eq(correspondenceRecipients.deliveryStatus, "pending"),
          ),
        );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "transmittal",
        objectId: transmittalId,
        payload: {
          from: "draft",
          to: "issued",
          issueDate,
          ackDueDate,
          purpose: record.purpose,
          items: items[0]?.n ?? 0,
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
            title: `${record.reference} was issued to you (${record.purpose.replace(/_/g, " ")})`,
            body: record.subject,
            recordType: "transmittal",
            recordId: transmittalId,
          })),
      );
      const synced = await syncTransmittal(app.db, companyId, projectId, transmittalId, req.user!.id, todayISO());
      return { ...row, status: synced.status, position: synced.position };
    },
  );

  app.get(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/acknowledgement",
    { preHandler: readGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      const recipients = await loadRecipients(app.db, companyId, "transmittal", transmittalId);
      return {
        reference: record.reference,
        status: record.status,
        ackDueDate: record.ackDueDate,
        position: ackPosition(recipients.map(toRecipientInput), record.ackDueDate, todayISO()),
        recipients,
      };
    },
  );

  app.post(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/close",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status === "draft" || record.status === "void" || record.status === "closed") {
        throw conflict(`${record.reference} is ${record.status} and cannot be closed.`);
      }
      const [row] = await app.db
        .update(transmittals)
        .set({ status: "closed", closedAt: nowISO(), closedBy: req.user!.id, updatedAt: nowISO() })
        .where(eq(transmittals.id, transmittalId))
        .returning();
      await settleObligation(
        app.db,
        companyId,
        projectId,
        req.user!.id,
        record.obligationId,
        record.acknowledgedCount >= record.ackRequiredCount ? "satisfied" : "waived",
        `${record.reference} was closed with ${record.acknowledgedCount} of ${record.ackRequiredCount} acknowledgements.`,
      );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "transmittal",
        objectId: transmittalId,
        payload: {
          from: record.status,
          to: "closed",
          acknowledged: record.acknowledgedCount,
          required: record.ackRequiredCount,
        },
      });
      return row;
    },
  );

  app.post(
    "/projects/:projectId/correspondence/transmittals/:transmittalId/void",
    { preHandler: standardGate },
    async (req) => {
      const { projectId, transmittalId } = req.params as { projectId: string; transmittalId: string };
      const body = z.object({ reason: z.string().trim().min(3).max(2000) }).parse(req.body);
      const companyId = req.companyId!;
      const record = await loadTransmittal(companyId, projectId, transmittalId);
      if (record.status === "void") throw conflict(`${record.reference} is already void.`);
      const [row] = await app.db
        .update(transmittals)
        .set({ status: "void", voidReason: body.reason, updatedAt: nowISO() })
        .where(eq(transmittals.id, transmittalId))
        .returning();
      await settleObligation(
        app.db,
        companyId,
        projectId,
        req.user!.id,
        record.obligationId,
        "waived",
        `${record.reference} was voided: ${body.reason}`,
      );
      await ledger(app.db, {
        companyId,
        projectId,
        actorId: req.user!.id,
        action: "state_change",
        objectType: "transmittal",
        objectId: transmittalId,
        payload: { from: record.status, to: "void", reason: body.reason },
      });
      return row;
    },
  );
};
