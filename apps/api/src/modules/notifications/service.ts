/**
 * The one place a notification is written.
 *
 * Every module calls `pushNotifications`. That makes this the only place a
 * recipient's preferences can be honoured without asking forty modules to
 * remember to — so the policy (policy.ts) is applied here, and a module that
 * knows nothing about preferences still respects them.
 *
 * Covers Vol I §0.5 #70 (watchers actually hear about the records they
 * follow), #93–#97 (preferences, muting, digest).
 */
import { and, eq, inArray } from "drizzle-orm";
import { notificationPreferences, notifications, watchers } from "@constructos/db";
import type { NotificationKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { decideDelivery, type PreferenceRow } from "./policy.js";

export interface NotifyTarget {
  companyId: string;
  userId: string;
  projectId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  recordType?: string | null;
  recordId?: string | null;
  /** the tool this belongs to, so per-tool muting can apply */
  tool?: string | null;
}

async function loadPreferences(
  db: Db,
  companyId: string,
  userIds: string[],
): Promise<Map<string, PreferenceRow>> {
  const map = new Map<string, PreferenceRow>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, companyId),
        inArray(notificationPreferences.userId, userIds),
      ),
    );
  for (const row of rows) {
    map.set(row.userId, {
      userId: row.userId,
      defaultChannel: row.defaultChannel,
      digest: row.digest,
      kinds: row.kinds ?? {},
      mutedProjectIds: row.mutedProjectIds ?? [],
      mutedTools: row.mutedTools ?? [],
    });
  }
  return map;
}

/**
 * Insert in-app notifications, honouring each recipient's preferences.
 *
 * Deduplicates identical (user, kind, record, title) tuples within one call
 * so an "assignee + distribution list" fan-out never double-notifies the same
 * person. Returns what happened, so a caller that cares (the digest job, a
 * test) can see how many were suppressed and why.
 */
export async function pushNotifications(
  db: Db,
  targets: NotifyTarget[],
): Promise<{ inserted: number; suppressed: number; reasons: Record<string, number> }> {
  const seen = new Set<string>();
  const deduped: NotifyTarget[] = [];
  for (const t of targets) {
    if (!t.userId) continue;
    const key = [t.companyId, t.userId, t.kind, t.recordType ?? "", t.recordId ?? "", t.title].join(
      "|",
    );
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  if (deduped.length === 0) return { inserted: 0, suppressed: 0, reasons: {} };

  // Preferences are per (company, user); a fan-out is usually one company.
  const byCompany = new Map<string, NotifyTarget[]>();
  for (const t of deduped) {
    const list = byCompany.get(t.companyId) ?? [];
    list.push(t);
    byCompany.set(t.companyId, list);
  }

  const rows: Array<typeof notifications.$inferInsert> = [];
  const reasons: Record<string, number> = {};
  let suppressed = 0;

  for (const [companyId, list] of byCompany) {
    const prefs = await loadPreferences(db, companyId, [...new Set(list.map((t) => t.userId))]);
    for (const t of list) {
      const decision = decideDelivery(
        { userId: t.userId, projectId: t.projectId ?? null, kind: t.kind, tool: t.tool ?? null },
        prefs.get(t.userId),
      );
      if (!decision.deliver) {
        suppressed += 1;
        reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
        continue;
      }
      rows.push({
        id: newId("ntf"),
        companyId: t.companyId,
        userId: t.userId,
        projectId: t.projectId ?? null,
        kind: t.kind,
        title: t.title,
        body: t.body ?? null,
        recordType: t.recordType ?? null,
        recordId: t.recordId ?? null,
      });
    }
  }

  if (rows.length > 0) await db.insert(notifications).values(rows);
  return { inserted: rows.length, suppressed, reasons };
}

/**
 * Tell a record's watchers that something happened to it (#70).
 *
 * Watching used to be a dead toggle: rows were written and nothing on the
 * platform ever read them. This is the reader. The actor is excluded — being
 * told about your own action is noise — and the watcher list is scoped to the
 * tenant, because `watchers` is addressed by (recordType, recordId) and those
 * ids are not tenant-unique.
 */
export async function notifyWatchers(
  db: Db,
  args: {
    companyId: string;
    projectId: string | null;
    recordType: string;
    recordId: string;
    actorId: string | null;
    kind: NotificationKind;
    title: string;
    body?: string | null;
    tool?: string | null;
  },
): Promise<number> {
  const rows = await db
    .select({ userId: watchers.userId })
    .from(watchers)
    .where(
      and(
        eq(watchers.companyId, args.companyId),
        eq(watchers.recordType, args.recordType),
        eq(watchers.recordId, args.recordId),
      ),
    );
  const recipients = rows.map((r) => r.userId).filter((id) => id !== args.actorId);
  if (recipients.length === 0) return 0;
  const result = await pushNotifications(
    db,
    recipients.map((userId) => ({
      companyId: args.companyId,
      userId,
      projectId: args.projectId,
      kind: args.kind,
      title: args.title,
      body: args.body ?? null,
      recordType: args.recordType,
      recordId: args.recordId,
      tool: args.tool ?? null,
    })),
  );
  return result.inserted;
}
