/**
 * Analytics — the two remaining doors the adversarial review found ajar.
 *
 *  1. METRIC WIDGETS RESOLVED REACH BY BARE MEMBERSHIP. Report widgets went
 *     through the dataset's governing tool; metric tiles did not, so a
 *     subcontractor-template member holding `none` on assurance could read the
 *     open-signal count for their project — and, on a company-wide dashboard,
 *     across every project they were a member of. A tile is a read of the tool
 *     it counts.
 *  2. runDueSchedules WAS A CHECK-THEN-ACT. It selected the due schedules and
 *     advanced next_run_at only after rendering and sending, so two admin
 *     clicks — or one click overlapping the scheduler tick — both mailed the
 *     same extract and both wrote a report_runs row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  dashboards,
  obligations,
  projectMemberships,
  projects,
  reportDefinitions,
  reportRuns,
  reportSchedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let sub: TestActor;
/** the subcontractor's headers, scoped to the owner's company */
let subHeaders: Record<string, string>;
let projectId: string;

const url = (p: string) => `/api/v1${p}`;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  sub = await registerActor(app);

  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: sub.userId,
    role: "member",
  });
  subHeaders = {
    authorization: sub.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Widget Gating",
  });
  // The built-in subcontractor template holds `none` on assurance and on
  // contracts, and standard on the field tools.
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: sub.userId,
    templateKey: "subcontractor",
  });

  await app.db.insert(signals).values([
    {
      id: newId("sig"),
      companyId: owner.companyId,
      projectId,
      detector: "test_detector",
      severity: "high",
      confidence: 0.8,
      title: "Something adverse",
      explanation: "…",
      disposition: "new",
    },
    {
      id: newId("sig"),
      companyId: owner.companyId,
      projectId,
      detector: "test_detector",
      severity: "low",
      confidence: 0.4,
      title: "Something else",
      explanation: "…",
      disposition: "under_review",
    },
  ]);
  await app.db.insert(obligations).values({
    id: newId("obl"),
    companyId: owner.companyId,
    projectId,
    sourceClause: "cl 20.1",
    trigger: "notice",
    status: "open",
    createdBy: owner.userId,
  });
}, 300_000);

afterAll(async () => {
  await built.close();
});

async function makeDashboard(projectScope: string | null, metric: string): Promise<string> {
  const id = newId("dsh");
  await app.db.insert(dashboards).values({
    id,
    companyId: owner.companyId,
    projectId: projectScope,
    name: `Dashboard ${metric}`,
    audience: "executive",
    widgets: [
      { id: newId("wdg"), kind: "stat", title: metric, metric, span: 1 },
    ],
    createdBy: owner.userId,
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* Metric widgets are governed by the tool they count                  */
/* ------------------------------------------------------------------ */

describe("dashboard metric widgets", () => {
  it("the owner sees the counts", async () => {
    const dash = await makeDashboard(projectId, "open_signals");
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dash}/data`),
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { widgets: { data: { value: number } | null }[] };
    expect(body.widgets[0]!.data!.value).toBe(2);
  });

  it("REGRESSION: a member with `none` on assurance is refused the open-signal tile", async () => {
    const dash = await makeDashboard(projectId, "open_signals");
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dash}/data`),
      headers: subHeaders,
    });
    // The dashboard still renders — each widget fails alone — but the tile
    // carries an error instead of a number the caller may not read.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { widgets: { data: unknown; error?: string }[] };
    expect(body.widgets[0]!.data).toBeNull();
    expect(body.widgets[0]!.error).toContain("assurance");
  });

  it("REGRESSION: the same holds for obligations, which are contracts data", async () => {
    const dash = await makeDashboard(projectId, "open_obligations");
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dash}/data`),
      headers: subHeaders,
    });
    const body = res.json() as { widgets: { data: unknown; error?: string }[] };
    expect(body.widgets[0]!.data).toBeNull();
    expect(body.widgets[0]!.error).toContain("contracts");
  });

  it("a company-wide tile counts only the projects the caller may read the tool on", async () => {
    const dash = await makeDashboard(null, "open_signals");
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dash}/data`),
      headers: subHeaders,
    });
    const body = res.json() as { widgets: { data: { value: number } | null }[] };
    // Membership alone used to be enough, and returned 2. The subcontractor
    // template holds `none` on assurance everywhere, so the honest count is 0.
    expect(body.widgets[0]!.data!.value).toBe(0);
  });

  it("a member who DOES hold the tool reads the tile", async () => {
    // owner_stakeholder is the built-in template that carries assurance:read —
    // project_manager deliberately does not, which is the whole point.
    const pm = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: pm.userId,
      role: "member",
    });
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: pm.userId,
      templateKey: "owner_stakeholder",
    });
    const dash = await makeDashboard(projectId, "open_signals");
    const res = await app.inject({
      method: "GET",
      url: url(`/analytics/dashboards/${dash}/data`),
      headers: {
        authorization: pm.headers["authorization"]!,
        "x-company-id": owner.companyId,
      },
    });
    const body = res.json() as { widgets: { data: { value: number } | null; error?: string }[] };
    expect(body.widgets[0]!.error).toBeUndefined();
    expect(body.widgets[0]!.data!.value).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Scheduled delivery is claimed, not merely observed to be due        */
