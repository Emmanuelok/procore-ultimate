import { notifications } from "@constructos/db";
import type { NotificationKind } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";

export interface NotifyTarget {
  companyId: string;
  userId: string;
  projectId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  recordType?: string | null;
  recordId?: string | null;
}

/**
 * Insert in-app notifications. Deduplicates identical (user, kind, record,
 * title) tuples within one call so "assignee + distribution" fan-outs never
 * double-notify the same person.
 */
export async function pushNotifications(db: Db, targets: NotifyTarget[]): Promise<void> {
  const seen = new Set<string>();
  const rows = [];
  for (const t of targets) {
    if (!t.userId) continue;
    const key = [t.userId, t.kind, t.recordType ?? "", t.recordId ?? "", t.title].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
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
  if (rows.length > 0) await db.insert(notifications).values(rows);
}
