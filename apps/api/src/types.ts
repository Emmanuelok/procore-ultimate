import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AssuranceRole,
  CompanyRole,
  PermissionLevel,
  ToolKey,
} from "@constructos/shared";
import type { Config } from "./config.js";
import type { Db } from "./lib/db.js";
import type { StorageService } from "./lib/storage.js";
import type { PlatformScheduler } from "./lib/scheduler.js";

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    storage: StorageService;
    appConfig: Config;
    /** The platform job scheduler — modules register their sweeps here (lib/scheduler.ts). */
    scheduler: PlatformScheduler;
    /** Verifies the Bearer token and populates req.user. */
    authenticate: PreHandler;
    /**
     * Resolves the tenant from the `x-company-id` header, verifies the user
     * is a member, and populates req.companyId / req.companyRole.
     * Must run after `authenticate`.
     */
    requireCompany: PreHandler;
    /**
     * Factory: project-tool permission gate. Route MUST carry a `:projectId`
     * param. Verifies the project belongs to the tenant, resolves the user's
     * permission template + overrides and checks the required level.
     * Company owners/admins bypass. Assurance-role holders get read access.
     * Populates req.projectId. Must run after `requireCompany`.
     */
    requireTool: (tool: ToolKey, level: PermissionLevel) => PreHandler;
    /** Factory: company-role gate (e.g. ["owner","admin"]). */
    requireCompanyRole: (roles: CompanyRole[]) => PreHandler;
    /** Factory: assurance-role gate (integrity_reviewer / auditor / regulator). */
    requireAssuranceRole: (roles: AssuranceRole[]) => PreHandler;
    signAccessToken: (user: { id: string; email: string }) => Promise<string>;
  }

  interface FastifyRequest {
    user?: { id: string; email: string; name: string };
    companyId?: string;
    companyRole?: CompanyRole;
    projectId?: string;
    /** set when access was granted via an assurance role instead of a tool level */
    assuranceRole?: AssuranceRole;
  }
}
