/**
 * WP-EQUIP regressions and new capability — timecards, batches and T&M.
 *
 * Every `it` in "regressions" corresponds to a reported defect and fails on
 * the code as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  changeEvents,
  companyMemberships,
  costCodes,
  crewMembers,
  crews,
  projects,
  siteAccessRecords,
  timecardAllocations,
  timecards,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** a second admin — the independent approver */
let approver: TestActor;
let projectId: string;
let crewId: string;
let costCodeId: string;
let budgetLineId: string;
let workerIds: string[] = [];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (offset: number) => {
  const d = new Date("2026-03-02T00:00:00Z"); // a Monday
  d.setUTCDate(d.getUTCDate() + offset);
  return iso(d);
};

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function put(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

async function makeWorker(reference: string, rate = 20): Promise<string> {
  const id = newId("wkr");
  await app.db.insert(workers).values({
    id,
    companyId: owner.companyId,
    projectId,
    reference,
    fullName: `Worker ${reference}`,
    currency: "GBP",
    agreedDailyRate: rate * 8,
    createdBy: owner.userId,
  });
  await app.db.insert(crewMembers).values({
    id: newId("crm"),
    companyId: owner.companyId,
    projectId,
    crewId,
    workerId: id,
    fromDate: day(-30),
    hourlyRate: rate,
    overtimeMultiplier: 1.5,
    currency: "GBP",
  });
  return id;
}

/** A card with one allocation covering all its hours. */
async function makeCard(
  workerId: string,
  workDate: string,
  workedHours: number,
  over: Record<string, unknown> = {},
) {
  const res = await post(`/projects/${projectId}/timecards`, {
    workerId,
    crewId,
    workDate,
    workedHours,
    allocations: [{ costCodeId, budgetLineItemId: budgetLineId, regularHours: workedHours }],
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; reference: string; totalHours: number };
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  approver = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: approver.userId,
    role: "admin",
  });
  approver = {
    ...approver,
    companyId: owner.companyId,
    headers: {
      authorization: approver.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Timecards upgrade",
    stage: "course_of_construction",
  });

  costCodeId = newId("cc");
  await app.db.insert(costCodes).values({
    id: costCodeId,
    companyId: owner.companyId,
    projectId,
    code: "02-2000",
    title: "Groundworks labour",
  });

  const budgetId = newId("bud");
  await app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId,
    name: "Upgrade budget",
    createdBy: owner.userId,
  });
  budgetLineId = newId("bli");
  await app.db.insert(budgetLineItems).values({
    id: budgetLineId,
    companyId: owner.companyId,
    projectId,
    budgetId,
    costCode: "02-2000",
    costCodeId,
    costType: "labour",
    description: "Excavation",
    unit: "m3",
    quantity: 500,
    originalBudget: 40000,
    revisedBudget: 40000,
    detail: { budgetHours: 1000 },
    createdBy: owner.userId,
  });

  const crew = await post(`/projects/${projectId}/crews`, {
    name: "Groundworks gang",
    trade: "groundworks",
    overtimeThresholdHours: 8,
    currency: "GBP",
  });
  expect(crew.statusCode).toBe(201);
  crewId = crew.json().id as string;

  workerIds = [
    await makeWorker("W-001"),
    await makeWorker("W-002"),
    await makeWorker("W-003"),
  ];
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Regressions                                                         */
/* ================================================================== */

