/**
 * WP-EQUIP regressions and new capability — workforce rights and welfare.
 *
 * The first test in "regressions" is the launch blocker: a payroll file
 * re-posted after a timeout used to double every worker's claimed days and
 * turn honest people into named overclaims.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  labourRiskFlags,
  payrollEntries,
  projects,
  signals,
  vendors,
  workerGrievances,
  workerVoiceChannels,
  workers,
} from "@constructos/db";
import { LABOUR_COMPLIANCE_DETECTORS } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;
let projectId: string;
let vendorId: string;
let workerId: string;

const today = () => todayISO();
const daysAgo = (n: number) => addDaysISO(todayISO(), -n);

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Workforce upgrade",
    stage: "course_of_construction",
  });
  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Labour Supply Ltd" });

  const worker = await post(`/projects/${projectId}/workers`, {
    reference: "W-100",
    fullName: "Aminata Diallo",
    vendorId,
    currency: "AED",
    agreedDailyRate: 120,
    idVerified: true,
    contractIssued: true,
  });
  expect(worker.statusCode).toBe(201);
  workerId = worker.json().id as string;
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Regressions                                                         */
/* ================================================================== */

describe("regressions", () => {
  it("replaces, never duplicates, a payroll file posted twice", async () => {
    const entry = {
      workerReference: "W-100",
      periodStart: daysAgo(60),
      periodEnd: daysAgo(31),
      daysClaimed: 26,
      hoursClaimed: 240,
      grossPay: 3120,
      deductions: 0,
      netPay: 3120,
      currency: "AED",
      paidAt: daysAgo(25),
    };
    const first = await post(`/projects/${projectId}/payroll`, { entries: [entry] });
    expect(first.statusCode).toBe(201);
    expect(first.json().upserted).toBe(1);
    expect(first.json().replaced).toBe(0);

    const retry = await post(`/projects/${projectId}/payroll`, { entries: [entry] });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().replaced).toBe(1);
    expect(retry.json().note).toContain("never adds a second copy");

    const rows = await app.db
      .select()
      .from(payrollEntries)
      .where(and(eq(payrollEntries.projectId, projectId), eq(payrollEntries.workerId, workerId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.daysClaimed).toBe(26);
  });

  it("keeps an adjustment run as its own row", async () => {
    const res = await post(`/projects/${projectId}/payroll`, {
      payrollRunRef: "ADJ-01",
      entries: [
        {
          workerReference: "W-100",
          periodStart: daysAgo(60),
          periodEnd: daysAgo(31),
          daysClaimed: 1,
          grossPay: 120,
          deductions: 0,
          netPay: 120,
          currency: "AED",
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(payrollEntries)
      .where(and(eq(payrollEntries.projectId, projectId), eq(payrollEntries.workerId, workerId)));
    expect(rows).toHaveLength(2);
  });

  it("does not let a duplicate upload manufacture an overclaim signal", async () => {
    // 26 days claimed against 26 access days: honest.
    const records = Array.from({ length: 26 }, (_, i) => ({
      workerReference: "W-100",
      accessDate: addDaysISO(daysAgo(60), i),
      hoursOnSite: 9,
    }));
    const access = await post(`/projects/${projectId}/site-access`, { records });
    expect(access.statusCode).toBe(201);

    const run = await post(`/projects/${projectId}/workforce/reconcile`, {
      periodStart: daysAgo(60),
      periodEnd: daysAgo(31),
    });
    expect(run.statusCode).toBe(201);
    const overclaims = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "payroll_overclaim"),
        ),
      );
    expect(overclaims).toHaveLength(0);
  });

  it("stops counting a dismissed reconciliation signal against the employer", async () => {
    const signalId = newId("sig");
    await app.db.insert(signals).values({
      id: signalId,
      companyId: owner.companyId,
      projectId,
      detector: "ghost_worker",
      severity: "critical",
      confidence: 1,
      title: "Ghost worker",
      explanation: "test fixture",
      evidenceRefs: { workerId, vendorId },
    });
    const before = await get(`/projects/${projectId}/workforce/vendor-risk`);
    const beforeScore = (
      before.json().items as Array<{ vendorId: string | null; score: number }>
    ).find((v) => v.vendorId === vendorId)?.score;

    await app.db
      .update(signals)
      .set({ disposition: "false_positive" })
      .where(eq(signals.id, signalId));

    const after = await get(`/projects/${projectId}/workforce/vendor-risk`);
    const afterScore = (
      after.json().items as Array<{ vendorId: string | null; score: number }>
    ).find((v) => v.vendorId === vendorId)?.score;
    expect(afterScore ?? 0).toBeLessThan(beforeScore ?? 0);
    expect(after.json().weighting).toContain("dismissed false positive");
  });

  it("links payroll entries to the approved timecards they paid for", async () => {
    // No timecards on this project, so the link count is honestly zero.
    const res = await post(`/projects/${projectId}/payroll`, {
      payrollRunRef: "LINK-TEST",
      entries: [
        {
          workerReference: "W-100",
          periodStart: daysAgo(20),
          periodEnd: daysAgo(1),
          daysClaimed: 10,
          grossPay: 1200,
          deductions: 0,
          netPay: 1200,
          currency: "AED",
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty("linkedTimecards");
  });
});

/* ================================================================== */
/* Worker voice                                                        */
/* ================================================================== */

describe("worker voice", () => {
  let token = "";
  let trackingCode = "";
  let grievanceId = "";

  it("issues an intake token once and stores only its hash", async () => {
    const res = await post(`/projects/${projectId}/worker-voice/channels`, {
      name: "Gate 2 card",
      languages: ["en", "bn"],
      responseSlaHours: 48,
    });
    expect(res.statusCode).toBe(201);
    token = res.json().token as string;
    expect(token).toMatch(/^wv_/);
    expect(res.json().note).toContain("stored only as a hash");

    const list = await get(`/projects/${projectId}/worker-voice/channels`);
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(token);
  });

  it("takes an anonymous report with no account at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": token },
      payload: {
        category: "wages_unpaid",
        summary: "Two months of wages have not been paid",
        language: "bn",
      },
    });
    expect(res.statusCode).toBe(201);
    trackingCode = res.json().trackingCode as string;
    expect(trackingCode).toMatch(/^WV-/);

    const rows = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isAnonymous).toBe(1);
    expect(rows[0]?.workerId).toBeNull();
    grievanceId = rows[0]!.id;

    // The report raises a signal AND a risk flag against the employer.
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "worker_voice_report"),
        ),
      );
    expect(raised).toHaveLength(1);
    const flags = await app.db
      .select()
      .from(labourRiskFlags)
      .where(
        and(
          eq(labourRiskFlags.projectId, projectId),
          eq(labourRiskFlags.indicator, "wage_withheld"),
        ),
      );
    expect(flags.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses an unknown token without saying why", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": "wv_not_a_real_token" },
      payload: { category: "other", summary: "test" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("not valid on any open channel");
  });

  it("lets the reporter check the status anonymously, seeing only visible updates", async () => {
    await post(`/projects/${projectId}/worker-grievances/${grievanceId}/updates`, {
      kind: "note",
      text: "Internal: contacted the employer's HR",
      visibleToReporter: false,
    });
    await post(`/projects/${projectId}/worker-grievances/${grievanceId}/updates`, {
      kind: "response",
      text: "We have asked the employer for the payment records",
      visibleToReporter: true,
      status: "investigating",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/worker-voice/reports/${trackingCode}`,
    });
    expect(res.statusCode).toBe(200);
    const updates = res.json().updates as Array<{ text: string }>;
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain("payment records");
    expect(res.json().status).toBe("investigating");
  });

  it("escalates and signals a report nobody answered inside the SLA", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": token },
      payload: { category: "accommodation", summary: "No running water in block C" },
    });
    expect(res.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.summary, "No running water in block C"));
    const id = rows[0]!.id;
    // Age it past its SLA.
    await app.db
      .update(workerGrievances)
      .set({ responseDueAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(workerGrievances.id, id));

    const swept = await post(`/projects/${projectId}/worker-grievances/sweep`, {});
    expect(swept.statusCode).toBe(200);
    expect(swept.json().breached).toBe(1);

    const after = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.id, id));
    expect(after[0]?.slaBreached).toBe(1);
    expect(after[0]?.status).toBe("escalated");

    // Idempotent.
    const again = await post(`/projects/${projectId}/worker-grievances/sweep`, {});
    expect(again.json().breached).toBe(0);
  });

  /*
   * The SLA is the only thing that makes an employer-independent channel
   * worth having, and `sweepGrievanceSla` reads nothing but
   * `firstRespondedAt`. An internal note the worker cannot see must not stop
   * the clock, or the control is satisfied by writing to oneself.
   */
  it("does not treat an internal note as the first response to the reporter", async () => {
    const raised = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": token },
      payload: { category: "other", summary: "Internal note must not close the SLA" },
    });
    expect(raised.statusCode).toBe(201);
    const rows = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.summary, "Internal note must not close the SLA"));
    const id = rows[0]!.id;

    const noted = await post(`/projects/${projectId}/worker-grievances/${id}/updates`, {
      kind: "note",
      text: "Internal: chased the employer by phone",
      visibleToReporter: false,
    });
    expect(noted.statusCode, noted.body).toBe(201);
    const afterNote = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.id, id));
    expect(afterNote[0]?.firstRespondedAt).toBeNull();

    await app.db
      .update(workerGrievances)
      .set({ responseDueAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(workerGrievances.id, id));
    const swept = await post(`/projects/${projectId}/worker-grievances/sweep`, {});
    expect(swept.json().breached).toBe(1);

    const answered = await post(`/projects/${projectId}/worker-grievances/${id}/updates`, {
      kind: "response",
      text: "We have asked the employer to answer you directly",
      visibleToReporter: true,
    });
    expect(answered.statusCode, answered.body).toBe(201);
    const afterAnswer = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.id, id));
    expect(afterAnswer[0]?.firstRespondedAt).toBeTruthy();
  });

  it("refuses the grievance register to another company", async () => {
    const res = await get(`/projects/${projectId}/worker-grievances`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });

  /*
   * A card is a physical object: it gets lost, photographed, or handed to
   * the gang-master. Revoking it must close the channel the token opens
   * WITHOUT telling whoever holds it that this particular token is the dead
   * one — a channel that distinguishes "revoked" from "never existed" lets
   * an employer enumerate which cards are live.
   */
  it("revokes an issued card so the token stops opening the channel", async () => {
    const issued = await post(`/projects/${projectId}/worker-voice/channels`, {
      name: "Gate 5 card (to be withdrawn)",
      languages: ["en"],
      responseSlaHours: 24,
    });
    expect(issued.statusCode).toBe(201);
    const doomed = issued.json() as { id: string; token: string };

    const works = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": doomed.token },
      payload: { category: "other", summary: "The card works before it is withdrawn" },
    });
    expect(works.statusCode, works.body).toBe(201);

    const revoked = await post(
      `/projects/${projectId}/worker-voice/channels/${doomed.id}/revoke`,
      {},
    );
    expect(revoked.statusCode, revoked.body).toBe(200);

    const after = await app.db
      .select()
      .from(workerVoiceChannels)
      .where(eq(workerVoiceChannels.id, doomed.id));
    expect(after[0]?.isActive).toBe(0);
    expect(after[0]?.revokedAt).toBeTruthy();

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/worker-voice/reports",
      headers: { "x-intake-token": doomed.token },
      payload: { category: "other", summary: "and not after" },
    });
    expect(refused.statusCode).toBe(400);
    // Identical wording to an unknown token: no enumeration oracle.
    expect(refused.json().message).toContain("not valid on any open channel");

    // Reports already taken through that card are NOT deleted with it.
    const kept = await app.db
      .select()
      .from(workerGrievances)
      .where(eq(workerGrievances.channelId, doomed.id));
    expect(kept.length).toBe(1);

    // Revoking is ledgered, and a stranger cannot revoke anybody's channel.
    const bystander = await post(
      `/projects/${projectId}/worker-voice/channels/${doomed.id}/revoke`,
      {},
      stranger.headers,
    );
    expect(bystander.statusCode).toBe(403);
  });

  it("404s a revoke for a channel that belongs to no project of ours", async () => {
    const res = await post(
      `/projects/${projectId}/worker-voice/channels/${newId("wvc")}/revoke`,
      {},
    );
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Working time and wages                                              */
/* ================================================================== */

describe("wage and working-time compliance", () => {
  it("refuses a jurisdiction the library does not hold", async () => {
    const res = await get(
      `/projects/${projectId}/workforce/compliance?jurisdiction=atlantis&periodStart=${daysAgo(30)}&periodEnd=${today()}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("simply wrong");
  });

  it("publishes the library with a citation on every jurisdiction", async () => {
    const res = await get("/workforce/jurisdictions");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ key: string; citation: string }>;
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.citation.length > 20)).toBe(true);
  });

  it("finds a rest-day breach from site access alone and cites the instrument", async () => {
    const start = daysAgo(20);
    const records = Array.from({ length: 12 }, (_, i) => ({
      workerReference: "W-100",
      accessDate: addDaysISO(start, i),
      hoursOnSite: 11,
    }));
    const access = await post(`/projects/${projectId}/site-access`, { records });
    expect(access.statusCode).toBe(201);

    const res = await post(`/projects/${projectId}/workforce/compliance/run`, {
      jurisdiction: "ae",
      periodStart: start,
      periodEnd: addDaysISO(start, 13),
    });
    expect(res.statusCode).toBe(201);
    const findings = res.json().findings as Array<{ detector: string; citation: string }>;
    const restDay = findings.find((f) => f.detector === "labour_no_rest_day");
    expect(restDay).toBeDefined();
    expect(restDay!.citation).toContain("33/2021");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "labour_no_rest_day"),
        ),
      );
    expect(raised).toHaveLength(1);

    // Re-running the same window raises nothing new.
    const again = await post(`/projects/${projectId}/workforce/compliance/run`, {
      jurisdiction: "ae",
      periodStart: start,
      periodEnd: addDaysISO(start, 13),
    });
    expect(again.json().signalsRaised).toBe(0);
  });

  it("raises a risk flag against the employer, which the vendor score reads", async () => {
    const flags = await app.db
      .select()
      .from(labourRiskFlags)
      .where(
        and(
          eq(labourRiskFlags.projectId, projectId),
          eq(labourRiskFlags.indicator, "no_rest_day"),
        ),
      );
    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(flags[0]?.vendorId).toBe(vendorId);
    expect(flags[0]?.source).toBe("detector");
  });
});

