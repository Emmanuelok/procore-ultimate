import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  companyMemberships,
  costCodes,
  equipment,
  equipmentUtilisation,
  ledgerEntries,
  projects,
  signals,
  siteAccessRecords,
  timecardApprovals,
  timecards,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
/** company owner — author and submitter throughout */
let u1: TestActor;
/** company admin — the INDEPENDENT approver every segregation test needs */
let u2: TestActor;
let outsider: TestActor;
let h1: Record<string, string>;
let h2: Record<string, string>;

let proj: string;
let vendorId: string;
let ccSlab: string;
let ccColumns: string;
let blLabour: string;
let blConcrete: string;

/** the register — this module creates no second person table */
let wFixer: string;
let wLabourer: string;
let wOperator: string;

type Body = Record<string, unknown>;

const inject = (
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  headers: Record<string, string>,
  payload?: Body,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

const post = (url: string, headers: Record<string, string>, payload?: Body) =>
  inject("POST", `/api/v1/projects/${proj}${url}`, headers, payload);
const get = (url: string, headers: Record<string, string> = h1) =>
  inject("GET", `/api/v1/projects/${proj}${url}`, headers);
const put = (url: string, headers: Record<string, string>, payload?: Body) =>
  inject("PUT", `/api/v1/projects/${proj}${url}`, headers, payload);
const patch = (url: string, headers: Record<string, string>, payload?: Body) =>
  inject("PATCH", `/api/v1/projects/${proj}${url}`, headers, payload);

async function makeWorker(reference: string, fullName: string): Promise<string> {
  const id = newId("wkr");
  await built.app.db.insert(workers).values({
    id,
    companyId: u1.companyId,
    projectId: proj,
    reference,
    fullName,
    vendorId,
    trade: "concrete",
    currency: "USD",
    createdBy: u1.userId,
  });
  return id;
}

async function access(workerId: string, date: string, hours: number | null, times?: [string, string]) {
  await built.app.db
    .insert(siteAccessRecords)
    .values({
      id: newId("sac"),
      companyId: u1.companyId,
      projectId: proj,
      workerId,
      accessDate: date,
      firstIn: times?.[0] ?? null,
      lastOut: times?.[1] ?? null,
      hoursOnSite: hours,
      source: "turnstile",
    })
    .onConflictDoNothing();
}

/** A crew on the DAILY rule: overtime over 8 h, double time over 12 h. */
async function makeDailyCrew(name: string, extra: Record<string, unknown> = {}) {
  const res = await post("/crews", h1, {
    name,
    trade: "concrete",
    vendorId,
    standardHoursPerDay: 8,
    overtimeThresholdHours: 8,
    config: { overtimeRule: "daily", doubleTimeThresholdHours: 12 },
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; reference: string };
}

async function addMember(crewId: string, workerId: string, fromDate: string, extra: Record<string, unknown> = {}) {
  return post(`/crews/${crewId}/members`, h1, {
    workerId,
    fromDate,
    roleInCrew: "operative",
    hourlyRate: 30,
    overtimeMultiplier: 1.5,
    doubleTimeMultiplier: 2,
    burdenRate: 1.3,
    currency: "USD",
    ...extra,
  });
}

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app, { companyName: "Timecard Co" });
  u2 = await registerActor(built.app);
  outsider = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: u1.companyId,
    userId: u2.userId,
    role: "admin",
  });
  h1 = u1.headers;
  h2 = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };

  proj = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: proj, companyId: u1.companyId, name: "Podium Slab", currency: "USD" });

  vendorId = newId("vnd");
  await built.app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: u1.companyId, name: "Concrete Sub Ltd" });

  ccSlab = newId("cc");
  ccColumns = newId("cc");
  await built.app.db.insert(costCodes).values([
    { id: ccSlab, companyId: u1.companyId, projectId: proj, code: "03300", title: "Slab" },
    { id: ccColumns, companyId: u1.companyId, projectId: proj, code: "03310", title: "Columns" },
  ]);

  const budgetId = newId("bud");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: u1.companyId,
    projectId: proj,
    number: 1,
    reference: "BUD-001",
    name: "Live budget",
    isActive: 1,
    createdBy: u1.userId,
  });
  blLabour = newId("bli");
  blConcrete = newId("bli");
  await built.app.db.insert(budgetLineItems).values([
    {
      id: blLabour,
      budgetId,
      companyId: u1.companyId,
      projectId: proj,
      costCodeId: ccSlab,
      costCode: "03300",
      costType: "labour",
      description: "Slab labour",
      revisedBudget: 250_000,
      createdBy: u1.userId,
    },
    {
      id: blConcrete,
      budgetId,
      companyId: u1.companyId,
      projectId: proj,
      costCodeId: ccColumns,
      costCode: "03310",
      costType: "labour",
      description: "Column labour",
      revisedBudget: 90_000,
      createdBy: u1.userId,
    },
  ]);

  wFixer = await makeWorker("W-001", "Amara Okafor");
  wLabourer = await makeWorker("W-002", "Dmitri Vasiliev");
  wOperator = await makeWorker("W-003", "Grace Mwangi");
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Crews and dated membership                                          */
/* ------------------------------------------------------------------ */

