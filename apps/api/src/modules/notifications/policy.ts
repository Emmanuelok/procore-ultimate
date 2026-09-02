/**
 * Notification policy (Vol I §0.5 #93–#97).
 *
 * Every module on the platform calls `pushNotifications`. Before this file
 * that call was unconditional: a person on twelve projects received every
 * status change on all of them, and the only control offered was to stop
 * looking. Preferences and muting turn that into a policy the recipient
 * controls, applied in ONE place so no module can bypass it.
 *
 * The rules, in order:
 *   1. a muted project silences everything from it (except escalations,
 *      which are the point of an escalation);
 *   2. a kind set to `none` is not delivered;
 *   3. `in_app` writes the row immediately;
 *   4. `email` also writes the row — the centre is the record of what was
 *      sent, and the email is a copy of it;
 *   5. a digest cadence holds ordinary kinds back from the unread count
 *      until the digest goes out; urgent kinds are never digested.
 *
 * Pure, so every branch is testable without a database.
 */
import type { NotificationKind } from "@constructos/shared";

export interface PreferenceRow {
  userId: string;
  defaultChannel: string;
  digest: string;
  kinds: Record<string, string>;
  mutedProjectIds: string[];
  mutedTools: string[];
}

/**
 * Kinds a person cannot mute themselves out of.
 *
 * An escalation exists because a deadline was missed; a signal is the
 * assurance layer telling someone their record is disputed. Both would be
 * worthless if a preference could silence them, so preferences narrow their
 * CHANNEL but never suppress them.
 */
export const UNSUPPRESSABLE_KINDS: ReadonlySet<string> = new Set<NotificationKind>([
  "escalation",
  "signal",
  "ai_review",
]);

/** Kinds that are always delivered immediately, never rolled into a digest. */
export const NEVER_DIGESTED: ReadonlySet<string> = new Set<NotificationKind>([
  "escalation",
  "signal",
  "overdue",
  "ai_review",
  "workflow_step",
  "mention",
]);

export interface DeliveryTarget {
  userId: string;
  projectId?: string | null;
  kind: string;
  /** the tool the notification belongs to, when the caller knows it */
  tool?: string | null;
}

export type DeliveryDecision =
  | { deliver: true; channel: "in_app" | "email"; digested: boolean }
  | { deliver: false; reason: "muted_project" | "muted_tool" | "kind_disabled" };

const DEFAULT_PREFERENCE: Omit<PreferenceRow, "userId"> = {
  defaultChannel: "in_app",
  digest: "off",
  kinds: {},
  mutedProjectIds: [],
  mutedTools: [],
};

/** Decide what happens to one notification for one recipient. */
export function decideDelivery(
  target: DeliveryTarget,
  preference: PreferenceRow | undefined,
): DeliveryDecision {
  const pref = preference ?? { userId: target.userId, ...DEFAULT_PREFERENCE };
  const unsuppressable = UNSUPPRESSABLE_KINDS.has(target.kind);

  if (!unsuppressable) {
    if (target.projectId && pref.mutedProjectIds.includes(target.projectId)) {
      return { deliver: false, reason: "muted_project" };
    }
    if (target.tool && pref.mutedTools.includes(target.tool)) {
      return { deliver: false, reason: "muted_tool" };
    }
  }

  const configured = pref.kinds[target.kind] ?? pref.defaultChannel;
  if (configured === "none") {
    if (!unsuppressable) return { deliver: false, reason: "kind_disabled" };
    // Unsuppressable: fall back to in-app rather than dropping it.
    return { deliver: true, channel: "in_app", digested: false };
  }

  const channel = configured === "email" ? "email" : "in_app";
  const digested = pref.digest !== "off" && !NEVER_DIGESTED.has(target.kind);
  return { deliver: true, channel, digested };
}

/* ------------------------------------------------------------------ */
/* Digest assembly (#96)                                               */
/* ------------------------------------------------------------------ */

export interface DigestItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  projectId: string | null;
  createdAt: string;
}

export interface DigestSection {
  projectId: string | null;
  projectName: string | null;
  byKind: Array<{ kind: string; count: number; items: DigestItem[] }>;
  total: number;
}

export interface DigestSummary {
  userId: string;
  since: string;
  until: string;
  total: number;
  sections: DigestSection[];
  /** a one-line subject a mail transport can use */
  subject: string;
}

/**
 * Group a window of notifications into a digest: by project first (that is
 * how people think about their day), then by kind, newest first inside each.
 * Items with no project fall into one "Company" section, which sorts last.
 */
export function buildDigest(
  userId: string,
  items: DigestItem[],
  window: { since: string; until: string },
  projectNames: Map<string, string> = new Map(),
  maxPerKind = 5,
): DigestSummary {
  const byProject = new Map<string | null, DigestItem[]>();
  for (const item of items) {
    const key = item.projectId ?? null;
    const list = byProject.get(key) ?? [];
    list.push(item);
    byProject.set(key, list);
  }

  const sections: DigestSection[] = [];
  for (const [projectId, list] of byProject) {
    const byKind = new Map<string, DigestItem[]>();
    for (const item of list) {
      const bucket = byKind.get(item.kind) ?? [];
      bucket.push(item);
      byKind.set(item.kind, bucket);
    }
    sections.push({
      projectId,
      projectName: projectId ? (projectNames.get(projectId) ?? null) : null,
      total: list.length,
      byKind: [...byKind.entries()]
        .map(([kind, kindItems]) => ({
          kind,
          count: kindItems.length,
          items: [...kindItems]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, maxPerKind),
        }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    });
  }

  sections.sort((a, b) => {
    if (a.projectId === null) return 1;
    if (b.projectId === null) return -1;
    return b.total - a.total || (a.projectName ?? "").localeCompare(b.projectName ?? "");
  });

  const total = items.length;
  const subject =
    total === 0
      ? "Nothing new on ConstructOS"
      : `${total} update${total === 1 ? "" : "s"} across ${sections.length} area${
          sections.length === 1 ? "" : "s"
        }`;

  return { userId, since: window.since, until: window.until, total, sections, subject };
}

/** When the next digest for a cadence is due, given the last one. */
export function nextDigestDue(cadence: string, lastAt: string | null, now: Date): boolean {
  if (cadence === "off") return false;
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  if (Number.isNaN(last)) return true;
  const elapsed = now.getTime() - last;
  return cadence === "weekly" ? elapsed >= 7 * 86_400_000 : elapsed >= 86_400_000;
}
