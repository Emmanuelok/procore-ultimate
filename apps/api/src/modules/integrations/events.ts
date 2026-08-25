import { and, count, eq, max, sql } from "drizzle-orm";
import { ledgerEntries } from "@constructos/db";
import { LEDGER_ACTIONS } from "@constructos/shared";
import type { Db } from "../../lib/db.js";

/**
 * Vol I §0.7 #121 — the catalogue of emittable event kinds.
 *
 * There is no hand-maintained list here on purpose. A curated taxonomy drifts
 * away from the platform the first time a module ships a new object type and
 * nobody remembers to add it, and the drift is silent: subscribers keep asking
 * for events that exist and being told they do not. So the catalogue is DERIVED
 * — the distinct (objectType, action) pairs the tenant's own ledger has
 * actually recorded, with counts and last-seen times, unioned with the fixed
 * LEDGER_ACTIONS vocabulary that any object type can produce.
 *
 * The honest consequence, stated on the response: a tenant that has never
 * created a variation will not see `variation.create` in its catalogue. The
 * catalogue describes what THIS tenant's record has emitted, not the union of
 * everything the platform could ever emit. Subscribing to a kind that has not
 * been seen yet is allowed — the subscription simply waits.
 */

/** The wire form of an event kind. */
export function eventKind(objectType: string, action: string): string {
  return `${objectType}.${action}`;
}

/**
 * Does an endpoint's subscription list select this event kind?
 *
 *   []                  → every kind (the default; an empty list is not "none")
 *   "*"                 → every kind
 *   "rfi.*"             → every action on that object type
 *   "*.create"          → that action on every object type
 *   "rfi.create"        → exactly that kind
 */
export function matchesEventKind(subscriptions: string[], kind: string): boolean {
  if (subscriptions.length === 0) return true;
  const [objectType = "", action = ""] = kind.split(".", 2);
  for (const raw of subscriptions) {
    const sub = raw.trim();
    if (sub === "" || sub === "*" || sub === "*.*") return true;
    if (sub === kind) return true;
    if (sub.endsWith(".*") && sub.slice(0, -2) === objectType) return true;
    if (sub.startsWith("*.") && sub.slice(2) === action) return true;
  }
  return false;
}

/** A subscription string is well-formed if it is a kind or a supported wildcard. */
const SUBSCRIPTION_RE = /^(\*|(\*|[a-z0-9_]+)\.(\*|[a-z0-9_]+))$/;

export function isValidSubscription(value: string): boolean {
  return SUBSCRIPTION_RE.test(value.trim());
}

export interface EventCatalogueRow {
  eventKind: string;
  objectType: string;
  action: string;
  count: number;
  lastSeenAt: string | null;
}

export interface EventCatalogue {
  /** kinds this tenant's ledger has actually recorded, most recent first */
  events: EventCatalogueRow[];
  /** object types seen, for building `objectType.*` subscriptions */
  objectTypes: string[];
  /** the closed vocabulary of ledger actions */
  actions: readonly string[];
  wildcards: string[];
  derivedFrom: string;
  note: string;
}

/** Build the catalogue from the tenant's own ledger. */
export async function eventCatalogue(db: Db, companyId: string): Promise<EventCatalogue> {
  const rows = await db
    .select({
      objectType: ledgerEntries.objectType,
      action: ledgerEntries.action,
      n: count(),
      lastSeenAt: max(ledgerEntries.at),
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.companyId, companyId))
    .groupBy(ledgerEntries.objectType, ledgerEntries.action)
    .orderBy(sql`max(${ledgerEntries.at}) desc`);

  const events: EventCatalogueRow[] = rows.map((r) => ({
    eventKind: eventKind(r.objectType, r.action),
    objectType: r.objectType,
    action: r.action,
    count: Number(r.n ?? 0),
    lastSeenAt: r.lastSeenAt ?? null,
  }));
  const objectTypes = [...new Set(events.map((e) => e.objectType))].sort();

  return {
    events,
    objectTypes,
    actions: LEDGER_ACTIONS,
    wildcards: ["*", ...objectTypes.map((t) => `${t}.*`), ...LEDGER_ACTIONS.map((a) => `*.${a}`)],
    derivedFrom: "ledger_entries",
    note:
      "Derived from this tenant's hash-chained ledger rather than a curated list, so it cannot " +
      "drift from what the platform actually emits. It therefore shows only the kinds this " +
      "tenant has already produced: an object type nobody here has created yet is absent. " +
      "Subscribing to an absent kind is allowed — the subscription simply waits for the first " +
      "one. Event kinds are `objectType.action`; `*`, `objectType.*` and `*.action` are accepted " +
      "in an endpoint's eventKinds, and an empty eventKinds list means every kind.",
  };
}

/** Count of ledger entries for a company — used by tests and the catalogue. */
export async function ledgerEntryCount(db: Db, companyId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.companyId, companyId)));
  return Number(row?.n ?? 0);
}