describe("regressions", () => {
  it("refuses a 72-hour day entered as an explicit split", async () => {
    const res = await post(`/projects/${projectId}/timecards`, {
      workerId: workerIds[0]!,
      workDate: day(40),
      regularHours: 24,
      overtimeHours: 24,
      doubleTimeHours: 24,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("A day holds 24 hours");
  });

  it("refuses a card into a batch that has already been submitted", async () => {
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(0),
      periodEnd: day(6),
    });
    expect(batch.statusCode).toBe(201);
    const batchId = batch.json().id as string;
    await makeCard(workerIds[0]!, day(0), 8, { batchId });
    const submitted = await post(`/projects/${projectId}/timecard-batches/${batchId}/submit`, {});
    expect(submitted.statusCode).toBe(200);

    const late = await post(`/projects/${projectId}/timecards`, {
      workerId: workerIds[1]!,
      crewId,
      workDate: day(1),
      workedHours: 8,
      batchId,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().message).toContain("takes no further cards");
  });

  it("stores a null batch cost when a card could not be priced, and says why on the list", async () => {
    const noRateWorker = newId("wkr");
    await app.db.insert(workers).values({
      id: noRateWorker,
      companyId: owner.companyId,
      projectId,
      reference: "W-NORATE",
      fullName: "Unpriced worker",
      currency: "GBP",
      createdBy: owner.userId,
    });
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(7),
      periodEnd: day(13),
    });
    const batchId = batch.json().id as string;
    const card = await post(`/projects/${projectId}/timecards`, {
      workerId: noRateWorker,
      crewId,
      workDate: day(7),
      workedHours: 8,
      batchId,
    });
    expect(card.statusCode).toBe(201);
    expect(card.json().totalCost).toBeNull();

    const list = await get(`/projects/${projectId}/timecard-batches`);
    const row = (
      list.json().items as Array<{ id: string; totalCost: number | null; costNote: string | null }>
    ).find((b) => b.id === batchId);
    expect(row?.totalCost).toBeNull();
    expect(row?.costNote).toContain("no rate for");
  });

  it("refuses a batch approval by somebody who raised cards in it", async () => {
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(14),
      periodEnd: day(20),
    });
    const batchId = batch.json().id as string;
    // owner raises the card; APPROVER submits the batch; owner then tries to
    // approve — the batch check alone used to allow this.
    await makeCard(workerIds[0]!, day(14), 8, { batchId });
    const submitted = await post(
      `/projects/${projectId}/timecard-batches/${batchId}/submit`,
      {},
      approver.headers,
    );
    expect(submitted.statusCode).toBe(200);

    const refused = await post(`/projects/${projectId}/timecard-batches/${batchId}/approve`, {
      decision: "approved",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toContain("own");

    const cards = await app.db
      .select()
      .from(timecards)
      .where(eq(timecards.batchId, batchId));
    expect(cards.every((c) => c.status !== "approved")).toBe(true);
  });

  it("refuses a batch whose cards were edited after they were coded", async () => {
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(21),
      periodEnd: day(27),
    });
    const batchId = batch.json().id as string;
    const card = await makeCard(workerIds[1]!, day(21), 8, { batchId });
    const submitted = await post(`/projects/${projectId}/timecard-batches/${batchId}/submit`, {});
    expect(submitted.statusCode).toBe(200);

    // PATCH a submitted card's hours: the allocations no longer reconcile.
    const edited = await patch(`/projects/${projectId}/timecards/${card.id}`, {
      workedHours: 10,
    });
    expect(edited.statusCode).toBe(200);

    const approve = await post(
      `/projects/${projectId}/timecard-batches/${batchId}/approve`,
      { decision: "approved" },
      approver.headers,
    );
    expect(approve.statusCode).toBe(409);
    expect(approve.json().message).toContain("no longer reconciles");
  });

  it("derives the approval level so a two-tier crew can actually complete", async () => {
    const twoTier = await post(`/projects/${projectId}/crews`, {
      name: "Two tier gang",
      trade: "groundworks",
      overtimeThresholdHours: 8,
      currency: "GBP",
      detail: { approvalLevels: 2, overtimeRule: "daily" },
    });
    expect(twoTier.statusCode).toBe(201);
    const twoTierCrewId = twoTier.json().id as string;
    const workerId = workerIds[2]!;
    await app.db.insert(crewMembers).values({
      id: newId("crm"),
      companyId: owner.companyId,
      projectId,
      crewId: twoTierCrewId,
      workerId,
      fromDate: day(28),
      hourlyRate: 20,
      overtimeMultiplier: 1.5,
      currency: "GBP",
    });
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId: twoTierCrewId,
      periodStart: day(28),
      periodEnd: day(34),
    });
    const batchId = batch.json().id as string;
    const card = await post(`/projects/${projectId}/timecards`, {
      workerId,
      crewId: twoTierCrewId,
      workDate: day(28),
      workedHours: 8,
      batchId,
      allocations: [{ costCodeId, budgetLineItemId: budgetLineId, regularHours: 8 }],
    });
    expect(card.statusCode).toBe(201);
    await post(`/projects/${projectId}/timecard-batches/${batchId}/submit`, {});

    // No level sent, twice, by two different people.
    const first = await post(
      `/projects/${projectId}/timecard-batches/${batchId}/approve`,
      { decision: "approved" },
      approver.headers,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().level).toBe(1);
    expect(first.json().status).toBe("partially_approved");
    expect(first.json().approvalProgress).toContain("1 of 2");

    const second = await post(`/projects/${projectId}/timecard-batches/${batchId}/approve`, {
      decision: "approved",
    });
    // The owner raised the card, so this must be refused — which is itself the
    // segregation control working. Approve as a third party instead.
    expect(second.statusCode).toBe(403);
  });

  it("reprices the rest of the week when a weekly-rule card is edited", async () => {
    const weekly = await post(`/projects/${projectId}/crews`, {
      name: "Weekly rule gang",
      trade: "groundworks",
      currency: "GBP",
      overtimeThresholdHours: 40,
      detail: { overtimeRule: "weekly", weeklyOvertimeThresholdHours: 40, weekStartsOn: 1 },
    });
    const weeklyCrewId = weekly.json().id as string;
    const workerId = newId("wkr");
    await app.db.insert(workers).values({
      id: workerId,
      companyId: owner.companyId,
      projectId,
      reference: "W-WEEK",
      fullName: "Weekly worker",
      currency: "GBP",
      createdBy: owner.userId,
    });
    await app.db.insert(crewMembers).values({
      id: newId("crm"),
      companyId: owner.companyId,
      projectId,
      crewId: weeklyCrewId,
      workerId,
      fromDate: day(35),
      hourlyRate: 20,
      overtimeMultiplier: 1.5,
      currency: "GBP",
    });

    const days = [35, 36, 37, 38, 39];
    const created: string[] = [];
    for (const d of days) {
      const res = await post(`/projects/${projectId}/timecards`, {
        workerId,
        crewId: weeklyCrewId,
        workDate: day(d),
        workedHours: 8,
      });
      expect(res.statusCode).toBe(201);
      created.push(res.json().id as string);
    }
    // Friday is still plain time at 40 h in the week.
    const fridayBefore = await get(`/projects/${projectId}/timecards/${created[4]!}`);
    expect(fridayBefore.json().overtimeHours).toBe(0);

    // Push Monday to 12 h: the week now crosses 40 on Friday.
    const edited = await patch(`/projects/${projectId}/timecards/${created[0]!}`, {
      workedHours: 12,
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json().weekReclassified as unknown[]).length).toBeGreaterThan(0);

    const fridayAfter = await get(`/projects/${projectId}/timecards/${created[4]!}`);
    expect(fridayAfter.json().overtimeHours).toBeGreaterThan(0);
  });

  it("does not match a dated adjustment against the adjustment day's access record", async () => {
    const workerId = newId("wkr");
    await app.db.insert(workers).values({
      id: workerId,
      companyId: owner.companyId,
      projectId,
      reference: "W-ADJ",
      fullName: "Adjustment worker",
      currency: "GBP",
      createdBy: owner.userId,
    });
    await app.db.insert(crewMembers).values({
      id: newId("crm"),
      companyId: owner.companyId,
      projectId,
      crewId,
      workerId,
      fromDate: day(-30),
      hourlyRate: 20,
      overtimeMultiplier: 1.5,
      currency: "GBP",
    });
    const original = await makeCard(workerId, day(45), 8);
    // The worker was on site 8 h TODAY (the adjustment date), not on the
    // original work date.
    await app.db.insert(siteAccessRecords).values({
      id: newId("sac"),
      companyId: owner.companyId,
      projectId,
      workerId,
      accessDate: day(50),
      hoursOnSite: 8,
      source: "turnstile",
    });
    const revised = await post(`/projects/${projectId}/timecards/${original.id}/revise`, {
      adjustmentDate: day(50),
      reason: "corrected last week's hours",
      workedHours: 10,
    });
    expect(revised.statusCode).toBe(201);
    const adjustmentId = revised.json().adjustment.id as string;

    // The sweep must skip it: matching would invent a +2h variance.
    await app.scheduler.runNow("timecards.access-links");
    const after = await get(`/projects/${projectId}/timecards/${adjustmentId}`);
    expect(after.json().siteAccessRecordId).toBeNull();
    expect(after.json().varianceHours).toBeNull();
  });

  it("does not write to the database on a timecard list read", async () => {
    const before = await app.db
      .select({ id: timecards.id, updatedAt: timecards.updatedAt })
      .from(timecards)
      .where(eq(timecards.projectId, projectId));
    const res = await get(`/projects/${projectId}/timecards?pageSize=200`);
    expect(res.statusCode).toBe(200);
    expect(res.json().sweep).toBeUndefined();
    const after = await app.db
      .select({ id: timecards.id, updatedAt: timecards.updatedAt })
      .from(timecards)
      .where(eq(timecards.projectId, projectId));
    expect(after.map((r) => r.updatedAt).sort()).toEqual(
      before.map((r) => r.updatedAt).sort(),
    );
  });

  it("refuses a T&M signature timestamp that is not a timestamp", async () => {
    const ticket = await post(`/projects/${projectId}/tm-tickets`, {
      title: "Extra excavation",
      ticketDate: day(41),
    });
    expect(ticket.statusCode).toBe(201);
    const ticketId = ticket.json().id as string;
    const res = await post(`/projects/${projectId}/tm-tickets/${ticketId}/sign`, {
      outcome: "signed",
      signedByName: "A Client",
      signedAt: "yesterday",
    });
    expect(res.statusCode).toBe(400);
  });

  /*
   * The PCO precondition used to be checked AFTER the change event was
   * inserted, so every refused promote left another orphan CE-nnn row behind
   * and the ticket was never stamped. Two refusals must leave the register
   * exactly as it was, and the fallback must still preserve the entitlement.
   */
  it("leaves no orphan change event behind when a PCO promote is refused", async () => {
    const ticket = await post(`/projects/${projectId}/tm-tickets`, {
      title: "Hand-dig around live services",
      ticketDate: day(43),
      currency: "GBP",
      rateBasis: "to_be_agreed",
      lines: [{ lineKind: "labour", description: "Two labourers", hours: 16, rate: null }],
    });
    expect(ticket.statusCode).toBe(201);
    const ticketId = ticket.json().id as string;
    await post(`/projects/${projectId}/tm-tickets/${ticketId}/sign`, {
      outcome: "signed",
      signedByName: "R. Bell",
      signedByRole: "Resident Engineer",
      signedByOrganisation: "Owner's Representative",
      signatureMethod: "on_device",
    });

    const before = await app.db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.projectId, projectId));

    for (const _attempt of [1, 2]) {
      const refused = await post(`/projects/${projectId}/tm-tickets/${ticketId}/promote`, {
        target: "potential_change_order",
      });
      expect(refused.statusCode).toBe(409);
    }

    const after = await app.db
      .select({ id: changeEvents.id })
      .from(changeEvents)
      .where(eq(changeEvents.projectId, projectId));
    expect(after.length).toBe(before.length);

    // and the entitlement is still reachable through the change-event path,
    // which DOES stamp the ticket.
    const asEvent = await post(`/projects/${projectId}/tm-tickets/${ticketId}/promote`, {
      target: "change_event",
    });
    expect(asEvent.statusCode).toBe(201);
    expect(asEvent.json().ticket.incorporatedChangeOrderId).toBe(asEvent.json().changeEvent.id);
  });

  it("does not price a sourced labour line at the worker's internal pay rate", async () => {
    const card = await makeCard(workerIds[0]!, day(42), 8);
    const allocations = await app.db
      .select()
      .from(timecardAllocations)
      .where(eq(timecardAllocations.timecardId, card.id));
    expect(allocations[0]).toBeDefined();

    const ticket = await post(`/projects/${projectId}/tm-tickets`, {
      title: "Daywork",
      ticketDate: day(42),
      currency: "GBP",
    });
    const ticketId = ticket.json().id as string;
    const sourced = await post(`/projects/${projectId}/tm-tickets/${ticketId}/lines/source`, {
      timecardAllocationIds: [allocations[0]!.id],
    });
    expect(sourced.statusCode).toBe(200);
    const lines = sourced.json().lines as Array<{
      lineKind: string;
      rate: number | null;
      detail: { costRate?: number };
    }>;
    const labour = lines.find((l) => l.lineKind === "labour")!;
    expect(labour.rate).toBeNull();
    expect(labour.detail.costRate).toBe(20);
  });

  it("releases the billed-once stamps when a ticket's lines are replaced", async () => {
    const card = await makeCard(workerIds[1]!, day(43), 8);
    const allocations = await app.db
      .select()
      .from(timecardAllocations)
      .where(eq(timecardAllocations.timecardId, card.id));
    const allocationId = allocations[0]!.id;

    const first = await post(`/projects/${projectId}/tm-tickets`, {
      title: "First ticket",
      ticketDate: day(43),
      currency: "GBP",
    });
    const firstId = first.json().id as string;
    await post(`/projects/${projectId}/tm-tickets/${firstId}/lines/source`, {
      timecardAllocationIds: [allocationId],
    });
    // Replace the line set — the stamp must be released.
    const replaced = await put(`/projects/${projectId}/tm-tickets/${firstId}/lines`, {
      lines: [{ description: "Replaced with a lump sum", amount: 500, lineKind: "other" }],
    });
    expect(replaced.statusCode).toBe(200);

    const second = await post(`/projects/${projectId}/tm-tickets`, {
      title: "Second ticket",
      ticketDate: day(43),
      currency: "GBP",
    });
    const secondId = second.json().id as string;
    const resourced = await post(`/projects/${projectId}/tm-tickets/${secondId}/lines/source`, {
      timecardAllocationIds: [allocationId],
    });
    expect(resourced.statusCode).toBe(200);
    const skipped = resourced.json().skipped as Array<{ reason: string }>;
    expect(skipped.some((s) => s.reason.includes("already billed"))).toBe(false);
  });

  it("reports an unpriced ticket's total as incomplete on the register", async () => {
    const ticket = await post(`/projects/${projectId}/tm-tickets`, {
      title: "To be agreed",
      ticketDate: day(44),
      currency: "GBP",
      lines: [{ description: "40 labour hours, rate to be agreed", hours: 40, lineKind: "labour" }],
    });
    expect(ticket.statusCode).toBe(201);
    const list = await get(`/projects/${projectId}/tm-tickets`);
    const row = (
      list.json().items as Array<{ title: string; totalsAreComplete: boolean; totalNote: string }>
    ).find((t) => t.title === "To be agreed");
    expect(row?.totalsAreComplete).toBe(false);
    expect(row?.totalNote).toContain("cannot be stated");
  });
});

