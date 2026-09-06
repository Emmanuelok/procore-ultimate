/**
 * Integration tests for the lender-discipline upgrade to the finance module
 * (spec Vol II Domain O #736-751).
 *
 * Covers: eligibility classification and the submission gate it creates,
 * independent certification between approval and payment, disbursement
 * forecasts vs actuals, ineligible-expenditure recoveries, computed
 * covenants from period cashflows, lender waivers and the draw-stop they
 * lift, the cost-of-finance accrual schedule, the withdrawal application,
 * the portfolio roll-up and health inputs.
 *
 * Also carries the regression tests for the audit findings in this area:
 * headroom is enforced under a row lock, money is never summed across
 * currencies, draws after the availability period or during an unwaived
 * covenant breach are refused, payment is separated from approval, and the
 * category picker's "available" figure agrees with the gate that enforces it.
 *
 * Deliberately not covered here: the base facility/condition/covenant
 * behaviour, which finance.test.ts already owns.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  disbursements,
  evidence,
  ledgerEntries,
  projects,
  reconciliations,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor; // requester
let approver: TestActor; // admin — approves
let approverHeaders: Record<string, string>;
let certifier: TestActor; // admin — certifies and pays
let certifierHeaders: Record<string, string>;

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
  approverHeaders = {
    authorization: approver.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  certifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: certifier.userId,
    role: "admin",
  });
  certifierHeaders = {
    authorization: certifier.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

}, 600_000);

afterAll(async () => {
  await built.close();
});

/* ----------------------------- small helpers ----------------------------- */

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function insertEvidence(pid: string): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    kind: "document",
    source: "contractor invoice pack",
    contentHash: `hash-${id}`,
    submittedBy: owner.userId,
  });
  return id;
}

async function createFacility(pid: string, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/facilities`,
    headers: owner.headers,
    payload: {
      name: "IFI Loan",
      lender: "Development Bank",
      instrument: "loan",
      committedAmount: 1_000_000,
      ...payload,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; currency: string; categories: { id: string }[] };
}

async function createRequest(pid: string, facilityId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/facilities/${facilityId}/disbursements`,
    headers: owner.headers,
    payload: { purpose: "Interim payment certificate 3", ...payload },
  });
}

async function classifyAllEligible(pid: string, disbursementId: string, evidenceIds: string[]) {
  return app.inject({
    method: "PUT",
    url: `/api/v1/projects/${pid}/disbursements/${disbursementId}/eligibility`,
    headers: owner.headers,
    payload: {
      entries: evidenceIds.map((evidenceId) => ({ evidenceId, eligibility: "eligible" })),
    },
  });
}

async function submit(pid: string, id: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disbursements/${id}/submit`,
    headers: owner.headers,
    payload: {},
  });
}

async function approve(pid: string, id: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disbursements/${id}/approve`,
    headers: approverHeaders,
    payload: {},
  });
}

async function certify(pid: string, id: string, headers = certifierHeaders) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disbursements/${id}/certify`,
    headers,
    payload: { note: "Works inspected; quantities agree with the measured record." },
  });
}

async function disburse(pid: string, id: string, headers = certifierHeaders) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disbursements/${id}/disburse`,
    headers,
    payload: {},
  });
}

/** Draft → paid, doing every step with the right actor. */
async function payInFull(pid: string, facilityId: string, amount: number, opts: { evidence?: string[] } = {}) {
  const evidenceIds = opts.evidence ?? [];
  const created = await createRequest(pid, facilityId, { amount, evidenceIds });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  if (evidenceIds.length > 0) {
    expect((await classifyAllEligible(pid, id, evidenceIds)).statusCode).toBe(200);
  }
  expect((await submit(pid, id)).statusCode).toBe(200);
  expect((await approve(pid, id)).statusCode).toBe(200);
  expect((await certify(pid, id)).statusCode).toBe(200);
  const paid = await disburse(pid, id);
  expect(paid.statusCode).toBe(200);
  return id;
}

/* ------------------------------------------------------------------ */
/* Eligibility classification (#736-737)                               */
/* ------------------------------------------------------------------ */

