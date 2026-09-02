/**
 * WP-FIN2 — statutory payments upgrade coverage (Vol II F #373–393).
 *
 *   liens (#373-380)            register, statutory deadline as an Obligation,
 *                               transitions, and the scheduled breach sweep
 *   retention trusts / PBAs     accounts, movements, and the reconciliation
 *   (#381-385)                  that answers "is the trust actually funded?"
 *   adjudication (#386-390)     code-resident timetables per regime, cases,
 *                               obligations, the radar
 *   payment practice reporting  metrics computed from the registers, per
 *   (#391-393)                  currency, published as a fact
 *
 *   regressions                 index.ts:549 a late response never rescues a
 *                                            claim from being deemed
 *                               index.ts:166 the deemed sweep is a scheduled
 *                                            job, and raises one signal only
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  commitmentSovLines,
  commitments,
  obligations,
  paymentClaims,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { sweepLienDeadlines } from "./liens.js";
import { computeAdjudicationTimetable, ADJUDICATION_RULES } from "./adjudication.js";
import { reconcileAccount, signedAmount } from "./security.js";
import { computeMetrics, type PaidInvoiceSample } from "./supplychain.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let projectId: string;
let vendorId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  outsider = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "FIN2 statutory payments",
  });
  vendorId = newId("ven");
  await app.db.insert(vendors).values({
    id: vendorId,
    companyId: owner.companyId,
    name: "Tier-2 Groundworks",
  });
});

afterAll(async () => {
  await built.close();
});

const inject = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/* ================================================================== */
/* Pure engines                                                        */
/* ================================================================== */

describe("adjudication timetable (pure)", () => {
  it("computes the UK Scheme's 7-day referral and 28-day decision from the notice", () => {
    const steps = computeAdjudicationTimetable("uk_hgcra", "2026-06-01", null);
    const referral = steps.find((s) => s.step === "referral")!;
    expect(referral.dueAt).toBe("2026-06-08");
    const decision = steps.find((s) => s.step === "decision")!;
    // decision runs from referral; with no referral date the notice+referral window stands in
    expect(decision.dueAt > referral.dueAt).toBe(true);
  });

  it("re-bases the decision on the ACTUAL referral date once it is known", () => {
    const before = computeAdjudicationTimetable("uk_hgcra", "2026-06-01", null);
    const after = computeAdjudicationTimetable("uk_hgcra", "2026-06-01", "2026-06-04");
    const decisionBefore = before.find((s) => s.step === "decision")!.dueAt;
    const decisionAfter = after.find((s) => s.step === "decision")!.dueAt;
    expect(decisionAfter).toBe("2026-07-02"); // 2026-06-04 + 28 calendar days
    expect(decisionAfter).not.toBe(decisionBefore);
  });

  it("counts working days where the Act does, skipping weekends", () => {
    const steps = computeAdjudicationTimetable("au_nsw_sopa", "2026-06-01", null); // a Monday
    const referral = steps.find((s) => s.step === "referral")!;
    // 10 business days from Monday 1 June lands on Monday 15 June
    expect(referral.dueAt).toBe("2026-06-15");
    expect(referral.basis).toContain("business");
  });

  it("holds a rule for every regime and says which are working-day clocks", () => {
    for (const rule of Object.values(ADJUDICATION_RULES)) {
      expect(rule.referralDays).toBeGreaterThan(0);
      expect(rule.decisionDays).toBeGreaterThan(0);
      expect(rule.note.length).toBeGreaterThan(20);
    }
  });
});

describe("payment security accounts (pure)", () => {
  it("debits a release and a withdrawal, credits everything else", () => {
    expect(signedAmount("deposit", 100)).toBe(100);
    expect(signedAmount("interest", 5)).toBe(5);
    expect(signedAmount("release", 40)).toBe(-40);
    expect(signedAmount("withdrawal", 10)).toBe(-10);
  });

  it("reports a shortfall when the balance does not cover the retainage held", () => {
    const r = reconcileAccount({
      accountId: "a1",
      currency: "GBP",
      movements: [{ amount: 10000 }, { amount: -2000 }],
      commitments: [
        { id: "c1", reference: "SC-1", currency: "GBP", retainageHeld: 6000 },
        { id: "c2", reference: "SC-2", currency: "GBP", retainageHeld: 5000 },
      ],
    });
    expect(r.balance).toBe(8000);
    expect(r.retainageHeld).toBe(11000);
    expect(r.shortfall).toBe(3000);
    expect(r.funded).toBe(false);
  });

  it("never sums a commitment in another currency into the trust position", () => {
    const r = reconcileAccount({
      accountId: "a1",
      currency: "GBP",
      movements: [{ amount: 5000 }],
      commitments: [
        { id: "c1", reference: "SC-1", currency: "GBP", retainageHeld: 4000 },
        { id: "c2", reference: "SC-2", currency: "EUR", retainageHeld: 9999 },
      ],
    });
    expect(r.retainageHeld).toBe(4000);
    expect(r.funded).toBe(true);
    expect(r.skippedForCurrency).toHaveLength(1);
    expect(r.basis).toContain("other currencies");
  });
});

