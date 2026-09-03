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
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Sunday shift project",
    stage: "construction",
    currency: "USD",
  });

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

  it("falls back to Monday when no plan is active", async () => {
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
    expect(res.json().weekStart).toBe("2026-12-07"); // the Monday
  });
});
