import type { FastifyPluginAsync } from "fastify";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "@constructos/db";
import { notFound } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";

const listQuerySchema = pageQuerySchema.extend({
  unread: z.enum(["true", "false"]).optional(),
});

/** In-app notification centre (spec Vol I §0.5). */
export const notificationsModule: FastifyPluginAsync = async (app) => {
  const gate = [app.authenticate, app.requireCompany];

  app.get("/notifications", { preHandler: gate }, async (req) => {
    const q = listQuerySchema.parse(req.query);
    const where =
      q.unread === "true"
        ? and(
            eq(notifications.companyId, req.companyId!),
            eq(notifications.userId, req.user!.id),
            isNull(notifications.readAt),
          )
        : and(
            eq(notifications.companyId, req.companyId!),
            eq(notifications.userId, req.user!.id),
          );
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
    return { count: Number(row?.n ?? 0) };
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

  app.post("/notifications/read-all", { preHandler: gate }, async (req) => {
    const now = new Date().toISOString();
    const updated = await app.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.companyId, req.companyId!),
          eq(notifications.userId, req.user!.id),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return { updated: updated.length, readAt: now };
  });
};