describe("expenditure eligibility", () => {
  it("refuses submission while any attached item is ineligible or unassessed", async () => {
    const pid = await makeProject("Eligibility Project");
    const facility = await createFacility(pid);
    const e1 = await insertEvidence(pid);
    const e2 = await insertEvidence(pid);

    const created = await createRequest(pid, facility.id, {
      amount: 10_000,
      evidenceIds: [e1, e2],
    });
    const id = created.json().id as string;

    // Nothing classified yet — "we didn't look" is not an answer.
    const unassessed = await submit(pid, id);
    expect(unassessed.statusCode).toBe(409);
    expect(unassessed.json().eligibility.unassessed).toBe(2);

    // One item ineligible with a reason — still refused, and the reason shows.
    const mixed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disbursements/${id}/eligibility`,
      headers: owner.headers,
      payload: {
        entries: [
          { evidenceId: e1, eligibility: "eligible" },
          {
            evidenceId: e2,
            eligibility: "ineligible",
            reason: "taxes_and_duties",
            amount: 2_500,
          },
        ],
      },
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().assessment.ineligible).toBe(1);
    expect(mixed.json().assessment.ineligibleAmount).toBe(2_500);

    const blocked = await submit(pid, id);
    expect(blocked.statusCode).toBe(409);

    // Reclassify and it goes through.
    expect((await classifyAllEligible(pid, id, [e1, e2])).statusCode).toBe(200);
    const ok = await submit(pid, id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().conditionality.eligibility.eligible).toBe(2);
  });

  it("requires a reason for an ineligible item and rejects unattached evidence", async () => {
    const pid = await makeProject("Eligibility Validation");
    const facility = await createFacility(pid);
    const attached = await insertEvidence(pid);
    const stray = await insertEvidence(pid);
    const created = await createRequest(pid, facility.id, {
      amount: 1_000,
      evidenceIds: [attached],
    });
    const id = created.json().id as string;

    const noReason = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disbursements/${id}/eligibility`,
      headers: owner.headers,
      payload: { entries: [{ evidenceId: attached, eligibility: "ineligible" }] },
    });
    expect(noReason.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disbursements/${id}/eligibility`,
      headers: owner.headers,
      payload: { entries: [{ evidenceId: stray, eligibility: "eligible" }] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().details?.unknownEvidenceIds ?? unknown.json().unknownEvidenceIds).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* Certification (#738)                                                */
/* ------------------------------------------------------------------ */

describe("independent certification", () => {
  it("inserts certification between approval and payment on a loan facility", async () => {
    const pid = await makeProject("Certification Project");
    const facility = await createFacility(pid);
    const created = await createRequest(pid, facility.id, { amount: 20_000 });
    const id = created.json().id as string;
    expect((await submit(pid, id)).statusCode).toBe(200);
    expect((await approve(pid, id)).statusCode).toBe(200);

    // Paying an uncertified loan draw is refused with the reason.
    const early = await disburse(pid, id);
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/certification/i);

    const certified = await certify(pid, id);
    expect(certified.statusCode).toBe(200);
    expect(certified.json().certifiedBy).toBe(certifier.userId);

    const paid = await disburse(pid, id);
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status).toBe("disbursed");
  });

  it("REGRESSION: refuses a certifier who created, submitted or approved the request", async () => {
    const pid = await makeProject("Certification SoD");
    const facility = await createFacility(pid);
    const created = await createRequest(pid, facility.id, { amount: 5_000 });
    const id = created.json().id as string;
    await submit(pid, id);
    await approve(pid, id);

    const byApprover = await certify(pid, id, approverHeaders);
    expect(byApprover.statusCode).toBe(403);
    expect(byApprover.json().message).toMatch(/separation of duties/i);

    const byRequester = await certify(pid, id, owner.headers);
    expect(byRequester.statusCode).toBe(403);
  });

  it("REGRESSION: the payer may not be the requester, submitter or approver", async () => {
    const pid = await makeProject("Payment SoD");
    const facility = await createFacility(pid, { instrument: "grant" });
    const created = await createRequest(pid, facility.id, { amount: 5_000 });
    const id = created.json().id as string;
    await submit(pid, id);
    await approve(pid, id);

    // A grant needs no certification, so this isolates the payment SoD rule.
    const byRequester = await disburse(pid, id, owner.headers);
    expect(byRequester.statusCode).toBe(403);
    const byApprover = await disburse(pid, id, approverHeaders);
    expect(byApprover.statusCode).toBe(403);
    const byThirdParty = await disburse(pid, id);
    expect(byThirdParty.statusCode).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Headroom, draw-stops and availability (#739-741, #747)              */
/* ------------------------------------------------------------------ */

describe("headroom and draw-stops", () => {
  it("REGRESSION: the pipeline — not just cash paid — consumes headroom, and 'available' agrees with the gate", async () => {
    const pid = await makeProject("Headroom Project");
    const facility = await createFacility(pid, {
      committedAmount: 1_000_000,
      categories: [{ name: "Civil works", limit: 500_000 }],
    });
    const categoryId = facility.categories[0]!.id;

    const first = await createRequest(pid, facility.id, { amount: 300_000, categoryId });
    const firstId = first.json().id as string;
    expect((await submit(pid, firstId)).statusCode).toBe(200);
    expect((await approve(pid, firstId)).statusCode).toBe(200);
    // Approved but unpaid — the old code showed 500,000 "remaining" here.

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}`,
      headers: owner.headers,
    });
    const category = detail.json().categories[0];
    expect(category.disbursed).toBe(0);
    expect(category.pipeline).toBe(300_000);
    expect(category.available).toBe(200_000);
    expect(category.remaining).toBe(500_000); // the cash view, still reported

    const second = await createRequest(pid, facility.id, { amount: 400_000, categoryId });
    const secondId = second.json().id as string;
    const refused = await submit(pid, secondId);
    expect(refused.statusCode).toBe(409);

    const withinAvailable = await createRequest(pid, facility.id, {
      amount: 200_000,
      categoryId,
    });
    expect((await submit(pid, withinAvailable.json().id as string)).statusCode).toBe(200);
  });

  it("REGRESSION: refuses a submission after the availability period ends", async () => {
    const pid = await makeProject("Closed Facility");
    const facility = await createFacility(pid, {
      availabilityEndDate: addDaysISO(todayISO(), -30),
    });
    const created = await createRequest(pid, facility.id, { amount: 1_000 });
    const refused = await submit(pid, created.json().id as string);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/availability period ended/i);

    const stop = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/draw-stop`,
      headers: owner.headers,
    });
    expect(stop.json().stopped).toBe(true);
    expect(stop.json().pastAvailability).toBe(true);
  });

  it("REGRESSION: an unwaived covenant breach stops draws; a lender waiver lifts it", async () => {
    const pid = await makeProject("Covenant Draw Stop");
    const facility = await createFacility(pid);
    const covenant = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/covenants`,
      headers: owner.headers,
      payload: { name: "DSCR", operator: "gte", threshold: 1.2, unit: "x" },
    });
    expect(covenant.statusCode).toBe(201);
    const covenantId = covenant.json().id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/covenants/${covenantId}/readings`,
      headers: owner.headers,
      payload: { readingDate: todayISO(), value: 0.9 },
    });

    const created = await createRequest(pid, facility.id, { amount: 1_000 });
    const id = created.json().id as string;
    const blocked = await submit(pid, id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/breach/i);

    const waiver = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/covenants/${covenantId}/waive`,
      headers: owner.headers,
      payload: {
        reason: "Lender waived the Q2 DSCR test subject to an equity cure.",
        lenderReference: "WV-2026-04",
        effectiveFrom: addDaysISO(todayISO(), -1),
      },
    });
    expect(waiver.statusCode).toBe(201);

    const afterWaiver = await submit(pid, id);
    expect(afterWaiver.statusCode).toBe(200);

    const stop = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/draw-stop`,
      headers: owner.headers,
    });
    expect(stop.json().stopped).toBe(false);
    expect(stop.json().covenants[0].waivedBy.reference).toBe("WV-2026-04");
  });
});

/* ------------------------------------------------------------------ */
/* Forecasts and recoveries (#744-746)                                 */
/* ------------------------------------------------------------------ */

describe("disbursement forecasts", () => {
  it("compares planned tranches with actuals and names a milestone that has not happened", async () => {
    const pid = await makeProject("Forecast Project");
    const facility = await createFacility(pid);

    const scheduleId = newId("sch");
    await app.db.insert(schedules).values({
      id: scheduleId,
      companyId: owner.companyId,
      projectId: pid,
      name: "Baseline",
      projectStart: addDaysISO(todayISO(), -120),
      isActive: 1,
      createdBy: owner.userId,
    });
    const taskId = newId("tsk");
    await app.db.insert(scheduleTasks).values({
      id: taskId,
      scheduleId,
      projectId: pid,
      name: "Substructure complete",
      durationDays: 10,
      sortOrder: 1,
    });

    const start = addDaysISO(todayISO(), -60);
    const end = addDaysISO(todayISO(), -30);
    const forecast = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/forecasts`,
      headers: owner.headers,
      payload: {
        periodStart: start,
        periodEnd: end,
        plannedAmount: 200_000,
        milestoneTaskId: taskId,
      },
    });
    expect(forecast.statusCode).toBe(201);

    const view = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/forecast`,
      headers: owner.headers,
    });
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.points).toHaveLength(1);
    expect(body.points[0].planned).toBe(200_000);
    expect(body.points[0].actual).toBe(0);
    expect(body.behindPlan).toBe(true);
    expect(body.milestoneBreaches).toHaveLength(1);
    expect(body.lagAmount).toBe(200_000);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${pid}/disbursement-forecasts/${forecast.json().id}`,
      headers: owner.headers,
    });
    expect(removed.statusCode).toBe(204);
  });
});

