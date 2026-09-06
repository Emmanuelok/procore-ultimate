import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { engagements, stakeholders } from "@constructos/db";
import { CONSENT_STATUSES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { isoDateSchema } from "../field/dates.js";
import {
  ENGAGEMENT_KINDS,
  STAKEHOLDER_CATEGORIES,
  STAKEHOLDER_QUADRANTS,
  quadrantFor,
} from "./reference.js";
import { validateFiles } from "./shared.js";

/** How many engagements a stakeholder drawer previews before the register. */
const STAKEHOLDER_ENGAGEMENT_PREVIEW = 50;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const scale = z.number().int().min(1).max(5);

const stakeholderCreateSchema = z.object({
  name: z.string().min(1).max(300),
  organisation: z.string().max(300).nullable().optional(),
  category: z.enum(STAKEHOLDER_CATEGORIES).nullable().optional(),
  influence: scale.optional(),
  interest: scale.optional(),
  contact: z.string().max(300).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
});

const stakeholderPatchSchema = stakeholderCreateSchema.partial();

const stakeholderListQuery = pageQuerySchema.extend({
  category: z.enum(STAKEHOLDER_CATEGORIES).optional(),
  quadrant: z.enum(STAKEHOLDER_QUADRANTS).optional(),
});

const feedbackSchema = z.object({
  point: z.string().min(1).max(5000),
  raisedBy: z.string().max(300).nullable().optional(),
  disposition: z.string().max(5000).nullable().optional(),
});

const engagementCreateSchema = z.object({
  title: z.string().min(1).max(300),
  kind: z.enum(ENGAGEMENT_KINDS),
  engagementDate: isoDateSchema,
  location: z.string().max(300).nullable().optional(),
  stakeholderIds: z.array(z.string().min(1)).max(500).optional(),
  attendeeCount: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  summary: z.string().max(50000).nullable().optional(),
  feedback: z.array(feedbackSchema).max(500).optional(),
  consentStatus: z.enum(CONSENT_STATUSES).nullable().optional(),
  fileIds: z.array(z.string().min(1)).max(200).optional(),
});

const engagementPatchSchema = engagementCreateSchema.partial();

const engagementListQuery = pageQuerySchema.extend({
  kind: z.enum(ENGAGEMENT_KINDS).optional(),
  consentStatus: z.enum(CONSENT_STATUSES).optional(),
  stakeholderId: z.string().min(1).optional(),
});

/**
 * Stakeholder register, influence/interest mapping and the engagement /
 * consultation log — spec Domain J #579-584 (plus FPIC consent capture from
 * #575 carried on the engagement record).
 */
export async function registerEngagementRoutes(app: FastifyInstance): Promise<void> {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("land", "read")];
  const standardGate = [app.authenticate, app.requireCompany, app.requireTool("land", "standard")];

  /**
   * `stakeholder_ids` is a JSONB array; `@>` asks Postgres whether it
   * CONTAINS the id, which the GIN index on the column answers directly.
   * Every use below used to pull rows into memory and test with
   * `Array.includes` — the register list capped that scan at 1000 rows, so on
   * a long-running scheme an older engagement silently vanished from a
   * stakeholder's consultation history and `total` under-reported it. A
   * consultation record that quietly loses entries is not a record.
   */
  const mentions = (stakeholderId: string) =>
    sql`${engagements.stakeholderIds} @> ${JSON.stringify([stakeholderId])}::jsonb`;


  async function fetchStakeholder(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(stakeholders)
      .where(
        and(
          eq(stakeholders.id, id),
          eq(stakeholders.companyId, companyId),
          eq(stakeholders.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Stakeholder not found");
    return rows[0];
  }

  async function fetchEngagement(id: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(engagements)
      .where(
        and(
          eq(engagements.id, id),
          eq(engagements.companyId, companyId),
          eq(engagements.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Engagement not found");
    return rows[0];
  }

  async function validateStakeholders(
    companyId: string,
    projectId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const rows = await app.db
      .select({ id: stakeholders.id })
      .from(stakeholders)
      .where(
        and(
          inArray(stakeholders.id, unique),
          eq(stakeholders.companyId, companyId),
          eq(stakeholders.projectId, projectId),
        ),
      );
    if (rows.length !== unique.length) {
      throw badRequest("stakeholderIds must reference stakeholders in this project");
    }
  }

  const decorateStakeholder = (s: typeof stakeholders.$inferSelect) => ({
    ...s,
    quadrant: quadrantFor(s.influence, s.interest),
  });

  /* ---------------------------------------------------------------- */
  /* Stakeholder register (#579)                                       */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/stakeholders", { preHandler: standardGate }, async (req, reply) => {
    const body = stakeholderCreateSchema.parse(req.body);
    const id = newId("stk");
    await app.db.insert(stakeholders).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      name: body.name,
      organisation: body.organisation ?? null,
      category: body.category ?? null,
      influence: body.influence ?? 3,
      interest: body.interest ?? 3,
      contact: body.contact ?? null,
      notes: body.notes ?? null,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "stakeholder",
      objectId: id,
      payload: {
        name: body.name,
        organisation: body.organisation ?? null,
        category: body.category ?? null,
        influence: body.influence ?? 3,
        interest: body.interest ?? 3,
      },
      storePayload: true,
    });
    return reply.status(201).send(decorateStakeholder(await fetchStakeholder(id, req.companyId!, req.projectId!)));
  });

  app.get("/projects/:projectId/stakeholders", { preHandler: readGate }, async (req) => {
    const q = stakeholderListQuery.parse(req.query);
    const clauses = [
      eq(stakeholders.companyId, req.companyId!),
      eq(stakeholders.projectId, req.projectId!),
    ];
    if (q.category) clauses.push(eq(stakeholders.category, q.category));
    const where = and(...clauses);
    if (q.quadrant) {
      // quadrant is derived, so it is filtered after projection; the page is
      // then taken from the filtered set to keep the count honest.
      const all = await app.db
        .select()
        .from(stakeholders)
        .where(where)
        .orderBy(desc(stakeholders.influence), desc(stakeholders.interest), asc(stakeholders.name));
      const filtered = all.map(decorateStakeholder).filter((s) => s.quadrant === q.quadrant);
      return paginate(filtered.slice(pageOffset(q), pageOffset(q) + q.pageSize), filtered.length, q);
    }
    const [totalRow] = await app.db.select({ n: count() }).from(stakeholders).where(where);
    const rows = await app.db
      .select()
      .from(stakeholders)
      .where(where)
      .orderBy(desc(stakeholders.influence), desc(stakeholders.interest), asc(stakeholders.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows.map(decorateStakeholder), Number(totalRow?.n ?? 0), q);
  });

  /**
   * Influence/interest grid (#579). Returns the full 5×5 lattice — including
   * the empty cells — so the client renders a stable matrix rather than a
   * ragged scatter, plus the Mendelow quadrant roll-up that says what to
   * actually do with each group.
   */
  app.get("/projects/:projectId/stakeholders/matrix", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(stakeholders)
      .where(
        and(
          eq(stakeholders.companyId, req.companyId!),
          eq(stakeholders.projectId, req.projectId!),
        ),
      )
      .orderBy(asc(stakeholders.name));
    const cells: {
      influence: number;
      interest: number;
      quadrant: string;
      count: number;
      stakeholders: { id: string; name: string; organisation: string | null }[];
    }[] = [];
    for (let influence = 5; influence >= 1; influence -= 1) {
      for (let interest = 1; interest <= 5; interest += 1) {
        const inCell = rows.filter((s) => s.influence === influence && s.interest === interest);
        cells.push({
          influence,
          interest,
          quadrant: quadrantFor(influence, interest),
          count: inCell.length,
          stakeholders: inCell.map((s) => ({
            id: s.id,
            name: s.name,
            organisation: s.organisation,
          })),
        });
      }
    }
    const quadrants: Record<string, number> = Object.fromEntries(
      STAKEHOLDER_QUADRANTS.map((q) => [q, 0]),
    );
    for (const s of rows) {
      const q = quadrantFor(s.influence, s.interest);
      quadrants[q] = (quadrants[q] ?? 0) + 1;
    }
    return { size: 5, grid: cells, quadrants, total: rows.length };
  });

  app.get(
    "/projects/:projectId/stakeholders/:stakeholderId",
    { preHandler: readGate },
    async (req) => {
      const { stakeholderId } = req.params as { stakeholderId: string };
      const s = await fetchStakeholder(stakeholderId, req.companyId!, req.projectId!);
      const [countRow] = await app.db
        .select({ n: count() })
        .from(engagements)
        .where(
          and(
            eq(engagements.companyId, req.companyId!),
            eq(engagements.projectId, req.projectId!),
            mentions(stakeholderId),
          ),
        );
      const recent = await app.db
        .select()
        .from(engagements)
        .where(
          and(
            eq(engagements.companyId, req.companyId!),
            eq(engagements.projectId, req.projectId!),
            mentions(stakeholderId),
          ),
        )
        .orderBy(desc(engagements.engagementDate))
        .limit(STAKEHOLDER_ENGAGEMENT_PREVIEW);
      return {
        ...decorateStakeholder(s),
        engagements: recent,
        engagementCount: Number(countRow?.n ?? 0),
        // the drawer shows the most recent; the register is the full history
        engagementsTruncated: Number(countRow?.n ?? 0) > recent.length,
      };
    },
  );

  app.patch(
    "/projects/:projectId/stakeholders/:stakeholderId",
    { preHandler: standardGate },
    async (req) => {
      const { stakeholderId } = req.params as { stakeholderId: string };
      const body = stakeholderPatchSchema.parse(req.body);
      await fetchStakeholder(stakeholderId, req.companyId!, req.projectId!);
      const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      for (const key of [
        "name",
        "organisation",
        "category",
        "influence",
        "interest",
        "contact",
        "notes",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      await app.db.update(stakeholders).set(set).where(eq(stakeholders.id, stakeholderId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "stakeholder",
        objectId: stakeholderId,
        payload: { changed: Object.keys(body) },
      });
      return decorateStakeholder(
        await fetchStakeholder(stakeholderId, req.companyId!, req.projectId!),
      );
    },
  );

  app.delete(
    "/projects/:projectId/stakeholders/:stakeholderId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { stakeholderId } = req.params as { stakeholderId: string };
      const s = await fetchStakeholder(stakeholderId, req.companyId!, req.projectId!);
      const [usedRow] = await app.db
        .select({ n: count() })
        .from(engagements)
        .where(
          and(
            eq(engagements.companyId, req.companyId!),
            eq(engagements.projectId, req.projectId!),
            mentions(stakeholderId),
          ),
        );
      if (Number(usedRow?.n ?? 0) > 0) {
        throw conflict(
          "A stakeholder recorded on an engagement cannot be deleted — the consultation " +
            "record must keep pointing at a real party",
        );
      }
      await app.db.delete(stakeholders).where(eq(stakeholders.id, stakeholderId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "stakeholder",
        objectId: stakeholderId,
        payload: { name: s.name, organisation: s.organisation, category: s.category },
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Engagement / consultation log (#580-584)                          */
  /* ---------------------------------------------------------------- */

  app.post("/projects/:projectId/engagements", { preHandler: standardGate }, async (req, reply) => {
    const body = engagementCreateSchema.parse(req.body);
    await validateStakeholders(req.companyId!, req.projectId!, body.stakeholderIds ?? []);
    await validateFiles(app.db, req.companyId!, req.projectId!, body.fileIds ?? []);
    const id = newId("eng");
    await app.db.insert(engagements).values({
      id,
      companyId: req.companyId!,
      projectId: req.projectId!,
      title: body.title,
      kind: body.kind,
      engagementDate: body.engagementDate,
      location: body.location ?? null,
      stakeholderIds: body.stakeholderIds ?? [],
      attendeeCount: body.attendeeCount ?? null,
      summary: body.summary ?? null,
      feedback: body.feedback ?? [],
      consentStatus: body.consentStatus ?? null,
      fileIds: body.fileIds ?? [],
      recordedBy: req.user!.id,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "engagement",
      objectId: id,
      payload: {
        title: body.title,
        kind: body.kind,
        engagementDate: body.engagementDate,
        stakeholderIds: body.stakeholderIds ?? [],
        attendeeCount: body.attendeeCount ?? null,
        consentStatus: body.consentStatus ?? null,
        feedback: body.feedback ?? [],
      },
      storePayload: true,
    });
    const created = await fetchEngagement(id, req.companyId!, req.projectId!);
    return reply.status(201).send(created);
  });

  app.get("/projects/:projectId/engagements", { preHandler: readGate }, async (req) => {
    const q = engagementListQuery.parse(req.query);
    const clauses = [
      eq(engagements.companyId, req.companyId!),
      eq(engagements.projectId, req.projectId!),
    ];
    if (q.kind) clauses.push(eq(engagements.kind, q.kind));
    if (q.consentStatus) clauses.push(eq(engagements.consentStatus, q.consentStatus));
    // filtered IN SQL, so pagination and the total are both honest
    if (q.stakeholderId) clauses.push(mentions(q.stakeholderId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(engagements).where(where);
    const rows = await app.db
      .select()
      .from(engagements)
      .where(where)
      .orderBy(desc(engagements.engagementDate), desc(engagements.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const total = Number(totalRow?.n ?? 0);
    const stakeholderIds = [...new Set(rows.flatMap((e) => e.stakeholderIds))];
    const named = stakeholderIds.length
      ? await app.db
          .select({ id: stakeholders.id, name: stakeholders.name })
          .from(stakeholders)
          .where(inArray(stakeholders.id, stakeholderIds))
      : [];
    const nameOf = new Map(named.map((s) => [s.id, s.name]));
    const items = rows.map((e) => ({
      ...e,
      stakeholderNames: e.stakeholderIds.map((sid) => nameOf.get(sid) ?? sid),
      feedbackCount: (e.feedback as unknown[]).length,
    }));
    return paginate(items, total, q);
  });

  app.get(
    "/projects/:projectId/engagements/:engagementId",
    { preHandler: readGate },
    async (req) => {
      const { engagementId } = req.params as { engagementId: string };
      const e = await fetchEngagement(engagementId, req.companyId!, req.projectId!);
      const named = e.stakeholderIds.length
        ? await app.db
            .select()
            .from(stakeholders)
            .where(inArray(stakeholders.id, e.stakeholderIds))
        : [];
      return { ...e, stakeholders: named.map(decorateStakeholder) };
    },
  );

  app.patch(
    "/projects/:projectId/engagements/:engagementId",
    { preHandler: standardGate },
    async (req) => {
      const { engagementId } = req.params as { engagementId: string };
      const body = engagementPatchSchema.parse(req.body);
      await fetchEngagement(engagementId, req.companyId!, req.projectId!);
      if (body.stakeholderIds !== undefined) {
        await validateStakeholders(req.companyId!, req.projectId!, body.stakeholderIds);
      }
      if (body.fileIds !== undefined) {
        await validateFiles(app.db, req.companyId!, req.projectId!, body.fileIds);
      }
      const set: Record<string, unknown> = {};
      for (const key of [
        "title",
        "kind",
        "engagementDate",
        "location",
        "stakeholderIds",
        "attendeeCount",
        "summary",
        "feedback",
        "consentStatus",
        "fileIds",
      ] as const) {
        if (body[key] !== undefined) set[key] = body[key];
      }
      if (Object.keys(set).length > 0) {
        await app.db.update(engagements).set(set).where(eq(engagements.id, engagementId));
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "engagement",
        objectId: engagementId,
        payload: { changed: Object.keys(body), consentStatus: body.consentStatus ?? undefined },
        storePayload: true,
      });
      return fetchEngagement(engagementId, req.companyId!, req.projectId!);
    },
  );

  app.delete(
    "/projects/:projectId/engagements/:engagementId",
    { preHandler: standardGate },
    async (req, reply) => {
      const { engagementId } = req.params as { engagementId: string };
      const e = await fetchEngagement(engagementId, req.companyId!, req.projectId!);
      await app.db.delete(engagements).where(eq(engagements.id, engagementId));
      // A public-disclosure record is deletable but never disappears: the
      // full row is stored in the ledger entry (#584).
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "delete",
        objectType: "engagement",
        objectId: engagementId,
        payload: e,
        storePayload: true,
      });
      return reply.status(204).send();
    },
  );
}
