import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, resourcePlans } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { resourcesModule } from "./index.js";

/**
 * Regression: DEMAND AND SUPPLY MUST BUCKET ON THE SAME WEEK BOUNDARY.
 *
 * The week boundary is a project setting, not a constant — a Sunday-start
 * week and a Monday-start week put a Saturday's hours in different weeks. If
 * demand normalises to the plan's boundary and supply normalises to Monday,
 * every cell on a Sunday-start project reads as BOTH short (demand with no
 * matching supply row) and unknown (supply with no matching demand row), and
 * the histogram is unusable in exactly the projects that most need it.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let projectId: string;
/** A project that has never held a plan at all. */
let virginProjectId: string;
let typeId: string;
let planId: string;

/** A Wednesday, so Monday-start and Sunday-start weeks differ. */
const WEDNESDAY = "2026-11-11";
const SUNDAY_WEEK = "2026-11-08";
const MONDAY_WEEK = "2026-11-09";

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.hasRoute({ method: "GET", url: "/api/v1/resource-types" })) {
    await app.register(resourcesModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Week Boundary Co" });
  projectId = newId("prj");
  virginProjectId = newId("prj");
  await app.db.insert(projects).values([
    {
      id: projectId,
      companyId: owner.companyId,
      name: "Sunday shift project",
      stage: "construction",
      currency: "USD",
    },
    {
      id: virginProjectId,
      companyId: owner.companyId,
      name: "Never planned",
      stage: "construction",
      currency: "USD",
    },
  ]);

  const type = await app.inject({
    method: "POST",
    url: "/api/v1/resource-types",
    headers: owner.headers,
    payload: { code: "SF", name: "Steel fixers", standardHoursPerDay: 10 },
  });
  typeId = type.json().id as string;

  const plan = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/resource-plans`,
    headers: owner.headers,
    payload: { name: "Sunday-start plan", weekStartsOn: 0 },
  });
  planId = plan.json().id as string;
  await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/resource-plans/${planId}/activate`,
    headers: owner.headers,
    payload: {},
  });
});

afterAll(async () => {
  await built.close();
});

describe("week boundaries", () => {
  it("normalises a demand row to the plan's week start", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/resource-plans/${planId}/demand`,
      headers: owner.headers,
      payload: { resourceTypeId: typeId, weekStart: WEDNESDAY, demandHours: 300 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().weekStart).toBe(SUNDAY_WEEK);
    expect(res.json().weekStart).not.toBe(MONDAY_WEEK);
  });

  it("normalises supply to the SAME week start, not to Monday", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/resource-availability`,
      headers: owner.headers,
      payload: {
        resourceTypeId: typeId,
        weekStart: WEDNESDAY,
        availableHours: 400,
        source: "roster",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().weekStart).toBe(SUNDAY_WEEK);
  });

  it("lines demand up against supply in one cell", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/resources/histogram?from=${SUNDAY_WEEK}&to=${SUNDAY_WEEK}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.weeks).toEqual([SUNDAY_WEEK]);
    const cell = body.series[0].cells[0];
    expect(cell.demandHours).toBe(300);
    expect(cell.availableHours).toBe(400);
    // the cell is covered, not simultaneously "short" and "supply unknown"
    expect(cell.state).toBe("ok");
    expect(cell.utilisationPercent).toBe(75);
    expect(body.totals.unknownSupplyCells).toBe(0);
  });

  it("buckets a bulk supply window on the plan's boundary too", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/resource-availability/bulk`,
      headers: owner.headers,
      payload: {
        resourceTypeId: typeId,
        from: WEDNESDAY,
        to: "2026-11-25",
        availableHours: 400,
        source: "roster",
      },
    });
    expect(res.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/resource-availability?resourceTypeId=${typeId}`,
      headers: owner.headers,
    });
    const weeks = (listed.json().items as Array<{ weekStart: string }>).map((r) => r.weekStart);
    // every stored week begins on a Sunday
    expect(weeks.every((w) => new Date(`${w}T00:00:00Z`).getUTCDay() === 0)).toBe(true);
  });

  /**
   * Regression: THE BOUNDARY BELONGS TO THE PROJECT, NOT TO WHICHEVER PLAN IS
   * ACTIVE RIGHT NOW.
   *
   * Resolving it from the active `current` plan alone left two holes a user
   * walks straight into. Supply is stated from the Plan tab with no
   * activation required, so a Sunday-start plan still in draft got Monday
   * supply rows; and archiving the live plan flipped the boundary under rows
   * already stored, stranding every one of them.
   */
  it("refuses to move a plan's week boundary once demand is bucketed on it", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/resource-plans/${planId}`,
      headers: owner.headers,
      payload: { weekStartsOn: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("histogram no longer draws");
  });

  it("allows a no-op restatement of the same boundary", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/resource-plans/${planId}`,
      headers: owner.headers,
      payload: { weekStartsOn: 0, name: "Sunday-start plan" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().weekStartsOn).toBe(0);
  });

  it("refuses a second plan that would introduce a second boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/resource-plans`,
      headers: owner.headers,
      payload: { name: "Monday rebel", weekStartsOn: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already buckets its weeks");
  });

  it("keeps the project's boundary when no plan is active", async () => {
    await app.db
      .update(resourcePlans)
      .set({ status: "archived" })
      .where(eq(resourcePlans.id, planId));
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/resource-availability`,
      headers: owner.headers,
      payload: {
        resourceTypeId: typeId,
        weekStart: "2026-12-09", // a Wednesday
        availableHours: 100,
        source: "roster",
      },
    });
    expect(res.statusCode).toBe(200);
    // Sunday, not the Monday a "no active plan → default" fallback would give:
    // the rows already stored on this project all begin on a Sunday.
    expect(res.json().weekStart).toBe("2026-12-06");
  });

  it("falls back to Monday only on a project that has never had a plan", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${virginProjectId}/resource-availability`,
      headers: owner.headers,
      payload: {
        resourceTypeId: typeId,
        weekStart: "2026-12-09", // a Wednesday
        availableHours: 100,
        source: "roster",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().weekStart).toBe("2026-12-07"); // the ISO-8601 Monday
  });

  it("lets a project with no rows yet choose its own boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${virginProjectId}/resource-plans`,
      headers: owner.headers,
      payload: { name: "Saturday shift", weekStartsOn: 6 },
    });
    // one supply row exists on this project now, so the boundary is settled
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already buckets its weeks");
  });
});
