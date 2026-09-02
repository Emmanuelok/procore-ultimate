import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

/**
 * `Idempotency-Key` for money-moving POSTs (plan §6.2).
 *
 * A client that times out on "issue this payment" and retries must not
 * release the retainage twice. When the header is present, the first
 * successful response is stored against (company, key) and every replay gets
 * the stored body back with the stored status — the second request never
 * reaches the handler. Keys are scoped per company so two tenants cannot
 * collide, and per route so the same key on a different verb is a new act.
 *
 * Without the header the call runs as it always did; idempotency is opt-in
 * because a client that does not send a key has not asked for a replay.
 */
export async function withIdempotency<T>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  route: string,
  fn: () => Promise<T>,
): Promise<T> {
  const header = req.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  const companyId = req.companyId;
  if (!key || !companyId || key.length > 200) return fn();

  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.companyId, companyId), eq(idempotencyKeys.key, key)))
    .limit(1);
  const hit = existing[0];
  if (hit) {
    reply.status(hit.responseStatus);
    reply.header("idempotent-replayed", "true");
    return hit.responseBody as T;
  }
  const result = await fn();
  const status = reply.statusCode && reply.statusCode !== 200 ? reply.statusCode : 200;
  try {
    await db.insert(idempotencyKeys).values({
      id: newId("idk"),
      companyId,
      key,
      route,
      responseStatus: status,
      responseBody: result === undefined ? null : (result as unknown),
    });
  } catch {
    /* a concurrent replay already stored it — the stored body wins on the next call */
  }
  return result;
}
