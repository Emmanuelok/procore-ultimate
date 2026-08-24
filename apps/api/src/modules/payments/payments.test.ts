import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  contracts,
  notifications,
  obligations,
  paymentClaims,
  paymentResponses,
  projects,
  signals,
} from "@constructos/db";
import { PAYMENT_REGIMES } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  addBusinessDays,
  computeTimeline,
  findRegime,
  libraryCoversAllRegimes,
  REGIME_LIBRARY,
} from "./regimes.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let projectId: string;

function isoTimestampDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Payment Security Test Project",
  });
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function createClaim(pid: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/payment-claims`,
    headers: owner.headers,
    payload,
  });
}

/** Direct fixture: a claim already in a given post-service state. */
async function insertClaim(overrides: Record<string, unknown>): Promise<string> {
  const id = newId("pcl");
  await app.db.insert(paymentClaims).values({
    id,
    companyId: owner.companyId,
    projectId,
    number: 900 + Math.floor(Math.random() * 90000),
    regime: "uk_hgcra",
    referenceDate: addDaysISO(todayISO(), -30),
    claimedAmount: 50000,
    currency: "GBP",
    status: "served",
    createdBy: owner.userId,
    ...overrides,
  } as typeof paymentClaims.$inferInsert);
  return id;
}

async function insertObligation(): Promise<string> {
  const id = newId("obl");
  await app.db.insert(obligations).values({
    id,
    companyId: owner.companyId,
    projectId,
    sourceClause: "test — payment response",
    trigger: "Respond to payment claim",
    status: "open",
    createdBy: owner.userId,
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* Regime library                                                      */
/* ------------------------------------------------------------------ */

describe("regime library", () => {
  it("covers all five regimes with honest, positive day counts", () => {
    expect(libraryCoversAllRegimes()).toBe(true);
    expect(REGIME_LIBRARY.length).toBe(PAYMENT_REGIMES.length);
    const seen = new Set<string>();
    for (const def of REGIME_LIBRARY) {
      expect(seen.has(def.regime)).toBe(false);
      seen.add(def.regime);
      expect(def.responseDeadlineDays).toBeGreaterThan(0);
      expect(def.finalPaymentDays).toBeGreaterThan(0);
      expect(def.suspensionNoticeDays).toBeGreaterThan(0);
      expect(def.annualInterestPercent).toBeGreaterThan(0);
      expect(["calendar", "business"]).toContain(def.responseDayBasis);
      expect(["calendar", "business"]).toContain(def.finalPaymentBasis);
      expect(def.summary.length).toBeGreaterThan(60);
      expect(def.interestNote.length).toBeGreaterThan(20);
      expect(def.deemedRule.length).toBeGreaterThan(20);
      expect(def.adjudicationNote.length).toBeGreaterThan(20);
    }
    // business-day basis only where the statute counts working days
    expect(findRegime("uk_hgcra")!.responseDayBasis).toBe("calendar");
    expect(findRegime("sg_sopa")!.responseDayBasis).toBe("calendar");
    expect(findRegime("au_nsw_sopa")!.responseDayBasis).toBe("business");
    expect(findRegime("au_nsw_sopa")!.finalPaymentBasis).toBe("business");
    expect(findRegime("my_cipaa")!.responseDayBasis).toBe("business");
    expect(findRegime("my_cipaa")!.finalPaymentBasis).toBe("calendar");
    expect(findRegime("nz_cca")!.responseDayBasis).toBe("business");
    expect(findRegime("nz_cca")!.finalPaymentBasis).toBe("business");
  });

  it("serves the library and single regimes over HTTP, 404 on unknown", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/payment-regimes",
      headers: owner.headers,
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json() as { items: { regime: string }[]; total: number };
    expect(list.total).toBe(5);
    expect(list.items.map((r) => r.regime).sort()).toEqual([...PAYMENT_REGIMES].sort());

    const oneRes = await app.inject({
      method: "GET",
      url: "/api/v1/payment-regimes/au_nsw_sopa",
      headers: owner.headers,
    });
    expect(oneRes.statusCode).toBe(200);
    expect((oneRes.json() as { jurisdiction: string }).jurisdiction).toContain("New South Wales");

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/payment-regimes/us_lien",
      headers: owner.headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Statutory timeline math                                             */
/* ------------------------------------------------------------------ */

describe("computeTimeline", () => {
  it("counts NSW business days over weekends (10 business days from a Thursday)", () => {
    // 2026-01-08 is a Thursday. Hand-count of 10 business days:
    // Fri 9, Mon 12, Tue 13, Wed 14, Thu 15, Fri 16, Mon 19, Tue 20,
    // Wed 21, Thu 22 → response deadline 2026-01-22; +5 more business
    // days (Fri 23, Mon 26, Tue 27, Wed 28, Thu 29) → due 2026-01-29.
    const t = computeTimeline("au_nsw_sopa", "2026-01-01", "2026-01-08T09:00:00Z");
    expect(t.responseDeadline).toBe("2026-01-22");
    expect(t.finalPaymentDate).toBe("2026-01-29");
    // bare business-day arithmetic across a weekend
    expect(addBusinessDays("2026-01-09", 1)).toBe("2026-01-12"); // Fri +1 → Mon
    expect(addBusinessDays("2026-01-10", 1)).toBe("2026-01-12"); // Sat +1 → Mon
    expect(addBusinessDays("2026-01-05", 20)).toBe("2026-02-02"); // Mon +4 weeks
  });

  it("computes UK calendar deadlines and bases the clock on the LATER of reference and service", () => {
    const served = computeTimeline("uk_hgcra", "2026-02-01", "2026-02-01T10:00:00Z");
    expect(served.responseDeadline).toBe("2026-02-06"); // +5 calendar days
    expect(served.finalPaymentDate).toBe("2026-02-18"); // +17 calendar days
    // served BEFORE the reference date: the clock waits for the reference date
    const early = computeTimeline("uk_hgcra", "2026-02-01", "2026-01-28T10:00:00Z");
    expect(early.responseDeadline).toBe("2026-02-06");
    // served AFTER the reference date: the clock runs from service
    const late = computeTimeline("uk_hgcra", "2026-02-01", "2026-02-10T10:00:00Z");
    expect(late.responseDeadline).toBe("2026-02-15");
  });

  it("applies NZ working-day defaults to both clocks", () => {
    // 2026-01-05 is a Monday; 20 business days = exactly 4 weeks.
    const t = computeTimeline("nz_cca", "2026-01-01", "2026-01-05T00:00:00Z");
    expect(t.responseDeadline).toBe("2026-02-02");
    expect(t.finalPaymentDate).toBe("2026-02-02");
  });
});

/* ------------------------------------------------------------------ */
/* Claim lifecycle                                                     */
/* ------------------------------------------------------------------ */

describe("payment claims", () => {
  it("creates a draft claim with sequential numbering and validates linked records", async () => {
    const contractId = newId("con");
    await app.db.insert(contracts).values({
      id: contractId,
      companyId: owner.companyId,
      projectId,
      name: "Main Works Contract",
      form: "bespoke",
      createdBy: owner.userId,
    });
    const res = await createClaim(projectId, {
      regime: "uk_hgcra",
      referenceDate: todayISO(),
      claimedAmount: 125000,
      currency: "GBP",
      description: "Interim application 7",
      contractId,
    });
    expect(res.statusCode).toBe(201);
    const claim = res.json() as Record<string, unknown>;
    expect(claim["status"]).toBe("draft");
    expect(claim["number"]).toBe(1);
    expect(claim["contractId"]).toBe(contractId);
    expect(claim["servedAt"]).toBeNull();
    expect(claim["responseDeadline"]).toBeNull();

    const second = await createClaim(projectId, {
      regime: "sg_sopa",
      referenceDate: todayISO(),
      claimedAmount: 8000,
    });
    expect((second.json() as { number: number }).number).toBe(2);

    // out-of-project contract and non-positive amounts are rejected
    const badContract = await createClaim(projectId, {
      regime: "uk_hgcra",
      referenceDate: todayISO(),
      claimedAmount: 100,
      contractId: "con_doesnotexist",
    });
    expect(badContract.statusCode).toBe(400);
    const badAmount = await createClaim(projectId, {
      regime: "uk_hgcra",
      referenceDate: todayISO(),
      claimedAmount: 0,
    });
    expect(badAmount.statusCode).toBe(400);
  });

  it("permits edits while draft only", async () => {
    const created = (
      await createClaim(projectId, {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 1000,
      })
    ).json() as { id: string };
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}`,
      headers: owner.headers,
      payload: { claimedAmount: 2500, description: "revised" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { claimedAmount: number }).claimedAmount).toBe(2500);

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
      headers: owner.headers,
      payload: { method: "email" },
    });
    const afterServe = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}`,
      headers: owner.headers,
      payload: { claimedAmount: 9999 },
    });
    expect(afterServe.statusCode).toBe(400);
  });

  it("serves a claim: statutory timeline computed, obligation materialized, draft-only", async () => {
    const created = (
      await createClaim(projectId, {
        regime: "uk_hgcra",
        referenceDate: addDaysISO(todayISO(), -3),
        claimedAmount: 60000,
      })
    ).json() as { id: string; number: number };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
      headers: owner.headers,
      payload: { method: "portal", reference: "PORTAL-889" },
    });
    expect(res.statusCode).toBe(200);
    const served = res.json() as Record<string, unknown>;
    expect(served["status"]).toBe("served");
    expect(served["servedAt"]).toBeTruthy();
    // reference date is in the past, so the clock runs from today (service)
    expect(served["responseDeadline"]).toBe(addDaysISO(todayISO(), 5));
    expect(served["finalPaymentDate"]).toBe(addDaysISO(todayISO(), 17));
    expect(served["daysToResponseDeadline"]).toBe(5);
    expect(served["obligationId"]).toBeTruthy();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, served["obligationId"] as string));
    expect(obl).toBeDefined();
    expect(obl!.status).toBe("open");
    // Postgres normalizes the timestamp text — compare instants, not strings
    expect(Date.parse(obl!.deadline!)).toBe(Date.parse(`${addDaysISO(todayISO(), 5)}T23:59:59Z`));
    expect(obl!.sourceClause).toContain("Housing Grants");
    expect(obl!.sourceClause).toContain("payment response");
    expect(obl!.trigger).toContain(`payment claim ${created.number}`);
    expect(obl!.warnDaysBefore).toBe(3);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
      headers: owner.headers,
      payload: { method: "email" },
    });
    expect(again.statusCode).toBe(400);
  });

  it("lists claims with daysToResponseDeadline and status filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/payment-claims?status=served`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { status: string; daysToResponseDeadline: number | null }[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const c of body.items) {
      expect(c.status).toBe("served");
      expect(typeof c.daysToResponseDeadline).toBe("number");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Payment responses                                                   */
/* ------------------------------------------------------------------ */

describe("payment responses", () => {
  it("an on-time response flips the claim to responded and satisfies the obligation", async () => {
    const created = (
      await createClaim(projectId, {
        regime: "sg_sopa",
        referenceDate: todayISO(),
        claimedAmount: 30000,
        currency: "SGD",
      })
    ).json() as { id: string };
    const served = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
        headers: owner.headers,
        payload: { method: "email" },
      })
    ).json() as { obligationId: string };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/respond`,
      headers: owner.headers,
      payload: { kind: "payment_notice", amount: 30000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      status: string;
      response: { late: boolean; amount: number };
    };
    expect(body.status).toBe("responded");
    expect(body.response.late).toBe(false);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, served.obligationId));
    expect(obl!.status).toBe("satisfied");
  });

  it("rejects a pay-less notice below the claimed amount without stated grounds", async () => {
    const created = (
      await createClaim(projectId, {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 20000,
      })
    ).json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
      headers: owner.headers,
      payload: { method: "email" },
    });
    const bare = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/respond`,
      headers: owner.headers,
      payload: { kind: "pay_less_notice", amount: 12000 },
    });
    expect(bare.statusCode).toBe(400);
    expect((bare.json() as { message: string }).message).toContain("grounds");

    const grounded = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/respond`,
      headers: owner.headers,
      payload: {
        kind: "pay_less_notice",
        amount: 12000,
        reasons: "Defective work to level 3 slab; set-off per clause 4.12",
        breakdown: [{ item: "L3 slab remediation", amount: -8000 }],
      },
    });
    expect(grounded.statusCode).toBe(201);
  });

  it("refuses responses on claims that were never served", async () => {
    const draft = (
      await createClaim(projectId, {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 500,
      })
    ).json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${draft.id}/respond`,
      headers: owner.headers,
      payload: { kind: "payment_notice", amount: 500 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a late response raises a high signal, breaches the obligation and rescues no status", async () => {
    const oblId = await insertObligation();
    const claimId = await insertClaim({
      servedAt: isoTimestampDaysAgo(10),
      serviceMethod: "email",
      responseDeadline: addDaysISO(todayISO(), -3),
      finalPaymentDate: addDaysISO(todayISO(), 7),
      obligationId: oblId,
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${claimId}/respond`,
      headers: owner.headers,
      payload: { kind: "payment_notice", amount: 50000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { status: string; response: { late: boolean } };
    expect(body.response.late).toBe(true);
    expect(body.status).toBe("served"); // no promotion to responded

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, oblId));
    expect(obl!.status).toBe("breached");
    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, projectId), eq(signals.detector, "late_payment_response")),
      );
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("high");
    expect(sigs[0]!.explanation).toContain(addDaysISO(todayISO(), -3));
    expect(sigs[0]!.explanation).toContain(todayISO());
  });
});

/* ------------------------------------------------------------------ */
/* Deemed liability sweep + suspension                                 */
/* ------------------------------------------------------------------ */

describe("deemed liability and suspension", () => {
  let sweepProject: string;
  let overdueClaimId: string;
  let oblId: string;

  beforeAll(async () => {
    sweepProject = await makeProject("Deemed Sweep Project");
    oblId = newId("obl");
    await app.db.insert(obligations).values({
      id: oblId,
      companyId: owner.companyId,
      projectId: sweepProject,
      sourceClause: "test — payment response",
      trigger: "Respond to payment claim",
      status: "open",
      createdBy: owner.userId,
    });
    overdueClaimId = newId("pcl");
    await app.db.insert(paymentClaims).values({
      id: overdueClaimId,
      companyId: owner.companyId,
      projectId: sweepProject,
      number: 900, // clear of the API's own numbering sequence
      regime: "au_nsw_sopa",
      referenceDate: addDaysISO(todayISO(), -40),
      claimedAmount: 75000,
      currency: "AUD",
      status: "served",
      servedAt: isoTimestampDaysAgo(30),
      serviceMethod: "portal",
      responseDeadline: addDaysISO(todayISO(), -5),
      finalPaymentDate: addDaysISO(todayISO(), -1),
      obligationId: oblId,
      createdBy: owner.userId,
    });
  });

  it("deems an unanswered served claim on read: status, breached obligation, critical signal", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${sweepProject}/payment-claims`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { id: string; status: string }[] }).items;
    expect(items.find((c) => c.id === overdueClaimId)!.status).toBe("deemed");

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, oblId));
    expect(obl!.status).toBe("breached");
    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, sweepProject), eq(signals.detector, "payment_deemed_liability")),
      );
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.severity).toBe("critical");
    expect(sigs[0]!.title).toBe(
      "No payment response served in time — deemed liability for AUD 75000",
    );
  });

  it("is idempotent: a second read raises no second signal", async () => {
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${sweepProject}/payment-claims/${overdueClaimId}`,
      headers: owner.headers,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { status: string; regimeDef: { regime: string } };
    expect(body.status).toBe("deemed");
    expect(body.regimeDef.regime).toBe("au_nsw_sopa");
    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.projectId, sweepProject), eq(signals.detector, "payment_deemed_liability")),
      );
    expect(sigs.length).toBe(1);
  });

  it("suspends only from deemed, with effectiveFrom after the statutory notice period", async () => {
    // not deemed → refused
    const draft = (
      await createClaim(sweepProject, {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 100,
      })
    ).json() as { id: string };
    const refused = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sweepProject}/payment-claims/${draft.id}/suspend`,
      headers: owner.headers,
      payload: {},
    });
    expect(refused.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sweepProject}/payment-claims/${overdueClaimId}/suspend`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const notice = res.json() as { id: string; effectiveFrom: string };
    // au_nsw_sopa: 2 days' notice (s 27, modelled in calendar days)
    expect(notice.effectiveFrom).toBe(addDaysISO(todayISO(), 2));

    const [claim] = await app.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, overdueClaimId));
    expect(claim!.status).toBe("suspended");

    // claim creator is notified
    const notes = await app.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, owner.userId), eq(notifications.recordId, overdueClaimId)),
      );
    expect(notes.length).toBe(1);
    expect(notes[0]!.title).toContain("Suspension notice served");

    // lift restores the pre-suspension (deemed) state
    const lift = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sweepProject}/suspension-notices/${notice.id}/lift`,
      headers: owner.headers,
      payload: {},
    });
    expect(lift.statusCode).toBe(200);
    expect((lift.json() as { liftedAt: string | null }).liftedAt).toBeTruthy();
    const [after] = await app.db
      .select()
      .from(paymentClaims)
      .where(eq(paymentClaims.id, overdueClaimId));
    expect(after!.status).toBe("deemed");

    const liftAgain = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${sweepProject}/suspension-notices/${notice.id}/lift`,
      headers: owner.headers,
      payload: {},
    });
    expect(liftAgain.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Interest (#387)                                                     */
/* ------------------------------------------------------------------ */

describe("late payment interest", () => {
  it("accrues nothing before the final payment date", async () => {
    const created = (
      await createClaim(projectId, {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 40000,
      })
    ).json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/serve`,
      headers: owner.headers,
      payload: { method: "email" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/payment-claims/${created.id}/interest`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { daysLate: number; interest: number; annualRate: number };
    expect(body.daysLate).toBe(0);
    expect(body.interest).toBe(0);
    expect(body.annualRate).toBe(12.75);
  });

  it("computes ACT/365 simple interest on a claim paid after the final date", async () => {
    const claimId = await insertClaim({
      servedAt: isoTimestampDaysAgo(30),
      serviceMethod: "email",
      responseDeadline: addDaysISO(todayISO(), -25),
      finalPaymentDate: addDaysISO(todayISO(), -10),
      status: "deemed",
    });
    const paid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/payment-claims/${claimId}/mark-paid`,
      headers: owner.headers,
      payload: { paidAmount: 50000 },
    });
    expect(paid.statusCode).toBe(200);
    expect((paid.json() as { status: string }).status).toBe("paid");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/payment-claims/${claimId}/interest`,
      headers: owner.headers,
    });
    const body = res.json() as {
      daysLate: number;
      interest: number;
      outstanding: number;
      basis: string;
    };
    expect(body.daysLate).toBe(10);
    expect(body.outstanding).toBe(50000);
    // 50000 × 12.75% × 10/365 = 174.657… → 174.66
    expect(body.interest).toBe(174.66);
    expect(body.basis).toContain("ACT/365");
  });

  it("accrues on unpaid deemed claims and uses a valid response amount as the base", async () => {
    const claimId = await insertClaim({
      claimedAmount: 10000,
      servedAt: isoTimestampDaysAgo(100),
      serviceMethod: "email",
      responseDeadline: addDaysISO(todayISO(), -90),
      finalPaymentDate: addDaysISO(todayISO(), -73),
      status: "deemed",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/payment-claims/${claimId}/interest`,
      headers: owner.headers,
    });
    const body = res.json() as { daysLate: number; interest: number; outstanding: number };
    expect(body.daysLate).toBe(73);
    expect(body.outstanding).toBe(10000);
    // 10000 × 12.75% × 73/365 = exactly 255.00
    expect(body.interest).toBe(255);

    // an ON-TIME response re-bases the outstanding amount
    const respondedId = await insertClaim({
      claimedAmount: 10000,
      servedAt: isoTimestampDaysAgo(100),
      serviceMethod: "email",
      responseDeadline: addDaysISO(todayISO(), -90),
      finalPaymentDate: addDaysISO(todayISO(), -73),
      status: "responded",
    });
    await app.db.insert(paymentResponses).values({
      id: newId("prs"),
      paymentClaimId: respondedId,
      companyId: owner.companyId,
      kind: "pay_less_notice",
      amount: 8000,
      reasons: "abatement",
      servedAt: isoTimestampDaysAgo(95),
      late: 0,
      servedBy: owner.userId,
    });
    const rebased = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/payment-claims/${respondedId}/interest`,
      headers: owner.headers,
    });
    const rebasedBody = rebased.json() as { outstanding: number; interest: number };
    expect(rebasedBody.outstanding).toBe(8000);
    // 8000 × 12.75% × 73/365 = exactly 204.00
    expect(rebasedBody.interest).toBe(204);
  });
});

/* ------------------------------------------------------------------ */
/* Analytics + deadline radar (#386)                                   */
/* ------------------------------------------------------------------ */

describe("payments analytics", () => {
  let pid: string;

  beforeAll(async () => {
    pid = await makeProject("Payments Analytics Project");
    const base = {
      companyId: owner.companyId,
      projectId: pid,
      regime: "uk_hgcra",
      referenceDate: addDaysISO(todayISO(), -30),
      currency: "GBP",
      createdBy: owner.userId,
    };
    await app.db.insert(paymentClaims).values([
      // paid in 8 days
      {
        ...base,
        id: newId("pcl"),
        number: 1,
        claimedAmount: 5000,
        status: "paid",
        servedAt: isoTimestampDaysAgo(10),
        responseDeadline: addDaysISO(todayISO(), -5),
        finalPaymentDate: addDaysISO(todayISO(), 7),
        paidAt: isoTimestampDaysAgo(2),
        paidAmount: 5000,
      },
      // paid in 4 days
      {
        ...base,
        id: newId("pcl"),
        number: 2,
        claimedAmount: 3000,
        status: "paid",
        servedAt: isoTimestampDaysAgo(6),
        responseDeadline: addDaysISO(todayISO(), -1),
        finalPaymentDate: addDaysISO(todayISO(), 11),
        paidAt: isoTimestampDaysAgo(2),
        paidAmount: 3000,
      },
      // served, response deadline in 5 days
      {
        ...base,
        id: newId("pcl"),
        number: 3,
        claimedAmount: 1000,
        status: "served",
        servedAt: isoTimestampDaysAgo(0),
        responseDeadline: addDaysISO(todayISO(), 5),
        finalPaymentDate: addDaysISO(todayISO(), 17),
      },
      // deemed
      {
        ...base,
        id: newId("pcl"),
        number: 4,
        claimedAmount: 2000,
        status: "deemed",
        servedAt: isoTimestampDaysAgo(20),
        responseDeadline: addDaysISO(todayISO(), -15),
        finalPaymentDate: addDaysISO(todayISO(), -3),
      },
      // draft
      {
        ...base,
        id: newId("pcl"),
        number: 5,
        claimedAmount: 700,
        status: "draft",
      },
    ]);
  });

  it("reports status mix, avgDaysToPay, outstanding book and deemed exposure", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/payments/analytics`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, number | null>;
    expect(body["claims"]).toBe(5);
    expect(body["served"]).toBe(1);
    expect(body["paid"]).toBe(2);
    expect(body["deemed"]).toBe(1);
    expect(body["avgDaysToPay"]).toBe(6); // (8 + 4) / 2
    expect(body["totalOutstanding"]).toBe(3000); // served 1000 + deemed 2000
    expect(body["deemedExposure"]).toBe(2000);
  });

  it("surfaces served claims inside the deadline radar window", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/payments/deadlines?days=14`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      windowDays: number;
      items: { number: number; daysRemaining: number }[];
    };
    expect(body.windowDays).toBe(14);
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.number).toBe(3);
    expect(body.items[0]!.daysRemaining).toBe(5);
  });
});
