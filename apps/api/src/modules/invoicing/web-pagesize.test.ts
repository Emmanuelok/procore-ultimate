/**
 * A CONTRACT TEST BETWEEN THE WEB PAGES AND THE PAGINATION SCHEMA.
 *
 * The single most damaging defect the audit found in this area was not a
 * money bug: it was four workspaces asking for `pageSize=500` against an API
 * that capped it at 200, so every list returned 400 and the Change Management
 * and Invoicing pages rendered an error banner and nothing else. Nothing in
 * the type system connects a hard-coded query string in a React file to a zod
 * schema in the API, so this test does: it reads the web sources for the four
 * WP-FIN2 workspaces and asserts that no hard-coded `pageSize=` exceeds what
 * `pageQuerySchema` will actually accept.
 *
 * It deliberately parses the cap out of the schema rather than restating it,
 * so lowering the cap fails here instead of in production.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pageQuerySchema } from "../../lib/pagination.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webPages = path.resolve(here, "../../../../../apps/web/src/pages");
const WORKSPACES = ["commitments", "changes", "invoicing", "payments"] as const;

/** The largest pageSize the API will accept, found by bisection on the schema. */
function apiPageSizeCap(): number {
  let lo = 1;
  let hi = 100_000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pageQuerySchema.safeParse({ page: 1, pageSize: mid }).success) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("web pages never ask for a page bigger than the API allows", () => {
  const cap = apiPageSizeCap();

  it("finds the cap on the shared pagination schema", () => {
    expect(cap).toBeGreaterThanOrEqual(200);
    expect(pageQuerySchema.safeParse({ page: 1, pageSize: cap + 1 }).success).toBe(false);
  });

  for (const workspace of WORKSPACES) {
    it(`pages/${workspace} requests nothing above ${cap}`, () => {
      const dir = path.join(webPages, workspace);
      const offenders: string[] = [];
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/pageSize=(\d+)/g)) {
          const requested = Number(match[1]);
          if (requested > cap) offenders.push(`${path.basename(file)}: pageSize=${requested}`);
        }
        /* the paging helper's default page size counts too */
        for (const match of text.matchAll(/pageSize\s*=\s*(\d+)\b/g)) {
          const requested = Number(match[1]);
          if (requested > cap)
            offenders.push(`${path.basename(file)}: default pageSize ${requested}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
