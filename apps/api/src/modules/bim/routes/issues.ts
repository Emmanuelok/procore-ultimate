/**
 * Coordination issue lifecycle (spec #240-245, #466, #469-470).
 *
 * The register a coordination meeting actually runs on: raise from the
 * viewer or from a clash, assign to a person with a due date, discuss in a
 * comment thread, escalate to an RFI when the answer has to come from the
 * design team, verify, and export the register.
 *
 * What changed: an issue used to be assignable only through a field the UI
 * never sent, so every issue raised in the product was stuck at `open` with
 * "void" as its only exit. Assignment is now validated (a company member),
 * notified, and available as its own transition; every consequential change
 * is ledgered; and `escalate` creates the RFI and back-links both records.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bimModelVersions,
  bimModels,
  clashResults,
  companyMemberships,
  coordinationIssueComments,
  coordinationIssues,
  recordLinks,
  rfis,
  users,
} from "@constructos/db";
import {
  COORDINATION_ISSUE_STATUSES,
  DRAWING_DISCIPLINES,
  type CoordinationIssueStatus,
} from "@constructos/shared";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict } from "../../../lib/errors.js";
import { nextRecordNumber } from "../../../lib/numbering.js";
import { pageOffset, pageQuerySchema, paginate } from "../../../lib/pagination.js";
import { pushNotifications } from "../../notifications/service.js";
import { buildBimGates, buildLoaders, isoDateSchema, ledger, nowISO, todayISO } from "../shared.js";

/** open -> assigned -> resolved -> verified, void from anywhere */
const ISSUE_TRANSITIONS: Record<CoordinationIssueStatus, CoordinationIssueStatus[]> = {
  open: ["assigned", "void"],
  assigned: ["open", "resolved", "void"],
  resolved: ["assigned", "verified", "void"],
  verified: ["void"],
  void: [],
};

const issueCreateSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).nullable().optional(),
  assigneeId: z.string().max(64).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  elementGlobalIds: z.array(z.string().max(64)).max(500).optional(),
  modelVersionId: z.string().max(64).nullable().optional(),
  viewpoint: z.unknown().optional(),
  source: z.enum(["manual", "clash", "viewer", "design_review"]).optional(),
});

const issuePatchSchema = issueCreateSchema.partial().extend({
  title: z.string().min(1).max(300).optional(),
  status: z.enum(COORDINATION_ISSUE_STATUSES).optional(),
});

const issueListQuery = pageQuerySchema.extend({
  status: z.enum(COORDINATION_ISSUE_STATUSES).optional(),
  search: z.string().max(200).optional(),
  assigneeId: z.string().max(64).optional(),
  discipline: z.enum(DRAWING_DISCIPLINES).optional(),
  overdue: z.enum(["0", "1"]).optional(),
  escalated: z.enum(["0", "1"]).optional(),
});

const commentSchema = z.object({
  body: z.string().min(1).max(10000),
  mentions: z.array(z.string().max(64)).max(50).optional(),
});

const escalateSchema = z.object({
  subject: z.string().min(1).max(300).optional(),
  question: z.string().min(1).max(10000).optional(),
  assigneeId: z.string().max(64).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
});

