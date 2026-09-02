import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { obligations, projects, signals, siteAccessRecords, vendors } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  ageOnDate,
  distinctAccessDays,
  isUnderage,
  periodsOverlap,
  rankVendorRisk,
  reconcileWorker,
  reconcileWorkforce,
  scoreVendorRisk,
  type ReconcileWorkerInput,
} from "./reconcile.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let vendorA: string;
let vendorB: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  outsider = await registerActor(app);
  vendorA = await makeVendor("Alpha Manpower LLC");
  vendorB = await makeVendor("Bravo Labour Supply");
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string, actor: TestActor = owner): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: actor.companyId, name });
  return id;
}

async function makeVendor(name: string, actor: TestActor = owner): Promise<string> {
  const id = newId("vnd");
  await app.db.insert(vendors).values({ id, companyId: actor.companyId, name });
  return id;
}

async function createWorker(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/workers`,
    headers: owner.headers,
    payload: { fullName: "Test Worker", ...payload },
  });
}

async function ingestAccess(pid: string, records: Record<string, unknown>[]) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/site-access`,
    headers: owner.headers,
    payload: { records },
  });
}

async function ingestPayroll(pid: string, entries: Record<string, unknown>[]) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/payroll`,
    headers: owner.headers,
    payload: { entries },
  });
}

async function countSignals(pid: string, detector: string): Promise<number> {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.projectId, pid), eq(signals.detector, detector)));
  return rows.length;
}

const baseWorker: ReconcileWorkerInput = {
  workerId: "wkr_1",
  reference: "W-001",
  fullName: "A Worker",
  vendorId: null,
  agreedDailyRate: 100,
  currency: "USD",
  daysClaimed: 10,
  grossPay: 1000,
  netPay: 1000,
  accessDays: 10,
  payrollEntries: 1,
};

/* ------------------------------------------------------------------ */
/* Pure engines (#669, #670, #677, #694)                               */
/* ------------------------------------------------------------------ */

describe("age verification engine (#670)", () => {
  it("measures whole years and treats the 18th birthday itself as of age", () => {
    expect(ageOnDate("2000-06-15", "2018-06-15")).toBe(18);
    expect(ageOnDate("2000-06-15", "2018-06-14")).toBe(17);
    expect(ageOnDate("2000-06-15", "2018-05-30")).toBe(17);
    expect(isUnderage("2000-06-15", "2018-06-15")).toBe(false);
    expect(isUnderage("2000-06-15", "2018-06-14")).toBe(true);
    // an unparseable date must not silently pass the gate as "18+"
    expect(ageOnDate("not-a-date", "2018-06-15")).toBe(null);
    expect(isUnderage("not-a-date", "2018-06-15")).toBe(false);
  });
});

describe("reconciliation engine (#669, #677)", () => {
  it("classifies a ghost worker: pay claimed with zero evidenced days", () => {
    const r = reconcileWorker({ ...baseWorker, accessDays: 0 });
    expect(r.classification).toBe("ghost");
    expect(r.isGhost).toBe(true);
    expect(r.isOverclaim).toBe(false);
    // the whole gross is at risk, not just the unmatched-day slice
    expect(r.valueAtRisk).toBe(1000);
    expect(r.unmatchedDays).toBe(10);
    expect(r.claimRatio).toBe(null);
  });

  it("classifies an overclaim only beyond the 1.15x tolerance", () => {
    // 12 claimed / 8 evidenced = 1.5x → overclaim; 4 unmatched days at the
    // implied rate of 1200/12 = 100 → 400 at risk
    const over = reconcileWorker({ ...baseWorker, daysClaimed: 12, grossPay: 1200, accessDays: 8 });
    expect(over.classification).toBe("overclaim");
    expect(over.unmatchedDays).toBe(4);
    expect(over.impliedDailyRate).toBe(100);
    expect(over.valueAtRisk).toBe(400);
    // 9 claimed / 8 evidenced = 1.125x → inside the tolerance, not a finding
    const inside = reconcileWorker({ ...baseWorker, daysClaimed: 9, grossPay: 900, accessDays: 8 });
    expect(inside.classification).toBe("ok");
    expect(inside.valueAtRisk).toBe(0);
  });

  it("classifies underpayment against the agreed rate and abstains without one", () => {
    // 800 / 10 days = 80/day vs an agreed 100 → below the 95 floor
    const under = reconcileWorker({ ...baseWorker, grossPay: 800 });
    expect(under.classification).toBe("underpaid");
    expect(under.wageShortfall).toBe(200);
    expect(under.valueAtRisk).toBe(0);
    // 960/10 = 96/day is inside the 5% band
    expect(reconcileWorker({ ...baseWorker, grossPay: 960 }).classification).toBe("ok");
    // no agreed rate on file → #677 abstains rather than guessing
    const noRate = reconcileWorker({ ...baseWorker, grossPay: 100, agreedDailyRate: null });
    expect(noRate.classification).toBe("ok");
    expect(noRate.isUnderpaid).toBe(false);
    // a ghost is never also reported as underpaid — different wrong, no noise
    const ghost = reconcileWorker({ ...baseWorker, grossPay: 100, accessDays: 0 });
    expect(ghost.isUnderpaid).toBe(false);
  });

  it("totals a period and orders the table worst-first", () => {
    const summary = reconcileWorkforce(
      [
        { ...baseWorker, workerId: "w_ok", reference: "W-OK" },
        { ...baseWorker, workerId: "w_ghost", reference: "W-GHOST", accessDays: 0 },
        {
          ...baseWorker,
          workerId: "w_over",
          reference: "W-OVER",
          daysClaimed: 12,
          grossPay: 1200,
          accessDays: 8,
        },
        { ...baseWorker, workerId: "w_under", reference: "W-UNDER", grossPay: 800 },
      ],
      { periodStart: "2025-03-01", periodEnd: "2025-03-31" },
    );
    expect(summary.workers).toBe(4);
    expect(summary.ghosts).toBe(1);
    expect(summary.overclaims).toBe(1);
    expect(summary.underpayments).toBe(1);
    // 10 + 10 + 12 + 10 claimed against 10 + 0 + 8 + 10 evidenced
    expect(summary.totals.daysClaimed).toBe(42);
    expect(summary.totals.accessDays).toBe(28);
    expect(summary.totals.unmatchedDays).toBe(14);
    expect(summary.totals.valueAtRisk).toBe(1400);
    expect(summary.totals.wageShortfall).toBe(200);
    expect(summary.rows.map((r) => r.reference)).toEqual([
      "W-GHOST",
      "W-OVER",
      "W-UNDER",
      "W-OK",
    ]);
  });

  it("counts only distinct in-window access dates and detects period overlap", () => {
    expect(
      distinctAccessDays(
        ["2025-03-02", "2025-03-02", "2025-03-03", "2025-02-28", "2025-04-01"],
        "2025-03-01",
        "2025-03-31",
      ),
    ).toEqual(["2025-03-02", "2025-03-03"]);
    expect(periodsOverlap("2025-03-01", "2025-03-31", "2025-03-25", "2025-04-24")).toBe(true);
    expect(periodsOverlap("2025-03-01", "2025-03-31", "2025-04-01", "2025-04-30")).toBe(false);
  });
});

describe("modern-slavery composite scoring (#694)", () => {
  it("weights critical indicators double and bands the score", () => {
    const clean = scoreVendorRisk({
      vendorId: "v1",
      vendorName: "Clean Co",
      workers: 10,
      contractIssued: 10,
      idVerified: 10,
      openFlagIndicators: [],
      ghostSignals: 0,
      overclaimSignals: 0,
    });
    expect(clean.score).toBe(0);
    expect(clean.band).toBe("low");

    // 1 critical (12) + 1 other (6) = 18 flags; 1 ghost (6) + 2 overclaims (6) = 12;
    // contracts 50% → 9; identity 0% → 12. Total 51 → high.
    const bad = scoreVendorRisk({
      vendorId: "v2",
      vendorName: "Bad Co",
      workers: 10,
      contractIssued: 5,
      idVerified: 0,
      openFlagIndicators: ["passport_retained", "excessive_overtime"],
      ghostSignals: 1,
      overclaimSignals: 2,
    });
    expect(bad.components.flags).toBe(18);
    expect(bad.components.reconciliation).toBe(12);
    expect(bad.components.contracts).toBe(9);
    expect(bad.components.identity).toBe(12);
    expect(bad.score).toBe(51);
    expect(bad.band).toBe("high");
    expect(bad.flagsByIndicator["passport_retained"]).toBe(1);

    // a vendor with no workers on the project must not manufacture risk
    const empty = scoreVendorRisk({
      vendorId: "v3",
      vendorName: "Empty Co",
      workers: 0,
      contractIssued: 0,
      idVerified: 0,
      openFlagIndicators: [],
      ghostSignals: 0,
      overclaimSignals: 0,
    });
    expect(empty.score).toBe(0);
  });

  it("caps each component and ranks worst-first", () => {
    const ranked = rankVendorRisk([
      {
        vendorId: "v1",
        vendorName: "Mild",
        workers: 4,
        contractIssued: 4,
        idVerified: 2,
        openFlagIndicators: ["no_rest_day"],
        ghostSignals: 0,
        overclaimSignals: 0,
      },
      {
        vendorId: "v2",
        vendorName: "Severe",
        workers: 4,
        contractIssued: 0,
        idVerified: 0,
        openFlagIndicators: [
          "passport_retained",
          "debt_bondage",
          "underage",
          "movement_restricted",
          "wage_withheld",
        ],
        ghostSignals: 10,
        overclaimSignals: 10,
      },
    ]);
    expect(ranked[0]!.vendorName).toBe("Severe");
    expect(ranked[0]!.components.flags).toBe(45); // capped from 54
    expect(ranked[0]!.components.reconciliation).toBe(25); // capped from 90
    expect(ranked[0]!.score).toBe(100);
    expect(ranked[0]!.band).toBe("critical");
    expect(ranked[1]!.vendorName).toBe("Mild");
    expect(ranked[1]!.score).toBeLessThan(ranked[0]!.score);
  });
});

/* ------------------------------------------------------------------ */
/* Worker register (#667-670)                                          */
/* ------------------------------------------------------------------ */

describe("worker register", () => {
  let pid: string;
  beforeAll(async () => {
    pid = await makeProject("Worker Register Project");
  });

  it("refuses an underage worker and raises a critical signal (#670)", async () => {
    const dob = addDaysISO(todayISO(), -365 * 15);
    const res = await createWorker(pid, {
      reference: "CHILD-1",
      fullName: "Too Young",
      dateOfBirth: dob,
      vendorId: vendorA,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/minimum working age is 18/);

    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "underage_worker_blocked")));
    expect(raised.length).toBe(1);
    expect(raised[0]!.severity).toBe("critical");
    expect((raised[0]!.evidenceRefs as { reference: string }).reference).toBe("CHILD-1");

    // and the worker was genuinely not created
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workers`,
      headers: owner.headers,
    });
    expect(
      (list.json() as { items: { reference: string }[] }).items.some(
        (w) => w.reference === "CHILD-1",
      ),
    ).toBe(false);
  });

  it("creates a worker, rejects a duplicate reference and an unknown vendor", async () => {
    const res = await createWorker(pid, {
      reference: "W-100",
      fullName: "Amina Okoye",
      dateOfBirth: "1990-04-02",
      vendorId: vendorA,
      trade: "steelfixer",
      idVerified: true,
      contractIssued: true,
      contractLanguage: "Hausa",
      agreedDailyRate: 120,
      currency: "USD",
      inductedAt: todayISO(),
    });
    expect(res.statusCode).toBe(201);
    const worker = res.json() as { id: string; idVerified: number; openRiskFlags: number };
    expect(worker.idVerified).toBe(1);
    expect(worker.openRiskFlags).toBe(0);

    const dup = await createWorker(pid, { reference: "W-100", fullName: "Someone Else" });
    expect(dup.statusCode).toBe(409);

    const badVendor = await createWorker(pid, {
      reference: "W-101",
      fullName: "Ghost Vendor",
      vendorId: "vnd_does_not_exist",
    });
    expect(badVendor.statusCode).toBe(400);
  });

  it("patches a worker, blocks an underage correction and moves status", async () => {
    const created = await createWorker(pid, {
      reference: "W-200",
      fullName: "Bilal Rahman",
      vendorId: vendorB,
      agreedDailyRate: 90,
    });
    const id = (created.json() as { id: string }).id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/workers/${id}`,
      headers: owner.headers,
      payload: { biometricEnrolled: true, agreedDailyRate: 95, trade: "carpenter" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().biometricEnrolled).toBe(1);
    expect(patch.json().agreedDailyRate).toBe(95);

    const badPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/workers/${id}`,
      headers: owner.headers,
      payload: { dateOfBirth: addDaysISO(todayISO(), -365 * 12) },
    });
    expect(badPatch.statusCode).toBe(400);

    const status = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/workers/${id}/status`,
      headers: owner.headers,
      payload: { status: "demobilised" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("demobilised");
    expect(status.json().demobilisedAt).toBe(todayISO());
  });

  it("filters the register and reports open risk flags per worker", async () => {
    const flagged = await createWorker(pid, {
      reference: "W-300",
      fullName: "Chidi Eze",
      vendorId: vendorA,
      trade: "scaffolder",
    });
    const flaggedId = (flagged.json() as { id: string }).id;
    const flagRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: {
        workerId: flaggedId,
        indicator: "passport_retained",
        source: "worker_report",
        detail: "Passport held by the camp boss since arrival",
      },
    });
    expect(flagRes.statusCode).toBe(201);
    expect(flagRes.json().severity).toBe("high");
    expect(flagRes.json().signalId).toMatch(/^sig_/);

    const byTrade = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workers?trade=scaffolder`,
      headers: owner.headers,
    });
    const items = (byTrade.json() as { items: { id: string; openRiskFlags: number }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.openRiskFlags).toBe(1);

    const riskOnly = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workers?riskFlagged=true`,
      headers: owner.headers,
    });
    expect((riskOnly.json() as { items: { id: string }[] }).items.map((w) => w.id)).toEqual([
      flaggedId,
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workers/${flaggedId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().riskFlags.length).toBe(1);
    expect(detail.json().vendorName).toBe("Alpha Manpower LLC");
    expect(detail.json().recentAccess).toEqual([]);
    expect(detail.json().latestPayroll).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* Batch ingest (#668, #676)                                           */
/* ------------------------------------------------------------------ */

describe("site access and payroll ingest", () => {
  let pid: string;
  let workerId: string;

  beforeAll(async () => {
    pid = await makeProject("Ingest Project");
    const res = await createWorker(pid, {
      reference: "ING-1",
      fullName: "Ingest Worker",
      vendorId: vendorA,
      agreedDailyRate: 100,
    });
    workerId = (res.json() as { id: string }).id;
  });

  it("upserts on (worker, date), collapses in-batch duplicates and reports unknown references", async () => {
    const first = await ingestAccess(pid, [
      { workerReference: "ING-1", accessDate: "2025-05-01", firstIn: "06:00", hoursOnSite: 8 },
      { workerReference: "ING-1", accessDate: "2025-05-02", hoursOnSite: 9 },
      // repeated (worker, date) inside one payload — last write wins
      { workerReference: "ING-1", accessDate: "2025-05-02", hoursOnSite: 4 },
      { workerReference: "NOT-A-WORKER", accessDate: "2025-05-01" },
    ]);
    expect(first.statusCode).toBe(201);
    const body = first.json() as {
      received: number;
      upserted: number;
      duplicatesCollapsed: number;
      unknown: { index: number; workerReference: string }[];
    };
    expect(body.received).toBe(4);
    expect(body.upserted).toBe(2);
    expect(body.duplicatesCollapsed).toBe(1);
    expect(body.unknown).toEqual([{ index: 3, workerReference: "NOT-A-WORKER" }]);

    // re-ingesting the same day updates in place rather than duplicating
    const second = await ingestAccess(pid, [
      { workerId, accessDate: "2025-05-01", hoursOnSite: 10, source: "biometric" },
    ]);
    expect(second.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(siteAccessRecords)
      .where(eq(siteAccessRecords.workerId, workerId));
    expect(rows.length).toBe(2);
    const may1 = rows.find((r) => r.accessDate === "2025-05-01")!;
    expect(may1.hoursOnSite).toBe(10);
    expect(may1.source).toBe("biometric");
    const may2 = rows.find((r) => r.accessDate === "2025-05-02")!;
    expect(may2.hoursOnSite).toBe(4);
  });

  it("rejects payroll whose net pay does not reconcile to gross minus deductions", async () => {
    const res = await ingestPayroll(pid, [
      {
        workerReference: "ING-1",
        periodStart: "2025-05-01",
        periodEnd: "2025-05-31",
        daysClaimed: 20,
        grossPay: 2000,
        deductions: 150,
        netPay: 1900,
      },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/entries\[0\]: netPay 1900/);

    // an out-of-order period is refused too
    const backwards = await ingestPayroll(pid, [
      {
        workerReference: "ING-1",
        periodStart: "2025-05-31",
        periodEnd: "2025-05-01",
        daysClaimed: 1,
        grossPay: 100,
        netPay: 100,
      },
    ]);
    expect(backwards.statusCode).toBe(400);
  });

  it("accepts arithmetic within the 0.01 tolerance and reports unknown workers", async () => {
    const res = await ingestPayroll(pid, [
      {
        workerReference: "ING-1",
        periodStart: "2025-05-01",
        periodEnd: "2025-05-31",
        daysClaimed: 20,
        grossPay: 2000,
        deductions: 150.004,
        netPay: 1850,
        wpsReference: "WPS-99",
      },
      {
        workerReference: "NOT-A-WORKER",
        periodStart: "2025-05-01",
        periodEnd: "2025-05-31",
        daysClaimed: 20,
        grossPay: 100,
        netPay: 100,
      },
    ]);
    expect(res.statusCode).toBe(201);
    expect(res.json().inserted).toBe(1);
    expect(res.json().unknown).toEqual([{ index: 1, workerReference: "NOT-A-WORKER" }]);
  });
});

/* ------------------------------------------------------------------ */
/* Ghost-worker reconciliation over HTTP (#669, #677)                  */
/* ------------------------------------------------------------------ */

describe("workforce reconciliation", () => {
  let pid: string;
  const periodStart = "2025-03-01";
  const periodEnd = "2025-03-31";

  beforeAll(async () => {
    pid = await makeProject("Reconciliation Project");
    const specs = [
      { reference: "GHOST-1", vendorId: vendorB, accessDays: 0, days: 10, gross: 1000 },
      { reference: "OVER-1", vendorId: vendorB, accessDays: 8, days: 12, gross: 1200 },
      { reference: "UNDER-1", vendorId: vendorA, accessDays: 10, days: 10, gross: 800 },
      { reference: "OK-1", vendorId: vendorA, accessDays: 10, days: 10, gross: 1000 },
    ];
    const access: Record<string, unknown>[] = [];
    const payroll: Record<string, unknown>[] = [];
    for (const s of specs) {
      await createWorker(pid, {
        reference: s.reference,
        fullName: `Worker ${s.reference}`,
        vendorId: s.vendorId,
        agreedDailyRate: 100,
        currency: "USD",
        contractIssued: true,
        idVerified: true,
      });
      for (let d = 0; d < s.accessDays; d += 1) {
        access.push({
          workerReference: s.reference,
          accessDate: addDaysISO(periodStart, d),
          hoursOnSite: 9,
        });
      }
      payroll.push({
        workerReference: s.reference,
        periodStart,
        periodEnd,
        daysClaimed: s.days,
        grossPay: s.gross,
        netPay: s.gross,
      });
    }
    // one access record outside the window must not be counted
    access.push({ workerReference: "GHOST-1", accessDate: "2025-02-20" });
    await ingestAccess(pid, access);
    await ingestPayroll(pid, payroll);
  });

  it("classifies the period and raises one signal per finding", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/workforce/reconcile`,
      headers: owner.headers,
      payload: { periodStart, periodEnd },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      runId: string;
      workers: number;
      ghosts: number;
      overclaims: number;
      underpayments: number;
      signalsRaised: number;
      totals: Record<string, number>;
      rows: { reference: string; classification: string; valueAtRisk: number }[];
    };
    expect(body.runId).toMatch(/^wrc_/);
    expect(body.workers).toBe(4);
    expect(body.ghosts).toBe(1);
    expect(body.overclaims).toBe(1);
    expect(body.underpayments).toBe(1);
    expect(body.signalsRaised).toBe(3);
    expect(body.totals.daysClaimed).toBe(42);
    expect(body.totals.accessDays).toBe(28);
    expect(body.totals.unmatchedDays).toBe(14);
    expect(body.totals.valueAtRisk).toBe(1400);
    expect(body.rows.map((r) => r.reference)).toEqual([
      "GHOST-1",
      "OVER-1",
      "UNDER-1",
      "OK-1",
    ]);
    expect(body.rows[0]!.valueAtRisk).toBe(1000);

    expect(await countSignals(pid, "ghost_worker")).toBe(1);
    expect(await countSignals(pid, "payroll_overclaim")).toBe(1);
    expect(await countSignals(pid, "wage_underpayment")).toBe(1);
    const ghost = (
      await app.db
        .select()
        .from(signals)
        .where(and(eq(signals.projectId, pid), eq(signals.detector, "ghost_worker")))
    )[0]!;
    expect(ghost.severity).toBe("critical");
    expect((ghost.evidenceRefs as { periodStart: string }).periodStart).toBe(periodStart);
  });

  it("is idempotent on re-run over the same window", async () => {
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/workforce/reconcile`,
      headers: owner.headers,
      payload: { periodStart, periodEnd },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().ghosts).toBe(1);
    expect(again.json().signalsRaised).toBe(0);
    expect(await countSignals(pid, "ghost_worker")).toBe(1);
    expect(await countSignals(pid, "payroll_overclaim")).toBe(1);
    expect(await countSignals(pid, "wage_underpayment")).toBe(1);
  });

  it("recomputes the same view on GET without writing anything", async () => {
    const before = await countSignals(pid, "ghost_worker");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workforce/reconciliations?from=${periodStart}&to=${periodEnd}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().persisted).toBe(false);
    expect(res.json().ghosts).toBe(1);
    expect(res.json().totals.valueAtRisk).toBe(1400);
    expect(await countSignals(pid, "ghost_worker")).toBe(before);

    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workforce/reconciliations?from=2024-01-01&to=2024-01-31`,
      headers: owner.headers,
    });
    expect(empty.json().workers).toBe(0);
    expect(empty.json().totals.valueAtRisk).toBe(0);

    const backwards = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/workforce/reconcile`,
      headers: owner.headers,
      payload: { periodStart: "2025-03-31", periodEnd: "2025-03-01" },
    });
    expect(backwards.statusCode).toBe(400);
  });

  it("scores subcontractor modern-slavery exposure worst-first (#694)", async () => {
    // vendorB carries the ghost + the overclaim; vendorA only the wage finding
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: {
        vendorId: vendorB,
        indicator: "debt_bondage",
        source: "audit",
        detail: "Recruitment debt deducted from wages",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workforce/vendor-risk`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: {
        vendorId: string | null;
        vendorName: string;
        workers: number;
        score: number;
        band: string;
        ghostSignals: number;
        overclaimSignals: number;
        openFlags: number;
        contractIssuedPct: number;
      }[];
      weighting: string;
    };
    expect(body.weighting).toMatch(/45 pts open risk flags/);
    expect(body.items.length).toBe(2);
    const worst = body.items[0]!;
    expect(worst.vendorId).toBe(vendorB);
    expect(worst.vendorName).toBe("Bravo Labour Supply");
    expect(worst.workers).toBe(2);
    expect(worst.ghostSignals).toBe(1);
    expect(worst.overclaimSignals).toBe(1);
    expect(worst.openFlags).toBe(1);
    // 12 (debt_bondage) + 6 (ghost) + 3 (overclaim); contracts and ids are 100%
    expect(worst.score).toBe(21);
    expect(worst.band).toBe("medium");
    expect(body.items[1]!.vendorId).toBe(vendorA);
    expect(body.items[1]!.score).toBe(0);
    expect(body.items[1]!.contractIssuedPct).toBe(1);
    expect(worst.score).toBeGreaterThan(body.items[1]!.score);
  });
});