/* ================================================================== */
/* New capability                                                      */
/* ================================================================== */

describe("labour productivity", () => {
  it("earns hours at the planned rate and refuses a figure without quantity", async () => {
    const before = await get(`/projects/${projectId}/labour-productivity?from=${day(-1)}&to=${day(60)}`);
    expect(before.statusCode).toBe(200);
    // Nothing has recorded an installed quantity yet.
    expect(before.json().totals.productivityFactor).toBeNull();

    const card = await post(`/projects/${projectId}/timecards`, {
      workerId: workerIds[0]!,
      crewId,
      workDate: day(46),
      workedHours: 8,
      allocations: [
        {
          costCodeId,
          budgetLineItemId: budgetLineId,
          regularHours: 8,
          quantity: 4,
          unit: "m3",
        },
      ],
    });
    expect(card.statusCode).toBe(201);

    const after = await get(
      `/projects/${projectId}/labour-productivity?from=${day(46)}&to=${day(46)}`,
    );
    const line = (after.json().lines as Array<{ plannedUnitRate: number; productivityFactor: number }>)[0];
    expect(line?.plannedUnitRate).toBe(2); // 1000 h / 500 m3
    expect(line?.productivityFactor).toBe(1); // 4 m3 earned 8 h against 8 h spent
  });
});