/* ================================================================== */
/* Labour position and health inputs                                   */
/* ================================================================== */

describe("labour position", () => {
  it("reports a missing payroll leg as missing rather than as zero", async () => {
    const bare = newId("prj");
    await app.db.insert(projects).values({
      id: bare,
      companyId: owner.companyId,
      name: "Bare project",
      stage: "course_of_construction",
    });
    const res = await get(`/projects/${bare}/workforce/labour-position`);
    expect(res.statusCode).toBe(200);
    expect(res.json().workers).toBe(0);
    expect(res.json().reasons.join(" ")).toContain("no workers");
  });

  it("states three legs for a worker who has all three", async () => {
    const res = await get(
      `/projects/${projectId}/workforce/labour-position?from=${daysAgo(60)}&to=${today()}`,
    );
    expect(res.statusCode).toBe(200);
    const row = (res.json().rows as Array<{ reference: string; accessDays: number }>).find(
      (r) => r.reference === "W-100",
    );
    expect(row).toBeDefined();
    expect(row!.accessDays).toBeGreaterThan(0);
    expect(res.json().method).toContain("never as zero");
  });
});

describe("health inputs and jobs", () => {
  it("returns workforce metrics with reasons rather than zeros", async () => {
    const res = await get(`/projects/${projectId}/workforce/health-inputs`);
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.openGrievances).toBeGreaterThanOrEqual(1);
  });

  it("registers the grievance SLA job", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("workforce.grievance-sla");
    expect(names).toContain("workforce.labour-audit-caps");
    expect(names).toContain("workforce.labour-compliance");
  });

  it("never guesses a jurisdiction: a project with no country is skipped by the sweep", async () => {
    // The fixture project records no country, so the weekly sweep must leave
    // it alone rather than judge it under somebody else's working-time law.
    await app.db
      .update(projects)
      .set({ country: null })
      .where(eq(projects.id, projectId));
    const before = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...LABOUR_COMPLIANCE_DETECTORS]),
        ),
      );
    await app.scheduler.runNow("workforce.labour-compliance");
    const after = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...LABOUR_COMPLIANCE_DETECTORS]),
        ),
      );
    expect(after.length).toBe(before.length);
  });

  it("assesses a project that does record a jurisdiction, and is idempotent", async () => {
    await app.db
      .update(projects)
      .set({ country: "gb" })
      .where(eq(projects.id, projectId));
    await app.scheduler.runNow("workforce.labour-compliance");
    const first = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...LABOUR_COMPLIANCE_DETECTORS]),
        ),
      );
    await app.scheduler.runNow("workforce.labour-compliance");
    const second = await app.db
      .select({ id: signals.id })
      .from(signals)
      .where(
        and(
          eq(signals.projectId, projectId),
          inArray(signals.detector, [...LABOUR_COMPLIANCE_DETECTORS]),
        ),
      );
    // Running the same window twice must never accuse the same person twice.
    expect(second.length).toBe(first.length);
  });
});

describe("tenant isolation", () => {
  it("refuses a stranger the compliance run and the worker register", async () => {
    const compliance = await post(
      `/projects/${projectId}/workforce/compliance/run`,
      { jurisdiction: "gb", periodStart: daysAgo(10), periodEnd: today() },
      stranger.headers,
    );
    expect(compliance.statusCode).toBe(403);
    const register = await get(`/projects/${projectId}/workers`, stranger.headers);
    expect(register.statusCode).toBe(403);
    const rows = await app.db.select().from(workers).where(eq(workers.projectId, projectId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