/* ------------------------------------------------------------------ */

describe("run-due claims each schedule", () => {
  let reportId: string;
  let scheduleId: string;

  beforeAll(async () => {
    reportId = newId("rpt");
    await app.db.insert(reportDefinitions).values({
      id: reportId,
      companyId: owner.companyId,
      projectId,
      name: "Open signals",
      dataset: "signals",
      columns: ["title", "severity"],
      filters: [],
      aggregations: [],
      limitRows: 50,
      isShared: 1,
      createdBy: owner.userId,
    });
    scheduleId = newId("rsc");
    await app.db.insert(reportSchedules).values({
      id: scheduleId,
      companyId: owner.companyId,
      reportId,
      cadence: "daily",
      recipients: ["ops@example.test"],
      isActive: 1,
      // due an hour ago
      nextRunAt: new Date(Date.now() - 3_600_000).toISOString(),
      createdBy: owner.userId,
    });
  }, 120_000);

  const runsFor = async () =>
    app.db.select().from(reportRuns).where(eq(reportRuns.scheduleId, scheduleId));

  it("REGRESSION: two concurrent run-due calls execute the schedule exactly once", async () => {
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: url("/analytics/reports/schedules/run-due"),
        headers: owner.headers,
      }),
      app.inject({
        method: "POST",
        url: url("/analytics/reports/schedules/run-due"),
        headers: owner.headers,
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const bodies = [a, b].map(
      (r) => r.json() as { due: number; claimed: number; skippedAlreadyClaimed: number },
    );
    // Both may SEE it due; exactly one may claim it.
    expect(bodies.reduce((n, x) => n + x.claimed, 0)).toBe(1);

    const runs = await runsFor();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("scheduled");
  });

  it("a second sweep finds nothing due, and the schedule carries its next instant", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("/analytics/reports/schedules/run-due"),
      headers: owner.headers,
    });
    expect((res.json() as { due: number }).due).toBe(0);

    const [row] = await app.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, scheduleId));
    expect(row!.nextRunAt).not.toBeNull();
    expect(new Date(row!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(row!.runCount).toBe(1);
  });

  it("the run row states honestly whether a delivery left the platform", async () => {
    const runs = await runsFor();
    const run = runs[0]!;
    // No email transport is configured under test, so nothing was dispatched —
    // and the reasons say why rather than the row implying a send.
    expect(run.deliveryDispatched).toBe(0);
    expect((run.deliveryReasons as string[]).length).toBeGreaterThan(0);

    const listed = await app.inject({
      method: "GET",
      url: url("/analytics/reports/runs"),
      headers: owner.headers,
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { items: { id: string; deliveryDispatched: boolean }[] };
    expect(body.items.some((r) => r.id === run.id)).toBe(true);
  });

  it("does not run a paused schedule at all", async () => {
    await app.db
      .update(reportSchedules)
      .set({ isActive: 0, nextRunAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(reportSchedules.id, scheduleId));
    const res = await app.inject({
      method: "POST",
      url: url("/analytics/reports/schedules/run-due"),
      headers: owner.headers,
    });
    expect((res.json() as { due: number; claimed: number }).claimed).toBe(0);
    expect(await runsFor()).toHaveLength(1);
    const [row] = await app.db
      .select()
      .from(reportSchedules)
      .where(
        and(eq(reportSchedules.id, scheduleId), eq(reportSchedules.companyId, owner.companyId)),
      );
    expect(row!.runCount).toBe(1);
  });
});