/* ------------------------------------------------------------------ */
/* Welfare inspections (#683-688)                                      */
/* ------------------------------------------------------------------ */

describe("welfare inspections", () => {
  let pid: string;
  beforeAll(async () => {
    pid = await makeProject("Welfare Project");
  });

  it("scores areas, flags overcrowding and failing standards", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/welfare-inspections`,
      headers: owner.headers,
      payload: {
        inspectionDate: todayISO(),
        location: "Camp 2, Block C",
        vendorId: vendorA,
        occupancyCount: 30,
        capacity: 20,
        areas: [
          { area: "accommodation", score: 2, note: "Ten bunks over capacity" },
          { area: "sanitation", score: 1, note: "Two working toilets for 30 men" },
          { area: "potable_water", score: 4 },
          { area: "catering", score: 5 },
        ],
        actions: [{ text: "Install six additional toilets", dueDate: addDaysISO(todayISO(), 14) }],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as {
      id: string;
      overallScore: number;
      signalsRaised: number;
      actions: { id: string; closed: boolean }[];
    };
    // (2 + 1 + 4 + 5) / 4 = 3
    expect(created.overallScore).toBe(3);
    expect(created.signalsRaised).toBe(2);

    const crowding = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "accommodation_overcrowding")));
    expect(crowding.length).toBe(1);
    expect(crowding[0]!.severity).toBe("high");
    expect((crowding[0]!.evidenceRefs as { over: number }).over).toBe(10);

    const failing = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "welfare_standard_failure")));
    expect(failing.length).toBe(1);
    expect(failing[0]!.severity).toBe("medium");
    expect((failing[0]!.evidenceRefs as { failing: unknown[] }).failing.length).toBe(2);

    // a compliant inspection raises nothing
    const clean = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/welfare-inspections`,
      headers: owner.headers,
      payload: {
        inspectionDate: todayISO(),
        location: "Camp 1, Block A",
        occupancyCount: 18,
        capacity: 20,
        areas: [
          { area: "accommodation", score: 5 },
          { area: "sanitation", score: 4 },
        ],
      },
    });
    expect(clean.json().signalsRaised).toBe(0);
    expect(clean.json().overallScore).toBe(4.5);
  });

  it("closes a corrective action once and lists open action counts", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/welfare-inspections?vendorId=${vendorA}`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const items = (
      list.json() as {
        items: {
          id: string;
          openActions: number;
          failingAreas: number;
          overcrowded: boolean;
          actions: { id: string }[];
        }[];
      }
    ).items;
    expect(items.length).toBe(1);
    expect(items[0]!.openActions).toBe(1);
    expect(items[0]!.failingAreas).toBe(2);
    expect(items[0]!.overcrowded).toBe(true);

    const inspectionId = items[0]!.id;
    const actionId = items[0]!.actions[0]!.id;
    const close = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/welfare-inspections/${inspectionId}/actions/${actionId}/close`,
      headers: owner.headers,
      payload: { note: "Six toilets installed and commissioned" },
    });
    expect(close.statusCode).toBe(200);
    expect((close.json().actions as { closed: boolean }[])[0]!.closed).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/welfare-inspections/${inspectionId}/actions/${actionId}/close`,
      headers: owner.headers,
      payload: {},
    });
    expect(again.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/welfare-inspections/${inspectionId}/actions/wac_nope/close`,
      headers: owner.headers,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/welfare-inspections/${inspectionId}`,
      headers: owner.headers,
    });
    expect(one.json().openActions).toBe(0);
    expect(one.json().vendorName).toBe("Alpha Manpower LLC");
  });
});

/* ------------------------------------------------------------------ */
/* Labour audits + CAP obligations (#697-699)                          */
/* ------------------------------------------------------------------ */

describe("labour audits", () => {
  let pid: string;
  beforeAll(async () => {
    pid = await makeProject("Audit Project");
  });

  async function createAudit(vendorId: string, scheduledFor: string, isUnannounced = false) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits`,
      headers: owner.headers,
      payload: { vendorId, scheduledFor, isUnannounced },
    });
    return res;
  }

  it("materialises each CAP as an assurance obligation and satisfies it on close", async () => {
    const audit = await createAudit(vendorA, todayISO(), true);
    expect(audit.statusCode).toBe(201);
    expect(audit.json().isUnannounced).toBe(1);
    expect(audit.json().status).toBe("scheduled");
    const auditId = audit.json().id as string;

    const report = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/report`,
      headers: owner.headers,
      payload: {
        score: 62,
        findings: [
          {
            indicator: "no_contract_in_language",
            description: "Contracts issued in English only for Nepali-speaking crew",
            severity: "high",
            capDueDate: addDaysISO(todayISO(), 30),
          },
          { description: "Muster board out of date", severity: "low" },
        ],
      },
    });
    expect(report.statusCode).toBe(200);
    const reported = report.json() as {
      status: string;
      score: number;
      findings: { id: string; obligationId: string | null; capDueDate: string | null }[];
    };
    expect(reported.status).toBe("reported");
    expect(reported.score).toBe(62);
    expect(reported.findings.length).toBe(2);
    const withCap = reported.findings.find((f) => f.capDueDate !== null)!;
    const withoutCap = reported.findings.find((f) => f.capDueDate === null)!;
    expect(withCap.obligationId).toMatch(/^obl_/);
    expect(withoutCap.obligationId).toBe(null);

    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, withCap.obligationId!));
    expect(obligation!.status).toBe("open");
    expect(obligation!.sourceClause).toBe("Labour audit CAP — Alpha Manpower LLC");
    expect(obligation!.warnDaysBefore).toBe(7);

    // reporting twice is refused
    const twice = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/report`,
      headers: owner.headers,
      payload: { findings: [] },
    });
    expect(twice.statusCode).toBe(400);

    const close = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/findings/${withCap.id}/close`,
      headers: owner.headers,
      payload: { note: "Nepali contracts re-issued and countersigned" },
    });
    expect(close.statusCode).toBe(200);
    const [after] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, withCap.obligationId!));
    expect(after!.status).toBe("satisfied");
    // still one finding open, so the audit is not yet closed
    expect(close.json().status).toBe("reported");

    const closeAgain = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/findings/${withCap.id}/close`,
      headers: owner.headers,
      payload: { note: "again" },
    });
    expect(closeAgain.statusCode).toBe(400);

    const closeLast = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/findings/${withoutCap.id}/close`,
      headers: owner.headers,
      payload: { note: "Board updated" },
    });
    expect(closeLast.json().status).toBe("closed");
  });

  it("breaches an overdue CAP exactly once and never re-raises it", async () => {
    const audit = await createAudit(vendorB, addDaysISO(todayISO(), -20));
    const auditId = audit.json().id as string;
    const report = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/report`,
      headers: owner.headers,
      payload: {
        findings: [
          {
            indicator: "wage_withheld",
            description: "March wages unpaid for 14 workers",
            severity: "critical",
            capDueDate: addDaysISO(todayISO(), -3),
          },
        ],
      },
    });
    const finding = (report.json() as { findings: { id: string; obligationId: string }[] })
      .findings[0]!;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/labour-audits?vendorId=${vendorB}`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as { items: { id: string; overdueCaps: number }[] }).items[0]!;
    expect(row.overdueCaps).toBe(1);

    const [breached] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, finding.obligationId));
    expect(breached!.status).toBe("breached");
    expect(await countSignals(pid, "labour_cap_overdue")).toBe(1);

    // the sweep runs again on every read and must stay idempotent
    await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/labour-audits`,
      headers: owner.headers,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(await countSignals(pid, "labour_cap_overdue")).toBe(1);
    expect(detail.json().overdueCaps).toBe(1);
    expect(detail.json().findings[0].obligation.status).toBe("breached");

    // closing late does not rewrite the register: the breach stands
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-audits/${auditId}/findings/${finding.id}/close`,
      headers: owner.headers,
      payload: { note: "Wages paid in full with 14 days' interest" },
    });
    const [stillBreached] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, finding.obligationId));
    expect(stillBreached!.status).toBe("breached");
  });
});

/* ------------------------------------------------------------------ */
/* Risk flags + tenant isolation                                       */
/* ------------------------------------------------------------------ */

describe("risk flags and tenancy", () => {
  let pid: string;
  beforeAll(async () => {
    pid = await makeProject("Flags Project");
  });

  it("derives signal severity from the indicator and resolves once", async () => {
    const worker = await createWorker(pid, {
      reference: "FLAG-1",
      fullName: "Flagged Worker",
      vendorId: vendorA,
    });
    const workerId = (worker.json() as { id: string }).id;

    const high = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: { workerId, indicator: "movement_restricted", source: "inspection" },
    });
    expect(high.statusCode).toBe(201);
    const medium = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: { vendorId: vendorB, indicator: "excessive_overtime", source: "detector" },
    });
    expect(medium.statusCode).toBe(201);

    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.projectId, pid), eq(signals.detector, "labour_rights_indicator")));
    expect(raised.length).toBe(2);
    expect(raised.filter((s) => s.severity === "high").length).toBe(1);
    expect(raised.filter((s) => s.severity === "medium").length).toBe(1);

    // exactly one subject is required
    const neither = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: { indicator: "no_rest_day", source: "audit" },
    });
    expect(neither.statusCode).toBe(400);
    const both = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags`,
      headers: owner.headers,
      payload: { workerId, vendorId: vendorA, indicator: "no_rest_day", source: "audit" },
    });
    expect(both.statusCode).toBe(400);

    const flagId = high.json().id as string;
    const resolve = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags/${flagId}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Worker confirmed free movement; camp gate rota withdrawn" },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().resolvedAt).toBeTruthy();
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/labour-risk-flags/${flagId}/resolve`,
      headers: owner.headers,
      payload: { resolution: "duplicate" },
    });
    expect(again.statusCode).toBe(400);

    const open = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/labour-risk-flags?open=true`,
      headers: owner.headers,
    });
    const items = (open.json() as { items: { indicator: string; vendorName: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.indicator).toBe("excessive_overtime");
    expect(items[0]!.vendorName).toBe("Bravo Labour Supply");

    const byIndicator = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/labour-risk-flags?indicator=movement_restricted`,
      headers: owner.headers,
    });
    expect((byIndicator.json() as { total: number }).total).toBe(1);
  });

  it("scopes every read to the tenant and the project", async () => {
    // another company cannot reach this project at all
    for (const url of [
      `/api/v1/projects/${pid}/workers`,
      `/api/v1/projects/${pid}/labour-risk-flags`,
      `/api/v1/projects/${pid}/workforce/vendor-risk`,
      `/api/v1/projects/${pid}/labour-audits`,
      `/api/v1/projects/${pid}/welfare-inspections`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: outsider.headers });
      expect(res.statusCode).toBe(403);
    }

    // and a sibling project of the same company shares no rows — the same
    // worker reference may legitimately exist in both
    const other = await makeProject("Sibling Project");
    const dup = await createWorker(other, { reference: "FLAG-1", fullName: "Different Person" });
    expect(dup.statusCode).toBe(201);
    const otherList = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${other}/workers`,
      headers: owner.headers,
    });
    const otherItems = (otherList.json() as { items: { id: string; fullName: string }[] }).items;
    expect(otherItems.length).toBe(1);
    expect(otherItems[0]!.fullName).toBe("Different Person");

    const crossProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${other}/workers/${(dup.json() as { id: string }).id}`,
      headers: owner.headers,
    });
    expect(crossProject.statusCode).toBe(200);
    const wrongProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/workers/${(dup.json() as { id: string }).id}`,
      headers: owner.headers,
    });
    expect(wrongProject.statusCode).toBe(404);

    // an outsider's vendor cannot be attached to this tenant's worker
    const foreignVendor = await makeVendor("Outsider Supply", outsider);
    const attach = await createWorker(other, {
      reference: "X-1",
      fullName: "Cross Tenant",
      vendorId: foreignVendor,
    });
    expect(attach.statusCode).toBe(400);
  });
});
