import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  dashboards,
  grievances,
  obligations,
  paymentClaims,
  projectMemberships,
  projects,
  punchItems,
  reportDefinitions,
  rfis,
  signals,
  variations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { computeNextRunAt } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor;
let outsider: TestActor;
/** member's headers, but scoped to the owner's company */
let memberHeaders: Record<string, string>;
let projectId: string;
let otherProjectId: string;

const url = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  member = await registerActor(app);
  outsider = await registerActor(app);

  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  otherProjectId = newId("prj");
  await app.db.insert(projects).values([
    { id: projectId, companyId: owner.companyId, name: "Analytics Test Project" },
    { id: otherProjectId, companyId: owner.companyId, name: "Second Project" },
  ]);
  // the member is a non-admin, so project reach comes from membership (#751)
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: member.userId,
    templateKey: "project_manager",
  });

  await app.db.insert(rfis).values([
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      subject: "Foundation rebar clash",
      question: "q",
      status: "open",
      dueDate: "2026-01-10",
      createdBy: owner.userId,
    },
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 2,
      subject: 'Cladding, "specified" finish',
      question: "q",
      status: "open",
      dueDate: "2026-02-01",
      createdBy: owner.userId,
    },
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId,
      number: 3,
      subject: "Drainage invert",
      question: "q",
      status: "answered",
      createdBy: owner.userId,
    },
    {
      id: newId("rfi"),
      companyId: owner.companyId,
      projectId: otherProjectId,
      number: 1,
      subject: "Other project",
      question: "q",
      status: "open",
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(punchItems).values([
    {
      id: newId("pun"),
      companyId: owner.companyId,
      projectId,
      number: 1,
      title: "Chipped tile",
      status: "open",
      createdBy: owner.userId,
    },
    {
      id: newId("pun"),
      companyId: owner.companyId,
      projectId,
      number: 2,
      title: "Paint touch-up",
      status: "closed",
      createdBy: owner.userId,
    },
  ]);
  await app.db.insert(variations).values({
    id: newId("var"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Extra piling",
    status: "agreed",
    agreedValue: 12000,
    createdBy: owner.userId,
  });
  await app.db.insert(paymentClaims).values({
    id: newId("pcl"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    regime: "uk_hgcra",
    referenceDate: "2026-01-31",
    claimedAmount: 50000,
    status: "served",
    createdBy: owner.userId,
  });
  await app.db.insert(grievances).values({
    id: newId("grv"),
    companyId: owner.companyId,
    projectId,
    number: 1,
    channel: "in_person",
    category: "dust",
    severity: "medium",
    description: "Dust over the market",
    receivedAt: "2026-02-02",
    status: "received",
    createdBy: owner.userId,
  });
  await app.db.insert(signals).values({
    id: newId("sig"),
    companyId: owner.companyId,
    projectId,
    detector: "test_detector",
    severity: "high",
    confidence: 0.9,
    title: "Something odd",
    explanation: "seeded",
  });
  await app.db.insert(obligations).values({
    id: newId("obl"),
    companyId: owner.companyId,
    projectId,
    sourceClause: "cl 20.1",
    trigger: "notice",
    status: "open",
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function createReport(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: url("/analytics/reports"),
    headers,
    payload: {
      name: "RFIs",
      projectId,
      dataset: "rfis",
      columns: ["number", "subject", "status"],
      ...payload,
    },
  });
}

/* ------------------------------------------------------------------ */

describe("catalog", () => {
  it("publishes all 12 datasets with their column capabilities", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("/analytics/datasets"),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      datasets: { key: string; columns: { key: string; operators: string[] }[] }[];
      limits: { maxLimitRows: number };
    };
    expect(body.datasets).toHaveLength(12);
    expect(body.datasets.map((d) => d.key)).toContain("grievances");
    expect(body.limits.maxLimitRows).toBe(5000);
    for (const ds of body.datasets) expect(ds.columns.length).toBeGreaterThanOrEqual(6);
  });

  it("requires a company context", async () => {
    const res = await app.inject({ method: "GET", url: url("/analytics/datasets") });
    expect(res.statusCode).toBe(401);
  });
});

describe("report definitions", () => {
  it("creates a definition and rejects invalid ones with 400", async () => {
    const ok = await createReport(owner.headers, { name: "Open RFIs list" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ dataset: "rfis", isShared: false });

    const badDataset = await createReport(owner.headers, { dataset: "users" });
    expect(badDataset.statusCode).toBe(400);
    expect(badDataset.json().message).toContain("Unknown dataset");

    const badColumn = await createReport(owner.headers, { columns: ["passwordHash"] });
    expect(badColumn.statusCode).toBe(400);

    const badFilter = await createReport(owner.headers, {
      filters: [{ field: "id; drop table users", operator: "eq", value: "x" }],
    });
    expect(badFilter.statusCode).toBe(400);
    expect(badFilter.json().message).toContain("Unknown filter field");

    const badAggregate = await createReport(owner.headers, {
      groupBy: "status",
      aggregations: [{ field: "secretSalary", fn: "sum", alias: "n" }],
    });
    expect(badAggregate.statusCode).toBe(400);
    expect(badAggregate.json().message).toContain("Unknown aggregation field");

    const badProject = await createReport(owner.headers, { projectId: outsider.companyId });
    expect(badProject.statusCode).toBe(400);
  });

  it("shows a caller their own reports plus shared ones, and hides private ones", async () => {
    const mine = await createReport(memberHeaders, { name: "Member private" });
    expect(mine.statusCode).toBe(201);
    const shared = await createReport(owner.headers, { name: "Owner shared", isShared: true });
    const privateOwner = await createReport(owner.headers, { name: "Owner private" });

    const list = await app.inject({
      method: "GET",
      url: url("/analytics/reports?pageSize=100"),
      headers: memberHeaders,
    });
    expect(list.statusCode).toBe(200);
    const names = (list.json().items as { name: string }[]).map((r) => r.name);
    expect(names).toContain("Member private");
    expect(names).toContain("Owner shared");
    expect(names).not.toContain("Owner private");

    const filtered = await app.inject({
      method: "GET",
      url: url("/analytics/reports?dataset=punch_items"),
      headers: memberHeaders,
    });
    expect(filtered.json().items).toHaveLength(0);

    const readShared = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${shared.json().id}`),
      headers: memberHeaders,
    });
    expect(readShared.statusCode).toBe(200);

    const readPrivate = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${privateOwner.json().id}`),
      headers: memberHeaders,
    });
    expect(readPrivate.statusCode).toBe(404);
  });

  it("lets only the creator or a company admin edit and delete", async () => {
    const shared = await createReport(owner.headers, { name: "Shared editable", isShared: true });
    const id = shared.json().id as string;

    const byOther = await app.inject({
      method: "PATCH",
      url: url(`/analytics/reports/${id}`),
      headers: memberHeaders,
      payload: { name: "Hijacked" },
    });
    expect(byOther.statusCode).toBe(403);

    const byCreator = await app.inject({
      method: "PATCH",
      url: url(`/analytics/reports/${id}`),
      headers: owner.headers,
      payload: { name: "Renamed", sortBy: "dueDate", sortDir: "asc" },
    });
    expect(byCreator.statusCode).toBe(200);
    expect(byCreator.json()).toMatchObject({ name: "Renamed", sortBy: "dueDate" });

    // the merged definition is re-validated, so an invalid patch is rejected
    const invalidPatch = await app.inject({
      method: "PATCH",
      url: url(`/analytics/reports/${id}`),
      headers: owner.headers,
      payload: { sortBy: "nonexistent" },
    });
    expect(invalidPatch.statusCode).toBe(400);

    // a company admin may edit a report they did not create
    const memberReport = await createReport(memberHeaders, { name: "Member owned" });
    const byAdmin = await app.inject({
      method: "PATCH",
      url: url(`/analytics/reports/${memberReport.json().id}`),
      headers: owner.headers,
      payload: { description: "curated by the admin" },
    });
    expect(byAdmin.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: url(`/analytics/reports/${id}`),
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${id}`),
      headers: owner.headers,
    });
    expect(gone.statusCode).toBe(404);
  });

  it("never exposes another company's report", async () => {
    const mine = await createReport(owner.headers, { name: "Tenant bound" });
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${mine.json().id}`),
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("execution", () => {
  it("runs a saved report with paging and a truncation flag", async () => {
    const created = await createReport(owner.headers, {
      name: "Run me",
      sortBy: "number",
      sortDir: "asc",
      limitRows: 2,
    });
    const id = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${id}/run?pageSize=50`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      columns: { key: string; label: string }[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      report: { projectId: string };
    };
    expect(body.columns.map((c) => c.key)).toEqual(["number", "subject", "status"]);
    expect(body.columns[0]!.label).toBe("Number");
    expect(body.rows.map((r) => r["number"])).toEqual([1, 2]);
    expect(body.rowCount).toBe(2);
    expect(body.truncated).toBe(true); // 3 RFIs in the project, limitRows 2
    expect(body.report.projectId).toBe(projectId);
  });

  it("scopes a run to the report's project", async () => {
    const scoped = await createReport(owner.headers, { name: "This project" });
    const wide = await createReport(owner.headers, {
      name: "Company wide",
      projectId: null,
      isShared: true,
    });

    const a = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${scoped.json().id}/run`),
      headers: owner.headers,
    });
    expect(a.json().rowCount).toBe(3);

    const b = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${wide.json().id}/run`),
      headers: owner.headers,
    });
    expect(b.json().rowCount).toBe(4); // both projects

    // a company-wide report may be narrowed at run time
    const c = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${wide.json().id}/run?projectId=${otherProjectId}`),
      headers: owner.headers,
    });
    expect(c.json().rowCount).toBe(1);

    // …but not into a project the caller cannot reach (#751)
    const d = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${wide.json().id}/run?projectId=${otherProjectId}`),
      headers: memberHeaders,
    });
    expect(d.statusCode).toBe(403);
  });

  it("previews a definition without saving it", async () => {
    const before = await app.db
      .select()
      .from(reportDefinitions)
      .where(eq(reportDefinitions.companyId, owner.companyId));

    const res = await app.inject({
      method: "POST",
      url: url("/analytics/reports/preview"),
      headers: owner.headers,
      payload: {
        projectId,
        dataset: "rfis",
        columns: ["id"],
        groupBy: "status",
        aggregations: [{ field: "id", fn: "count", alias: "n" }],
        sortBy: "n",
        sortDir: "desc",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Record<string, unknown>[]; saved: boolean };
    expect(body.saved).toBe(false);
    expect(body.rows).toEqual([
      { status: "open", n: 2 },
      { status: "answered", n: 1 },
    ]);

    const after = await app.db
      .select()
      .from(reportDefinitions)
      .where(eq(reportDefinitions.companyId, owner.companyId));
    expect(after.length).toBe(before.length);
  });

  it("rejects an injection-shaped preview field with 400 rather than running it", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/analytics/reports/preview"),
      headers: owner.headers,
      payload: {
        projectId,
        dataset: "rfis",
        columns: ["number"],
        sortBy: "number; delete from rfis",
      },
    });
    expect(res.statusCode).toBe(400);
    // and nothing was deleted
    const rows = await app.db
      .select()
      .from(rfis)
      .where(and(eq(rfis.companyId, owner.companyId), eq(rfis.projectId, projectId)));
    expect(rows).toHaveLength(3);
  });

  it("exports CSV with a header row and quote-escaped values", async () => {
    const created = await createReport(owner.headers, {
      name: "Export me",
      columns: ["number", "subject"],
      sortBy: "number",
      sortDir: "asc",
    });
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${created.json().id}/export.csv`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("Export-me.csv");
    const lines = res.body.trimEnd().split("\n");
    expect(lines[0]).toBe("Number,Subject");
    expect(lines[2]).toBe('2,"Cladding, ""specified"" finish"');
    expect(lines).toHaveLength(4);
  });

  /**
   * Regression: `DATASETS[key]` was a bare index, so a key inherited from
   * Object.prototype resolved to a truthy non-dataset and crashed the request
   * with a 500 instead of rejecting it. No user string ever reached SQL, but
   * an unknown dataset must 400 whatever its name.
   */
  it("rejects prototype-chain dataset names with 400, not 500", async () => {
    for (const dataset of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const res = await app.inject({
        method: "POST",
        url: url("/analytics/reports/preview"),
        headers: owner.headers,
        payload: { projectId, dataset, columns: ["id"] },
      });
      expect(res.statusCode, `dataset "${dataset}"`).toBe(400);
      expect(res.json().message).toContain("Unknown dataset");
    }
  });

  /**
   * Regression (#751): row-level security was applied only when a run NAMED a
   * project, so omitting `projectId` let any company member read every
   * project's rows. A company-wide run must be narrowed to the projects the
   * caller actually reaches.
   */
  it("does not let a company-wide run reach projects the caller cannot open", async () => {
    // The member is on `projectId` only — `otherProjectId` is out of reach.
    const scoped = await app.inject({
      method: "POST",
      url: url("/analytics/reports/preview"),
      headers: memberHeaders,
      payload: { dataset: "rfis", columns: ["id", "subject"], limitRows: 5000 },
    });
    expect(scoped.statusCode).toBe(200);
    const subjects = (scoped.json().rows as { subject: string }[]).map((r) => r.subject);
    expect(subjects).not.toContain("Other project");
    expect(subjects).toContain("Foundation rebar clash");

    // …while a company owner still sees both projects.
    const wide = await app.inject({
      method: "POST",
      url: url("/analytics/reports/preview"),
      headers: owner.headers,
      payload: { dataset: "rfis", columns: ["id", "subject"], limitRows: 5000 },
    });
    expect(wide.json().rowCount).toBe(4);

    // A member on no project at all gets nothing rather than everything.
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: outsider.userId,
      role: "member",
    });
    const none = await app.inject({
      method: "POST",
      url: url("/analytics/reports/preview"),
      headers: {
        authorization: outsider.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
      payload: { dataset: "rfis", columns: ["id", "subject"], limitRows: 5000 },
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().rowCount).toBe(0);
  });
});

