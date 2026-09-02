/**
 * The notification centre and the policy behind it (Vol I §0.5 #93–#103).
 *
 * Routes: the in-app feed with filters and an honest unread count, per-user
 * preferences (kinds, channels, digest cadence, project and tool muting), and
 * the digest builder — exposed both as a scheduler job and as a manual run so
 * an operator can see exactly what a digest would contain before it goes out.
 *
 * What this module deliberately does not do: send email. `lib/email.ts` owns
 * the transport and WP-AUTH owns its configuration; the digest returns a
 * rendered summary and records that it ran, and a transport-backed sender is
 * a thin adapter over `buildDigest`.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  notificationPreferences,
  notifications,
  projects,
} from "@constructos/db";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DIGESTS,
  NOTIFICATION_KINDS,
  TOOLS,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { buildDigest, nextDigestDue, type DigestItem } from "./policy.js";

const listQuerySchema = pageQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional(),
  kind: z.string().max(50).optional(),
  projectId: z.string().max(100).optional(),
});

const KIND_SET = new Set<string>(NOTIFICATION_KINDS);

const preferencesSchema = z.object({
  defaultChannel: z.enum(NOTIFICATION_CHANNELS).optional(),
  digest: z.enum(NOTIFICATION_DIGESTS).optional(),
  /*
   * A partial map, not an exhaustive one: `z.record(z.enum(...), ...)` in zod
   * v4 demands every key of the enum, which would force a client to send all
   * 27 notification kinds to change one. Keys are checked below instead.
   */
  kinds: z
    .record(z.string().max(50), z.enum(NOTIFICATION_CHANNELS))
    .refine(
      (map) => Object.keys(map).every((k) => KIND_SET.has(k)),
      "kinds may only name notification kinds the platform raises",
    )
    .optional(),
  mutedProjectIds: z.array(z.string().min(1).max(100)).max(500).optional(),
  mutedTools: z.array(z.enum(TOOLS)).max(TOOLS.length).optional(),
});

const DIGEST_JOB = "notifications.digest";

