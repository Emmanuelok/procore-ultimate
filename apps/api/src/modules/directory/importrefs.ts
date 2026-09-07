/**
 * Cross-references a directory CSV import against the directory itself.
 *
 * The column spec (modules/projects/import.ts) can say a `vendor_name` cell is
 * present and non-empty; only the database can say whether it names a vendor
 * that exists. Without this pass a 500-row contact file whose employer column
 * says "Acme Ltd." where the directory holds "Acme Limited" previews with zero
 * findings and imports 500 contacts with no employer at all — the dry run,
 * whose whole purpose is to be the last honest moment before a write, said
 * nothing.
 *
 * Deliberately not done here: fuzzy matching. Guessing which vendor the
 * spreadsheet meant is how a contact ends up attached to the wrong company;
 * the finding names the unmatched value and the person fixes the file or the
 * directory.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { vendors } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import type { ImportRowError } from "../projects/import.js";

/** Every distinct, normalised `vendor_name` the file refers to. */
export function referencedVendorNames(rows: Array<Record<string, string>>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const name = (row["vendor_name"] ?? "").trim().toLowerCase();
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Resolve those names to vendor ids.
 *
 * Bounded by the names the file actually mentions (PLAN §6.4): the previous
 * implementation loaded every vendor and every contact of the tenant into
 * memory to build a lookup map.
 */
export async function loadVendorsByName(
  db: Db,
  companyId: string,
  names: string[],
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const rows = await db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(
        and(
          eq(vendors.companyId, companyId),
          isNull(vendors.deletedAt),
          inArray(sql<string>`lower(${vendors.name})`, chunk),
        ),
      );
    for (const row of rows) byName.set(row.name.trim().toLowerCase(), row.id);
  }
  return byName;
}

/**
 * A warning per row whose `vendor_name` matches nothing.
 *
 * A warning, not an error: the contact is still worth importing, and the
 * commit reports the same names again so the outcome is not only visible in
 * the dry run.
 */
export function unresolvedVendorFindings(
  rows: Array<Record<string, string>>,
  byName: Map<string, string>,
): ImportRowError[] {
  const findings: ImportRowError[] = [];
  for (const row of rows) {
    const raw = (row["vendor_name"] ?? "").trim();
    if (!raw) continue;
    if (byName.has(raw.toLowerCase())) continue;
    findings.push({
      row: Number(row["__row"] ?? 0) || 0,
      field: "vendor_name",
      message: `No vendor named "${raw}" in the directory — this contact will be imported with no employer.`,
      severity: "warning",
    });
  }
  return findings;
}

/** The distinct unmatched names, for a commit response or a summary line. */
export function unresolvedVendorNames(
  rows: Array<Record<string, string>>,
  byName: Map<string, string>,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const raw = (row["vendor_name"] ?? "").trim();
    if (raw && !byName.has(raw.toLowerCase())) seen.add(raw);
  }
  return [...seen];
}
