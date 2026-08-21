import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  assuranceGrants,
  companyMemberships,
  permissionTemplates,
  projectMemberships,
  projects,
  users,
} from "@constructos/db";
import {
  BUILTIN_PERMISSION_TEMPLATES,
  meetsLevel,
  resolveLevel,
  type AssuranceRole,
  type CompanyRole,
  type PermissionLevel,
  type ToolKey,
  type ToolPermissionMap,
} from "@constructos/shared";
import { forbidden, unauthorized } from "../lib/errors.js";

const authPlugin: FastifyPluginAsync = async (app) => {
  const secret = new TextEncoder().encode(app.appConfig.AUTH_SECRET);
  const ttl = app.appConfig.ACCESS_TOKEN_TTL_SECONDS;

  app.decorate("signAccessToken", async (user: { id: string; email: string }) => {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(secret);
  });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized("Missing bearer token");
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(header.slice(7), secret);
      sub = payload.sub;
    } catch {
      throw unauthorized("Invalid or expired token");
    }
    if (!sub) throw unauthorized("Invalid token subject");
    const row = await app.db
      .select({ id: users.id, email: users.email, name: users.name, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, sub))
      .limit(1);
    const user = row[0];
    if (!user || !user.isActive) throw unauthorized("Unknown or deactivated user");
    req.user = { id: user.id, email: user.email, name: user.name };
  });

  app.decorate("requireCompany", async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    const companyId = req.headers["x-company-id"];
    if (typeof companyId !== "string" || !companyId) {
      throw unauthorized("Missing x-company-id header");
    }
    const membership = await app.db
      .select({ role: companyMemberships.role })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.userId, req.user.id),
        ),
      )
      .limit(1);
    if (!membership[0]) throw forbidden("Not a member of this company");
    req.companyId = companyId;
    req.companyRole = membership[0].role as CompanyRole;
  });

  app.decorate("requireCompanyRole", (roles: CompanyRole[]) => {
    return async (req: FastifyRequest) => {
      if (!req.companyRole) throw unauthorized("Company context not resolved");
      if (!roles.includes(req.companyRole)) {
        throw forbidden(`Requires company role: ${roles.join(" or ")}`);
      }
    };
  });

  app.decorate("requireAssuranceRole", (roles: AssuranceRole[]) => {
    return async (req: FastifyRequest) => {
      if (!req.user || !req.companyId) throw unauthorized();
      const now = new Date().toISOString();
      const grants = await app.db
        .select()
        .from(assuranceGrants)
        .where(
          and(
            eq(assuranceGrants.companyId, req.companyId),
            eq(assuranceGrants.userId, req.user.id),
          ),
        );
      const grant = grants.find(
        (g) =>
          roles.includes(g.role as AssuranceRole) && (!g.expiresAt || g.expiresAt > now),
      );
      if (!grant) throw forbidden("Requires an assurance role");
      req.assuranceRole = grant.role as AssuranceRole;
    };
  });

  app.decorate("requireTool", (tool: ToolKey, level: PermissionLevel) => {
    return async (req: FastifyRequest) => {
      if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
      const params = req.params as Record<string, string | undefined>;
      const projectId = params["projectId"];
      if (!projectId) throw forbidden("Route is missing :projectId");

      const project = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, req.companyId)))
        .limit(1);
      if (!project[0]) throw forbidden("Project not found in this company");
      req.projectId = projectId;

      // Company owners and admins bypass tool-level checks.
      if (req.companyRole === "owner" || req.companyRole === "admin") return;

      const membership = await app.db
        .select()
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, projectId),
            eq(projectMemberships.userId, req.user.id),
          ),
        )
        .limit(1);

      if (membership[0]) {
        const templateRow = await app.db
          .select({ tools: permissionTemplates.tools })
          .from(permissionTemplates)
          .where(
            and(
              eq(permissionTemplates.companyId, req.companyId),
              eq(permissionTemplates.key, membership[0].templateKey),
            ),
          )
          .limit(1);
        const template =
          (templateRow[0]?.tools as ToolPermissionMap | undefined) ??
          BUILTIN_PERMISSION_TEMPLATES.find((t) => t.key === membership[0]!.templateKey)?.tools;
        const effective = resolveLevel(
          tool,
          template,
          membership[0].overrides as ToolPermissionMap,
        );
        if (meetsLevel(effective, level)) return;
      }

      // Assurance roles grant read-only visibility over operational tools.
      if (level === "read") {
        const now = new Date().toISOString();
        const grants = await app.db
          .select()
          .from(assuranceGrants)
          .where(
            and(
              eq(assuranceGrants.companyId, req.companyId),
              eq(assuranceGrants.userId, req.user.id),
              or(isNull(assuranceGrants.projectId), eq(assuranceGrants.projectId, projectId)),
            ),
          );
        const grant = grants.find((g) => !g.expiresAt || g.expiresAt > now);
        if (grant) {
          req.assuranceRole = grant.role as AssuranceRole;
          return;
        }
      }

      throw forbidden(`Requires ${level} access to ${tool}`);
    };
  });
};

export default fp(authPlugin, { name: "auth" });