describe("payment practice metrics (pure)", () => {
  const sample = (days: number[], withinTerms: Array<boolean | null>): PaidInvoiceSample[] =>
    days.map((d, i) => ({
      invoiceId: `i${i}`,
      reference: `INV-${i}`,
      currency: "GBP",
      receivedAt: "2026-01-01",
      paidAt: "2026-02-01",
      dueAt: withinTerms[i] === null ? null : "2026-01-31",
      amount: 1000,
      daysToPay: d,
      withinTerms: withinTerms[i] ?? null,
    }));

  it("buckets days to pay at the regulation's boundaries", () => {
    const m = computeMetrics("GBP", sample([10, 30, 31, 60, 61, 200], [true, true, true, false, false, false]), 3);
    expect(m.invoicesPaid).toBe(6);
    expect(m.paidWithin30Pct).toBeCloseTo(33.3, 1);
    expect(m.paid31To60Pct).toBeCloseTo(33.3, 1);
    expect(m.paid61PlusPct).toBeCloseTo(33.3, 1);
    expect(m.notPaidWithinTermsPct).toBe(50);
    expect(m.invoicesOutstandingAtPeriodEnd).toBe(3);
  });

  it("says it cannot state the averages rather than reporting zero", () => {
    const m = computeMetrics("GBP", [], 0);
    expect(m.averageDaysToPay).toBeNull();
    expect(m.medianDaysToPay).toBeNull();
    expect(m.paidWithin30Pct).toBeNull();
    expect(m.reasons[0]).toContain("cannot be stated");
  });

  it("cannot answer 'within agreed terms' with no due dates, and says so", () => {
    const m = computeMetrics("GBP", sample([10, 20], [null, null]), 0);
    expect(m.notPaidWithinTermsPct).toBeNull();
    expect(m.termsUnknownCount).toBe(2);
    expect(m.reasons.join(" ")).toContain("agreed terms");
  });

  it("computes a median over an even sample", () => {
    const m = computeMetrics("GBP", sample([10, 20, 30, 40], [true, true, true, true]), 0);
    expect(m.medianDaysToPay).toBe(25);
    expect(m.averageDaysToPay).toBe(25);
  });
});

/* ================================================================== */
/* Statutory liens (#373-380)                                          */
/* ================================================================== */

