/**
 * Unit tests for the company-level visibility helpers.
 *
 * These are the pure half of `scope.ts` — the predicate builders and the
 * membership check. The gate itself (`companyToolGate`) is exercised through
 * the modules' integration tests, where a real permission template and a real
 * assurance grant exist to resolve against.
 *
 * The property under test throughout: an EMPTY scope must produce a predicate
 * that matches nothing, never "no filter". A helper that returns `undefined`
 * for "you may see nothing" turns a permission check into a full table scan
 * of another tenant's data, which is the exact bug this file exists to close.
 */
import { describe, expect, it } from "vitest";
import { insurancePolicies, meetingActionItems } from "@constructos/db";
import {
  companyScopeOf,
  scopeAllows,
  scopeProjects,
  scopeProjectsOrCompanyWide,
  type CompanyScope,
} from "./scope.js";

const scope = (over: Partial<CompanyScope> = {}): CompanyScope => ({
  all: false,
  projectIds: [],
  tool: "meetings",
  ...over,
});

/**
 * Flatten a drizzle predicate to the literal text and bound values it carries.
 *
 * Drizzle's SQL objects hold Column references whose `table` points back at
 * the column, so JSON.stringify cycles. This walks the tree with a seen-set
 * and keeps only the strings that matter: SQL fragments, column names, and
 * the bound parameter values.
 */
function sqlOf(predicate: unknown): string {
  if (predicate === undefined) return "<undefined>";
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > 8) return;
    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      out.push(String(node));
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ["queryChunks", "value", "name", "chunks"]) {
      if (key in record) walk(record[key], depth + 1);
    }
  };
  walk(predicate, 0);
  return out.join(" ");
}

describe("scopeProjects (NOT NULL project column)", () => {
  it("applies no restriction for an unrestricted scope", () => {
    expect(scopeProjects(scope({ all: true }), meetingActionItems.projectId)).toBeUndefined();
  });

  it("restricts to the held projects", () => {
    const out = scopeProjects(scope({ projectIds: ["prj_a", "prj_b"] }), meetingActionItems.projectId);
    expect(out).toBeDefined();
    expect(sqlOf(out)).toContain("prj_a");
    expect(sqlOf(out)).toContain("prj_b");
  });

  it("returns an IMPOSSIBLE predicate for an empty scope, never 'no filter'", () => {
    const out = scopeProjects(scope(), meetingActionItems.projectId);
    expect(out).toBeDefined();
    expect(sqlOf(out)).toContain("__none__");
  });
});

describe("scopeProjectsOrCompanyWide (nullable project column)", () => {
  it("applies no restriction for an unrestricted scope", () => {
    expect(
      scopeProjectsOrCompanyWide(scope({ all: true }), insurancePolicies.projectId),
    ).toBeUndefined();
  });

  it("keeps company-level rows visible alongside the held projects", () => {
    const out = scopeProjectsOrCompanyWide(
      scope({ projectIds: ["prj_a"] }),
      insurancePolicies.projectId,
    );
    expect(out).toBeDefined();
    const sql = sqlOf(out);
    expect(sql).toContain("prj_a");
    expect(sql.toLowerCase()).toContain("null");
  });

  it("shows ONLY the company-level rows to a caller who holds no project", () => {
    const out = scopeProjectsOrCompanyWide(scope(), insurancePolicies.projectId);
    expect(out).toBeDefined();
    /*
     * A tenant asset — an OCIP master policy, a published lesson — stays
     * readable by anyone who holds the tool somewhere. Hiding it would make
     * the register unusable for a broker who holds insurance on one job, and
     * it is not project data.
     */
    expect(sqlOf(out).toLowerCase()).toContain("null");
    expect(sqlOf(out)).not.toContain("__none__");
  });
});

describe("scopeAllows", () => {
  it("admits everything for an unrestricted scope", () => {
    expect(scopeAllows(scope({ all: true }), "prj_anything")).toBe(true);
  });

  it("admits a company-level record (null project) to any holder of the tool", () => {
    expect(scopeAllows(scope(), null)).toBe(true);
  });

  it("admits only the held projects", () => {
    const s = scope({ projectIds: ["prj_a"] });
    expect(scopeAllows(s, "prj_a")).toBe(true);
    expect(scopeAllows(s, "prj_b")).toBe(false);
  });

  it("refuses every project for an empty scope", () => {
    expect(scopeAllows(scope(), "prj_a")).toBe(false);
  });
});

describe("companyScopeOf", () => {
  it("fails CLOSED when a handler forgot its gate", () => {
    const out = companyScopeOf({} as never, "meetings");
    expect(out.all).toBe(false);
    expect(out.projectIds).toEqual([]);
    /* "Nothing visible", not "everything": a route that lost its preHandler
       must return an empty register, not the whole tenant. */
    expect(scopeAllows(out, "prj_a")).toBe(false);
    expect(sqlOf(scopeProjects(out, meetingActionItems.projectId))).toContain("__none__");
  });

  it("reads back the scope a gate stashed, per tool", () => {
    const req = {
      wpMeetScope: {
        meetings: { all: false, projectIds: ["prj_a"], tool: "meetings" },
        insurance: { all: true, projectIds: [], tool: "insurance" },
      },
    } as never;
    expect(companyScopeOf(req, "meetings").projectIds).toEqual(["prj_a"]);
    expect(companyScopeOf(req, "insurance").all).toBe(true);
    /* A tool the gate never resolved still fails closed. */
    expect(companyScopeOf(req, "learning").all).toBe(false);
  });
});
