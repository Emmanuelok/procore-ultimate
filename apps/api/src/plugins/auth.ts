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
import { isExpired } from "../lib/time.js";
import { loadSession } from "../modules/account/sessions.js";
// Vol I §0.7 #120 — machine callers. This gate needed four small additions,
// all marked below: resolve an OAuth2 access token to a machine identity in
// `authenticate`, branch to the machine equivalents in `requireCompany` and
// `requireTool`, label each tool gate, and record which routes carry one. The
// point of all of it is that a machine goes THROUGH these checks rather than
// around them. See modules/integrations/machine-auth.ts for why it cannot
// live outside this file: hooks and content-type parsers are
// plugin-encapsulated, and the integrations module is registered last, so
// nothing it adds can reach routes registered before it.
import { machineAuth } from "../modules/integrations/machine-auth.js";
import { guardCompanyIpAccess } from "../modules/account/login.js";

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
    if (await machineAuth.resolve(app.db, req, header.slice(7))) {
      // A machine caller's authority is its tool:level scopes, so a route with
      // no tool gate has nothing to check it against. Refused HERE rather than
      // only in requireCompany, because a route gated `[authenticate]` alone
      // never reaches requireCompany — see machineGuardRoute.
      machineAuth.guardRoute(req);
      return;
    }
    let sub: string | undefined;
    let payload: Record<string, unknown> = {};
    try {
      const verified = await jwtVerify(header.slice(7), secret);
      payload = verified.payload as Record<string, unknown>;
      sub = verified.payload.sub;
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

    // Phase 8 — REVOCATION ON THE ACCESS PATH.
    //
    // An access token is a one-hour stateless JWT, so revoking the refresh
    // token alone leaves the bearer working for the rest of that hour: the
    // exact hour that matters after a laptop is stolen. modules/account mints
    // every token with a `sid` naming its `auth_sessions` row and enforced
    // that row on its own routes; enforcing it only there made "sign out this
    // device" cosmetic everywhere else — a revoked token was measured
    // reading GET /me and CREATING A PROJECT. The check belongs here, where
    // it reaches every authenticated route, because Fastify binds a route's
    // hooks from the encapsulation context it was registered in and no module
    // hook can reach routes registered before it.
    //
    // A token with NO `sid` is not refused: `signAccessToken` (and every test
    // helper) mints one, and there is no session behind it to check. That is
    // stated rather than assumed.
    const sid = (payload as { sid?: unknown }).sid;
    if (typeof sid === "string" && sid.length > 0) {
      const session = await loadSession(app.db, sid);
      if (!session || session.userId !== user.id) {
        throw unauthorized("Session is no longer valid");
      }
      if (session.revokedAt) {
        throw unauthorized(
          session.revokedReason === "password_changed" || session.revokedReason === "mfa_reset"
            ? "Session ended because the account credentials changed"
            : "Session has been signed out",
        );
      }
      if (isExpired(session.expiresAt, Date.now())) {
        throw unauthorized("Session has expired");
      }
      req.accountSessionId = session.id;
    }
  });

  app.decorate("requireCompany", async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    if (req.machineClient) return machineAuth.company(req);
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
    // The sign-in guard refuses an address only when EVERY company of the
    // account refuses it, so a strict tenant's own rule has to be applied on
    // the request that names that tenant - otherwise a session opened from
    // the office and carried home keeps reading the tenant that excluded the
    // home address. `monitor` mode records and allows, break-glass users are
    // exempt, and a policy read failure allows and is logged.
    await guardCompanyIpAccess(app, req, companyId, req.user.id);
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
      const nowMs = Date.now();
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
          roles.includes(g.role as AssuranceRole) && !isExpired(g.expiresAt, nowMs),
      );
      if (!grant) throw forbidden("Requires an assurance role");
      req.assuranceRole = grant.role as AssuranceRole;
    };
  });

  app.decorate("requireTool", (tool: ToolKey, level: PermissionLevel) => {
    // machineAuth.markToolGate labels this closure so the onRoute hook below
    // can tell which routes are tool-scoped — machine callers are admitted
    // only to those. It changes nothing about how the gate behaves.
    return machineAuth.markToolGate(async (req: FastifyRequest) => {
      if (!req.user || !req.companyId) throw unauthorized("Company context not resolved");
      if (req.machineClient) return machineAuth.tool(app.db, req, tool, level);
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
        // Merge the builtin template underneath the stored one so tenants
        // seeded before a tool existed still inherit its builtin level.
        const builtin = BUILTIN_PERMISSION_TEMPLATES.find(
          (t) => t.key === membership[0]!.templateKey,
        )?.tools;
        const stored = templateRow[0]?.tools as ToolPermissionMap | undefined;
        const template: ToolPermissionMap | undefined = stored
          ? { ...(builtin ?? {}), ...stored }
          : builtin;
        const effective = resolveLevel(
          tool,
          template,
          membership[0].overrides as ToolPermissionMap,
        );
        if (meetsLevel(effective, level)) return;
      }

      // Assurance roles grant read-only visibility over operational tools.
      if (level === "read") {
        const nowMs = Date.now();
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
        const grant = grants.find((g) => !isExpired(g.expiresAt, nowMs));
        if (grant) {
          req.assuranceRole = grant.role as AssuranceRole;
          return;
        }
      }

      throw forbidden(`Requires ${level} access to ${tool}`);
    }, tool, level);
  });

  // Vol I §0.7 #120 — record which routes carry a tool gate. This plugin is
  // non-encapsulated and loads before every module, so the hook sees every
  // route in the API; machine callers are refused anywhere it does not fire.
  app.addHook("onRoute", machineAuth.noteRoute);
};

export default fp(authPlugin, { name: "auth" });