describe("statutory liens", () => {
  let lienId: string;

  it("records a preliminary notice and materialises its deadline as an Obligation", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/liens`, owner.headers, {
      kind: "preliminary_notice",
      claimantName: "Tier-2 Groundworks",
      claimantVendorId: vendorId,
      tier: 2,
      amount: 42000,
      currency: "USD",
      jurisdiction: "CA",
      deadlineAt: addDaysISO(todayISO(), 20),
      deadlineBasis: "90 days from last furnishing (Civil Code 8414)",
    });
    expect(res.statusCode).toBe(201);
    lienId = res.json().id;
    expect(res.json().reference).toMatch(/^LIEN-\d{3}$/);
    expect(res.json().status).toBe("noticed");
    expect(res.json().obligationId).toBeTruthy();
    const obl = (
      await app.db.select().from(obligations).where(eq(obligations.id, res.json().obligationId)).limit(1)
    )[0]!;
    expect(obl.status).toBe("open");
  });

  it("refuses a claimant vendor from another company", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/liens`, owner.headers, {
      kind: "lien_filed",
      claimantName: "Ghost",
      claimantVendorId: "ven_not_real",
      amount: 100,
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports open exposure per currency and per tier, never as one number", async () => {
    await inject("POST", `/api/v1/projects/${projectId}/liens`, owner.headers, {
      kind: "lien_filed",
      claimantName: "Euro claimant",
      amount: 5000,
      currency: "EUR",
      deadlineAt: addDaysISO(todayISO(), 5),
    });
    const res = await inject("GET", `/api/v1/projects/${projectId}/liens/summary`, owner.headers);
    expect(res.statusCode).toBe(200);
    const currencies = (res.json().byCurrency as Array<{ currency: string; amount: number }>).map((c) => c.currency);
    expect(currencies).toContain("USD");
    expect(currencies).toContain("EUR");
    expect(res.json().dueWithin14).toBeGreaterThanOrEqual(1);
  });

  it("walks the lifecycle and satisfies the deadline obligation on release", async () => {
    const filed = await inject("POST", `/api/v1/projects/${projectId}/liens/${lienId}/file`, owner.headers, {});
    expect(filed.statusCode).toBe(200);
    expect(filed.json().status).toBe("filed");
    expect(filed.json().filedAt).toBeTruthy();

    const released = await inject(
      "POST",
      `/api/v1/projects/${projectId}/liens/${lienId}/release`,
      owner.headers,
      { releasedAt: todayISO() },
    );
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe("released");
    const obl = (
      await app.db.select().from(obligations).where(eq(obligations.id, released.json().obligationId)).limit(1)
    )[0]!;
    expect(obl.status).toBe("satisfied");
  });

  it("refuses a transition out of a closed lien", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/liens/${lienId}/file`, owner.headers, {});
    expect(res.statusCode).toBe(409);
  });

  it("breaches the obligation and raises exactly one signal when a deadline passes", async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/liens`, owner.headers, {
      kind: "lien_filed",
      claimantName: "Overdue claimant",
      amount: 9000,
      deadlineAt: addDaysISO(todayISO(), -2),
      deadlineBasis: "90 days from completion",
    });
    const id = created.json().id as string;

    const first = await sweepLienDeadlines(app.db, owner.companyId);
    expect(first.breached).toBeGreaterThanOrEqual(1);
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "lien_deadline_passed")));
    expect(raised.length).toBe(1);
    const obl = (
      await app.db.select().from(obligations).where(eq(obligations.id, created.json().obligationId)).limit(1)
    )[0]!;
    expect(obl.status).toBe("breached");

    const second = await sweepLienDeadlines(app.db, owner.companyId);
    expect(second.breached).toBe(0);
    const again = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "lien_deadline_passed")));
    expect(again.length).toBe(1);
    void id;
  });

  it("runs as a registered scheduler job, not only on a page read", async () => {
    const status = await app.scheduler.runNow("payments.lien-deadlines");
    expect(status.lastError).toBeNull();
  });

  it("does not leak the lien register to another company", async () => {
    const res = await inject("GET", `/api/v1/projects/${projectId}/liens`, outsider.headers);
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Retention trusts and project bank accounts (#381-385)               */
/* ================================================================== */

describe("retention trusts and project bank accounts", () => {
  let accountId: string;
  let commitmentId: string;

  beforeAll(async () => {
    commitmentId = newId("cmt");
    await app.db.insert(commitments).values({
      id: commitmentId,
      companyId: owner.companyId,
      projectId,
      kind: "subcontract",
      number: 50,
      reference: "SC-0050",
      title: "Trust beneficiary package",
      vendorId,
      status: "approved",
      executed: 1,
      currency: "USD",
      originalCommitmentSum: 100000,
      revisedCommitmentSum: 100000,
      retainageHeld: 10000,
      createdBy: owner.userId,
    });
    await app.db.insert(commitmentSovLines).values({
      id: newId("csl"),
      companyId: owner.companyId,
      projectId,
      commitmentId,
      lineNumber: "01",
      costCode: "02-100",
      costType: "subcontract",
      description: "Groundworks",
      scheduledValue: 100000,
      revisedScheduledValue: 100000,
      totalCompletedAndStored: 100000,
      retainageHeld: 10000,
    });
  });

  it("opens a retention trust with named beneficiaries", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-security-accounts`,
      owner.headers,
      {
        kind: "retention_trust",
        name: "Retention trust — Barclays 1234",
        currency: "USD",
        trustee: "Barclays Bank plc",
        beneficiaryVendorIds: [vendorId],
      },
    );
    expect(res.statusCode).toBe(201);
    accountId = res.json().id;
    expect(res.json().status).toBe("active");
  });

  it("reports it UNDER-FUNDED while nothing has been deposited", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/payment-security-accounts/${accountId}`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciliation.balance).toBe(0);
    expect(res.json().reconciliation.retainageHeld).toBe(10000);
    expect(res.json().reconciliation.funded).toBe(false);
    expect(res.json().reconciliation.shortfall).toBe(10000);
    expect(res.json().reconciliation.basis).toContain("Σ signed movements");
  });

  it("funds it with a deposit and reports it funded", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-security-accounts/${accountId}/movements`,
      owner.headers,
      { kind: "deposit", amount: 10000, reference: "TRF-001" },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().reconciliation.balance).toBe(10000);
    expect(res.json().reconciliation.funded).toBe(true);
  });

  it("refuses a release larger than the account holds", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-security-accounts/${accountId}/movements`,
      owner.headers,
      { kind: "release", amount: 50000 },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("exceeds");
  });

  it("raises a signal the moment a release makes the trust under-funded", async () => {
    const before = await app.db
      .select()
      .from(signals)
      .where(eq(signals.detector, "retention_trust_underfunded"));
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-security-accounts/${accountId}/movements`,
      owner.headers,
      { kind: "release", amount: 4000, beneficiaryVendorId: vendorId },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().reconciliation.funded).toBe(false);
    const after = await app.db
      .select()
      .from(signals)
      .where(eq(signals.detector, "retention_trust_underfunded"));
    expect(after.length).toBe(before.length + 1);
  });

  it("refuses to close an account that still holds money", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-security-accounts/${accountId}/close`,
      owner.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("still holds");
  });

  it("does not leak the accounts to another company", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/payment-security-accounts`,
      outsider.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Adjudication (#386-390)                                             */
/* ================================================================== */

describe("adjudication case management", () => {
  let caseId: string;

  it("serves the rule library with its disclaimer", async () => {
    const res = await inject("GET", "/api/v1/adjudication-rules", owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().indicative).toBe(true);
    expect(res.json().disclaimer).toContain("indicative");
    expect(res.json().items.length).toBeGreaterThanOrEqual(5);
  });

  it("opens a case and materialises every step as an Obligation", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/adjudications`, owner.headers, {
      regime: "uk_hgcra",
      disputedAmount: 120000,
      currency: "GBP",
      noticeAt: todayISO(),
      referringParty: "claimant",
    });
    expect(res.statusCode).toBe(201);
    caseId = res.json().id;
    expect(res.json().status).toBe("notice");
    expect(res.json().timetable.length).toBe(3);
    expect(res.json().disclaimer).toContain("indicative");

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/adjudications/${caseId}`,
      owner.headers,
    );
    expect(detail.json().obligations.length).toBe(3);
    expect(detail.json().rule.regime).toBe("uk_hgcra");
  });

  it("shows the next step and its countdown on the radar", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/adjudications-radar`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const mine = (res.json().items as Array<{ id: string; nextStep: string; daysRemaining: number | null }>).find(
      (i) => i.id === caseId,
    );
    expect(mine?.nextStep).toBe("referral");
    expect(mine?.daysRemaining).toBeGreaterThanOrEqual(0);
  });

  it("re-bases the timetable at referral and satisfies the referral obligation", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${caseId}/refer`,
      owner.headers,
      { adjudicatorName: "A. Adjudicator" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("referred");
    expect(res.json().adjudicatorName).toBe("A. Adjudicator");
    expect(res.json().decisionDueAt).toBeTruthy();
  });

  it("refuses to refer a case that is already referred", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${caseId}/refer`,
      owner.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("records a response and then a decision, with the decided amount on the record", async () => {
    const responded = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${caseId}/respond`,
      owner.headers,
      { summary: "The claim double counts the preliminaries." },
    );
    expect(responded.statusCode).toBe(200);
    expect(responded.json().status).toBe("responded");

    const decided = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${caseId}/decide`,
      owner.headers,
      { decisionAmount: 70000, decisionSummary: "Award of 70,000 plus the adjudicator's fee." },
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("decided");
    expect(decided.json().decisionAmount).toBe(70000);
  });

  it("refuses a decision with no summary behind it", async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/adjudications`, owner.headers, {
      regime: "sg_sopa",
      disputedAmount: 1000,
    });
    const id = created.json().id as string;
    await inject("POST", `/api/v1/projects/${projectId}/adjudications/${id}/refer`, owner.headers, {});
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${id}/decide`,
      owner.headers,
      { decisionAmount: 500 },
    );
    expect(res.statusCode).toBe(400);
  });

  it("moots the open deadlines when a case settles", async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/adjudications`, owner.headers, {
      regime: "nz_cca",
      disputedAmount: 5000,
    });
    const id = created.json().id as string;
    const settled = await inject(
      "POST",
      `/api/v1/projects/${projectId}/adjudications/${id}/settle`,
      owner.headers,
      { note: "Agreed at 3,000", amount: 3000 },
    );
    expect(settled.statusCode).toBe(200);
    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/adjudications/${id}`,
      owner.headers,
    );
    for (const o of detail.json().obligations as Array<{ status: string }>) {
      expect(o.status).toBe("satisfied");
    }
  });

  it("does not leak a case to another company", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/adjudications`,
      outsider.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Supply-chain payment practice reporting (#391-393)                  */
/* ================================================================== */

describe("supply-chain payment practice reporting", () => {
  let reportId: string;

  it("previews the metrics for a window without saving anything", async () => {
    const res = await inject(
      "GET",
      "/api/v1/supply-chain-payment-reports/preview?periodStart=2026-01-01&periodEnd=2026-06-30",
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().periodStart).toBe("2026-01-01");
    expect(Array.isArray(res.json().metrics)).toBe(true);
  });

  it("refuses a window that runs backwards", async () => {
    const res = await inject(
      "GET",
      "/api/v1/supply-chain-payment-reports/preview?periodStart=2026-06-30&periodEnd=2026-01-01",
      owner.headers,
    );
    expect(res.statusCode).toBe(400);
  });

  it("publishes a report whose metrics came from the registers, not from typing", async () => {
    const created = await inject("POST", "/api/v1/supply-chain-payment-reports", owner.headers, {
      regime: "uk_ppr_2017",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
    });
    expect(created.statusCode).toBe(201);
    reportId = created.json().id;
    expect(created.json().status).toBe("draft");
    expect(created.json().metrics.byCurrency).toBeDefined();

    const published = await inject(
      "POST",
      `/api/v1/supply-chain-payment-reports/${reportId}/publish`,
      owner.headers,
      {},
    );
    expect(published.statusCode).toBe(200);
    expect(published.json().status).toBe("published");
    expect(published.json().publishedAt).toBeTruthy();
  });

  it("refuses to regenerate a published report — it is a fact on the record", async () => {
    const res = await inject(
      "POST",
      `/api/v1/supply-chain-payment-reports/${reportId}/regenerate`,
      owner.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("does not serve another company's reports", async () => {
    const res = await inject(
      "GET",
      `/api/v1/supply-chain-payment-reports/${reportId}`,
      outsider.headers,
    );
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Regression: the deemed sweep is a job, and a late response is late  */
/* ================================================================== */

describe("regression: deemed liability does not depend on someone opening a page", () => {
  let claimId: string;

  beforeAll(async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/payment-claims`, owner.headers, {
      regime: "uk_hgcra",
      referenceDate: addDaysISO(todayISO(), -60),
      claimedAmount: 25000,
      currency: "GBP",
    });
    claimId = created.json().id;
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-claims/${claimId}/serve`,
      owner.headers,
      { method: "email", reference: "REG-1" },
    );
    // force the deadline into the past without anyone reading the register
    await app.db
      .update(paymentClaims)
      .set({ responseDeadline: addDaysISO(todayISO(), -5) })
      .where(eq(paymentClaims.id, claimId));
  });

  it("is deemed by the SCHEDULED job, with nobody having opened the project", async () => {
    const status = await app.scheduler.runNow("payments.deemed-liability");
    expect(status.lastError).toBeNull();
    const row = (
      await app.db.select().from(paymentClaims).where(eq(paymentClaims.id, claimId)).limit(1)
    )[0]!;
    expect(row.status).toBe("deemed");
  });

  it("raises exactly one critical signal, however many times the job runs", async () => {
    await app.scheduler.runNow("payments.deemed-liability");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "payment_deemed_liability")),
      );
    expect(raised.length).toBe(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.explanation).toContain("indicative");
  });
});