describe("ineligible expenditure recoveries", () => {
  it("opens, lists and resolves a recovery, bucketing open amounts by currency", async () => {
    const pid = await makeProject("Recovery Project");
    const facility = await createFacility(pid);

    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/recoveries`,
      headers: owner.headers,
      payload: {
        amount: 12_500,
        reason: "taxes_and_duties",
        detail: "VAT financed contrary to loan agreement clause 3.4",
      },
    });
    expect(opened.statusCode).toBe(201);
    const recoveryId = opened.json().id as string;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/recoveries`,
      headers: owner.headers,
    });
    expect(list.json().total).toBe(1);
    expect(list.json().openByCurrency).toEqual([
      expect.objectContaining({ currency: "GBP", amount: 12_500 }),
    ]);

    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/recoveries/${recoveryId}/resolve`,
      headers: owner.headers,
      payload: { status: "recovered", note: "Offset against application 7" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("recovered");

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/recoveries`,
      headers: owner.headers,
    });
    expect(after.json().openByCurrency).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Computed covenants and cost of finance (#743, #748-751)             */
/* ------------------------------------------------------------------ */

describe("computed covenants", () => {
  it("computes a DSCR reading from period cashflows and signals the breach", async () => {
    const pid = await makeProject("Computed Covenant Project");
    const facility = await createFacility(pid);
    const covenant = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/covenants`,
      headers: owner.headers,
      payload: {
        name: "DSCR",
        operator: "gte",
        threshold: 1.2,
        unit: "x",
        formula: "dscr",
      },
    });
    expect(covenant.statusCode).toBe(201);
    expect(covenant.json().formula).toBe("dscr");

    const periodEnd = todayISO();
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/cashflows`,
      headers: owner.headers,
      payload: { periodEnd, inputs: { cfads: 900_000, debtService: 1_000_000 } },
    });
    expect(saved.statusCode).toBe(200);
    const computed = saved.json().computed;
    expect(computed).toHaveLength(1);
    expect(computed[0].value).toBeCloseTo(0.9, 6);

    const readings = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/covenants/${covenant.json().id}/readings`,
      headers: owner.headers,
    });
    expect(readings.json().items).toHaveLength(1);
    expect(readings.json().items[0].compliant).toBe(0);

    // Re-saving the same period updates rather than duplicating the reading.
    const again = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/cashflows`,
      headers: owner.headers,
      payload: { periodEnd, inputs: { cfads: 1_500_000, debtService: 1_000_000 } },
    });
    expect(again.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/covenants/${covenant.json().id}/readings`,
      headers: owner.headers,
    });
    expect(after.json().items).toHaveLength(1);
    expect(after.json().items[0].compliant).toBe(1);
  });

  it("reports the missing input rather than a zero when a formula cannot be computed", async () => {
    const pid = await makeProject("Unknowable Covenant");
    const facility = await createFacility(pid);
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/covenants`,
      headers: owner.headers,
      payload: { name: "Gearing", operator: "lte", threshold: 0.7, formula: "gearing" },
    });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/cashflows`,
      headers: owner.headers,
      payload: { periodEnd: todayISO(), inputs: { cfads: 100 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().computed[0].value).toBeNull();
    expect(saved.json().computed[0].unavailableReason).toBeTruthy();
  });

  it("serves the formula library at company level", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/finance/covenant-formulas",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().formulas.length).toBeGreaterThan(0);
    expect(res.json().inputs).toContain("cfads");
  });
});

describe("cost of finance", () => {
  it("accrues interest and commitment fees from the disbursement ledger", async () => {
    const pid = await makeProject("Cost of Finance Project");
    const facility = await createFacility(pid, {
      committedAmount: 1_000_000,
      baseRatePercent: 3,
      marginPercent: 2,
      commitmentFeePercent: 0.5,
      availabilityEndDate: addDaysISO(todayISO(), 200),
    });
    await payInFull(pid, facility.id, 400_000);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/cost-of-finance?from=${addDaysISO(todayISO(), -365)}&to=${todayISO()}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unavailableReason).toBeNull();
    expect(body.periods.length).toBeGreaterThan(0);
    expect(body.totalCommitmentFees).toBeGreaterThan(0);
    expect(body.basis).toMatch(/commitment fee/i);
  });

  it("says why rather than reporting zero when no rates are configured", async () => {
    const pid = await makeProject("No Rates Project");
    const facility = await createFacility(pid, {
      availabilityEndDate: addDaysISO(todayISO(), 90),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/cost-of-finance`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unavailableReason).toMatch(/no base rate/i);
    expect(res.json().periods).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Withdrawal application, portfolio and health inputs                 */
