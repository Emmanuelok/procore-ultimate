import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, asc, count, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  contacts,
  distributionGroupMembers,
  distributionGroups,
  projectMemberships,
  projects,
  users,
  vendors,
} from "@constructos/db";
import { COMPANY_ROLES } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
// Phase 8 — an invitation now produces a record and a message instead of a
// temporary password and silence. Everything about tokens, dispatch and
// acceptance lives in modules/account; this module keeps the route.
import { createInvitation } from "../account/invitations.js";
import { hashPassword } from "../account/password.js";
import { requestContext } from "../account/sessions.js";
import { requireVerifiedEmail } from "../account/verification.js";

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const vendorCreateSchema = z.object({
  name: z.string().min(1).max(300),
  tradeCodes: z.array(z.string().min(1).max(50)).max(50).default([]),
  address: z.string().max(500).optional(),
  city: z.string().max(200).optional(),
  country: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  website: z.string().max(300).optional(),
  taxId: z.string().max(100).optional(),
  registrationNumber: z.string().max(100).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  notes: z.string().max(5000).optional(),
});
const vendorPatchSchema = vendorCreateSchema.partial();

const vendorListQuery = pageQuerySchema.extend({
  search: z.string().max(200).optional(),
  tradeCode: z.string().max(50).optional(),
  status: z.enum(["active", "inactive", "merged"]).optional(),
  includeMerged: z.string().optional(),
});

const contactCreateSchema = z.object({
  name: z.string().min(1).max(300),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(200).optional(),
  vendorId: z.string().max(100).optional(),
});
const contactPatchSchema = contactCreateSchema.partial().extend({
  vendorId: z.string().max(100).nullable().optional(),
});

const groupCreateSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: z.string().max(100).optional(),
});

