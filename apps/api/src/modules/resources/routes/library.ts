/**
 * THE COMPANY LIBRARY — resource types (trades, crafts, plant classes) and
 * skills/certifications.
 *
 * Both are COMPANY assets behind the company gate rather than the project
 * tool gate: a planner setting up the vocabulary a business resources against
 * does not necessarily hold a permission on any one project, and forcing them
 * to is how every project ends up with its own spelling of "Steel fixer".
 * Mutation additionally requires an owner/admin company role.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import {
  resourceAvailability,
  resourceDemands,
  resourceSkills,
  resourceTypes,
  workerSkills,
} from "@constructos/db";
import { newId } from "../../../lib/ids.js";
import { badRequest, conflict } from "../../../lib/errors.js";
import { pageOffset, paginate } from "../../../lib/pagination.js";
import {
  actorOf,
  companyOf,
  fetchResourceType,
  fetchSkill,
  ledgerResources,
  nowIso,
  requireProjectInCompany,
  resourceGates,
} from "../shared.js";
import * as S from "../schemas.js";

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const gates = resourceGates(app);

  /* ================================================================== */
  /* Resource types                                                      */
  /* ================================================================== */

  app.post("/resource-types", { preHandler: gates.companyAdmin }, async (req, reply) => {
    const body = S.resourceTypeCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    if (body.projectId) await requireProjectInCompany(app.db, body.projectId, companyId);

    const clash = await app.db
      .select({ id: resourceTypes.id })
      .from(resourceTypes)
      .where(and(eq(resourceTypes.companyId, companyId), eq(resourceTypes.code, body.code)))
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `A resource type with code ${body.code} already exists in this company. Codes are the join ` +
          "between a plan, a histogram and a productivity figure, so they are unique per tenant.",
      );
    }
    if (body.requiredSkillIds && body.requiredSkillIds.length > 0) {
      await assertSkillsExist(body.requiredSkillIds, companyId);
    }

    const id = newId("rty");
    await app.db.insert(resourceTypes).values({
      id,
      companyId,
      projectId: body.projectId ?? null,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind ?? "labour",
      trade: body.trade ?? null,
      equipmentCategory: body.equipmentCategory ?? null,
      unit: body.unit ?? "hours",
      standardHoursPerDay: body.standardHoursPerDay ?? null,
      workingDaysPerWeek: body.workingDaysPerWeek ?? null,
      defaultHourlyCost: body.defaultHourlyCost ?? null,
      currency: body.currency ?? "USD",
      requiredSkillIds: body.requiredSkillIds ?? [],
      mapsToTrade: body.mapsToTrade ?? null,
      status: body.status ?? "active",
      detail: body.detail ?? {},
      createdBy: actorOf(req),
    });
    await ledgerResources(app.db, req, "create", "resource_type", id, {
      code: body.code,
      name: body.name,
      kind: body.kind ?? "labour",
      projectId: body.projectId ?? null,
    });
    return reply.status(201).send(await fetchResourceType(app.db, id, companyId));
  });

  app.get("/resource-types", { preHandler: gates.company }, async (req) => {
    const q = S.resourceTypeListQuery.parse(req.query);
    const companyId = companyOf(req);
    const clauses = [eq(resourceTypes.companyId, companyId)];
    if (q.kind) clauses.push(eq(resourceTypes.kind, q.kind));
    if (q.status) clauses.push(eq(resourceTypes.status, q.status));
    if (q.projectId) {
      clauses.push(
        or(isNull(resourceTypes.projectId), eq(resourceTypes.projectId, q.projectId))!,
      );
    }
    if (q.q) {
      clauses.push(
        or(ilike(resourceTypes.name, `%${q.q}%`), ilike(resourceTypes.code, `%${q.q}%`))!,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(resourceTypes).where(where);
    const rows = await app.db
      .select()
      .from(resourceTypes)
      .where(where)
      .orderBy(asc(resourceTypes.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(rows, Number(totalRow?.n ?? 0), q);
  });

  app.get("/resource-types/:typeId", { preHandler: gates.company }, async (req) => {
    const { typeId } = req.params as { typeId: string };
    const companyId = companyOf(req);
    const type = await fetchResourceType(app.db, typeId, companyId);
    const skills =
      type.requiredSkillIds.length > 0
        ? await app.db
            .select()
            .from(resourceSkills)
            .where(
              and(
                eq(resourceSkills.companyId, companyId),
                inArray(resourceSkills.id, type.requiredSkillIds),
              ),
            )
        : [];
    const [demandRow] = await app.db
      .select({ n: count() })
      .from(resourceDemands)
      .where(eq(resourceDemands.resourceTypeId, typeId));
    const [supplyRow] = await app.db
      .select({ n: count() })
      .from(resourceAvailability)
      .where(eq(resourceAvailability.resourceTypeId, typeId));
    return {
      ...type,
      requiredSkills: skills,
      usage: {
        demandRows: Number(demandRow?.n ?? 0),
        availabilityRows: Number(supplyRow?.n ?? 0),
      },
      headcountBasis:
        type.standardHoursPerDay === null
          ? "No standard hours per day are recorded, so hours on this type are never converted to a headcount."
          : `${type.standardHoursPerDay} h/day${type.workingDaysPerWeek ? ` over ${type.workingDaysPerWeek} day(s) a week` : ""}.`,
    };
  });

  app.patch("/resource-types/:typeId", { preHandler: gates.companyAdmin }, async (req) => {
    const { typeId } = req.params as { typeId: string };
    const body = S.resourceTypePatchSchema.parse(req.body);
    const companyId = companyOf(req);
    const type = await fetchResourceType(app.db, typeId, companyId);
    if (body.projectId) await requireProjectInCompany(app.db, body.projectId, companyId);
    if (body.requiredSkillIds && body.requiredSkillIds.length > 0) {
      await assertSkillsExist(body.requiredSkillIds, companyId);
    }

    const set: Record<string, unknown> = { updatedAt: nowIso() };
    const direct = [
      "name",
      "description",
      "kind",
      "trade",
      "equipmentCategory",
      "unit",
      "standardHoursPerDay",
      "workingDaysPerWeek",
      "defaultHourlyCost",
      "currency",
      "requiredSkillIds",
      "mapsToTrade",
      "projectId",
      "status",
    ] as const;
    for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
    if (body.detail !== undefined) set["detail"] = { ...(type.detail ?? {}), ...body.detail };
    await app.db.update(resourceTypes).set(set).where(eq(resourceTypes.id, typeId));
    await ledgerResources(app.db, req, "update", "resource_type", typeId, {
      code: type.code,
      changed: Object.keys(body),
    });
    return fetchResourceType(app.db, typeId, companyId);
  });

  /* ================================================================== */
  /* Skills and certifications                                           */
  /* ================================================================== */

  async function assertSkillsExist(ids: string[], companyId: string): Promise<void> {
    const rows = await app.db
      .select({ id: resourceSkills.id })
      .from(resourceSkills)
      .where(and(eq(resourceSkills.companyId, companyId), inArray(resourceSkills.id, ids)));
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `These skill ids are not in this company's library: ${missing.join(", ")}. A requirement ` +
          "pointing at nothing silently stops being checked.",
      );
    }
  }

  app.post("/resource-skills", { preHandler: gates.companyAdmin }, async (req, reply) => {
    const body = S.skillCreateSchema.parse(req.body);
    const companyId = companyOf(req);
    const clash = await app.db
      .select({ id: resourceSkills.id })
      .from(resourceSkills)
      .where(and(eq(resourceSkills.companyId, companyId), eq(resourceSkills.code, body.code)))
      .limit(1);
    if (clash[0]) throw conflict(`A skill with code ${body.code} already exists in this company.`);

    const id = newId("rsk");
    await app.db.insert(resourceSkills).values({
      id,
      companyId,
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      category: body.category ?? "skill",
      trade: body.trade ?? null,
      issuingBody: body.issuingBody ?? null,
      validityMonths: body.validityMonths ?? null,
      requiresEvidence: body.requiresEvidence ? 1 : 0,
      isMandatory: body.isMandatory ? 1 : 0,
      status: body.status ?? "active",
      detail: body.detail ?? {},
      createdBy: actorOf(req),
    });
    await ledgerResources(app.db, req, "create", "resource_skill", id, {
      code: body.code,
      name: body.name,
      category: body.category ?? "skill",
      isMandatory: body.isMandatory ?? false,
    });
    return reply.status(201).send(await fetchSkill(app.db, id, companyId));
  });

  app.get("/resource-skills", { preHandler: gates.company }, async (req) => {
    const q = S.skillListQuery.parse(req.query);
    const companyId = companyOf(req);
    const clauses = [eq(resourceSkills.companyId, companyId)];
    if (q.category) clauses.push(eq(resourceSkills.category, q.category));
    if (q.status) clauses.push(eq(resourceSkills.status, q.status));
    if (q.q) {
      clauses.push(
        or(ilike(resourceSkills.name, `%${q.q}%`), ilike(resourceSkills.code, `%${q.q}%`))!,
      );
    }
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(resourceSkills).where(where);
    const rows = await app.db
      .select()
      .from(resourceSkills)
      .where(where)
      .orderBy(asc(resourceSkills.code))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(
      rows.map((row) => ({
        ...row,
        expires: row.validityMonths !== null,
        expiryNote:
          row.validityMonths === null
            ? "No validity period is recorded, so holders of this skill are never swept for expiry."
            : `Valid for ${row.validityMonths} month(s) from issue.`,
      })),
      Number(totalRow?.n ?? 0),
      q,
    );
  });

  app.patch("/resource-skills/:skillId", { preHandler: gates.companyAdmin }, async (req) => {
    const { skillId } = req.params as { skillId: string };
    const body = S.skillPatchSchema.parse(req.body);
    const companyId = companyOf(req);
    const skill = await fetchSkill(app.db, skillId, companyId);
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    const direct = [
      "name",
      "description",
      "category",
      "trade",
      "issuingBody",
      "validityMonths",
      "status",
    ] as const;
    for (const key of direct) if (body[key] !== undefined) set[key] = body[key];
    if (body.requiresEvidence !== undefined) set["requiresEvidence"] = body.requiresEvidence ? 1 : 0;
    if (body.isMandatory !== undefined) set["isMandatory"] = body.isMandatory ? 1 : 0;
    if (body.detail !== undefined) set["detail"] = { ...(skill.detail ?? {}), ...body.detail };
    await app.db.update(resourceSkills).set(set).where(eq(resourceSkills.id, skillId));
    await ledgerResources(app.db, req, "update", "resource_skill", skillId, {
      code: skill.code,
      changed: Object.keys(body),
    });
    return fetchSkill(app.db, skillId, companyId);
  });

  app.get("/resource-skills/:skillId", { preHandler: gates.company }, async (req) => {
    const { skillId } = req.params as { skillId: string };
    const companyId = companyOf(req);
    const skill = await fetchSkill(app.db, skillId, companyId);
    const [holders] = await app.db
      .select({ n: count() })
      .from(workerSkills)
      .where(and(eq(workerSkills.companyId, companyId), eq(workerSkills.skillId, skillId)));
    return {
      ...skill,
      holderCount: Number(holders?.n ?? 0),
      expires: skill.validityMonths !== null,
    };
  });
};
