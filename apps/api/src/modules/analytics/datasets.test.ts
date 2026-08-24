import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, rfis, variations } from "@constructos/db";
import { REPORT_DATASETS, REPORT_FILTER_OPERATORS } from "@constructos/shared";
import { buildTestApp } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import type { Db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import {
  DATASETS,
  csvEscape,
  datasetCatalog,
  executeReport,
  operatorsForType,
  resolveReport,
  resultToCsv,
  type ReportSpec,
} from "./datasets.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let db: Db;

/** Two companies, two projects in company A — the scoping fixtures. */
const companyA = newId("cmp");
const companyB = newId("cmp");
const projectA1 = newId("prj");
const projectA2 = newId("prj");
const projectB1 = newId("prj");

const spec = (over: Partial<ReportSpec> = {}): ReportSpec => ({
  dataset: "rfis",
  columns: ["number", "subject", "status"],
  filters: [],
  aggregations: [],
  limitRows: 100,
  ...over,
});

const run = (s: ReportSpec, scope: { companyId: string; projectId?: string | null }) =>
  executeReport(db, resolveReport(s), scope, { pageSize: 100, offset: 0 });

/** Expect a 400 AppError whose message mentions `fragment`. */
function expect400(fn: () => unknown, fragment: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected a rejection").toBeInstanceOf(AppError);
  expect((caught as AppError).statusCode).toBe(400);
  expect((caught as AppError).message).toContain(fragment);
}

beforeAll(async () => {
  built = await buildTestApp();
  db = built.app.db;

  for (const [companyId, id, name] of [
    [companyA, projectA1, "A1"],
    [companyA, projectA2, "A2"],
    [companyB, projectB1, "B1"],
  ] as const) {
    await db.insert(projects).values({ id, companyId, name });
  }

  // Company A / project A1: the operator + aggregation fixture.
  const rows: (typeof rfis.$inferInsert)[] = [
    {
      id: newId("rfi"),
      companyId: companyA,
      projectId: projectA1,
      number: 1,
      subject: "Foundation rebar clash",
      question: "q1",
      status: "open",
      assigneeId: "user-alpha",
      dueDate: "2026-01-10",
      scheduleImpactDays: 5,
      createdBy: "seed",
    },
    {
      id: newId("rfi"),
      companyId: companyA,
      projectId: projectA1,
      number: 2,
      subject: 'Cladding, "specified" finish',
      question: "q2",
      status: "open",
      assigneeId: "user-beta",
      dueDate: "2026-02-20",
      scheduleImpactDays: 10,
      createdBy: "seed",
    },
    {
      id: newId("rfi"),
      companyId: companyA,
      projectId: projectA1,
      number: 3,
      subject: "Drainage invert level",
      question: "q3",
      status: "answered",
      assigneeId: "user-alpha",
      dueDate: "2026-03-30",
      scheduleImpactDays: 20,
      createdBy: "seed",
    },
    {
      id: newId("rfi"),
      companyId: companyA,
      projectId: projectA1,
      number: 4,
      subject: "Roof detail",
      question: "q4",
      status: "closed",
      assigneeId: null,
      dueDate: null,
      scheduleImpactDays: null,
      createdBy: "seed",
    },
  ];
  await db.insert(rfis).values(rows);

  // Same-shaped rows in project A2 (project scoping) and company B (tenancy).
  await db.insert(rfis).values({
    id: newId("rfi"),
    companyId: companyA,
    projectId: projectA2,
    number: 1,
    subject: "Other project RFI",
    question: "q",
    status: "open",
    createdBy: "seed",
  });
  await db.insert(rfis).values({
    id: newId("rfi"),
    companyId: companyB,
    projectId: projectB1,
    number: 1,
    subject: "Foundation rebar clash",
    question: "q",
    status: "open",
    assigneeId: "user-alpha",
    createdBy: "seed",
  });

  // Variations for the numeric-aggregate hand check.
  await db.insert(variations).values([
    {
      id: newId("var"),
      companyId: companyA,
      projectId: projectA1,
      number: 1,
      title: "V1",
      status: "agreed",
      agreedValue: 1000,
      createdBy: "seed",
    },
    {
      id: newId("var"),
      companyId: companyA,
      projectId: projectA1,
      number: 2,
      title: "V2",
      status: "agreed",
      agreedValue: 2500.5,
      createdBy: "seed",
    },
    {
      id: newId("var"),
      companyId: companyA,
      projectId: projectA1,
      number: 3,
      title: "V3",
      status: "proposed",
      agreedValue: null,
      costEstimate: 400,
      createdBy: "seed",
    },
  ]);
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */

describe("registry integrity", () => {
  it("covers every REPORT_DATASETS member exactly once", () => {
    expect(Object.keys(DATASETS).sort()).toEqual([...REPORT_DATASETS].sort());
    expect(REPORT_DATASETS).toHaveLength(12);
    for (const key of REPORT_DATASETS) {
      const ds = DATASETS[key];
      expect(ds.key).toBe(key);
      expect(ds.label.length).toBeGreaterThan(0);
      expect(ds.table).toBeDefined();
      expect(ds.companyColumn).toBeDefined();
      expect(["project", "company"]).toContain(ds.scope);
      if (ds.scope === "project") expect(ds.projectColumn).not.toBeNull();
    }
  });

  it("gives every column a label, a type and a real drizzle column", () => {
    for (const key of REPORT_DATASETS) {
      const ds = DATASETS[key];
      const entries = Object.entries(ds.columns);
      expect(entries.length, `${key} column count`).toBeGreaterThanOrEqual(6);
      const seenColumns = new Set<unknown>();
      for (const [colKey, def] of entries) {
        expect(colKey, `${key}.${colKey}`).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        expect(def.label.length, `${key}.${colKey} label`).toBeGreaterThan(0);
        expect(["string", "number", "date", "enum"]).toContain(def.type);
        expect(def.column, `${key}.${colKey} column`).toBeDefined();
        // no two keys may point at the same physical column
        expect(seenColumns.has(def.column), `${key}.${colKey} duplicate column`).toBe(false);
        seenColumns.add(def.column);
        if (def.type === "enum") {
          expect(def.enumValues?.length, `${key}.${colKey} vocabulary`).toBeGreaterThan(1);
        }
      }
      expect(Object.hasOwn(ds.columns, ds.defaultSort), `${key} defaultSort`).toBe(true);
    }
  });

  it("publishes a JSON-safe catalog with per-column capabilities", () => {
    const catalog = datasetCatalog();
    expect(catalog).toHaveLength(12);
    // round-trips as JSON: no drizzle objects leak into the response
    const json = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
    const rfiDs = json.find((d) => d.key === "rfis")!;
    expect(rfiDs.columns.some((c) => "column" in c)).toBe(false);
    const status = rfiDs.columns.find((c) => c.key === "status")!;
    expect(status.type).toBe("enum");
    expect(status.enumValues).toContain("answered");
    expect(status.operators).toContain("in");
    expect(status.aggregations).toEqual(["count"]);
    const impact = rfiDs.columns.find((c) => c.key === "scheduleImpactDays")!;
    expect(impact.aggregations).toEqual(["count", "sum", "avg", "min", "max"]);
    expect(operatorsForType("string")).toContain("contains");
    expect(operatorsForType("enum")).not.toContain("contains");
  });
});

/* ------------------------------------------------------------------ */

describe("definition validation — nothing user-supplied reaches SQL", () => {
  it("rejects an unknown dataset", () => {
    expect400(() => resolveReport(spec({ dataset: "users" })), 'Unknown dataset "users"');
  });

  it("rejects an unknown column", () => {
    expect400(
      () => resolveReport(spec({ columns: ["number", "password_hash"] })),
      'Unknown column field "password_hash"',
    );
  });

  it("rejects an unknown filter field", () => {
    expect400(
      () => resolveReport(spec({ filters: [{ field: "companyId", operator: "eq", value: "x" }] })),
      'Unknown filter field "companyId"',
    );
  });

  it("rejects an unknown aggregate field", () => {
    expect400(
      () =>
        resolveReport(
          spec({ aggregations: [{ field: "salary", fn: "sum", alias: "total" }] }),
        ),
      'Unknown aggregation field "salary"',
    );
  });

  it("rejects SQL-injection-shaped identifiers everywhere they can appear", () => {
    const injection = "id; drop table users";
    expect400(() => resolveReport(spec({ columns: [injection] })), "Unknown column field");
    expect400(
      () => resolveReport(spec({ filters: [{ field: injection, operator: "eq", value: 1 }] })),
      "Unknown filter field",
    );
    expect400(
      () => resolveReport(spec({ groupBy: "status) OR 1=1--" })),
      "Unknown groupBy field",
    );
    expect400(
      () => resolveReport(spec({ sortBy: "number; delete from rfis" })),
      "Unknown sortBy field",
    );
    expect400(
      () => resolveReport(spec({ dataset: "rfis; drop table rfis" })),
      "Unknown dataset",
    );
    // aliases become SQL identifiers, so they are shape-constrained too
    expect400(
      () =>
        resolveReport(
          spec({
            groupBy: "status",
            aggregations: [{ field: "id", fn: "count", alias: 'n" from rfis; --' }],
          }),
        ),
      "must match",
    );
  });

  it("rejects capability violations and out-of-range limits", () => {
    expect400(
      () => resolveReport(spec({ aggregations: [{ field: "subject", fn: "sum", alias: "s" }] })),
      'Aggregation "sum" is not valid',
    );
    expect400(
      () => resolveReport(spec({ filters: [{ field: "status", operator: "contains", value: "op" }] })),
      'Operator "contains" is not valid',
    );
    expect400(
      () => resolveReport(spec({ filters: [{ field: "status", operator: "eq", value: "nope" }] })),
      "outside its vocabulary",
    );
    expect400(() => resolveReport(spec({ columns: [] })), "at least one column");
    expect400(() => resolveReport(spec({ limitRows: 5001 })), "limitRows must be between");
    expect400(
      () => resolveReport(spec({ groupBy: "status" })),
      "groupBy requires at least one aggregation",
    );
  });

  it("accepts every operator in REPORT_FILTER_OPERATORS on a compatible field", () => {
    for (const operator of REPORT_FILTER_OPERATORS) {
      // `contains` is a string operator; every other operator suits a number
      const field = operator === "contains" ? "subject" : "number";
      const value = operator === "contains" ? "x" : operator === "in" ? [1] : 1;
      expect(() =>
        resolveReport(spec({ filters: [{ field, operator, value }] })),
        `operator ${operator}`,
      ).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */

describe("execution — scope is appended by the executor, never by the definition", () => {
  it("returns only the caller's company rows when both companies hold matching data", async () => {
    const s = spec({
      columns: ["number", "subject", "assigneeId"],
      filters: [{ field: "subject", operator: "eq", value: "Foundation rebar clash" }],
    });
    const a = await run(s, { companyId: companyA });
    const b = await run(s, { companyId: companyB });
    // identical definition, identical filter, disjoint results
    expect(a.rowCount).toBe(1);
    expect(b.rowCount).toBe(1);
    expect(a.rows[0]!["assigneeId"]).toBe("user-alpha");
    const all = await run(spec({ columns: ["number"] }), { companyId: companyA });
    expect(all.rowCount).toBe(5); // 4 in A1 + 1 in A2, never company B's row
  });

  it("narrows to one project when the run is project-scoped", async () => {
    const s = spec({ columns: ["number", "subject"] });
    expect((await run(s, { companyId: companyA, projectId: projectA1 })).rowCount).toBe(4);
    expect((await run(s, { companyId: companyA, projectId: projectA2 })).rowCount).toBe(1);
    // a project id from the other company matches nothing — scope is ANDed
    expect(
      (await run(s, { companyId: companyA, projectId: projectB1 })).rowCount,
    ).toBe(0);
  });

  it("applies every filter operator correctly", async () => {
    const scope = { companyId: companyA, projectId: projectA1 };
    const numbers = async (filters: ReportSpec["filters"]) => {
      const r = await run(spec({ columns: ["number"], filters, sortBy: "number", sortDir: "asc" }), scope);
      return r.rows.map((row) => row["number"]);
    };
    expect(await numbers([{ field: "status", operator: "eq", value: "open" }])).toEqual([1, 2]);
    expect(await numbers([{ field: "status", operator: "ne", value: "open" }])).toEqual([3, 4]);
    expect(await numbers([{ field: "number", operator: "gt", value: 2 }])).toEqual([3, 4]);
    expect(await numbers([{ field: "number", operator: "gte", value: 2 }])).toEqual([2, 3, 4]);
    expect(await numbers([{ field: "number", operator: "lt", value: 2 }])).toEqual([1]);
    expect(await numbers([{ field: "number", operator: "lte", value: 2 }])).toEqual([1, 2]);
    expect(await numbers([{ field: "subject", operator: "contains", value: "rebar" }])).toEqual([1]);
    expect(await numbers([{ field: "status", operator: "in", value: ["answered", "closed"] }])).toEqual([3, 4]);
    expect(await numbers([{ field: "dueDate", operator: "is_null" }])).toEqual([4]);
    expect(await numbers([{ field: "dueDate", operator: "not_null" }])).toEqual([1, 2, 3]);
    // dates compare as ISO strings
    expect(await numbers([{ field: "dueDate", operator: "gte", value: "2026-02-01" }])).toEqual([2, 3]);
    // `contains` treats wildcards as literals, so a bare % matches nothing
    expect(await numbers([{ field: "subject", operator: "contains", value: "%" }])).toEqual([]);
  });

  it("groups and aggregates with hand-checked arithmetic", async () => {
    const byStatus = await run(
      spec({
        columns: ["id"],
        groupBy: "status",
        aggregations: [
          { field: "id", fn: "count", alias: "n" },
          { field: "scheduleImpactDays", fn: "sum", alias: "days" },
          { field: "scheduleImpactDays", fn: "avg", alias: "avg_days" },
          { field: "number", fn: "max", alias: "latest" },
        ],
        sortBy: "n",
        sortDir: "desc",
      }),
      { companyId: companyA, projectId: projectA1 },
    );
    expect(byStatus.columns.map((c) => c.key)).toEqual(["status", "n", "days", "avg_days", "latest"]);
    const open = byStatus.rows.find((r) => r["status"] === "open")!;
    expect(open["n"]).toBe(2); // RFIs 1 and 2
    expect(open["days"]).toBe(15); // 5 + 10
    expect(open["avg_days"]).toBe(7.5);
    expect(open["latest"]).toBe(2);
    const closed = byStatus.rows.find((r) => r["status"] === "closed")!;
    expect(closed["n"]).toBe(1);
    expect(closed["days"]).toBe(0); // sum over all-null coalesces to 0

    const money = await run(
      {
        dataset: "variations",
        columns: ["id"],
        groupBy: "status",
        aggregations: [
          { field: "id", fn: "count", alias: "n" },
          { field: "agreedValue", fn: "sum", alias: "agreed" },
        ],
        sortBy: "agreed",
        sortDir: "desc",
        limitRows: 50,
      },
      { companyId: companyA, projectId: projectA1 },
    );
    expect(money.rows[0]).toEqual({ status: "agreed", n: 2, agreed: 3500.5 });

    // aggregation with no groupBy collapses to a single row (the stat widget)
    const total = await run(
      spec({ columns: ["id"], aggregations: [{ field: "id", fn: "count", alias: "total" }] }),
      { companyId: companyA, projectId: projectA1 },
    );
    expect(total.rows).toEqual([{ total: 4 }]);
    expect(total.columns[0]!.label).toBe("Count of RFI id");
  });

  it("sorts, limits and reports truncation honestly", async () => {
    const asc = await run(
      spec({ columns: ["number"], sortBy: "number", sortDir: "asc" }),
      { companyId: companyA, projectId: projectA1 },
    );
    expect(asc.rows.map((r) => r["number"])).toEqual([1, 2, 3, 4]);
    expect(asc.truncated).toBe(false);

    const capped = await executeReport(
      db,
      resolveReport(spec({ columns: ["number"], sortBy: "number", sortDir: "desc", limitRows: 2 })),
      { companyId: companyA, projectId: projectA1 },
      { pageSize: 100, offset: 0 },
    );
    expect(capped.rows.map((r) => r["number"])).toEqual([4, 3]);
    expect(capped.rowCount).toBe(2);
    expect(capped.truncated).toBe(true);
    expect(capped.limitRows).toBe(2);

    // paging past the cap yields nothing rather than over-reading it
    const beyond = await executeReport(
      db,
      resolveReport(spec({ columns: ["number"], limitRows: 2 })),
      { companyId: companyA, projectId: projectA1 },
      { pageSize: 100, offset: 2 },
    );
    expect(beyond.rows).toEqual([]);
    expect(beyond.truncated).toBe(false);
    expect(typeof beyond.executedAt).toBe("string");
    expect(beyond.ms).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */

describe("csv", () => {
  it("quotes and escapes separators, quotes and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
  });

  it("renders a header row of labels and one line per row", async () => {
    const result = await run(
      spec({ columns: ["number", "subject"], sortBy: "number", sortDir: "asc" }),
      { companyId: companyA, projectId: projectA1 },
    );
    const csv = resultToCsv(result);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("Number,Subject");
    expect(lines[2]).toBe('2,"Cladding, ""specified"" finish"');
    expect(lines).toHaveLength(5);
  });
});
