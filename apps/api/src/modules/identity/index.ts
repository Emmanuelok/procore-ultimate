import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  authEvents,
  companies,
  companyMemberships,
  permissionTemplates,
  refreshTokens,
  users,
} from "@constructos/db";
import { BUILTIN_PERMISSION_TEMPLATES } from "@constructos/shared";
import { sha256Hex } from "@constructos/ledger";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, conflict, unauthorized } from "../../lib/errors.js";
import type { Db } from "../../lib/db.js";

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(200),
  companyName: z.string().min(1).max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

/** Seed the built-in permission templates into a new tenant. */
export async function seedCompanyDefaults(db: Db, companyId: string): Promise<void> {
  for (const template of BUILTIN_PERMISSION_TEMPLATES) {
    await db.insert(permissionTemplates).values({
      id: newId("ptpl"),
      companyId,
      key: template.key,
      name: template.name,
      description: template.description,
      tools: template.tools as Record<string, string>,
      isBuiltin: true,
    });
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "company"
  );
}

export const identityModule: FastifyPluginAsync = async (app) => {
  /** Stricter per-IP limits on credential endpoints (brute-force guard). */
  const authLimited =
    app.appConfig.RATE_LIMIT_ENABLED && app.appConfig.NODE_ENV !== "test"
      ? {
          config: {
            rateLimit: {
              max: app.appConfig.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
              timeWindow: "1 minute",
            },
          },
        }
      : {};

  async function issueTokens(user: { id: string; email: string }) {
    const accessToken = await app.signAccessToken(user);
    const refreshToken = newId("rt") + newId();
    const expiresAt = new Date(
      Date.now() + app.appConfig.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    await app.db.insert(refreshTokens).values({
      id: newId("rtk"),
      userId: user.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: app.appConfig.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async function createCompany(name: string, ownerId: string) {
    const companyId = newId("co");
    let slug = slugify(name);
    const existing = await app.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.slug, slug))
      .limit(1);
    if (existing[0]) slug = `${slug}-${newId().slice(0, 6)}`;
    await app.db.insert(companies).values({ id: companyId, name, slug });
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId,
      userId: ownerId,
      role: "owner",
    });
    await seedCompanyDefaults(app.db, companyId);
    await appendLedger(app.db, {
      companyId,
      actorId: ownerId,
      action: "create",
      objectType: "company",
      objectId: companyId,
      payload: { name, slug },
      storePayload: true,
    });
    return { id: companyId, name, slug };
  }

  app.post("/auth/register", authLimited, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const existing = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    if (existing[0]) throw conflict("An account with this email already exists");

    const userId = newId("u");
    const passwordHash = await bcrypt.hash(body.password, 10);
    await app.db.insert(users).values({
      id: userId,
      email: body.email,
      name: body.name,
      passwordHash,
    });

    let company: { id: string; name: string; slug: string } | null = null;
    if (body.companyName) {
      company = await createCompany(body.companyName, userId);
    }

    await app.db.insert(authEvents).values({
      id: newId("ae"),
      userId,
      email: body.email,
      kind: "register",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    const tokens = await issueTokens({ id: userId, email: body.email });
    return reply.status(201).send({
      user: { id: userId, email: body.email, name: body.name },
      company,
      ...tokens,
    });
  });

  app.post("/auth/login", authLimited, async (req) => {
    const body = loginSchema.parse(req.body);
    const rows = await app.db.select().from(users).where(eq(users.email, body.email)).limit(1);
    const user = rows[0];
    const ok = user ? await bcrypt.compare(body.password, user.passwordHash) : false;
    await app.db.insert(authEvents).values({
      id: newId("ae"),
      userId: user?.id ?? null,
      email: body.email,
      kind: ok ? "login_success" : "login_failure",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    if (!user || !ok || !user.isActive) throw unauthorized("Invalid credentials");
    await app.db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
    const tokens = await issueTokens(user);
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens };
  });

  app.post("/auth/refresh", authLimited, async (req) => {
    const body = refreshSchema.parse(req.body);
    const hash = sha256Hex(body.refreshToken);
    const rows = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    const token = rows[0];
    const now = new Date().toISOString();
    if (!token || token.revokedAt || token.expiresAt <= now) {
      throw unauthorized("Invalid refresh token");
    }
    // rotate: revoke old, issue new
    await app.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(eq(refreshTokens.id, token.id));
    const userRows = await app.db
      .select()
      .from(users)
      .where(eq(users.id, token.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || !user.isActive) throw unauthorized("Unknown or deactivated user");
    const tokens = await issueTokens(user);
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens };
  });

  app.post("/auth/logout", async (req) => {
    const body = refreshSchema.parse(req.body);
    await app.db
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(refreshTokens.tokenHash, sha256Hex(body.refreshToken)));
    return { ok: true };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const memberships = await app.db
      .select({
        companyId: companyMemberships.companyId,
        role: companyMemberships.role,
        name: companies.name,
        slug: companies.slug,
      })
      .from(companyMemberships)
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(eq(companyMemberships.userId, req.user!.id));
    return {
      ...req.user,
      companies: memberships.map((m) => ({
        id: m.companyId,
        name: m.name,
        slug: m.slug,
        role: m.role,
      })),
    };
  });

  app.post("/companies", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    const company = await createCompany(body.name, req.user!.id);
    return reply.status(201).send(company);
  });

  app.get("/companies", { preHandler: [app.authenticate] }, async (req) => {
    const rows = await app.db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        role: companyMemberships.role,
      })
      .from(companyMemberships)
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(eq(companyMemberships.userId, req.user!.id));
    return { items: rows };
  });

  app.get(
    "/companies/:companyId",
    { preHandler: [app.authenticate] },
    async (req) => {
      const { companyId } = req.params as { companyId: string };
      const member = await app.db
        .select({ role: companyMemberships.role })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.userId, req.user!.id),
          ),
        )
        .limit(1);
      if (!member[0]) throw badRequest("Not a member of this company");
      const rows = await app.db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      return rows[0];
    },
  );
};
