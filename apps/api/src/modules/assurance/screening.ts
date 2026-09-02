/**
 * Entity screening against sanctions, debarment and PEP lists
 * (spec Vol II Domain A #10, #42-52).
 *
 * WHAT THIS DEPLOYMENT ACTUALLY HAS, stated plainly because a screening engine
 * that overstates itself is worse than none: there is NO live connection to
 * OFAC, the UN consolidated list, the EU or UK lists, the World Bank debarment
 * register or any PEP provider. This module ships a small, code-resident
 * FIXTURE for each of those lists, clearly labelled as such, and a provider
 * interface (`ScreeningProvider`) that a real feed drops into without changing
 * a single caller.
 *
 * Every result therefore carries `listSource` and `listSnapshotHash`. "We
 * screened and found nothing" is only meaningful against a stated version of a
 * stated list; a screening record that cannot name what it was screened
 * against is decoration.
 *
 * MATCHING is deliberately conservative and explainable: normalise (case,
 * punctuation, corporate suffixes), then score on exact match, containment and
 * token overlap. No phonetics, no ML, no black box — a reviewer has to be able
 * to see why a name matched, because they are the one who has to defend the
 * consequence of the match.
 *
 * PURE: lists in, results out.
 */
import { createHash } from "node:crypto";
import type { ScreeningList } from "@constructos/shared";

export interface ScreeningListEntry {
  /** the list's own reference for this record */
  ref: string;
  name: string;
  aliases?: string[];
  country?: string;
  programme?: string;
}

export interface ScreeningSnapshot {
  list: ScreeningList;
  /** where these rows came from, in words an auditor can act on */
  source: string;
  /** sha256 over the canonical rows — reproducibility of a negative result */
  snapshotHash: string;
  entries: ScreeningListEntry[];
  /** true when these are the shipped fixtures rather than a real feed */
  fixture: boolean;
}

export interface ScreeningProvider {
  list: ScreeningList;
  load(): Promise<ScreeningSnapshot> | ScreeningSnapshot;
}

/* ------------------------------------------------------------------ */
/* Name normalisation and matching                                     */
/* ------------------------------------------------------------------ */

const CORPORATE_SUFFIXES = new Set([
  "ltd",
  "limited",
  "llc",
  "llp",
  "plc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "gmbh",
  "bv",
  "nv",
  "sa",
  "sarl",
  "srl",
  "spa",
  "ag",
  "pty",
  "pte",
  "co",
  "company",
  "holdings",
  "group",
  "sdn",
  "bhd",
]);

export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameTokens(value: string): string[] {
  return normaliseName(value)
    .split(" ")
    .filter((t) => t.length > 1 && !CORPORATE_SUFFIXES.has(t));
}

/**
 * 0..1 similarity between two names. 1 = identical after normalisation;
 * containment of one significant token set inside the other scores high; token
 * overlap (Jaccard) carries the rest. Below 0.6 is not reported at all.
 */
export function nameMatchScore(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  if (shared === 0) return 0;
  const jaccard = shared / (sa.size + sb.size - shared);
  const containment = shared / Math.min(sa.size, sb.size);
  // Containment dominates: "Kestrel Labour" inside "Kestrel Labour Supply
  // Limited" is a match a reviewer must see, even though Jaccard is modest.
  return Math.min(0.99, 0.35 * jaccard + 0.65 * containment);
}

/* ------------------------------------------------------------------ */
/* Shipped fixtures                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fabricated rows. They exist so the pipeline — screen, store, review,
 * re-screen on schedule — is exercised end to end and so the retrospective
 * harness can plant a screening hit. They are NOT real designations, and no
 * real person or company appears in them.
 */