export const notificationsModule: FastifyPluginAsync = async (app) => {
  const gate = [app.authenticate, app.requireCompany];
  const adminGate = [
    app.authenticate,
    app.requireCompany,
    app.requireCompanyRole(["owner", "admin"]),
  ];

  app.get("/notifications", { preHandler: gate }, async (req) => {
    const q = listQuerySchema.parse(req.query);
    const conds = [
      eq(notifications.companyId, req.companyId!),
      eq(notifications.userId, req.user!.id),
    ];
    if (q.unread === "true") conds.push(isNull(notifications.readAt));
    if (q.kind) conds.push(eq(notifications.kind, q.kind));
    if (q.projectId) conds.push(eq(notifications.projectId, q.projectId));
    const where = and(...conds);
    const [totalRow] = await app.db.select({ n: count() }).from(notifications).where(where);
    const items = await app.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get("/notifications/unread-count", { preHandler: gate }, async (req) => {
    const [row] = await app.db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, req.companyId!),
          eq(notifications.userId, req.user!.id),
          isNull(notifications.readAt),
        ),
      );
    // Per-kind so the shell can badge the right nav entry rather than one
    // undifferentiated number.
    const byKind = await app.db
      .select({ kind: notifications.kind, n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.companyId, req.companyId!),
          eq(notifications.userId, req.user!.id),
          isNull(notifications.readAt),
        ),
      )
      .groupBy(notifications.kind);
    return {
      count: Number(row?.n ?? 0),
      byKind: Object.fromEntries(byKind.map((r) => [r.kind, Number(r.n)])),
    };
  });

  app.post("/notifications/:id/read", { preHandler: gate }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await app.db
      .select({ id: notifications.id, readAt: notifications.readAt })
      .from(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.companyId, req.companyId!),
          eq(notifications.userId, req.user!.id),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Notification not found");
    const readAt = rows[0].readAt ?? new Date().toISOString();
    if (!rows[0].readAt) {
      await app.db.update(notifications).set({ readAt }).where(eq(notifications.id, id));
    }
    return { id, readAt };
  });

  /** Mark everything read, or everything of one kind / one project (#103). */
  app.post("/notifications/read-all", { preHandler: gate }, async (req) => {
    const body = z
      .object({ kind: z.string().max(50).optional(), projectId: z.string().max(100).optional() })
      .parse(req.body ?? {});
    const now = new Date().toISOString();
    const conds = [
      eq(notifications.companyId, req.companyId!),
      eq(notifications.userId, req.user!.id),
      isNull(notifications.readAt),
    ];
    if (body.kind) conds.push(eq(notifications.kind, body.kind));
    if (body.projectId) conds.push(eq(notifications.projectId, body.projectId));
    const updated = await app.db
      .update(notifications)
      .set({ readAt: now })
      .where(and(...conds))
      .returning({ id: notifications.id });
    return { updated: updated.length, readAt: now };
  });

  /* ---------------------------------------------------------------- */
  /* Preferences (#93–#95, #97)                                        */
  /* ---------------------------------------------------------------- */

  async function loadOrDefault(companyId: string, userId: string) {
    const rows = await app.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.companyId, companyId),
          eq(notificationPreferences.userId, userId),
        ),
      )
      .limit(1);
    return (
      rows[0] ?? {
        id: null,
        companyId,
        userId,
        defaultChannel: "in_app",
        digest: "off",
        kinds: {} as Record<string, string>,
        mutedProjectIds: [] as string[],
        mutedTools: [] as string[],
        quietHours: null,
        lastDigestAt: null,
      }
    );
  }

  app.get("/me/notification-preferences", { preHandler: gate }, async (req) => {
    const pref = await loadOrDefault(req.companyId!, req.user!.id);
    return {
      ...pref,
      // The catalogue the settings page renders from, so the UI never hard-
      // codes a kind list that drifts from the platform's.
      catalogue: {
        kinds: NOTIFICATION_KINDS,
        channels: NOTIFICATION_CHANNELS,
        digests: NOTIFICATION_DIGESTS,
      },
    };
  });

  app.put("/me/notification-preferences", { preHandler: gate }, async (req) => {
    const body = preferencesSchema.parse(req.body);
    const existing = await app.db
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.companyId, req.companyId!),
          eq(notificationPreferences.userId, req.user!.id),
        ),
      )
      .limit(1);

    // Muting a project you cannot see is meaningless; muting one you can is
    // the point. Validate against the tenant so stale ids do not accumulate.
    let mutedProjectIds = body.mutedProjectIds;
    if (mutedProjectIds && mutedProjectIds.length > 0) {
      const live = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.companyId, req.companyId!), inArray(projects.id, mutedProjectIds)),
        );
      mutedProjectIds = live.map((r) => r.id);
    }

    const patch = {
      ...(body.defaultChannel !== undefined ? { defaultChannel: body.defaultChannel } : {}),
      ...(body.digest !== undefined ? { digest: body.digest } : {}),
      ...(body.kinds !== undefined ? { kinds: body.kinds as Record<string, string> } : {}),
      ...(mutedProjectIds !== undefined ? { mutedProjectIds } : {}),
      ...(body.mutedTools !== undefined ? { mutedTools: [...body.mutedTools] } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (existing[0]) {
      await app.db
        .update(notificationPreferences)
        .set(patch)
        .where(eq(notificationPreferences.id, existing[0].id));
    } else {
      await app.db.insert(notificationPreferences).values({
        id: newId("npref"),
        companyId: req.companyId!,
        userId: req.user!.id,
        defaultChannel: body.defaultChannel ?? "in_app",
        digest: body.digest ?? "off",
        kinds: (body.kinds ?? {}) as Record<string, string>,
        mutedProjectIds: mutedProjectIds ?? [],
        mutedTools: body.mutedTools ? [...body.mutedTools] : [],
      });
    }
    return loadOrDefault(req.companyId!, req.user!.id);
  });

  /* ---------------------------------------------------------------- */
  /* Digest (#96)                                                      */
  /* ---------------------------------------------------------------- */

  /** Preview my own digest without sending or stamping anything. */
  app.get("/me/notification-digest", { preHandler: gate }, async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(30).default(1) }).parse(req.query);
    const until = new Date();
    const since = new Date(until.getTime() - q.days * 86_400_000);
    const digest = await composeDigest(app.db, req.companyId!, req.user!.id, since, until);
    return digest;
  });

  /** Run the digest sweep for this company on demand (admin/operator). */
  app.post("/notifications/digest/run", { preHandler: adminGate }, async (req) => {
    const result = await runDigestForCompany(app.db, req.companyId!, new Date());
    return result;
  });

  if (!app.scheduler.has(DIGEST_JOB)) {
    app.scheduler.register({
      name: DIGEST_JOB,
      description: "Compose daily/weekly notification digests for users who asked for one (#96)",
      everyMs: 60 * 60_000,
      runOnBoot: false,
      run: async ({ db, now }) => {
        let digests = 0;
        let items = 0;
        const result = await forEachCompany(db, async (companyId) => {
          const summary = await runDigestForCompany(db, companyId, now);
          digests += summary.digests;
          items += summary.items;
        });
        return { ...result, digests, items };
      },
    });
  }
};