export const issueRoutes: FastifyPluginAsync = async (app) => {
  const gates = buildBimGates(app);
  const { getIssue } = buildLoaders(app);

  /** Every referenced user must be a member of the tenant (#241 assignment). */
  async function assertCompanyMembers(companyId: string, ids: Array<string | null | undefined>) {
    const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (wanted.length === 0) return;
    const rows = await app.db
      .select({ userId: companyMemberships.userId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          inArray(companyMemberships.userId, wanted),
        ),
      );
    const found = new Set(rows.map((r) => r.userId));
    const missing = wanted.find((id) => !found.has(id));
    if (missing) throw badRequest(`User "${missing}" is not a member of this company`);
  }

  async function assertVersionInProject(
    companyId: string,
    projectId: string,
    modelVersionId: string | null | undefined,
  ) {
    if (!modelVersionId) return;
    const rows = await app.db
      .select({ id: bimModelVersions.id })
      .from(bimModelVersions)
      .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
      .where(
        and(
          eq(bimModelVersions.id, modelVersionId),
          eq(bimModels.companyId, companyId),
          eq(bimModels.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw badRequest("Model version not found in this project");
  }

  async function peopleMap(ids: Array<string | null | undefined>) {
    const wanted = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (wanted.length === 0) return {} as Record<string, { id: string; name: string; email: string }>;
    const rows = await app.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, wanted));
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  /* ---------------------------------------------------------------- */
  /* Register                                                          */
  /* ---------------------------------------------------------------- */

  app.get("/projects/:projectId/bim/issues", { preHandler: gates.readGate }, async (req) => {
    const q = issueListQuery.parse(req.query);
    const conds = [
      eq(coordinationIssues.companyId, req.companyId!),
      eq(coordinationIssues.projectId, req.projectId!),
    ];
    if (q.status) conds.push(eq(coordinationIssues.status, q.status));
    if (q.assigneeId) conds.push(eq(coordinationIssues.assigneeId, q.assigneeId));
    if (q.discipline) conds.push(eq(coordinationIssues.discipline, q.discipline));
    if (q.escalated === "1") conds.push(isNotNull(coordinationIssues.rfiId));
    if (q.overdue === "1") {
      conds.push(sql`${coordinationIssues.dueDate} is not null`);
      conds.push(sql`${coordinationIssues.dueDate} < ${todayISO()}`);
      conds.push(inArray(coordinationIssues.status, ["open", "assigned"]));
    }
    if (q.search) {
      const term = `%${q.search}%`;
      conds.push(
        or(ilike(coordinationIssues.title, term), ilike(coordinationIssues.description, term))!,
      );
    }
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(coordinationIssues).where(where);
    const items = await app.db
      .select()
      .from(coordinationIssues)
      .where(where)
      .orderBy(desc(coordinationIssues.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const people = await peopleMap(items.flatMap((i) => [i.assigneeId, i.createdBy]));
    const today = todayISO();
    return {
      ...paginate(
        items.map((i) => ({
          ...i,
          assigneeName: i.assigneeId ? (people[i.assigneeId]?.name ?? null) : null,
          createdByName: people[i.createdBy]?.name ?? null,
          overdue:
            !!i.dueDate && i.dueDate < today && (i.status === "open" || i.status === "assigned"),
        })),
        Number(totalRow?.n ?? 0),
        q,
      ),
      people,
    };
  });

  /** Register export for the coordination meeting minutes (#470). */
  app.get(
    "/projects/:projectId/bim/issues/export.csv",
    { preHandler: gates.readGate },
    async (req, reply) => {
      const rows = await app.db
        .select()
        .from(coordinationIssues)
        .where(
          and(
            eq(coordinationIssues.companyId, req.companyId!),
            eq(coordinationIssues.projectId, req.projectId!),
          ),
        )
        .orderBy(asc(coordinationIssues.number))
        .limit(5000);
      const people = await peopleMap(rows.flatMap((r) => [r.assigneeId, r.createdBy]));
      const header = [
        "Number",
        "Title",
        "Status",
        "Discipline",
        "Assignee",
        "Due date",
        "Source",
        "Elements",
        "RFI",
        "Created by",
        "Created at",
      ];
      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push(
          [
            r.number,
            r.title,
            r.status,
            r.discipline ?? "",
            r.assigneeId ? (people[r.assigneeId]?.name ?? r.assigneeId) : "",
            r.dueDate ?? "",
            r.source,
            r.elementGlobalIds.join(" "),
            r.rfiId ?? "",
            people[r.createdBy]?.name ?? r.createdBy,
            r.createdAt,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="coordination-issues.csv"');
      return reply.send(lines.join("\r\n") + "\r\n");
    },
  );

  app.post(
    "/projects/:projectId/bim/issues",
    { preHandler: gates.standardGate },
    async (req, reply) => {
      const body = issueCreateSchema.parse(req.body);
      await assertCompanyMembers(req.companyId!, [body.assigneeId]);
      await assertVersionInProject(req.companyId!, req.projectId!, body.modelVersionId);
      const number = await nextRecordNumber(app.db, req.projectId!, "coordination_issue");
      const id = newId("cis");
      const [created] = await app.db
        .insert(coordinationIssues)
        .values({
          id,
          companyId: req.companyId!,
          projectId: req.projectId!,
          number,
          title: body.title,
          description: body.description ?? null,
          status: body.assigneeId ? "assigned" : "open",
          discipline: body.discipline ?? null,
          assigneeId: body.assigneeId ?? null,
          dueDate: body.dueDate ?? null,
          elementGlobalIds: body.elementGlobalIds ?? [],
          modelVersionId: body.modelVersionId ?? null,
          viewpoint: body.viewpoint ?? null,
          source: body.source ?? "manual",
          createdBy: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: req.projectId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "coordination_issue",
        objectId: id,
        payload: created,
        storePayload: true,
      });
      if (body.assigneeId && body.assigneeId !== req.user!.id) {
        await pushNotifications(app.db, [
          {
            companyId: req.companyId!,
            userId: body.assigneeId,
            projectId: req.projectId!,
            kind: "assignment",
            title: `Coordination issue #${number} assigned to you`,
            body: body.title,
            recordType: "coordination_issue",
            recordId: id,
          },
        ]);
      }
      return reply.status(201).send(created);
    },
  );

  app.get("/bim/issues/:issueId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const issue = await getIssue(issueId, req.companyId!);
    await gates.requireToolFor(req, reply, issue.projectId, "read");
    const [comments, rfiRows] = await Promise.all([
      app.db
        .select()
        .from(coordinationIssueComments)
        .where(eq(coordinationIssueComments.issueId, issueId))
        .orderBy(asc(coordinationIssueComments.createdAt))
        .limit(500),
      issue.rfiId
        ? app.db
            .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, status: rfis.status })
            .from(rfis)
            .where(and(eq(rfis.id, issue.rfiId), eq(rfis.companyId, req.companyId!)))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const people = await peopleMap([
      issue.assigneeId,
      issue.createdBy,
      ...comments.map((c) => c.authorId),
    ]);
    const today = todayISO();
    return {
      ...issue,
      comments: comments.map((c) => ({ ...c, authorName: people[c.authorId]?.name ?? null })),
      rfi: rfiRows[0] ?? null,
      people,
      assigneeName: issue.assigneeId ? (people[issue.assigneeId]?.name ?? null) : null,
      overdue:
        !!issue.dueDate &&
        issue.dueDate < today &&
        (issue.status === "open" || issue.status === "assigned"),
      nextStatuses: ISSUE_TRANSITIONS[issue.status as CoordinationIssueStatus] ?? [],
    };
  });

  app.patch("/bim/issues/:issueId", { preHandler: gates.companyGate }, async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const body = issuePatchSchema.parse(req.body);
    const existing = await getIssue(issueId, req.companyId!);
    await gates.requireToolFor(req, reply, existing.projectId, "standard");

    const statusChanged = body.status !== undefined && body.status !== existing.status;
    if (statusChanged) {
      const from = existing.status as CoordinationIssueStatus;
      if (!ISSUE_TRANSITIONS[from].includes(body.status!)) {
        throw badRequest(
          `Illegal status transition ${from} -> ${body.status}. Flow: open -> assigned -> resolved -> verified (void from anywhere; an issue can be sent back).`,
        );
      }
      if (body.status === "assigned" && !(body.assigneeId ?? existing.assigneeId)) {
        throw badRequest("An assignee is required to move an issue to assigned");
      }
      if (body.status === "verified" && existing.assigneeId === req.user!.id) {
        // segregation of duties: whoever resolved the issue does not also
        // certify that it is resolved (Vol III: assertion and evidence never
        // share an author)
        throw badRequest(
          "The assignee who resolved this issue cannot verify it — verification needs a second coordinator",
        );
      }
    }
    await assertCompanyMembers(req.companyId!, [body.assigneeId]);
    await assertVersionInProject(req.companyId!, existing.projectId, body.modelVersionId);

    const patch: Record<string, unknown> = { updatedAt: nowISO() };
    if (body.title !== undefined) patch["title"] = body.title;
    if (body.description !== undefined) patch["description"] = body.description;
    if (body.discipline !== undefined) patch["discipline"] = body.discipline;
    if (body.assigneeId !== undefined) patch["assigneeId"] = body.assigneeId;
    if (body.dueDate !== undefined) {
      patch["dueDate"] = body.dueDate;
      patch["overdueNotifiedAt"] = null;
    }
    if (body.elementGlobalIds !== undefined) patch["elementGlobalIds"] = body.elementGlobalIds;
    if (body.modelVersionId !== undefined) patch["modelVersionId"] = body.modelVersionId;
    if (body.viewpoint !== undefined) patch["viewpoint"] = body.viewpoint;
    if (statusChanged) {
      patch["status"] = body.status;
      if (body.status === "resolved") patch["resolvedAt"] = nowISO();
      if (body.status === "verified") patch["verifiedAt"] = nowISO();
    }

    const [updated] = await app.db
      .update(coordinationIssues)
      .set(patch)
      .where(eq(coordinationIssues.id, issueId))
      .returning();

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: existing.projectId,
      actorId: req.user!.id,
      action: statusChanged ? "state_change" : "update",
      objectType: "coordination_issue",
      objectId: issueId,
      payload: statusChanged ? { from: existing.status, to: body.status, patch } : patch,
      storePayload: statusChanged,
    });

    const newAssignee = body.assigneeId ?? null;
    if (newAssignee && newAssignee !== existing.assigneeId && newAssignee !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: newAssignee,
          projectId: existing.projectId,
          kind: "assignment",
          title: `Coordination issue #${existing.number} assigned to you`,
          body: updated?.title ?? existing.title,
          recordType: "coordination_issue",
          recordId: issueId,
        },
      ]);
    }
    if (statusChanged && existing.createdBy !== req.user!.id) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: existing.createdBy,
          projectId: existing.projectId,
          kind: "status_change",
          title: `Coordination issue #${existing.number} is now ${body.status}`,
          body: updated?.title ?? existing.title,
          recordType: "coordination_issue",
          recordId: issueId,
        },
      ]);
    }
    return updated;
  });

  /* ---------------------------------------------------------------- */
  /* Comment thread (#466)                                             */
  /* ---------------------------------------------------------------- */

  app.get("/bim/issues/:issueId/comments", { preHandler: gates.companyGate }, async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const issue = await getIssue(issueId, req.companyId!);
    await gates.requireToolFor(req, reply, issue.projectId, "read");
    const items = await app.db
      .select()
      .from(coordinationIssueComments)
      .where(eq(coordinationIssueComments.issueId, issueId))
      .orderBy(asc(coordinationIssueComments.createdAt))
      .limit(500);
    const people = await peopleMap(items.map((c) => c.authorId));
    return {
      items: items.map((c) => ({ ...c, authorName: people[c.authorId]?.name ?? null })),
      total: items.length,
    };
  });

  app.post(
    "/bim/issues/:issueId/comments",
    { preHandler: gates.companyGate },
    async (req, reply) => {
      const { issueId } = req.params as { issueId: string };
      const body = commentSchema.parse(req.body);
      const issue = await getIssue(issueId, req.companyId!);
      await gates.requireToolFor(req, reply, issue.projectId, "standard");
      await assertCompanyMembers(req.companyId!, body.mentions ?? []);
      const id = newId("cic");
      const [created] = await app.db
        .insert(coordinationIssueComments)
        .values({
          id,
          companyId: req.companyId!,
          projectId: issue.projectId,
          issueId,
          body: body.body,
          mentions: body.mentions ?? [],
          authorId: req.user!.id,
        })
        .returning();
      await ledger(app.db, {
        companyId: req.companyId!,
        projectId: issue.projectId,
        actorId: req.user!.id,
        action: "create",
        objectType: "coordination_issue_comment",
        objectId: id,
        payload: { issueId, mentions: body.mentions ?? [] },
      });
      const recipients = new Set<string>([...(body.mentions ?? [])]);
      if (issue.assigneeId) recipients.add(issue.assigneeId);
      recipients.add(issue.createdBy);
      recipients.delete(req.user!.id);
      if (recipients.size > 0) {
        await pushNotifications(
          app.db,
          [...recipients].map((userId) => ({
            companyId: req.companyId!,
            userId,
            projectId: issue.projectId,
            kind: (body.mentions ?? []).includes(userId) ? ("mention" as const) : ("status_change" as const),
            title: `New comment on coordination issue #${issue.number}`,
            body: body.body.slice(0, 200),
            recordType: "coordination_issue",
            recordId: issueId,
          })),
        );
      }
      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Escalation to an RFI (#469)                                       */
  /* ---------------------------------------------------------------- */

  app.post("/bim/issues/:issueId/escalate", { preHandler: gates.companyGate }, async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const body = escalateSchema.parse(req.body ?? {});
    const issue = await getIssue(issueId, req.companyId!);
    await gates.requireToolFor(req, reply, issue.projectId, "standard");
    if (issue.rfiId) throw conflict("This issue has already been escalated to an RFI");
    if (issue.status === "void") throw conflict("A void issue cannot be escalated");
    await assertCompanyMembers(req.companyId!, [body.assigneeId ?? issue.assigneeId]);

    const number = await nextRecordNumber(app.db, issue.projectId, "rfi");
    const rfiId = newId("rfi");
    const question =
      body.question ??
      [
        issue.description ?? issue.title,
        issue.elementGlobalIds.length > 0
          ? `Model elements: ${issue.elementGlobalIds.join(", ")}`
          : null,
        `Raised from coordination issue #${issue.number}.`,
      ]
        .filter(Boolean)
        .join("\n\n");

    await app.db.insert(rfis).values({
      id: rfiId,
      companyId: req.companyId!,
      projectId: issue.projectId,
      number,
      subject: body.subject ?? `Coordination issue #${issue.number}: ${issue.title}`,
      question,
      status: "draft",
      assigneeId: body.assigneeId ?? issue.assigneeId ?? null,
      dueDate: body.dueDate ?? issue.dueDate ?? null,
      createdBy: req.user!.id,
    });

    await app.db
      .update(coordinationIssues)
      .set({ rfiId, updatedAt: nowISO() })
      .where(eq(coordinationIssues.id, issueId));

    await app.db.insert(recordLinks).values({
      id: newId("rl"),
      companyId: req.companyId!,
      projectId: issue.projectId,
      fromType: "coordination_issue",
      fromId: issueId,
      toType: "rfi",
      toId: rfiId,
      linkKind: "escalation",
      createdBy: req.user!.id,
    });

    await ledger(app.db, {
      companyId: req.companyId!,
      projectId: issue.projectId,
      actorId: req.user!.id,
      action: "create",
      objectType: "rfi",
      objectId: rfiId,
      payload: { escalatedFromIssue: issueId, number, subject: body.subject ?? issue.title },
      storePayload: true,
    });

    if (body.assigneeId ?? issue.assigneeId) {
      await pushNotifications(app.db, [
        {
          companyId: req.companyId!,
          userId: (body.assigneeId ?? issue.assigneeId)!,
          projectId: issue.projectId,
          kind: "assignment",
          title: `RFI #${number} raised from coordination issue #${issue.number}`,
          body: issue.title,
          recordType: "rfi",
          recordId: rfiId,
        },
      ]);
    }

    return reply.status(201).send({ rfiId, number, issueId });
  });

  /* ---------------------------------------------------------------- */
  /* BCF-style markup export (#242)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * The BCF 2.1 markup and viewpoint payload as JSON. It is deliberately not
   * called a .bcfzip: a real BCF archive needs a zip writer and a snapshot
   * image, neither of which exists here. Navisworks/Solibri users can convert
   * this payload; calling it BCF while shipping JSON would be a lie.
   */
  app.get("/bim/issues/:issueId/bcf.json", { preHandler: gates.companyGate }, async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const issue = await getIssue(issueId, req.companyId!);
    await gates.requireToolFor(req, reply, issue.projectId, "read");
    const comments = await app.db
      .select()
      .from(coordinationIssueComments)
      .where(eq(coordinationIssueComments.issueId, issueId))
      .orderBy(asc(coordinationIssueComments.createdAt))
      .limit(500);
    const people = await peopleMap([issue.createdBy, ...comments.map((c) => c.authorId)]);
    let modelName: string | null = null;
    if (issue.modelVersionId) {
      const rows = await app.db
        .select({ name: bimModels.name, version: bimModelVersions.version })
        .from(bimModelVersions)
        .innerJoin(bimModels, eq(bimModels.id, bimModelVersions.modelId))
        .where(eq(bimModelVersions.id, issue.modelVersionId))
        .limit(1);
      modelName = rows[0] ? `${rows[0].name} v${rows[0].version}` : null;
    }
    return {
      format: "bcf-2.1-json",
      topic: {
        guid: issue.id,
        topicType: "Clash",
        topicStatus: issue.status,
        title: issue.title,
        description: issue.description,
        index: issue.number,
        creationDate: issue.createdAt,
        creationAuthor: people[issue.createdBy]?.email ?? issue.createdBy,
        assignedTo: issue.assigneeId ? (people[issue.assigneeId]?.email ?? issue.assigneeId) : null,
        dueDate: issue.dueDate,
        labels: [issue.discipline].filter(Boolean),
      },
      viewpoint: issue.viewpoint ?? null,
      components: issue.elementGlobalIds.map((guid) => ({ ifcGuid: guid, selected: true })),
      model: modelName,
      comments: comments.map((c) => ({
        guid: c.id,
        date: c.createdAt,
        author: people[c.authorId]?.email ?? c.authorId,
        comment: c.body,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* Coordination analytics + health inputs                            */
  /* ---------------------------------------------------------------- */

  app.get(
    "/projects/:projectId/bim/coordination/summary",
    { preHandler: gates.readGate },
    async (req) => {
      const where = and(
        eq(coordinationIssues.companyId, req.companyId!),
        eq(coordinationIssues.projectId, req.projectId!),
      );
      const byStatus = await app.db
        .select({ status: coordinationIssues.status, n: count() })
        .from(coordinationIssues)
        .where(where)
        .groupBy(coordinationIssues.status);
      const byDiscipline = await app.db
        .select({ discipline: coordinationIssues.discipline, n: count() })
        .from(coordinationIssues)
        .where(where)
        .groupBy(coordinationIssues.discipline);
      const today = todayISO();
      const [overdueRow] = await app.db
        .select({ n: count() })
        .from(coordinationIssues)
        .where(
          and(
            where,
            inArray(coordinationIssues.status, ["open", "assigned"]),
            sql`${coordinationIssues.dueDate} is not null`,
            sql`${coordinationIssues.dueDate} < ${today}`,
          ),
        );
      const [escalatedRow] = await app.db
        .select({ n: count() })
        .from(coordinationIssues)
        .where(and(where, isNotNull(coordinationIssues.rfiId)));
      const [clashRow] = await app.db
        .select({ n: count() })
        .from(clashResults)
        .where(
          and(
            eq(clashResults.companyId, req.companyId!),
            eq(clashResults.projectId, req.projectId!),
            inArray(clashResults.status, ["new", "active"]),
          ),
        );

      const resolved = await app.db
        .select({
          createdAt: coordinationIssues.createdAt,
          resolvedAt: coordinationIssues.resolvedAt,
        })
        .from(coordinationIssues)
        .where(and(where, isNotNull(coordinationIssues.resolvedAt)))
        .limit(1000);
      const durations = resolved
        .map((r) =>
          r.resolvedAt
            ? (Date.parse(r.resolvedAt) - Date.parse(r.createdAt)) / 86_400_000
            : null,
        )
        .filter((d): d is number => d !== null && Number.isFinite(d));
      const avgResolutionDays =
        durations.length > 0
          ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
          : null;

      return {
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        byDiscipline: byDiscipline.map((r) => ({
          discipline: r.discipline ?? "unassigned",
          count: Number(r.n),
        })),
        overdue: Number(overdueRow?.n ?? 0),
        escalatedToRfi: Number(escalatedRow?.n ?? 0),
        openClashes: Number(clashRow?.n ?? 0),
        avgResolutionDays,
        avgResolutionBasis:
          durations.length > 0
            ? `${durations.length} resolved issues`
            : "no issue has been resolved yet",
      };
    },
  );
};

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // neutralise spreadsheet formula injection before quoting (=, +, -, @, tab, CR)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
