/**
 * Backdating, post-hoc edit and override forensics
 * (spec Vol II Domain A #104-105, Domain S #865-868).
 *
 * THE ATTACK. A record whose operational date is earlier than the moment it
 * was created is either a genuine late entry or an attempt to make something
 * look as though it happened before it did — before a deadline, before a
 * notice period expired, before an inspection failed. The ledger already
 * timestamps creation honestly; what nobody was comparing was the creation
 * time against the date the record CLAIMS.
 *
 * The second half is override forensics: `update` and `delete` actions against
 * high-value object types, performed by actors who are not the independent
 * reviewers, are exactly the events an evidentiary record has to surface
 * rather than merely store.
 *
 * PURE: rows in, drafts out, `now` never read from the clock.
 */
import type { SignalSeverity } from "@constructos/shared";
import { fingerprintOf, sortedIds, type SignalDraft } from "./detectors.js";

export interface DatedRecord {
  objectType: string;
  objectId: string;
  /** the date the record CLAIMS (assertedAt / occurredAt / capturedAt) */
  statedAt: string | null;
  /** when the row was actually written */
  createdAt: string;
  /** who wrote it */
  actorId: string | null;
  label: string;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const DAY_MS = 86_400_000;

/**
 * Records antedated by more than `windowHours`.
 *
 * The window matters: an inspection written up the same evening is normal
 * practice, and flagging it would bury the case that matters. The default of
 * 72 hours is the point past which "we wrote it up later" stops explaining
 * itself.
 */
export function backdatedRecords(
  rows: DatedRecord[],
  opts: { windowHours?: number } = {},
): SignalDraft[] {
  const windowMs = (opts.windowHours ?? 72) * 3_600_000;
  const byActor = new Map<string, Array<{ row: DatedRecord; lagDays: number }>>();
  for (const row of rows) {
    const stated = ms(row.statedAt);
    const created = ms(row.createdAt);
    if (stated === null || created === null) continue;
    const lag = created - stated;
    if (lag <= windowMs) continue;
    const key = row.actorId ?? "system";
    const list = byActor.get(key) ?? [];
    list.push({ row, lagDays: lag / DAY_MS });
    byActor.set(key, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [actorId, list] of byActor) {
    const worst = [...list].sort((a, b) => b.lagDays - a.lagDays);
    const maxLag = worst[0]!.lagDays;
    const severity: SignalSeverity = maxLag >= 30 ? "high" : list.length >= 3 ? "medium" : "low";
    const ids = list.map((x) => `${x.row.objectType}:${x.row.objectId}`);
    drafts.push({
      detector: "backdated_record",
      severity,
      confidence: Math.min(0.85, 0.4 + list.length * 0.1),
      title: `${list.length} record${list.length === 1 ? "" : "s"} dated before ${actorId === "system" ? "the system" : actorId} created them`,
      explanation:
        `${list.length} record(s) carry an operational date earlier than the moment they were ` +
        `written, by up to ${maxLag.toFixed(1)} days ` +
        `(worst: ${worst[0]!.row.label}, stated ${worst[0]!.row.statedAt}, created ` +
        `${worst[0]!.row.createdAt}). Entries written up shortly after the event are normal; a ` +
        "record antedated by weeks is how a missed deadline, a late notice or an inspection that " +
        "never happened is made to look timely (Domain A #104). The ledger's own creation " +
        "timestamp is the fact here — the stated date is a claim.",
      evidenceRefs: {
        actorId,
        count: list.length,
        maxLagDays: maxLag,
        records: worst.slice(0, 20).map((x) => ({
          objectType: x.row.objectType,
          objectId: x.row.objectId,
          statedAt: x.row.statedAt,
          createdAt: x.row.createdAt,
          lagDays: Number(x.lagDays.toFixed(2)),
        })),
      },
      fingerprint: fingerprintOf(actorId, sortedIds(ids)),
      subjectType: "user",
      subjectId: actorId,
      links: list.map((x) => ({ objectType: x.row.objectType, objectId: x.row.objectId })),
    });
  }
  return drafts;
}

export interface LedgerActionRow {
  seq: number;
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  at: string;
}

/**
 * Destructive or corrective actions against high-value object types, taken by
 * someone who is not an independent reviewer.
 *
 * This is deliberately not "any update is suspicious" — the platform runs on
 * updates. It is scoped to the object types where a silent rewrite changes
 * what the organisation owes or is owed, and it names the actor rather than
 * accusing them, because the answer is usually "yes, and here is the change
 * request that authorised it".
 */
export function overrideActivity(
  entries: LedgerActionRow[],
  opts: {
    highValueTypes: string[];
    /** actors whose corrections are expected (assurance roles, system) */
    exemptActorIds?: string[];
    minCount?: number;
  },
): SignalDraft[] {
  const high = new Set(opts.highValueTypes);
  const exempt = new Set(opts.exemptActorIds ?? []);
  const minCount = opts.minCount ?? 3;
  const byActor = new Map<string, LedgerActionRow[]>();
  for (const e of entries) {
    if (e.action !== "update" && e.action !== "delete") continue;
    if (!high.has(e.objectType)) continue;
    const actor = e.actorId ?? "system";
    if (exempt.has(actor)) continue;
    const list = byActor.get(actor) ?? [];
    list.push(e);
    byActor.set(actor, list);
  }
  const drafts: SignalDraft[] = [];
  for (const [actorId, list] of byActor) {
    const deletes = list.filter((e) => e.action === "delete");
    if (list.length < minCount && deletes.length === 0) continue;
    const severity: SignalSeverity = deletes.length > 0 ? "high" : "medium";
    drafts.push({
      detector: "administrative_override",
      severity,
      confidence: deletes.length > 0 ? 0.75 : 0.5,
      title:
        deletes.length > 0
          ? `${actorId} deleted ${deletes.length} high-value record${deletes.length === 1 ? "" : "s"}`
          : `${actorId} edited ${list.length} high-value records`,
      explanation:
        `${list.length} ledger entr${list.length === 1 ? "y" : "ies"} record ` +
        `${list.length - deletes.length} update(s) and ${deletes.length} delete(s) against ` +
        `${[...new Set(list.map((e) => e.objectType))].join(", ")} by an actor holding no ` +
        "assurance role. Corrections to commercial records are routine and are not themselves a " +
        "finding; what is a finding is a correction nobody outside the operational line reviewed " +
        "(Domain S #865-868). Open the ledger entries and confirm each carries a before/after " +
        "snapshot and an authorising instruction.",
      evidenceRefs: {
        actorId,
        updates: list.length - deletes.length,
        deletes: deletes.length,
        seqs: list.slice(0, 50).map((e) => e.seq),
        objectTypes: [...new Set(list.map((e) => e.objectType))],
      },
      fingerprint: fingerprintOf(actorId, sortedIds(list.map((e) => String(e.seq)))),
      subjectType: "user",
      subjectId: actorId,
      links: list.slice(0, 50).map((e) => ({ objectType: e.objectType, objectId: e.objectId })),
    });
  }
  return drafts;
}

export const BACKDATING_DETECTORS = ["backdated_record", "administrative_override"] as const;