/* ------------------------------------------------------------------ */
/* Digest composition                                                  */
/* ------------------------------------------------------------------ */

async function composeDigest(
  db: Db,
  companyId: string,
  userId: string,
  since: Date,
  until: Date,
) {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      projectId: notifications.projectId,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.userId, userId),
        gte(notifications.createdAt, since.toISOString()),
        lt(notifications.createdAt, until.toISOString()),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(500);

  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))];
  const names = new Map<string, string>();
  if (projectIds.length > 0) {
    const prj = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
    for (const p of prj) names.set(p.id, p.name);
  }

  return buildDigest(
    userId,
    rows as DigestItem[],
    { since: since.toISOString(), until: until.toISOString() },
    names,
  );
}

export async function runDigestForCompany(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ digests: number; items: number; skipped: number }> {
  const prefs = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, companyId),
        sql`${notificationPreferences.digest} <> 'off'`,
      ),
    );
  let digests = 0;
  let items = 0;
  let skipped = 0;
  for (const pref of prefs) {
    if (!nextDigestDue(pref.digest, pref.lastDigestAt, now)) {
      skipped += 1;
      continue;
    }
    const windowMs = pref.digest === "weekly" ? 7 * 86_400_000 : 86_400_000;
    const since = pref.lastDigestAt
      ? new Date(Math.max(Date.parse(pref.lastDigestAt), now.getTime() - 30 * 86_400_000))
      : new Date(now.getTime() - windowMs);
    const summary = await composeDigest(db, companyId, pref.userId, since, now);
    // Stamp regardless of whether there was anything: an empty digest still
    // resets the clock, so a quiet week does not produce a month-long window.
    await db
      .update(notificationPreferences)
      .set({ lastDigestAt: now.toISOString() })
      .where(eq(notificationPreferences.id, pref.id));
    if (summary.total === 0) {
      skipped += 1;
      continue;
    }
    digests += 1;
    items += summary.total;
    await db.insert(notifications).values({
      id: newId("ntf"),
      companyId,
      userId: pref.userId,
      projectId: null,
      kind: "digest",
      title: summary.subject,
      body: summary.sections
        .map(
          (s) =>
            `${s.projectName ?? "Company"}: ${s.byKind
              .map((k) => `${k.count} ${k.kind.replace(/_/g, " ")}`)
              .join(", ")}`,
        )
        .join(" · ")
        .slice(0, 2000),
      recordType: null,
      recordId: null,
    });
  }
  return { digests, items, skipped };
}

export const NOTIFICATION_DIGEST_JOB = DIGEST_JOB;