describe("dashboards", () => {
  it("creates a dashboard, validates widgets, and survives a broken one", async () => {
    const good = await createReport(owner.headers, {
      name: "Widget report",
      columns: ["id"],
      groupBy: "status",
      aggregations: [{ field: "id", fn: "count", alias: "n" }],
      isShared: true,
    });
    const doomed = await createReport(owner.headers, { name: "Doomed report", isShared: true });

    const bad = await app.inject({
      method: "POST",
      url: url("/analytics/dashboards"),
      headers: owner.headers,
      payload: {
        name: "Invalid",
        widgets: [{ kind: "stat", title: "Nothing", span: 1 }],
      },
    });
    expect(bad.statusCode).toBe(400);

    const unknownMetric = await app.inject({
      method: "POST",
      url: url("/analytics/dashboards"),
      headers: owner.headers,
      payload: {
        name: "Invalid metric",
        widgets: [{ kind: "stat", title: "?", metric: "drop_tables", span: 1 }],
      },
    });
    expect(unknownMetric.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: url("/analytics/dashboards"),
      headers: owner.headers,
      payload: {
        name: "Mixed",
        projectId,
        audience: "pm",
        widgets: [
          { kind: "bar", title: "RFIs by status", reportId: good.json().id, span: 2 },
          { kind: "table", title: "Will break", reportId: doomed.json().id, span: 2 },
          { kind: "stat", title: "Open obligations", metric: "open_obligations", span: 1 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const dashboardId = created.json().id as string;

    // break exactly one widget by deleting its backing report
    const del = await app.inject({
      method: "DELETE",
      url: url(`/analytics/reports/${doomed.json().id}`),
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);

    const data = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dashboardId}/data`),
      headers: owner.headers,
    });
    expect(data.statusCode).toBe(200);
    const widgets = data.json().widgets as {
      title: string;
      data: { rows?: Record<string, unknown>[]; value?: number } | null;
      error?: string;
    }[];
    expect(widgets).toHaveLength(3);
    const chart = widgets.find((w) => w.title === "RFIs by status")!;
    expect(chart.error).toBeUndefined();
    expect(chart.data!.rows).toHaveLength(2);
    const broken = widgets.find((w) => w.title === "Will break")!;
    expect(broken.error).toContain("Report not found");
    expect(broken.data).toBeNull();
    const stat = widgets.find((w) => w.title === "Open obligations")!;
    expect(stat.data!.value).toBe(1);

    const patched = await app.inject({
      method: "PATCH",
      url: url(`/analytics/dashboards/${dashboardId}`),
      headers: owner.headers,
      payload: { name: "Mixed (renamed)", isDefault: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Mixed (renamed)", isDefault: 1 });

    const forbidden = await app.inject({
      method: "DELETE",
      url: url(`/analytics/dashboards/${dashboardId}`),
      headers: outsider.headers,
    });
    expect(forbidden.statusCode).toBe(404);

    const removed = await app.inject({
      method: "DELETE",
      url: url(`/analytics/dashboards/${dashboardId}`),
      headers: owner.headers,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("seeds the three role dashboards idempotently and renders their data", async () => {
    const first = await app.inject({
      method: "POST",
      url: url("/analytics/dashboards/seed-defaults"),
      headers: owner.headers,
      payload: { projectId },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as {
      created: string[];
      adopted: string[];
      createdReports: string[];
      dashboards: { id: string; name: string; audience: string }[];
    };
    expect(firstBody.created).toEqual(["Project delivery", "Commercial", "Assurance"]);
    expect(firstBody.createdReports).toHaveLength(8);
    expect(firstBody.dashboards.map((d) => d.audience).sort()).toEqual([
      "assurance",
      "commercial",
      "pm",
    ]);

    const second = await app.inject({
      method: "POST",
      url: url("/analytics/dashboards/seed-defaults"),
      headers: owner.headers,
      payload: { projectId },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().created).toEqual([]);
    expect(second.json().adopted).toHaveLength(3);
    expect(second.json().createdReports).toEqual([]);

    const rows = await app.db
      .select()
      .from(dashboards)
      .where(
        and(eq(dashboards.companyId, owner.companyId), eq(dashboards.projectId, projectId)),
      );
    expect(rows).toHaveLength(3);

    const assurance = firstBody.dashboards.find((d) => d.audience === "assurance")!;
    const data = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${assurance.id}/data`),
      headers: owner.headers,
    });
    expect(data.statusCode).toBe(200);
    const widgets = data.json().widgets as {
      title: string;
      kind: string;
      data: { rows?: Record<string, unknown>[]; value?: number } | null;
      error?: string;
    }[];
    expect(widgets.map((w) => w.title)).toEqual([
      "Signals by severity",
      "Open obligations",
      "Grievances by status",
    ]);
    expect(widgets.every((w) => w.error === undefined)).toBe(true);
    expect(widgets[0]!.data!.rows).toEqual([{ severity: "high", signals: 1 }]);
    expect(widgets[1]!.data!.value).toBe(1);
    expect(widgets[2]!.data!.rows).toEqual([{ status: "received", grievances: 1 }]);

    const delivery = firstBody.dashboards.find((d) => d.audience === "pm")!;
    const pmData = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${delivery.id}/data`),
      headers: owner.headers,
    });
    const pmWidgets = pmData.json().widgets as {
      title: string;
      data: { rows?: Record<string, unknown>[] } | null;
    }[];
    // "Open RFIs" is a bare aggregate — one row, one number
    expect(pmWidgets[0]!.data!.rows).toEqual([{ open_rfis: 2 }]);
    // "RFI ageing" lists the two open RFIs, oldest due date first
    expect(pmWidgets[2]!.data!.rows!.map((r) => r["number"])).toEqual([1, 2]);
  });
});

describe("schedules (#736)", () => {
  it("computes the next run instant for each cadence", () => {
    const from = new Date("2026-03-10T09:00:00Z"); // a Tuesday, after 06:00Z
    expect(computeNextRunAt("daily", null, from)).toBe("2026-03-11T06:00:00.000Z");
    expect(computeNextRunAt("daily", null, new Date("2026-03-10T05:00:00Z"))).toBe(
      "2026-03-10T06:00:00.000Z",
    );
    // 4 = Thursday, two days after the Tuesday
    expect(computeNextRunAt("weekly", 4, from)).toBe("2026-03-12T06:00:00.000Z");
    // 2 = Tuesday: today's slot has passed, so a week out
    expect(computeNextRunAt("weekly", 2, from)).toBe("2026-03-17T06:00:00.000Z");
    expect(computeNextRunAt("weekly", null, from)).toBe("2026-03-16T06:00:00.000Z"); // Monday
    // monthly: the 5th has gone, the 20th has not
    expect(computeNextRunAt("monthly", 5, from)).toBe("2026-04-05T06:00:00.000Z");
    expect(computeNextRunAt("monthly", 20, from)).toBe("2026-03-20T06:00:00.000Z");
    // year rollover
    expect(computeNextRunAt("monthly", 1, new Date("2026-12-15T00:00:00Z"))).toBe(
      "2027-01-01T06:00:00.000Z",
    );
  });

  it("records a schedule, says plainly that nothing is delivered, and removes it", async () => {
    const report = await createReport(owner.headers, { name: "Scheduled report" });
    const id = report.json().id as string;

    const created = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: owner.headers,
      payload: { cadence: "weekly", dayOfPeriod: 1, recipients: ["pm@example.com"] },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      nextRunAt: string;
      delivery: { enabled: boolean; note: string };
    };
    expect(body.delivery.enabled).toBe(false);
    expect(body.delivery.note).toContain("no email is sent");
    expect(new Date(body.nextRunAt).getUTCDay()).toBe(1);
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const badDay = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: owner.headers,
      payload: { cadence: "weekly", dayOfPeriod: 12, recipients: ["pm@example.com"] },
    });
    expect(badDay.statusCode).toBe(400);

    const badEmail = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: owner.headers,
      payload: { cadence: "daily", recipients: ["not-an-email"] },
    });
    expect(badEmail.statusCode).toBe(400);

    const notMine = await app.inject({
      method: "POST",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: memberHeaders,
      payload: { cadence: "daily", recipients: ["pm@example.com"] },
    });
    expect(notMine.statusCode).toBe(404); // private report — invisible to the member

    const list = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: owner.headers,
    });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().delivery.enabled).toBe(false);

    const removed = await app.inject({
      method: "DELETE",
      url: url(`/analytics/reports/${id}/schedules/${body.id}`),
      headers: owner.headers,
    });
    expect(removed.statusCode).toBe(204);
    const after = await app.inject({
      method: "GET",
      url: url(`/analytics/reports/${id}/schedules`),
      headers: owner.headers,
    });
    expect(after.json().items).toHaveLength(0);
  });
});