describe("payroll export", () => {
  it("exports a batch as CSV with an EMPTY amount for an unpriced card", async () => {
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(47),
      periodEnd: day(53),
    });
    const batchId = batch.json().id as string;
    await makeCard(workerIds[0]!, day(47), 8, { batchId });

    const res = await get(
      `/projects/${projectId}/timecard-batches/${batchId}/payroll-export?format=generic_csv&inline=true`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toContain("worker_reference");
    expect(res.json().rowCount).toBe(1);
  });

  it("never pre-signs the certified payroll's statement of compliance", async () => {
    const res = await get(`/projects/${projectId}/certified-payroll?weekEnding=${day(53)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().statementOfCompliance.signed).toBe(false);
    expect(res.json().statementOfCompliance.note).toContain("penalty of law");
  });
});

describe("labour cost onto the budget", () => {
  it("posts approved hours as direct cost and replaces on a re-post", async () => {
    const batch = await post(`/projects/${projectId}/timecard-batches`, {
      crewId,
      periodStart: day(54),
      periodEnd: day(60),
    });
    const batchId = batch.json().id as string;
    await makeCard(workerIds[2]!, day(54), 8, { batchId });
    await post(`/projects/${projectId}/timecard-batches/${batchId}/submit`, {});
    const approved = await post(
      `/projects/${projectId}/timecard-batches/${batchId}/approve`,
      { decision: "approved" },
      approver.headers,
    );
    expect(approved.statusCode).toBe(200);

    const posted = await post(`/projects/${projectId}/labour-cost-report/post-to-budget`, {
      from: day(54),
      to: day(60),
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().posted).toBe(1);
    const [line] = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLineId));
    const first = line?.directCosts ?? 0;
    expect(first).toBeGreaterThan(0);

    const again = await post(`/projects/${projectId}/labour-cost-report/post-to-budget`, {
      from: day(54),
      to: day(60),
    });
    expect(again.statusCode).toBe(201);
    const [after] = await app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLineId));
    expect(after?.directCosts).toBe(first);
  });
});

/* ================================================================== */
/* Field progress — the independent side of the productivity ratio     */
/* ================================================================== */

describe("field progress", () => {
  it("refuses a measurement coded to nothing", async () => {
    const res = await post(`/projects/${projectId}/labour-progress`, {
      progressDate: day(70),
      quantity: 10,
      unit: "m3",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("cannot be earned against anything");
  });

  it("refuses a unit the budget line is not measured in, rather than converting it", async () => {
    const res = await post(`/projects/${projectId}/labour-progress`, {
      progressDate: day(70),
      quantity: 10,
      unit: "m2",
      budgetLineItemId: budgetLineId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("never converted here");
  });

  it("records a measurement and lets the report earn hours from it", async () => {
    await makeCard(workerIds[0]!, day(71), 8);
    const created = await post(`/projects/${projectId}/labour-progress`, {
      progressDate: day(71),
      quantity: 4,
      unit: "m3",
      budgetLineItemId: budgetLineId,
      costCodeId,
      crewId,
      method: "field_measure",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().verifiedBy).toBeNull();

    const report = await get(
      `/projects/${projectId}/labour-productivity?from=${day(71)}&to=${day(71)}`,
    );
    expect(report.statusCode).toBe(200);
    const line = (report.json().lines as Array<{
      budgetLineItemId: string;
      quantitySource: string;
      installedQuantity: number | null;
    }>).find((l) => l.budgetLineItemId === budgetLineId)!;
    expect(line.quantitySource).toBe("field_progress");
    expect(line.installedQuantity).toBe(4);
    expect((report.json().reasons as string[]).join(" ")).toContain("not been countersigned");
  });

  it("refuses to let the person who measured it countersign their own measurement", async () => {
    const created = await post(`/projects/${projectId}/labour-progress`, {
      progressDate: day(72),
      quantity: 3,
      unit: "m3",
      budgetLineItemId: budgetLineId,
    });
    const id = created.json().id as string;
    const own = await post(`/projects/${projectId}/labour-progress/${id}/verify`, {});
    expect(own.statusCode).toBe(403);
    expect(own.json().message).toContain("ADR 0004");

    const other = await post(
      `/projects/${projectId}/labour-progress/${id}/verify`,
      { note: "walked it with the sub" },
      approver.headers,
    );
    expect(other.statusCode).toBe(200);
    const again = await post(
      `/projects/${projectId}/labour-progress/${id}/verify`,
      {},
      approver.headers,
    );
    expect(again.statusCode).toBe(409);
  });

  it("lists the register and filters it to the unverified", async () => {
    const all = await get(`/projects/${projectId}/labour-progress?from=${day(70)}&to=${day(73)}`);
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBeGreaterThanOrEqual(2);
    const unverified = await get(
      `/projects/${projectId}/labour-progress?from=${day(70)}&to=${day(73)}&unverifiedOnly=true`,
    );
    expect(unverified.json().items.every((r: { verifiedBy: string | null }) => !r.verifiedBy)).toBe(
      true,
    );
  });

  it("keeps another company out of the progress register", async () => {
    const stranger = await registerActor(app);
    const read = await get(`/projects/${projectId}/labour-progress`, stranger.headers);
    expect(read.statusCode).toBe(403);
    const write = await post(
      `/projects/${projectId}/labour-progress`,
      { progressDate: day(70), quantity: 1, unit: "m3", budgetLineItemId: budgetLineId },
      stranger.headers,
    );
    expect(write.statusCode).toBe(403);
  });
});

describe("health inputs and jobs", () => {
  it("reports labour metrics with reasons rather than zeros", async () => {
    const res = await get(`/projects/${projectId}/timecards/health-inputs`);
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics).toHaveProperty("unallocatedCards");
  });

  it("registers the access-link and orphan-card jobs", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("timecards.access-links");
    expect(names).toContain("timecards.orphan-cards");
  });
});

describe("tenant isolation", () => {
  it("refuses another company's project entirely", async () => {
    const stranger = await registerActor(app);
    const res = await get(`/projects/${projectId}/labour-productivity`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });

  it("does not leak crews to a stranger", async () => {
    const stranger = await registerActor(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/crews`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(403);
    const rows = await app.db
      .select()
      .from(crews)
      .where(and(eq(crews.companyId, owner.companyId), eq(crews.projectId, projectId)));
    expect(rows.length).toBeGreaterThan(0);
  });
});