const FIXTURE_ENTRIES: Record<ScreeningList, ScreeningListEntry[]> = {
  ofac_sdn: [
    { ref: "FIXTURE-OFAC-1", name: "Northwind Trading Cooperative", country: "XX", programme: "FIXTURE" },
    { ref: "FIXTURE-OFAC-2", name: "Sable Maritime Holdings", country: "XX", programme: "FIXTURE" },
  ],
  un_consolidated: [
    { ref: "FIXTURE-UN-1", name: "Grey Harbour Logistics", country: "XX", programme: "FIXTURE" },
  ],
  eu_consolidated: [
    { ref: "FIXTURE-EU-1", name: "Vellum Infrastructure Partners", country: "XX", programme: "FIXTURE" },
  ],
  uk_hmt: [
    { ref: "FIXTURE-UK-1", name: "Ironvale Construction Services", country: "XX", programme: "FIXTURE" },
  ],
  world_bank_debarred: [
    {
      ref: "FIXTURE-WB-1",
      name: "Meridian Civil Works",
      aliases: ["Meridian Civils"],
      country: "XX",
      programme: "FIXTURE debarment",
    },
  ],
  pep: [
    {
      ref: "FIXTURE-PEP-1",
      name: "Adaeze Okonkwo-Fixture",
      country: "XX",
      programme: "FIXTURE politically exposed person",
    },
  ],
};

export function snapshotHashOf(entries: ScreeningListEntry[]): string {
  const canonical = entries
    .map((e) => `${e.ref}|${normaliseName(e.name)}|${(e.aliases ?? []).map(normaliseName).sort().join("~")}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function fixtureSnapshot(list: ScreeningList): ScreeningSnapshot {
  const entries = FIXTURE_ENTRIES[list];
  return {
    list,
    source:
      `SHIPPED FIXTURE (${list}) — this deployment has no live ${list} feed configured. ` +
      "These rows are fabricated and name no real designated party. A negative result against " +
      "this snapshot means only that the name did not match the fixture.",
    snapshotHash: snapshotHashOf(entries),
    entries,
    fixture: true,
  };
}

/** Every list this deployment can screen against right now. */
export function defaultProviders(): ScreeningProvider[] {
  return (Object.keys(FIXTURE_ENTRIES) as ScreeningList[]).map((list) => ({
    list,
    load: () => fixtureSnapshot(list),
  }));
}

/* ------------------------------------------------------------------ */
/* Screening one entity                                                */
/* ------------------------------------------------------------------ */

export interface ScreeningMatch {
  list: ScreeningList;
  listSource: string;
  listSnapshotHash: string;
  fixture: boolean;
  matchScore: number;
  matchedName: string;
  matchedRef: string;
  detail: Record<string, unknown>;
}

export interface EntityToScreen {
  id: string;
  name: string;
  kind: string;
  jurisdiction: string | null;
}

export const SCREENING_MATCH_FLOOR = 0.6;

/**
 * Screen one entity against one snapshot. Returns every match at or above the
 * floor, best first — never just the best one, because a reviewer disposing of
 * a match needs to see the others they are implicitly disposing of too.
 */
export function screenAgainst(
  entity: EntityToScreen,
  snapshot: ScreeningSnapshot,
  floor = SCREENING_MATCH_FLOOR,
): ScreeningMatch[] {
  const matches: ScreeningMatch[] = [];
  for (const entry of snapshot.entries) {
    const candidates = [entry.name, ...(entry.aliases ?? [])];
    let best = 0;
    let bestName = entry.name;
    for (const c of candidates) {
      const score = nameMatchScore(entity.name, c);
      if (score > best) {
        best = score;
        bestName = c;
      }
    }
    if (best < floor) continue;
    matches.push({
      list: snapshot.list,
      listSource: snapshot.source,
      listSnapshotHash: snapshot.snapshotHash,
      fixture: snapshot.fixture,
      matchScore: Number(best.toFixed(4)),
      matchedName: bestName,
      matchedRef: entry.ref,
      detail: {
        entityName: entity.name,
        normalisedEntity: normaliseName(entity.name),
        normalisedMatch: normaliseName(bestName),
        sharedTokens: nameTokens(entity.name).filter((t) => nameTokens(bestName).includes(t)),
        programme: entry.programme ?? null,
        listCountry: entry.country ?? null,
        entityJurisdiction: entity.jurisdiction,
      },
    });
  }
  return matches.sort((a, b) => b.matchScore - a.matchScore);
}

/** The screening status an entity should carry given its matches. */
export function statusFromMatches(matches: ScreeningMatch[]): string {
  if (matches.length === 0) return "clear";
  const lists = new Set(matches.map((m) => m.list));
  if (lists.has("world_bank_debarred")) return "debarred";
  if (lists.has("ofac_sdn") || lists.has("un_consolidated") || lists.has("eu_consolidated") || lists.has("uk_hmt")) {
    return "sanctions_hit";
  }
  return "pep";
}