const groupMemberSchema = z
  .object({
    userId: z.string().max(100).optional(),
    contactId: z.string().max(100).optional(),
    email: z.string().email().optional(),
  })
  .refine(
    (v) => [v.userId, v.contactId, v.email].filter(Boolean).length === 1,
    "Provide exactly one of userId, contactId or email",
  );

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  name: z.string().min(1).max(200),
  role: z.enum(COMPANY_ROLES),
  /** permission template applied to the projects below, on acceptance */
  templateKey: z.string().min(1).max(80).optional(),
  projectIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  /** a note from the inviter, rendered escaped in the message */
  message: z.string().max(2000).optional(),
});

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export const directoryModule: FastifyPluginAsync = async (app) => {
  const read = [app.authenticate, app.requireCompany];
  const write = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin", "member"]),
  ];
  const adminOnly = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  /* ---------------------------- Vendors ---------------------------- */

  app.get("/vendors", { preHandler: read }, async (req) => {
    const q = vendorListQuery.parse(req.query);
    const conds = [eq(vendors.companyId, req.companyId!)];
    if (q.status) {
      conds.push(eq(vendors.status, q.status));
    } else if (q.includeMerged !== "true") {
      conds.push(ne(vendors.status, "merged"));
    }
    if (q.search) conds.push(ilike(vendors.name, `%${q.search}%`));
    if (q.tradeCode) {
      conds.push(sql`${vendors.tradeCodes} @> ${JSON.stringify([q.tradeCode])}::jsonb`);
    }
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(vendors)
      .where(where)
      .orderBy(asc(vendors.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(vendors).where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  app.post("/vendors", { preHandler: write }, async (req, reply) => {
    const body = vendorCreateSchema.parse(req.body);
    const id = newId("vnd");
    await app.db.insert(vendors).values({ id, companyId: req.companyId!, ...body });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "vendor",
      objectId: id,
      payload: body,
    });
    const [created] = await app.db.select().from(vendors).where(eq(vendors.id, id));
    return reply.status(201).send(created);
  });

  async function getVendorOr404(companyId: string, vendorId: string) {
    const [vendor] = await app.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vendor) throw notFound("Vendor not found");
    return vendor;
  }

  app.get("/vendors/:vendorId", { preHandler: read }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    return getVendorOr404(req.companyId!, vendorId);
  });

  app.patch("/vendors/:vendorId", { preHandler: write }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const body = vendorPatchSchema.parse(req.body);
    const vendor = await getVendorOr404(req.companyId!, vendorId);
    if (vendor.status === "merged") throw conflict("A merged vendor cannot be edited");
    await app.db
      .update(vendors)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "vendor",
      objectId: vendorId,
      payload: body,
    });
    return getVendorOr404(req.companyId!, vendorId);
  });

  app.delete("/vendors/:vendorId", { preHandler: adminOnly }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const vendor = await getVendorOr404(req.companyId!, vendorId);
    await app.db
      .update(contacts)
      .set({ vendorId: null, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.vendorId, vendorId), eq(contacts.companyId, req.companyId!)));
    await app.db
      .delete(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "vendor",
      objectId: vendorId,
      payload: { name: vendor.name },
    });
    return { ok: true };
  });

  app.post("/vendors/:vendorId/merge", { preHandler: adminOnly }, async (req) => {
    const { vendorId } = req.params as { vendorId: string };
    const body = z.object({ intoVendorId: z.string().min(1) }).parse(req.body);
    if (body.intoVendorId === vendorId) {
      throw badRequest("A vendor cannot be merged into itself");
    }
    const source = await getVendorOr404(req.companyId!, vendorId);
    const target = await getVendorOr404(req.companyId!, body.intoVendorId);
    if (source.status === "merged") throw conflict("Vendor is already merged");
    if (target.status === "merged") throw conflict("Target vendor is itself merged");

    const now = new Date().toISOString();
    await app.db.transaction(async (tx) => {
      await tx
        .update(vendors)
        .set({ status: "merged", mergedIntoId: target.id, updatedAt: now })
        .where(and(eq(vendors.id, source.id), eq(vendors.companyId, req.companyId!)));
      await tx
        .update(contacts)
        .set({ vendorId: target.id, updatedAt: now })
        .where(and(eq(contacts.vendorId, source.id), eq(contacts.companyId, req.companyId!)));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "state_change",
      objectType: "vendor",
      objectId: source.id,
      payload: { status: "merged", mergedIntoId: target.id },
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "vendor",
      objectId: target.id,
      payload: { absorbedVendorId: source.id },
    });
    return getVendorOr404(req.companyId!, source.id);
  });

  /* ---------------------------- Contacts --------------------------- */

  async function assertVendorInCompany(companyId: string, vendorId: string) {
    const [vendor] = await app.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)))
      .limit(1);
    if (!vendor) throw badRequest("vendorId does not exist in this company");
  }

  app.get("/contacts", { preHandler: read }, async (req) => {
    const q = pageQuerySchema
      .extend({
        search: z.string().max(200).optional(),
        vendorId: z.string().max(100).optional(),
      })
      .parse(req.query);
    const conds = [eq(contacts.companyId, req.companyId!)];
    if (q.vendorId) conds.push(eq(contacts.vendorId, q.vendorId));
    if (q.search) {
      conds.push(
        or(ilike(contacts.name, `%${q.search}%`), ilike(contacts.email, `%${q.search}%`))!,
      );
    }
    const where = and(...conds);
    const items = await app.db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(asc(contacts.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(contacts).where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  app.post("/contacts", { preHandler: write }, async (req, reply) => {
    const body = contactCreateSchema.parse(req.body);
    if (body.vendorId) await assertVendorInCompany(req.companyId!, body.vendorId);
    const id = newId("cnt");
    await app.db.insert(contacts).values({ id, companyId: req.companyId!, ...body });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "contact",
      objectId: id,
      payload: body,
    });
    const [created] = await app.db.select().from(contacts).where(eq(contacts.id, id));
    return reply.status(201).send(created);
  });

  async function getContactOr404(companyId: string, contactId: string) {
    const [contact] = await app.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
      .limit(1);
    if (!contact) throw notFound("Contact not found");
    return contact;
  }

  app.get("/contacts/:contactId", { preHandler: read }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    return getContactOr404(req.companyId!, contactId);
  });

  app.patch("/contacts/:contactId", { preHandler: write }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    const body = contactPatchSchema.parse(req.body);
    await getContactOr404(req.companyId!, contactId);
    if (body.vendorId) await assertVendorInCompany(req.companyId!, body.vendorId);
    await app.db
      .update(contacts)
      .set({ ...body, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "contact",
      objectId: contactId,
      payload: body,
    });
    return getContactOr404(req.companyId!, contactId);
  });

  app.delete("/contacts/:contactId", { preHandler: write }, async (req) => {
    const { contactId } = req.params as { contactId: string };
    const contact = await getContactOr404(req.companyId!, contactId);
    await app.db
      .delete(distributionGroupMembers)
      .where(eq(distributionGroupMembers.contactId, contactId));
    await app.db
      .delete(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, req.companyId!)));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "contact",
      objectId: contactId,
      payload: { name: contact.name },
    });
    return { ok: true };
  });

  /* ----------------------- Distribution groups --------------------- */

  async function getGroupOr404(companyId: string, groupId: string) {
    const [group] = await app.db
      .select()
      .from(distributionGroups)
      .where(
        and(eq(distributionGroups.id, groupId), eq(distributionGroups.companyId, companyId)),
      )
      .limit(1);
    if (!group) throw notFound("Distribution group not found");
    return group;
  }

  app.get("/distribution-groups", { preHandler: read }, async (req) => {
    const q = pageQuerySchema
      .extend({ projectId: z.string().max(100).optional() })
      .parse(req.query);
    const conds = [eq(distributionGroups.companyId, req.companyId!)];
    if (q.projectId) conds.push(eq(distributionGroups.projectId, q.projectId));
    const where = and(...conds);
    const groups = await app.db
      .select()
      .from(distributionGroups)
      .where(where)
      .orderBy(asc(distributionGroups.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db.select({ n: count() }).from(distributionGroups).where(where);
    const ids = groups.map((g) => g.id);
    const counts = ids.length
      ? await app.db
          .select({ groupId: distributionGroupMembers.groupId, n: count() })
          .from(distributionGroupMembers)
          .where(inArray(distributionGroupMembers.groupId, ids))
          .groupBy(distributionGroupMembers.groupId)
      : [];
    const countMap = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    return paginate(
      groups.map((g) => ({ ...g, memberCount: countMap.get(g.id) ?? 0 })),
      Number(row?.n ?? 0),
      q,
    );
  });

  app.post("/distribution-groups", { preHandler: write }, async (req, reply) => {
    const body = groupCreateSchema.parse(req.body);
    if (body.projectId) {
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.companyId, req.companyId!)))
        .limit(1);
      if (!project) throw badRequest("projectId does not exist in this company");
    }
    const dupConds = [
      eq(distributionGroups.companyId, req.companyId!),
      eq(distributionGroups.name, body.name),
      body.projectId
        ? eq(distributionGroups.projectId, body.projectId)
        : sql`${distributionGroups.projectId} is null`,
    ];
    const [dup] = await app.db
      .select({ id: distributionGroups.id })
      .from(distributionGroups)
      .where(and(...dupConds))
      .limit(1);
    if (dup) throw conflict("A distribution group with this name already exists");

    const id = newId("dg");
    await app.db.insert(distributionGroups).values({
      id,
      companyId: req.companyId!,
      projectId: body.projectId ?? null,
      name: body.name,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "distribution_group",
      objectId: id,
      payload: body,
    });
    const group = await getGroupOr404(req.companyId!, id);
    return reply.status(201).send({ ...group, memberCount: 0 });
  });

  app.get("/distribution-groups/:groupId", { preHandler: read }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const group = await getGroupOr404(req.companyId!, groupId);
    const members = await app.db
      .select({
        id: distributionGroupMembers.id,
        userId: distributionGroupMembers.userId,
        contactId: distributionGroupMembers.contactId,
        email: distributionGroupMembers.email,
        userName: users.name,
        userEmail: users.email,
        contactName: contacts.name,
        contactEmail: contacts.email,
      })
      .from(distributionGroupMembers)
      .leftJoin(users, eq(users.id, distributionGroupMembers.userId))
      .leftJoin(contacts, eq(contacts.id, distributionGroupMembers.contactId))
      .where(eq(distributionGroupMembers.groupId, groupId));
    return { ...group, members };
  });

  app.patch("/distribution-groups/:groupId", { preHandler: write }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    await getGroupOr404(req.companyId!, groupId);
    await app.db
      .update(distributionGroups)
      .set({ name: body.name })
      .where(
        and(
          eq(distributionGroups.id, groupId),
          eq(distributionGroups.companyId, req.companyId!),
        ),
      );
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "distribution_group",
      objectId: groupId,
      payload: body,
    });
    return getGroupOr404(req.companyId!, groupId);
  });

  app.delete("/distribution-groups/:groupId", { preHandler: write }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    const group = await getGroupOr404(req.companyId!, groupId);
    await app.db.transaction(async (tx) => {
      await tx
        .delete(distributionGroupMembers)
        .where(eq(distributionGroupMembers.groupId, groupId));
      await tx.delete(distributionGroups).where(eq(distributionGroups.id, groupId));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "distribution_group",
      objectId: groupId,
      payload: { name: group.name },
    });
    return { ok: true };
  });

  app.post("/distribution-groups/:groupId/members", { preHandler: write }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const body = groupMemberSchema.parse(req.body);
    await getGroupOr404(req.companyId!, groupId);
    if (body.userId) {
      const [membership] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, req.companyId!),
            eq(companyMemberships.userId, body.userId),
          ),
        )
        .limit(1);
      if (!membership) throw badRequest("userId is not a member of this company");
    }
    if (body.contactId) await getContactOr404(req.companyId!, body.contactId);

    const id = newId("dgm");
    await app.db.insert(distributionGroupMembers).values({
      id,
      groupId,
      userId: body.userId ?? null,
      contactId: body.contactId ?? null,
      email: body.email ?? null,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "distribution_group",
      objectId: groupId,
      payload: { addedMember: body },
    });
    return reply.status(201).send({ id, groupId, ...body });
  });

  app.delete(
    "/distribution-groups/:groupId/members/:memberId",
    { preHandler: write },
    async (req) => {
      const { groupId, memberId } = req.params as { groupId: string; memberId: string };
      await getGroupOr404(req.companyId!, groupId);
      const [member] = await app.db
        .select()
        .from(distributionGroupMembers)
        .where(
          and(
            eq(distributionGroupMembers.id, memberId),
            eq(distributionGroupMembers.groupId, groupId),
          ),
        )
        .limit(1);
      if (!member) throw notFound("Group member not found");
      await app.db
        .delete(distributionGroupMembers)
        .where(eq(distributionGroupMembers.id, memberId));
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "distribution_group",
        objectId: groupId,
        payload: { removedMemberId: memberId },
      });
      return { ok: true };
    },
  );

  /* --------------------------- Company users ----------------------- */

  app.get("/company/users", { preHandler: read }, async (req) => {
    const q = pageQuerySchema.extend({ search: z.string().max(200).optional() }).parse(req.query);
    const conds = [eq(companyMemberships.companyId, req.companyId!)];
    if (q.search) {
      conds.push(or(ilike(users.name, `%${q.search}%`), ilike(users.email, `%${q.search}%`))!);
    }
    const where = and(...conds);
    const items = await app.db
      .select({
        id: users.id,
        membershipId: companyMemberships.id,
        email: users.email,
        name: users.name,
        title: users.title,
        phone: users.phone,
        isActive: users.isActive,
        lastLoginAt: users.lastLoginAt,
        role: companyMemberships.role,
        joinedAt: companyMemberships.createdAt,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(where)
      .orderBy(asc(users.name))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    const [row] = await app.db
      .select({ n: count() })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .where(where);
    return paginate(items, Number(row?.n ?? 0), q);
  });

  /**
   * Invite someone into the company.
   *
   * WHAT CHANGED (Phase 8) and what deliberately did not.
   *
   * Unchanged, because existing callers depend on it: an unknown address still
   * gets an account and a one-time temporary password in the response, and a
   * known address is still added to the company immediately.
   *
   * Added: a real `user_invitations` record with a hashed single-use token and
   * an expiry, a message composed and DISPATCHED through the email transport,
   * and an honest `delivery` block in the response. When no transport is
   * configured the answer says so — `dispatched: false`, with the reason
   * naming EMAIL_PROVIDER — and returns `acceptUrl` so an administrator can
   * pass the link on by hand. Silently pretending to send was the previous
   * behaviour and it is the one thing this must never do again.
   *
   * `acceptUrl` is returned ONLY for an account this invitation created. For
   * an address that already had one, handing the inviter a link that can set a
   * password would be a takeover of somebody else's account.
   *
   * The route is gated on the inviter having proved their own address (when
   * the deployment can send mail at all) — this is the outbound action an
   * unverified account must not have.
   */
  app.post(
    "/company/users/invite",
    { preHandler: [...adminOnly, requireVerifiedEmail(app, "invite people")] },
    async (req, reply) => {
    const body = inviteSchema.parse(req.body);
    const [existing] = await app.db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    let userId: string;
    let tempPassword: string | undefined;
    if (existing) {
      const [membership] = await app.db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, req.companyId!),
            eq(companyMemberships.userId, existing.id),
          ),
        )
        .limit(1);
      if (membership) throw conflict("User is already a member of this company");
      userId = existing.id;
    } else {
      userId = newId("u");
      tempPassword = randomBytes(12).toString("base64url");
      const passwordHash = await hashPassword(app.appConfig, tempPassword);
      await app.db.insert(users).values({
        id: userId,
        email: body.email,
        name: body.name,
        passwordHash,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "user",
        objectId: userId,
        payload: { email: body.email, name: body.name, invited: true },
      });
    }

    const membershipId = newId("cm");
    await app.db.insert(companyMemberships).values({
      id: membershipId,
      companyId: req.companyId!,
      userId,
      role: body.role,
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "create",
      objectType: "company_membership",
      objectId: membershipId,
      payload: { userId, role: body.role },
    });

    const [company] = await app.db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, req.companyId!))
      .limit(1);
    const invited = await createInvitation(app, requestContext(req), {
      companyId: req.companyId!,
      companyName: company?.name ?? "your company",
      invitedBy: req.user!.id,
      inviterName: req.user!.name,
      email: body.email,
      name: body.name,
      role: body.role,
      templateKey: body.templateKey ?? null,
      projectIds: body.projectIds,
      message: body.message ?? null,
      createdAccount: !existing,
    });

    return reply.status(201).send({
      user: { id: userId, email: body.email, name: existing?.name ?? body.name },
      role: body.role,
      existingUser: Boolean(existing),
      // Returned exactly once, only when a brand-new account was created.
      ...(tempPassword ? { tempPassword } : {}),
      invitation: {
        id: invited.invitation.id,
        status: invited.invitation.status,
        expiresAt: invited.invitation.expiresAt,
        tokenPrefix: invited.invitation.tokenPrefix,
      },
      // Never absent: the caller must always be able to tell an invitation
      // that is on its way from one that will never arrive.
      delivery: invited.delivery,
      acceptUrl: !invited.delivery.dispatched && !existing ? invited.acceptUrl : null,
    });
  },
  );

  async function getMembershipOr404(companyId: string, userId: string) {
    const [membership] = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.userId, userId),
        ),
      )
      .limit(1);
    if (!membership) throw notFound("User is not a member of this company");
    return membership;
  }

  async function countOwners(companyId: string): Promise<number> {
    const [row] = await app.db
      .select({ n: count() })
      .from(companyMemberships)
      .where(
        and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.role, "owner")),
      );
    return Number(row?.n ?? 0);
  }

  app.patch("/company/users/:userId/role", { preHandler: adminOnly }, async (req) => {
    const { userId } = req.params as { userId: string };
    const body = z.object({ role: z.enum(COMPANY_ROLES) }).parse(req.body);
    const membership = await getMembershipOr404(req.companyId!, userId);
    if (membership.role === "owner" && body.role !== "owner") {
      const owners = await countOwners(req.companyId!);
      if (owners <= 1) throw conflict("Cannot demote the last owner of the company");
    }
    await app.db
      .update(companyMemberships)
      .set({ role: body.role })
      .where(eq(companyMemberships.id, membership.id));
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "update",
      objectType: "company_membership",
      objectId: membership.id,
      payload: { userId, role: body.role, previousRole: membership.role },
    });
    return { id: membership.id, userId, role: body.role };
  });

  app.delete("/company/users/:userId", { preHandler: adminOnly }, async (req) => {
    const { userId } = req.params as { userId: string };
    const membership = await getMembershipOr404(req.companyId!, userId);
    if (membership.role === "owner") {
      const owners = await countOwners(req.companyId!);
      if (owners <= 1) throw conflict("Cannot remove the last owner of the company");
    }
    await app.db.transaction(async (tx) => {
      await tx
        .delete(projectMemberships)
        .where(
          and(
            eq(projectMemberships.companyId, req.companyId!),
            eq(projectMemberships.userId, userId),
          ),
        );
      await tx.delete(companyMemberships).where(eq(companyMemberships.id, membership.id));
    });
    await appendLedger(app.db, {
      companyId: req.companyId!,
      actorId: req.user!.id,
      action: "delete",
      objectType: "company_membership",
      objectId: membership.id,
      payload: { userId, role: membership.role },
    });
    return { ok: true };
  });
};