/* ------------------------------------------------------------------ */

describe("withdrawal application", () => {
  it("assembles the application with its statement of expenditure and names what is missing", async () => {
    const pid = await makeProject("Application Project");
    const facility = await createFacility(pid);
    const ev = await insertEvidence(pid);
    const created = await createRequest(pid, facility.id, { amount: 30_000, evidenceIds: [ev] });
    const id = created.json().id as string;

    const beforeCertification = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disbursements/${id}/application`,
      headers: owner.headers,
    });
    expect(beforeCertification.statusCode).toBe(200);
    const body = beforeCertification.json();
    expect(body.header.lender).toBe("Development Bank");
    expect(body.statementOfExpenditure).toHaveLength(1);
    expect(body.statementOfExpenditure[0].eligibility).toBe("unassessed");
    expect(body.certification.certified).toBe(false);
    expect(body.certification.requiredForInstrument).toBe(true);
    expect(body.warnings.join(" ")).toMatch(/NOT been certified/i);
  });
});

describe("portfolio and health inputs", () => {
  it("rolls facilities up per currency across the company and never sums across them", async () => {
    const pid = await makeProject("Portfolio Project");
    await createFacility(pid, { committedAmount: 500_000, currency: "GBP" });
    await createFacility(pid, {
      name: "USD Tranche",
      committedAmount: 250_000,
      currency: "USD",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/finance/portfolio",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const currencies = (res.json().committedByCurrency as { currency: string }[]).map(
      (b) => b.currency,
    );
    expect(currencies).toEqual(expect.arrayContaining(["GBP", "USD"]));
  });

  it("returns finance health inputs with reasons for anything unmeasurable", async () => {
    const pid = await makeProject("Health Inputs Project");
    await createFacility(pid);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/finance/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("metrics");
    expect(Array.isArray(res.json().reasons)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Sweeps run as the system, not as the reader                         */
/* ------------------------------------------------------------------ */

describe("scheduled sweeps", () => {
  it("breaches an overdue condition from the scheduler, not from a reader's request", async () => {
    const pid = await makeProject("Sweep Project");
    const facility = await createFacility(pid);
    const condition = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/conditions`,
      headers: owner.headers,
      payload: {
        kind: "subsequent",
        description: "Annual audited accounts delivered",
        dueDate: addDaysISO(todayISO(), -5),
      },
    });
    expect(condition.statusCode).toBe(201);

    await app.scheduler.runNow("finance.conditions");

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/conditions`,
      headers: owner.headers,
    });
    const row = (after.json().items as { id: string; status: string }[]).find(
      (c) => c.id === condition.json().id,
    );
    expect(row?.status).toBe("breached");

    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.projectId, pid)));
    expect(raised.length).toBeGreaterThan(0);
  });

  it("REGRESSION: a read-path sweep is attributed to the platform, never to the reader", async () => {
    const pid = await makeProject("Read Sweep Attribution");
    const facility = await createFacility(pid);
    const condition = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facility.id}/conditions`,
      headers: owner.headers,
      payload: {
        kind: "subsequent",
        description: "Insurance certificate renewed",
        dueDate: addDaysISO(todayISO(), -3),
      },
    });
    expect(condition.statusCode).toBe(201);
    const conditionId = condition.json().id as string;

    // A plain GET still refreshes the state — but as the system, not as the
    // auditor who happened to open the page.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/facilities`,
      headers: owner.headers,
    });
    expect(read.statusCode).toBe(200);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "facility_condition"),
          eq(ledgerEntries.objectId, conditionId),
          eq(ledgerEntries.action, "state_change"),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.actorId).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation on the upgraded finance routes", () => {
  it("keeps every new route invisible to another company", async () => {
    const pid = await makeProject("Isolation Project");
    const facility = await createFacility(pid);
    const created = await createRequest(pid, facility.id, { amount: 1_000 });
    const disbursementId = created.json().id as string;

    const stranger = await registerActor(app);
    const paths: Array<[string, string]> = [
      ["GET", `/api/v1/projects/${pid}/facilities/${facility.id}/forecast`],
      ["GET", `/api/v1/projects/${pid}/facilities/${facility.id}/recoveries`],
      ["GET", `/api/v1/projects/${pid}/facilities/${facility.id}/cashflows`],
      ["GET", `/api/v1/projects/${pid}/facilities/${facility.id}/draw-stop`],
      ["GET", `/api/v1/projects/${pid}/facilities/${facility.id}/cost-of-finance`],
      ["GET", `/api/v1/projects/${pid}/disbursements/${disbursementId}/application`],
      ["GET", `/api/v1/projects/${pid}/finance/health-inputs`],
    ];
    for (const [method, url] of paths) {
      const res = await app.inject({ method: method as "GET", url, headers: stranger.headers });
      expect([403, 404]).toContain(res.statusCode);
    }

    const write = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disbursements/${disbursementId}/eligibility`,
      headers: stranger.headers,
      payload: { entries: [] },
    });
    expect([403, 404]).toContain(write.statusCode);

    // And the row is untouched.
    const rows = await app.db
      .select()
      .from(disbursements)
      .where(eq(disbursements.id, disbursementId));
    expect(rows[0]?.status).toBe("draft");
  });

  it("does not leak another company's facilities through the portfolio roll-up", async () => {
    const stranger = await registerActor(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/finance/portfolio",
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().facilities).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Designated (special) account reconciliation (#735, #745)            */
/* ------------------------------------------------------------------ */

describe("designated accounts", () => {
  async function createAccount(pid: string, facilityId: string, payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facilityId}/designated-accounts`,
      headers: owner.headers,
      payload: {
        name: "Designated Account A",
        bankName: "Local Commercial Bank",
        accountRef: "…4417",
        authorisedCeiling: 500_000,
        openingBalance: 0,
        ...payload,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; currency: string };
  }

  async function addEntry(pid: string, accountId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${accountId}/entries`,
      headers: owner.headers,
      payload,
    });
  }

  it("keeps a signed ledger and reports the outstanding advance", async () => {
    const pid = await makeProject("Designated Account Project");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id);

    expect(
      (
        await addEntry(pid, account.id, {
          entryDate: addDaysISO(todayISO(), -60),
          kind: "advance",
          amount: 300_000,
          description: "Initial advance under the facility",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await addEntry(pid, account.id, {
          entryDate: addDaysISO(todayISO(), -30),
          kind: "eligible_expenditure",
          amount: 120_000,
          description: "IPC 3 paid to the main contractor",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await addEntry(pid, account.id, {
          entryDate: addDaysISO(todayISO(), -10),
          kind: "bank_charge",
          amount: 400,
          description: "Quarterly account charges",
        })
      ).statusCode,
    ).toBe(201);

    const view = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}`,
      headers: owner.headers,
    });
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.entries).toHaveLength(3);
    expect(body.position.balance).toBe(179_600);
    expect(body.position.outstandingAdvance).toBe(180_000);
    expect(body.position.documentedPercent).toBe(40);
    expect(body.position.ceilingHeadroom).toBe(320_400);
    expect(body.position.basis).toMatch(/Entries after that date are excluded/);
  });

  it("raises a signal when the balance goes above the authorised ceiling, once", async () => {
    const pid = await makeProject("Ceiling Breach Project");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id, { authorisedCeiling: 100_000 });

    const over = await addEntry(pid, account.id, {
      entryDate: todayISO(),
      kind: "advance",
      amount: 150_000,
      description: "Advance in excess of the ceiling",
    });
    expect(over.statusCode).toBe(201);
    expect(over.json().position.overCeiling).toBe(true);

    // A second breaching entry must not raise a second open signal.
    await addEntry(pid, account.id, {
      entryDate: todayISO(),
      kind: "advance",
      amount: 10_000,
      description: "Further advance",
    });

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.projectId, pid),
          eq(signals.detector, "designated_account_over_ceiling"),
        ),
      );
    expect(raised).toHaveLength(1);
  });

  it("raises an account nobody has reconciled from the scheduler, and clears it once they do", async () => {
    const pid = await makeProject("Stale Reconciliation Project");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id);

    await app.scheduler.runNow("finance.designated-accounts");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "designated_account_unreconciled_overdue"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.explanation).toMatch(/never been reconciled/i);

    // Running it again does not raise a second copy of the same finding.
    await app.scheduler.runNow("finance.designated-accounts");
    expect(
      await app.db
        .select()
        .from(signals)
        .where(
          and(
            eq(signals.projectId, pid),
            eq(signals.detector, "designated_account_unreconciled_overdue"),
          ),
        ),
    ).toHaveLength(1);

    const done = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}/reconcile`,
      headers: owner.headers,
      payload: { periodEnd: todayISO(), statementBalance: 0 },
    });
    expect(done.statusCode).toBe(201);
    expect(done.json().outcome).toBe("reconciled");

    await app.scheduler.runNow("finance.designated-accounts");
    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "designated_account_unreconciled_overdue"),
        ),
      );
    expect(after[0]?.disposition).toBe("closed");
  });

  it("reconciles against the bank, mirrors it into the assurance register and refuses a rewrite", async () => {
    const pid = await makeProject("Reconciliation Project");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id);
    const periodEnd = addDaysISO(todayISO(), -1);
    await addEntry(pid, account.id, {
      entryDate: addDaysISO(todayISO(), -20),
      kind: "advance",
      amount: 200_000,
      description: "Advance",
    });
    const ev = await insertEvidence(pid);

    const clean = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}/reconcile`,
      headers: owner.headers,
      payload: { periodEnd, statementBalance: 200_000, evidenceIds: [ev] },
    });
    expect(clean.statusCode).toBe(201);
    expect(clean.json().outcome).toBe("reconciled");
    expect(clean.json().difference).toBe(0);
    expect(clean.json().assuranceReconciliationId).toBeTruthy();

    // The assurance register carries the same finding.
    const mirrored = await app.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, clean.json().assuranceReconciliationId as string));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.result).toBe("supported");
    expect(mirrored[0]?.method).toBe("designated_account_balance");

    // A reconciliation is a record of what was checked on a date, not a draft.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}/reconcile`,
      headers: owner.headers,
      payload: { periodEnd, statementBalance: 199_000 },
    });
    expect(again.statusCode).toBe(409);
  });

  it("raises a signal and contradicts the assertion when the bank does not agree", async () => {
    const pid = await makeProject("Unreconciled Project");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id);
    await addEntry(pid, account.id, {
      entryDate: addDaysISO(todayISO(), -20),
      kind: "advance",
      amount: 200_000,
      description: "Advance",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}/reconcile`,
      headers: owner.headers,
      payload: { periodEnd: todayISO(), statementBalance: 185_000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("unreconciled");
    expect(res.json().difference).toBe(-15_000);

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "designated_account_unreconciled"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");

    const mirrored = await app.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, res.json().assuranceReconciliationId as string));
    expect(mirrored[0]?.result).toBe("contradicted");
    // No evidence attached → the row is marked self-certified, not trusted.
    expect(mirrored[0]?.selfCertified).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* PPP / availability payment mechanism                                */
/* ------------------------------------------------------------------ */

describe("availability payment mechanism", () => {
  async function createModel(pid: string, payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models`,
      headers: owner.headers,
      payload: {
        name: "Hospital concession — unitary charge",
        unitaryCharge: 1_000_000,
        availabilityWeightPercent: 70,
        performanceWeightPercent: 30,
        performancePointValuePercent: 0.1,
        ...payload,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; currency: string };
  }

  it("computes the deduction and the net payment for a period", async () => {
    const pid = await makeProject("Availability Project");
    const model = await createModel(pid);

    const period = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
      payload: {
        periodStart: addDaysISO(todayISO(), -30),
        periodEnd: todayISO(),
        requiredHours: 720,
        unavailabilityEvents: [{ area: "Ward block", hours: 72, weight: 0.5 }],
        performancePoints: 40,
      },
    });
    expect(period.statusCode).toBe(201);
    const computed = period.json().computed;
    // 1,000,000 × 70% × (36/720) = 35,000 ; performance 1,000,000 × 30% × 4% = 12,000
    expect(computed.availabilityDeduction).toBeCloseTo(35_000, 2);
    expect(computed.performanceDeduction).toBeCloseTo(12_000, 2);
    expect(computed.netPayment).toBeCloseTo(953_000, 2);
    expect(computed.basis).toMatch(/Ratchets/);
  });

  it("refuses weights that together exceed the whole charge", async () => {
    const pid = await makeProject("Bad Weights Project");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models`,
      headers: owner.headers,
      payload: {
        name: "Impossible mechanism",
        unitaryCharge: 100,
        availabilityWeightPercent: 80,
        performanceWeightPercent: 40,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("certifies a period with separation of duties and excludes drafts from the totals", async () => {
    const pid = await makeProject("Certified Period Project");
    const model = await createModel(pid, { persistentBreachPoints: 100 });
    const start = addDaysISO(todayISO(), -60);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
      payload: {
        periodStart: start,
        periodEnd: addDaysISO(todayISO(), -30),
        requiredHours: 720,
        unavailabilityEvents: [],
        performancePoints: 120,
      },
    });
    expect(created.statusCode).toBe(201);
    const periodId = created.json().id as string;

    // Before certification nothing counts toward the totals.
    const drafts = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
    });
    expect(drafts.json().totals.certifiedPeriods).toBe(0);
    expect(drafts.json().totals.certifiedNet).toBe(0);
    expect(drafts.json().basis).toMatch(/draft period is an unagreed number/);

    // The recorder may not certify their own period.
    const self = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-periods/${periodId}/certify`,
      headers: owner.headers,
      payload: {},
    });
    expect(self.statusCode).toBe(403);

    const certified = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-periods/${periodId}/certify`,
      headers: approverHeaders,
      payload: {},
    });
    expect(certified.statusCode).toBe(200);
    expect(certified.json().status).toBe("certified");
    expect(certified.json().certifiedBy).toBe(approver.userId);

    // 120 points past the 100-point threshold raises the persistent-breach signal.
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.projectId, pid),
          eq(signals.detector, "availability_persistent_breach"),
        ),
      );
    expect(raised).toHaveLength(1);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
    });
    expect(after.json().totals.certifiedPeriods).toBe(1);
    expect(after.json().totals.certifiedNet).toBeGreaterThan(0);

    // Certifying twice is refused rather than silently re-freezing.
    const twice = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-periods/${periodId}/certify`,
      headers: approverHeaders,
      payload: {},
    });
    expect(twice.statusCode).toBe(400);
  });

  it("refuses a duplicate period on the same model", async () => {
    const pid = await makeProject("Duplicate Period Project");
    const model = await createModel(pid);
    const payload = {
      periodStart: addDaysISO(todayISO(), -30),
      periodEnd: todayISO(),
      requiredHours: 720,
      unavailabilityEvents: [],
      performancePoints: 0,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
      headers: owner.headers,
      payload,
    });
    expect(second.statusCode).toBe(409);
  });

  it("keeps designated accounts and availability models out of another company's reach", async () => {
    const pid = await makeProject("New Routes Isolation");
    const facility = await createFacility(pid);
    const account = await createAccount(pid, facility.id);
    const model = await createModel(pid);
    const stranger = await registerActor(app);

    for (const url of [
      `/api/v1/projects/${pid}/facilities/${facility.id}/designated-accounts`,
      `/api/v1/projects/${pid}/designated-accounts/${account.id}`,
      `/api/v1/projects/${pid}/availability-models`,
      `/api/v1/projects/${pid}/availability-models/${model.id}/periods`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: stranger.headers });
      expect([403, 404]).toContain(res.statusCode);
    }

    const write = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/designated-accounts/${account.id}/entries`,
      headers: stranger.headers,
      payload: {
        entryDate: todayISO(),
        kind: "advance",
        amount: 1,
        description: "should not land",
      },
    });
    expect([403, 404]).toContain(write.statusCode);
  });

  async function createAccount(pid: string, facilityId: string, payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/facilities/${facilityId}/designated-accounts`,
      headers: owner.headers,
      payload: {
        name: "Designated Account",
        authorisedCeiling: 500_000,
        ...payload,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }
});