describe("crews and dated membership", () => {
  it("creates a crew that carries its overtime rule in words, and dates its membership", async () => {
    const crew = await makeDailyCrew("Slab gang");
    const detail = await get(`/crews/${crew.id}`);
    expect(detail.json().overtimeRule).toMatchObject({ kind: "daily", thresholdHours: 8 });
    expect(detail.json().overtimeRuleExplanation).toContain("beyond 8 per day");
    expect(detail.json().canClassifyHours).toBe(true);

    const m = await addMember(crew.id, wFixer, "2026-03-02", { toDate: "2026-03-06" });
    expect(m.statusCode).toBe(201);
    expect(m.json()).toMatchObject({ fromDate: "2026-03-02", toDate: "2026-03-06" });

    // membership is dated, so the crew ON A DATE is answerable historically
    const during = await get(`/crews/${crew.id}/members?onDate=2026-03-04`);
    expect(during.json().items).toHaveLength(1);
    const after = await get(`/crews/${crew.id}/members?onDate=2026-03-10`);
    expect(after.json().items).toHaveLength(0);
  });

  it("refuses a membership that overlaps another crew, naming the clash", async () => {
    const a = await makeDailyCrew("Overlap A");
    const b = await makeDailyCrew("Overlap B");
    expect((await addMember(a.id, wLabourer, "2026-04-01")).statusCode).toBe(201);
    const clash = await addMember(b.id, wLabourer, "2026-04-10");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toContain("already a member of crew");
    expect(clash.json().message).toContain("one crew on any given day");
  });

  it("answers which crew a worker was in on a date, and abstains with a reason when none", async () => {
    const hit = await get(`/crew-membership?workerId=${wLabourer}&onDate=2026-04-15`);
    expect(hit.json().crew?.name).toBe("Overlap A");
    expect(hit.json().reasons).toEqual([]);

    const miss = await get(`/crew-membership?workerId=${wLabourer}&onDate=2025-01-01`);
    expect(miss.json().crew).toBeNull();
    expect(miss.json().reasons.join(" ")).toContain("was not attributed to a crew that day");
    expect(miss.json().history.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Hour classification through the API                                 */
/* ------------------------------------------------------------------ */

describe("timecards — classification and the unique triple", () => {
  let crewId: string;

  beforeAll(async () => {
    const crew = await makeDailyCrew("Classify gang");
    crewId = crew.id;
    await addMember(crewId, wOperator, "2026-05-01");
  });

  it("classifies 10 worked hours under the crew's daily rule and returns the rule applied", async () => {
    const res = await post("/timecards", h1, {
      workerId: wOperator,
      workDate: "2026-05-04",
      crewId,
      workedHours: 10,
      source: "crew_sheet",
    });
    expect(res.statusCode).toBe(201);
    const card = res.json();
    expect(card).toMatchObject({ regularHours: 8, overtimeHours: 2, doubleTimeHours: 0, totalHours: 10 });
    expect(card.detail.hourClassification.method).toBe("classified_from_worked_hours");
    expect(card.detail.hourClassification.rule).toMatchObject({ kind: "daily", thresholdHours: 8 });
    // rates come off the crew membership; 8×30 + 2×45 = 330, ×1.3 burden
    expect(card.totalCost).toBe(429);
  });

  it("derives hours from clock times, net of the break, and refuses a duplicate triple", async () => {
    const res = await post("/timecards", h1, {
      workerId: wOperator,
      workDate: "2026-05-05",
      crewId,
      startTime: "07:00",
      endTime: "17:30",
      breakMinutes: 30,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ regularHours: 8, overtimeHours: 2, totalHours: 10 });

    const dup = await post("/timecards", h1, {
      workerId: wOperator,
      workDate: "2026-05-05",
      crewId,
      workedHours: 8,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toContain("One worker, one day, one shift");
  });

  it("refuses to classify against a crew that records no overtime threshold", async () => {
    const res = await post("/crews", h1, {
      name: "Unconfigured gang",
      config: { overtimeRule: "daily" },
    });
    const unconfigured = res.json();
    await addMember(unconfigured.id, wLabourer, "2026-06-01");
    const card = await post("/timecards", h1, {
      workerId: wLabourer,
      workDate: "2026-06-02",
      crewId: unconfigured.id,
      workedHours: 10,
    });
    expect(card.statusCode).toBe(400);
    expect(card.json().message).toContain("records no overtime threshold");
    expect(card.json().details.control).toBe("hour_classification");
  });

  it("applies a WEEKLY rule across the pay week, and reprices the week when a day is added", async () => {
    const crew = (
      await post("/crews", h1, {
        name: "Weekly gang",
        overtimeThresholdHours: 8,
        config: { overtimeRule: "weekly", weeklyOvertimeThresholdHours: 40, weekStartsOn: 1 },
      })
    ).json();
    const worker = await makeWorker("W-100", "Weekly Worker");
    await addMember(crew.id, worker, "2026-07-01", { hourlyRate: 20, overtimeMultiplier: 1.5 });

    // Mon–Thu, 10 h a day: 40 h banked, none of it overtime under a weekly rule
    for (const [i, date] of ["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09"].entries()) {
      const r = await post("/timecards", h1, {
        workerId: worker,
        workDate: date,
        crewId: crew.id,
        workedHours: 10,
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().overtimeHours, `day ${i + 1}`).toBe(0);
      expect(r.json().regularHours).toBe(10);
    }
    // Friday's 10 h sit entirely above 40 — all overtime
    const friday = await post("/timecards", h1, {
      workerId: worker,
      workDate: "2026-07-10",
      crewId: crew.id,
      workedHours: 10,
    });
    expect(friday.json()).toMatchObject({ regularHours: 0, overtimeHours: 10 });
    expect(friday.json().detail.hourClassification.rule).toMatchObject({
      kind: "weekly",
      basis: "week",
      cumulativeFrom: 40,
      cumulativeTo: 50,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Allocations — the join to the cost report                           */
/* ------------------------------------------------------------------ */

describe("allocations must reconcile", () => {
  let crewId: string;
  let cardId: string;

  beforeAll(async () => {
    const crew = await makeDailyCrew("Coding gang");
    crewId = crew.id;
    const worker = await makeWorker("W-200", "Coding Worker");
    await addMember(crewId, worker, "2026-08-01");
    cardId = (
      await post("/timecards", h1, {
        workerId: worker,
        workDate: "2026-08-03",
        crewId,
        workedHours: 10,
      })
    ).json().id;
  });

  it("refuses an allocation set that does not reconcile, naming the difference", async () => {
    const short = await put(`/timecards/${cardId}/allocations`, h1, {
      allocations: [
        { costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8 },
        { costCodeId: ccColumns, budgetLineItemId: blConcrete, overtimeHours: 1.5 },
      ],
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().message).toContain("9.5 hour(s) allocated against 10 hour(s) claimed");
    expect(short.json().message).toContain("short by 0.5 hour(s)");
    expect(short.json().details.control).toBe("allocations_must_reconcile");
    expect(short.json().details.differences).toContainEqual({
      bucket: "overtimeHours",
      claimed: 2,
      allocated: 1.5,
      difference: -0.5,
    });

    // and a set that balances on the total but moves hours between treatments
    const shuffled = await put(`/timecards/${cardId}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 10 }],
    });
    expect(shuffled.statusCode).toBe(400);
    expect(shuffled.json().message).toContain("balance in total but not by pay treatment");
  });

  it("refuses an allocation that names neither a cost code nor a budget line", async () => {
    const res = await put(`/timecards/${cardId}/allocations`, h1, {
      allocations: [{ regularHours: 8 }, { overtimeHours: 2 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("names neither a cost code nor a budget line");
  });

  it("accepts a reconciling set and lands the hours on the budget line", async () => {
    const ok = await put(`/timecards/${cardId}/allocations`, h1, {
      allocations: [
        { costCodeId: ccSlab, costCode: "03300", budgetLineItemId: blLabour, regularHours: 5 },
        {
          costCodeId: ccColumns,
          costCode: "03310",
          budgetLineItemId: blConcrete,
          regularHours: 3,
          overtimeHours: 2,
        },
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().check.ok).toBe(true);
    expect(ok.json().allocations).toHaveLength(2);

    const report = await get(`/labour-cost-report?from=2026-08-01&to=2026-08-31`);
    const slab = report.json().lines.find((l: { budgetLineItemId: string }) => l.budgetLineItemId === blLabour);
    expect(slab).toMatchObject({ totalHours: 5, onBudget: true, currency: "USD" });
    expect(report.json().totals.totalHours).toBe(10);
    expect(report.json().totals.uncodedHours).toBe(0);
    expect(report.json().note).toContain("does not write");
  });

  it("refuses submission of a card with no cost coding at all", async () => {
    const worker = await makeWorker("W-201", "Uncoded Worker");
    await addMember(crewId, worker, "2026-08-01");
    const card = (
      await post("/timecards", h1, { workerId: worker, workDate: "2026-08-04", crewId, workedHours: 8 })
    ).json();
    const res = await post(`/timecards/${card.id}/submit`, h1, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("hours nobody can code");

    const report = await get(`/labour-cost-report?from=2026-08-04&to=2026-08-04`);
    expect(report.json().totals.uncodedHours).toBe(8);
    expect(report.json().uncodedTimecards[0].reference).toBe(card.reference);
  });
});

/* ------------------------------------------------------------------ */
/* Segregation of duties                                               */
/* ------------------------------------------------------------------ */

describe("self-approval is refused AND recorded", () => {
  let cardId: string;
  let cardRef: string;

  beforeAll(async () => {
    const crew = await makeDailyCrew("Approval gang");
    const worker = await makeWorker("W-300", "Approval Worker");
    await addMember(crew.id, worker, "2026-09-01");
    const card = (
      await post("/timecards", h1, {
        workerId: worker,
        workDate: "2026-09-02",
        crewId: crew.id,
        workedHours: 8,
      })
    ).json();
    cardId = card.id;
    cardRef = card.reference;
    await put(`/timecards/${cardId}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8 }],
    });
    await post(`/timecards/${cardId}/submit`, h1, {});
  });

  it("refuses the submitter's own approval, records the attempt, and raises a signal", async () => {
    const res = await post(`/timecards/${cardId}/approve`, h1, { decision: "approved" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("the person who submitted this timecard may not approve it");
    expect(res.json().message).toContain("has been recorded as approval");
    expect(res.json().details).toMatchObject({ control: "no_self_approval", recorded: true });

    // the attempt is PROVABLE, not merely prevented
    const approvalId = res.json().details.approvalId as string;
    const [row] = await built.app.db
      .select()
      .from(timecardApprovals)
      .where(eq(timecardApprovals.id, approvalId));
    expect(row?.isSelfApproval).toBe(1);
    expect(row?.timecardId).toBe(cardId);
    expect((row?.detail as { outcome?: string })?.outcome).toBe("refused");

    const sigs = await built.app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, proj), eq(signals.detector, "timecard_self_approval")));
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect(sigs[0]?.severity).toBe("high");
    expect(sigs[0]?.explanation).toContain("classic labour fraud");

    // and the card did NOT move
    const card = await get(`/timecards/${cardId}`);
    expect(card.json().status).toBe("submitted");
    expect(card.json().approvedBy).toBeNull();
  });

  it("lets an independent approver approve the same card", async () => {
    const res = await post(`/timecards/${cardId}/approve`, h2, {
      decision: "approved",
      approverRole: "Superintendent",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().approvedBy).toBe(u2.userId);
    const recorded = res.json().approvals.filter((a: { isSelfApproval: number }) => a.isSelfApproval === 0);
    expect(recorded).toHaveLength(1);
    expect(cardRef).toMatch(/^TC-\d{3}$/);
  });
});

/* ------------------------------------------------------------------ */
/* Reconciliation against site access                                  */
/* ------------------------------------------------------------------ */

describe("claimed hours against site access", () => {
  let overclaimWorker: string;
  let gapWorker: string;
  let crewId: string;

  beforeAll(async () => {
    const crew = await makeDailyCrew("Access gang");
    crewId = crew.id;
    overclaimWorker = await makeWorker("W-400", "Overclaim Worker");
    gapWorker = await makeWorker("W-401", "No Turnstile Worker");
    await addMember(crewId, overclaimWorker, "2026-10-01");
    await addMember(crewId, gapWorker, "2026-10-01");
    for (const d of ["2026-10-05", "2026-10-06", "2026-10-07"]) {
      await access(overclaimWorker, d, 8);
    }
  });

  it("stores the variance and refuses approval of an unexplained overclaim", async () => {
    const card = (
      await post("/timecards", h1, {
        workerId: overclaimWorker,
        workDate: "2026-10-05",
        crewId,
        workedHours: 10,
      })
    ).json();
    expect(card.varianceHours).toBe(2);
    expect(card.accessHoursOnSite).toBe(8);
    expect(card.variance.withinTolerance).toBe(false);

    await put(`/timecards/${card.id}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8, overtimeHours: 2 }],
    });
    await post(`/timecards/${card.id}/submit`, h1, {});
    const blocked = await post(`/timecards/${card.id}/approve`, h2, { decision: "approved" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("recorded site presence");
    expect(blocked.json().message).toContain("explain-variance");

    const explained = await post(`/timecards/${card.id}/explain-variance`, h1, {
      varianceExplanation: "Two hours in the basement plant room; that door has no exit reader.",
    });
    expect(explained.statusCode).toBe(200);
    const approved = await post(`/timecards/${card.id}/approve`, h2, { decision: "approved" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");
  });

  it("returns a NULL variance with a reason where no access record exists — not a fraud finding", async () => {
    const card = (
      await post("/timecards", h1, {
        workerId: gapWorker,
        workDate: "2026-10-05",
        crewId,
        workedHours: 10,
      })
    ).json();
    expect(card.varianceHours).toBeNull();
    expect(card.accessHoursOnSite).toBeNull();
    expect(card.siteAccessRecordId).toBeNull();
    expect(card.variance.reasons.join(" ")).toContain("not zero hours on site");
    expect(card.variance.requiresExplanation).toBe(false);

    // and it is not treated as an exception the way a real overclaim is
    await put(`/timecards/${card.id}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8, overtimeHours: 2 }],
    });
    await post(`/timecards/${card.id}/submit`, h1, {});
    const approved = await post(`/timecards/${card.id}/approve`, h2, { decision: "approved" });
    expect(approved.statusCode).toBe(200);

    // explaining a variance that does not exist is refused rather than stored
    const explain = await post(`/timecards/${card.id}/explain-variance`, h1, {
      varianceExplanation: "nothing to explain",
    });
    expect(explain.statusCode).toBe(409);
    expect(explain.json().message).toContain("no computed variance");
  });

  it("attaches an access record that lands late, lazily on the next list read", async () => {
    const worker = await makeWorker("W-402", "Late Feed Worker");
    await addMember(crewId, worker, "2026-10-01");
    const card = (
      await post("/timecards", h1, { workerId: worker, workDate: "2026-10-08", crewId, workedHours: 8 })
    ).json();
    expect(card.varianceHours).toBeNull();

    await access(worker, "2026-10-08", 7);
    const list = await get(`/timecards?workerId=${worker}`);
    expect(list.json().sweep.linked).toBeGreaterThanOrEqual(1);
    const after = await get(`/timecards/${card.id}`);
    expect(after.json().varianceHours).toBe(1);
    expect(after.json().detail.variance.linkedBy).toBe("lazy_sweep");

    // the sweep is idempotent — a second read links nothing further
    const second = await get(`/timecards?workerId=${worker}`);
    expect(second.json().sweep.linked).toBe(0);
  });

  it("raises an overclaim-pattern signal and a separate, low-severity access-gap signal", async () => {
    for (const d of ["2026-10-06", "2026-10-07"]) {
      const c = (
        await post("/timecards", h1, {
          workerId: overclaimWorker,
          workDate: d,
          crewId,
          workedHours: 10,
        })
      ).json();
      expect(c.varianceHours).toBe(2);
    }
    for (const d of ["2026-10-06", "2026-10-07"]) {
      await post("/timecards", h1, { workerId: gapWorker, workDate: d, crewId, workedHours: 9 });
    }

    const run = await post("/timecards/reconcile", h1, {
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().signalsRaised).toBeGreaterThanOrEqual(2);

    const overclaim = run
      .json()
      .workers.find((w: { workerReference: string }) => w.workerReference === "W-400");
    expect(overclaim.isOverclaimPattern).toBe(true);
    expect(overclaim.unexplainedOverDays).toBe(2);
    const gap = run.json().workers.find((w: { workerReference: string }) => w.workerReference === "W-401");
    expect(gap.isAccessGap).toBe(true);
    expect(gap.isOverclaimPattern).toBe(false);

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(eq(signals.projectId, proj));
    const gapSignal = raised.find((s) => s.detector === "timecard_access_gap");
    expect(gapSignal?.severity).toBe("low");
    expect(gapSignal?.explanation).toContain("NOT A FINDING AGAINST THE WORKER");
    expect((gapSignal?.evidenceRefs as { findingKind?: string })?.findingKind).toBe("data_completeness");
    const overSignal = raised.find((s) => s.detector === "timecard_hours_overclaim");
    expect(overSignal?.severity).toBe("high");

    // idempotent: the same window re-run raises nothing further
    const again = await post("/timecards/reconcile", h1, {
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    });
    expect(again.json().signalsRaised).toBe(0);

    // and the read-only replay writes nothing
    const replay = await get(`/timecards/reconciliation?from=2026-10-01&to=2026-10-31`);
    expect(replay.json().persisted).toBe(false);
    expect(replay.json().overclaimPatterns).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Batches, locking and export                                         */
/* ------------------------------------------------------------------ */

describe("batches, locking and payroll export", () => {
  let crewId: string;
  let batchId: string;
  let cardIds: string[] = [];

  beforeAll(async () => {
    const crew = await makeDailyCrew("Batch gang");
    crewId = crew.id;
    const worker = await makeWorker("W-500", "Batch Worker");
    await addMember(crewId, worker, "2026-11-01");
    for (const d of ["2026-11-02", "2026-11-03"]) {
      const card = (
        await post("/timecards", h1, { workerId: worker, workDate: d, crewId, workedHours: 8 })
      ).json();
      await put(`/timecards/${card.id}/allocations`, h1, {
        allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8 }],
      });
      cardIds.push(card.id);
    }
  });

  it("collects a crew's week and rolls up its hours and cost", async () => {
    const res = await post("/timecard-batches", h1, {
      crewId,
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
      collect: true,
    });
    expect(res.statusCode).toBe(201);
    batchId = res.json().id;
    expect(res.json().rollup).toMatchObject({
      timecardCount: 2,
      workerCount: 1,
      regularHours: 16,
      totalHours: 16,
      currency: "USD",
    });
    // 8 h × 30 × 1.3 burden × 2 days
    expect(res.json().rollup.totalCost).toBe(624);
  });

  it("refuses a self-approval of the batch and records it, then an independent approver approves", async () => {
    expect((await post(`/timecard-batches/${batchId}/submit`, h1, {})).statusCode).toBe(200);
    const refused = await post(`/timecard-batches/${batchId}/approve`, h1, { decision: "approved" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().details.control).toBe("no_self_approval");
    const [row] = await built.app.db
      .select()
      .from(timecardApprovals)
      .where(eq(timecardApprovals.id, refused.json().details.approvalId as string));
    expect(row?.isSelfApproval).toBe(1);
    expect(row?.batchId).toBe(batchId);

    const ok = await post(`/timecard-batches/${batchId}/approve`, h2, { decision: "approved" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("approved");
    expect(ok.json().timecards.every((c: { status: string }) => c.status === "approved")).toBe(true);
  });

  it("exports to a payroll batch reference and then refuses every edit", async () => {
    const exported = await post(`/timecard-batches/${batchId}/export`, h1, {
      payrollBatchRef: "PAY-2026-W45",
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ status: "exported", payrollBatchRef: "PAY-2026-W45" });
    expect(
      exported.json().timecards.every((c: { payrollBatchRef: string }) => c.payrollBatchRef === "PAY-2026-W45"),
    ).toBe(true);

    const edit = await patch(`/timecards/${cardIds[0]}`, h1, { workedHours: 12 });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toContain("exported to payroll as PAY-2026-W45");
    expect(edit.json().message).toContain("/revise");

    const recode = await put(`/timecards/${cardIds[0]}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8 }],
    });
    expect(recode.statusCode).toBe(409);
  });

  it("corrects an exported card through a dated adjustment that references it", async () => {
    const res = await post(`/timecards/${cardIds[0]}/revise`, h1, {
      adjustmentDate: "2026-11-16",
      reason: "Two hours were booked to the wrong worker; correcting the week.",
      workedHours: 2,
    });
    expect(res.statusCode).toBe(201);
    const adjustment = res.json().adjustment;
    expect(adjustment.revisesTimecardId).toBe(cardIds[0]);
    expect(adjustment.workDate).toBe("2026-11-16");
    expect(adjustment.detail.adjustment).toMatchObject({ originalTotalHours: 8, deltaHours: -6 });
    // the original stays exactly as payroll paid it
    expect(res.json().original.totalHours).toBe(8);
    expect(res.json().original.payrollBatchRef).toBe("PAY-2026-W45");
    expect(res.json().original.status).toBe("revised");

    const before = await post(`/timecards/${cardIds[0]}/revise`, h1, {
      adjustmentDate: "2026-10-01",
      reason: "backdated",
      workedHours: 1,
    });
    expect(before.statusCode).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* T&M tickets                                                         */
/* ------------------------------------------------------------------ */

describe("T&M tickets — the signature is the product", () => {
  let crewId: string;
  let allocationId: string;
  let ticketId: string;

  beforeAll(async () => {
    const crew = await makeDailyCrew("Daywork gang");
    crewId = crew.id;
    const worker = await makeWorker("W-600", "Daywork Worker");
    await addMember(crewId, worker, "2026-12-01");
    const card = (
      await post("/timecards", h1, { workerId: worker, workDate: "2026-12-02", crewId, workedHours: 8 })
    ).json();
    const allocs = await put(`/timecards/${card.id}/allocations`, h1, {
      allocations: [{ costCodeId: ccSlab, budgetLineItemId: blLabour, regularHours: 8, hourlyRate: 30 }],
    });
    allocationId = allocs.json().allocations[0].id;
  });

  it("refuses a verbal-instruction ticket that names nobody who gave it", async () => {
    const res = await post("/tm-tickets", h1, {
      title: "Break out unrecorded obstruction",
      wasVerbalInstruction: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("names nobody who gave it");
    expect(res.json().message).toContain("entitlement is won or lost");
  });

  it("totals a ticket, keeps an unpriced line's hours and refuses to state a total for it", async () => {
    const res = await post("/tm-tickets", h1, {
      title: "Break out unrecorded obstruction",
      ticketDate: "2026-12-02",
      wasVerbalInstruction: true,
      instructedByName: "R. Bell, Resident Engineer",
      instructionDate: "2026-12-02",
      vendorId,
      crewId,
      rateBasis: "contract_daywork_rates",
      markupPercent: 15,
      currency: "USD",
      lines: [
        { lineKind: "labour", description: "Ganger", hours: 8, rate: 45 },
        { lineKind: "equipment", description: "Breaker attachment", hours: 6, rate: null },
      ],
    });
    expect(res.statusCode).toBe(201);
    ticketId = res.json().id;
    const t = res.json();
    expect(t.totals.totalLabourHours).toBe(8);
    expect(t.totals.labourTotal.value).toBe(360);
    expect(t.totals.equipmentTotal.value).toBeNull();
    expect(t.totals.total.value).toBeNull();
    expect(t.totalsAreComplete).toBe(false);
    expect(t.totals.total.reasons.join(" ")).toContain("Breaker attachment");
    expect(t.verbalInstruction.instructedByName).toContain("R. Bell");
    // an unsigned ticket NEVER presents as signed
    expect(t.isSigned).toBe(false);
    expect(t.signature.state).toBe("unsigned");
  });

  it("sources labour lines from timecard allocations rather than retyping them", async () => {
    const res = await post(`/tm-tickets/${ticketId}/lines/source`, h1, {
      timecardAllocationIds: [allocationId],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sourced).toBe(1);
    const sourced = res.json().lines.find((l: { timecardAllocationId: string | null }) => l.timecardAllocationId);
    expect(sourced.timecardAllocationId).toBe(allocationId);
    expect(sourced.timecardId).toBeTruthy();
    expect(sourced.hours).toBe(8);
    expect(sourced.description).toContain("Daywork Worker");

    // the same hour is not billed twice
    const again = await post(`/tm-tickets/${ticketId}/lines/source`, h1, {
      timecardAllocationIds: [allocationId],
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toContain("already on this ticket");
  });

  it("sources an equipment line from a utilisation row and links it back", async () => {
    const plantId = newId("eqp");
    await built.app.db.insert(equipment).values({
      id: plantId,
      companyId: u1.companyId,
      projectId: proj,
      number: 1,
      reference: "EQ-001",
      name: "20t excavator",
      category: "excavator",
      createdBy: u1.userId,
    });
    const utilId = newId("equ");
    await built.app.db.insert(equipmentUtilisation).values({
      id: utilId,
      companyId: u1.companyId,
      projectId: proj,
      equipmentId: plantId,
      utilisationDate: "2026-12-02",
      shift: "day",
      workingHours: 6,
      standbyHours: 2,
      hireCost: 720,
      currency: "USD",
      costCodeId: ccSlab,
      budgetLineItemId: blLabour,
      createdBy: u1.userId,
    });

    const res = await post(`/tm-tickets/${ticketId}/lines/source`, h1, {
      equipmentUtilisationIds: [utilId],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sourced).toBe(1);
    const line = res
      .json()
      .lines.find((l: { equipmentId: string | null }) => l.equipmentId === plantId);
    expect(line.lineKind).toBe("equipment");
    expect(line.hours).toBe(8);
    expect(line.amount).toBe(720);
    expect(line.detail.equipmentUtilisationId).toBe(utilId);
    expect(line.description).toContain("6 working + 2 standby hour(s)");

    const [linked] = await built.app.db
      .select()
      .from(equipmentUtilisation)
      .where(eq(equipmentUtilisation.id, utilId));
    expect(linked?.tmTicketId).toBe(ticketId);
    expect(linked?.isBillable).toBe(1);
  });

  it("refuses to promote a ticket with no client response at all", async () => {
    const res = await post(`/tm-tickets/${ticketId}/promote`, h1, { target: "change_event" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("no client response at all");
  });

  it("preserves SIGNED UNDER PROTEST distinctly, and never as a clean signature", async () => {
    const res = await post(`/tm-tickets/${ticketId}/sign`, h1, {
      outcome: "signed_under_protest",
      signedByName: "R. Bell",
      signedByRole: "Resident Engineer",
      signedByOrganisation: "Owner's Representative",
      signatureMethod: "on_device",
      signatureLatitude: 51.5072,
      signatureLongitude: -0.1276,
      signatureDeviceId: "ipad-site-04",
      protestNote: "Signed for record of hours only, without prejudice to liability.",
    });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.status).toBe("signed_under_protest");
    expect(t.signedUnderProtest).toBe(1);
    expect(t.refusedToSign).toBe(0);
    expect(t.protestNote).toContain("without prejudice");
    expect(t.signature.state).toBe("signed_under_protest");
    expect(t.isSigned).toBe(false);
    expect(t.signedByRole).toBe("Resident Engineer");
    expect(t.signatureLatitude).toBe(51.5072);
    expect(t.signatureDeviceId).toBe("ipad-site-04");

    // the signature block is written once
    const again = await post(`/tm-tickets/${ticketId}/sign`, h1, {
      outcome: "signed",
      signedByName: "Someone Else",
      signedByRole: "PM",
      signedByOrganisation: "Owner",
      signatureMethod: "typed",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain("already carries a client response");
  });

  it("preserves REFUSED TO SIGN distinctly, with its note and no signature time", async () => {
    const ticket = (
      await post("/tm-tickets", h1, {
        title: "Standby waiting on owner's permit",
        ticketDate: "2026-12-03",
        currency: "USD",
        lines: [{ lineKind: "labour", description: "Gang standing", hours: 6, rate: 40 }],
      })
    ).json();

    const missingNote = await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "refused",
      signedByName: "R. Bell",
    });
    expect(missingNote.statusCode).toBe(400);
    expect(missingNote.json().message).toContain("A refusal to sign needs its note");

    const res = await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "refused",
      signedByName: "R. Bell",
      signedByRole: "Resident Engineer",
      signedByOrganisation: "Owner's Representative",
      refusalNote: "Declines to acknowledge; says no instruction was given.",
    });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.refusedToSign).toBe(1);
    expect(t.signedAt).toBeNull();
    expect(t.signatureMethod).toBe("none");
    expect(t.signedUnderProtest).toBe(0);
    expect(t.status).toBe("disputed");
    expect(t.signature.state).toBe("refused_to_sign");
    expect(t.signature.hasClientResponse).toBe(true);
    expect(t.isSigned).toBe(false);
    expect(t.refusalNote).toContain("no instruction was given");
    expect(t.detail.signature.refusedAt).toBeTruthy();

    // the list filter reads the signature COLUMNS, never `status`
    const refusedList = await get(`/tm-tickets?signatureState=refused_to_sign`);
    expect(refusedList.json().items.map((t: { id: string }) => t.id)).toContain(ticket.id);
    const signedList = await get(`/tm-tickets?signatureState=signed`);
    expect(signedList.json().items.map((t: { id: string }) => t.id)).not.toContain(ticket.id);
    const protestList = await get(`/tm-tickets?signatureState=signed_under_protest`);
    expect(protestList.json().items.map((t: { id: string }) => t.id)).toContain(ticketId);
    expect(signedList.json().items.map((t: { id: string }) => t.id)).not.toContain(ticketId);

    // a refusal is still evidence, so it can still be promoted
    const promoted = await post(`/tm-tickets/${ticket.id}/promote`, h1, { target: "change_event" });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json().ticket.status).toBe("incorporated");
  });

  it("refuses a signature without a method, a role or an organisation", async () => {
    const ticket = (
      await post("/tm-tickets", h1, {
        title: "Extra formwork",
        currency: "USD",
        lines: [{ lineKind: "labour", description: "Carpenter", hours: 8, rate: 50 }],
      })
    ).json();
    const noMethod = await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "signed",
      signedByName: "R. Bell",
      signedByRole: "RE",
      signedByOrganisation: "Owner",
      signatureMethod: "none",
    });
    expect(noMethod.statusCode).toBe(400);
    expect(noMethod.json().message).toContain("must never present as signed");

    const noRole = await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "signed",
      signedByName: "R. Bell",
      signatureMethod: "typed",
    });
    expect(noRole.statusCode).toBe(400);
    expect(noRole.json().message).toContain("ROLE and ORGANISATION");
  });
});

/* ------------------------------------------------------------------ */
/* Promotion into the change chain                                     */
/* ------------------------------------------------------------------ */

describe("a signed ticket becomes a change", () => {
  it("promotes a priced, signed ticket into a change event and a PCO", async () => {
    const ticket = (
      await post("/tm-tickets", h1, {
        title: "Additional dowels to slab edge",
        ticketDate: "2027-01-11",
        currency: "USD",
        markupPercent: 10,
        vendorId,
        rateBasis: "contract_daywork_rates",
        lines: [
          { lineKind: "labour", description: "Steel fixer", hours: 8, rate: 45 },
          { lineKind: "material", description: "Dowels", quantity: 200, unit: "nr", rate: 3 },
        ],
      })
    ).json();
    expect(ticket.totals.total.value).toBe(1056); // (360 + 600) × 1.10

    const signed = await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "signed",
      signedByName: "R. Bell",
      signedByRole: "Resident Engineer",
      signedByOrganisation: "Owner's Representative",
      signatureMethod: "wet_ink_scanned",
    });
    expect(signed.json().signature.state).toBe("signed");
    expect(signed.json().isSigned).toBe(true);

    const promoted = await post(`/tm-tickets/${ticket.id}/promote`, h1, {
      target: "potential_change_order",
    });
    expect(promoted.statusCode).toBe(201);
    const body = promoted.json();
    expect(body.changeEvent.created).toBe(true);
    expect(body.changeEvent.reference).toMatch(/^CE-\d{3}$/);
    expect(body.potentialChangeOrder.reference).toMatch(/^PCO-\d{3}$/);
    expect(body.incorporatedChangeOrderId).toBe(body.potentialChangeOrder.id);
    expect(body.ticket.status).toBe("incorporated");
    expect(body.ticket.changeEventId).toBe(body.changeEvent.id);
    expect(body.ticket.incorporatedAt).toBeTruthy();

    // the change event's exposure came from the ticket, priced by the changes module
    const event = await inject(
      "GET",
      `/api/v1/projects/${proj}/change-events/${body.changeEvent.id}`,
      h1,
    );
    expect(event.statusCode).toBe(200);
    expect(event.json().event.detail.origin.originType).toBe("tm_ticket");
    expect(event.json().event.detail.tmTicket.reference).toBe(ticket.reference);
    expect(event.json().event.detail.tmTicket.signatureState).toBe("signed");
    // priced by the changes module's own line builder, markup included as a line
    expect(event.json().rollup.estimatedCost).toBe(1056);
    expect(event.json().potentialChangeOrders[0].estimatedAmount).toBe(1056);

    // and a ticket is absorbed once
    const twice = await post(`/tm-tickets/${ticket.id}/promote`, h1, { target: "change_event" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().message).toContain("already incorporated");
  });

  it("refuses to make a PCO out of a ticket that has hours but no cost position", async () => {
    const ticket = (
      await post("/tm-tickets", h1, {
        title: "Hand-dig around live services",
        ticketDate: "2027-01-12",
        currency: "USD",
        rateBasis: "to_be_agreed",
        lines: [{ lineKind: "labour", description: "Two labourers, all day", hours: 16, rate: null }],
      })
    ).json();
    await post(`/tm-tickets/${ticket.id}/sign`, h1, {
      outcome: "signed",
      signedByName: "R. Bell",
      signedByRole: "Resident Engineer",
      signedByOrganisation: "Owner's Representative",
      signatureMethod: "on_device",
    });

    const asPco = await post(`/tm-tickets/${ticket.id}/promote`, h1, {
      target: "potential_change_order",
    });
    expect(asPco.statusCode).toBe(409);
    expect(asPco.json().message).toContain("A PCO is a cost position");

    // but the entitlement is still preserved as a change event
    const asEvent = await post(`/tm-tickets/${ticket.id}/promote`, h1, { target: "change_event" });
    expect(asEvent.statusCode).toBe(201);
    expect(asEvent.json().total.value).toBeNull();
    expect(asEvent.json().total.reasons.length).toBeGreaterThan(0);
    expect(asEvent.json().ticket.incorporatedChangeOrderId).toBe(asEvent.json().changeEvent.id);
  });
});

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

describe("access control", () => {
  it("keeps another company's user out of every timecard route", async () => {
    const headers = { authorization: `Bearer ${outsider.accessToken}`, "x-company-id": outsider.companyId };
    for (const url of ["/crews", "/timecards", "/timecard-batches", "/tm-tickets"]) {
      const res = await get(url, headers);
      expect(res.statusCode, url).toBe(403);
    }
    const write = await post("/crews", headers, { name: "Not yours" });
    expect(write.statusCode).toBe(403);
  });

  it("appends every consequential mutation to the company ledger", async () => {
    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, u1.companyId));
    const kinds = new Set(entries.map((e) => e.objectType));
    for (const kind of [
      "crew",
      "crew_member",
      "timecard",
      "timecard_allocations",
      "timecard_approval",
      "timecard_batch",
      "timecard_adjustment",
      "timecard_reconciliation",
      "tm_ticket",
      "tm_ticket_signature",
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    // the refused self-approval is on the chain, not only in the approvals table
    const refusals = entries.filter(
      (e) => (e.payload as { control?: string } | null)?.control === "no_self_approval",
    );
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    const cards = await built.app.db.select().from(timecards).where(eq(timecards.projectId, proj));
    expect(cards.length).toBeGreaterThan(10);
  });
});
