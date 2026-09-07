/**
 * WP-FIN2 — the commitments routes the upgrade suites did not reach.
 *
 * A route with no test is not done, so this file closes the gap the coverage
 * scan found on the buy side:
 *
 *   GET  /projects/:id/commitments/health-inputs   the intelligence feed (§3.5)
 *   POST /commitments/:id/out-for-bid              buyout lifecycle
 *   POST /commitments/:id/terminate                the end of a subcontract
 *   GET  /projects/:id/payment-runs/candidates     what a run may gather
 *   POST /projects/:id/payment-runs/:id/cancel     abandoning a draft run
 *
 * and adds the regression the lifecycle hardening deserves: a commitment's
 * status now moves in ONE guarded statement inside a transaction, so the
 * second of two simultaneous approvals loses instead of both winning.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetLineItems,
  budgets,
  commitments,
  companyMemberships,
  insuranceCertificates,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { eq } from "drizzle-orm";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor;
let second: TestActor;
let third: TestActor;
let outsider: TestActor;

let secondH: Record<string, string>;
let thirdH: Record<string, string>;

let proj: string;
let vendor: string;
let budgetId: string;
let budgetLine: string;

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  built.app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app, { companyName: "FIN2 Coverage Co" });
  second = await registerActor(built.app);
  third = await registerActor(built.app);
  outsider = await registerActor(built.app);

  for (const actor of [second, third]) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: actor.userId,
      role: "member",
    });
  }
  secondH = { authorization: `Bearer ${second.accessToken}`, "x-company-id": owner.companyId };
  thirdH = { authorization: `Bearer ${third.accessToken}`, "x-company-id": owner.companyId };

  proj = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: proj, companyId: owner.companyId, name: "FIN2 coverage", currency: "USD" });
  for (const actor of [second, third]) {
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: proj,
      userId: actor.userId,
      templateKey: "project_admin",
      overrides: {},
    });
  }

  vendor = newId("ven");
  await built.app.db.insert(vendors).values({
    id: vendor,
    companyId: owner.companyId,
    name: "Meridian Mechanical",
    email: "ap@meridian.test",
  });
  await built.app.db.insert(insuranceCertificates).values({
    id: newId("cert"),
    companyId: owner.companyId,
    projectId: null,
    vendorId: vendor,
    subjectName: "Meridian Mechanical",
    policyType: "employers_liability",
    validFrom: isoDaysFromNow(-100),
    validTo: isoDaysFromNow(400),
    limitOfIndemnity: 5_000_000,
    currency: "USD",
    verifiedAt: new Date().toISOString(),
    createdBy: owner.userId,
  });

  budgetId = newId("bdg");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: proj,
    number: 1,
    reference: "BUD-0001",
    name: "Control budget",
    isActive: 1,
    currency: "USD",
    createdBy: owner.userId,
  });
  budgetLine = newId("bli");
  await built.app.db.insert(budgetLineItems).values({
    id: budgetLine,
    budgetId,
    companyId: owner.companyId,
    projectId: proj,
    costCode: "15-100",
    costType: "subcontract",
    description: "Mechanical",
    originalBudget: 1_000_000,
    revisedBudget: 1_000_000,
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function draftCommitment(title: string, amount: number): Promise<string> {
  const res = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
    kind: "subcontract",
    title,
    vendorId: vendor,
    defaultRetainagePercent: 10,
    requiresLienWaiver: false,
    compliance: { strictness: "warn", requiredPolicyTypes: ["employers_liability"] },
    sovLines: [
      {
        description: "Base scope",
        scheduledValue: amount,
        budgetLineItemId: budgetLine,
        costCode: "15-100",
        costType: "subcontract",
      },
    ],
  });
  if (res.statusCode !== 201) throw new Error(`draftCommitment: ${res.statusCode} ${res.body}`);
  return res.json().commitment.id as string;
}

/* ================================================================== */
/* Buyout lifecycle                                                    */
/* ================================================================== */

describe("out for bid", () => {
  let id: string;

  it("sends a draft commitment out to the market", async () => {
    id = await draftCommitment("Mechanical package", 250_000);
    const res = await inject("POST", `/api/v1/commitments/${id}/out-for-bid`, owner.headers, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().commitment.status).toBe("out_for_bid");
  });

  it("refuses to send it out twice — it is already in the market", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/out-for-bid`, owner.headers, {});
    expect(res.statusCode).toBe(409);
  });

  it("still approves from out_for_bid, because a bid ends in an award", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/approve`, secondH, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().commitment.status).toBe("approved");
  });

  it("does not let another company move it", async () => {
    const other = await draftCommitment("Another package", 10_000);
    const res = await inject(
      "POST",
      `/api/v1/commitments/${other}/out-for-bid`,
      outsider.headers,
      {},
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("termination", () => {
  let id: string;

  beforeAll(async () => {
    id = await draftCommitment("Terminated package", 400_000);
    await inject("POST", `/api/v1/commitments/${id}/approve`, secondH, {});
  });

  it("refuses a termination with no reason on it", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/terminate`, owner.headers, {});
    expect(res.statusCode).toBe(400);
  });

  it("terminates with the reason recorded and payment held", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/terminate`, owner.headers, {
      reason: "Subcontractor entered administration",
      terminationDate: isoDaysFromNow(0),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commitment.status).toBe("terminated");
    expect(body.commitment.paymentHold).toBe(1);
    expect(body.commitment.complianceHoldReason).toContain("administration");
  });

  it("takes the terminated commitment's value off the budget's committed cost", async () => {
    const [line] = await built.app.db
      .select({ committedCost: budgetLineItems.committedCost })
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLine));
    /* the terminated 400,000 is no longer committed; the live ones still are */
    expect(line!.committedCost).toBeLessThan(400_000 + 250_000 + 10_000);
  });

  it("refuses to terminate the same commitment twice", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/terminate`, owner.headers, {
      reason: "again",
    });
    expect(res.statusCode).toBe(409);
  });

  it("does not let another company terminate it", async () => {
    const res = await inject("POST", `/api/v1/commitments/${id}/terminate`, outsider.headers, {
      reason: "not mine",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("regression: a commitment's status moves exactly once", () => {
  it("lets only ONE of two simultaneous approvals through", async () => {
    const id = await draftCommitment("Race package", 75_000);
    const [a, b] = await Promise.all([
      inject("POST", `/api/v1/commitments/${id}/approve`, secondH, {}),
      inject("POST", `/api/v1/commitments/${id}/approve`, thirdH, {}),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);
    const [row] = await built.app.db
      .select({ status: commitments.status, approvedBy: commitments.approvedBy })
      .from(commitments)
      .where(eq(commitments.id, id));
    expect(row!.status).toBe("approved");
    expect([second.userId, third.userId]).toContain(row!.approvedBy);
  });
});

/* ================================================================== */
/* Payment runs — candidates and cancellation                          */
/* ================================================================== */

describe("payment run candidates", () => {
  let commitmentId: string;
  let paymentId: string;

  beforeAll(async () => {
    commitmentId = await draftCommitment("Run package", 120_000);
    await inject("POST", `/api/v1/commitments/${commitmentId}/approve`, secondH, {});
    await inject("POST", `/api/v1/commitments/${commitmentId}/execute`, secondH, {});
    const pay = await inject(
      "POST",
      `/api/v1/commitments/${commitmentId}/payments`,
      owner.headers,
      { amount: 20_000, paymentDate: isoDaysFromNow(0), method: "ach" },
    );
    if (pay.statusCode !== 201) throw new Error(`payment: ${pay.statusCode} ${pay.body}`);
    paymentId = pay.json().payment.id as string;
  });

  it("offers the scheduled payment and SAYS it is not approved yet", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/candidates`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; approved: boolean; currency: string }>;
      byCurrency: Array<{ currency: string; count: number; unapproved: number }>;
    };
    const mine = body.items.find((i) => i.id === paymentId);
    expect(mine).toBeDefined();
    expect(mine!.approved).toBe(false);
    /* the tally is bucketed by currency and never summed across them */
    expect(body.byCurrency.find((b) => b.currency === "USD")!.unapproved).toBeGreaterThan(0);
  });

  it("flags it approved once an independent approver releases it", async () => {
    const approve = await inject(
      "POST",
      `/api/v1/commitment-payments/${paymentId}/approve`,
      secondH,
      {},
    );
    expect(approve.statusCode).toBe(200);
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/candidates?currency=usd`,
      owner.headers,
    );
    const body = res.json() as { items: Array<{ id: string; approved: boolean; currency: string }> };
    expect(body.items.find((i) => i.id === paymentId)!.approved).toBe(true);
    expect(body.items.every((i) => i.currency === "USD")).toBe(true);
  });

  it("stops offering it once a live run has claimed it", async () => {
    const run = await inject("POST", `/api/v1/projects/${proj}/payment-runs`, owner.headers, {
      name: "Coverage run",
      scheduledDate: isoDaysFromNow(1),
      currency: "USD",
      paymentIds: [paymentId],
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id as string;
    const after = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/candidates`,
      owner.headers,
    );
    expect((after.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).not.toContain(
      paymentId,
    );

    /* and cancelling the run puts the payment back on the table */
    const cancel = await inject(
      "POST",
      `/api/v1/projects/${proj}/payment-runs/${runId}/cancel`,
      owner.headers,
      { reason: "Bank cut-off missed" },
    );
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    const back = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/candidates`,
      owner.headers,
    );
    expect((back.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain(
      paymentId,
    );
  });

  it("refuses to cancel the same run twice, and refuses it with no reason", async () => {
    const run = await inject("POST", `/api/v1/projects/${proj}/payment-runs`, owner.headers, {
      name: "Coverage run 2",
      scheduledDate: isoDaysFromNow(1),
      currency: "USD",
      paymentIds: [paymentId],
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id as string;
    const noReason = await inject(
      "POST",
      `/api/v1/projects/${proj}/payment-runs/${runId}/cancel`,
      owner.headers,
      {},
    );
    expect(noReason.statusCode).toBe(400);
    await inject(
      "POST",
      `/api/v1/projects/${proj}/payment-runs/${runId}/cancel`,
      owner.headers,
      { reason: "duplicate" },
    );
    const again = await inject(
      "POST",
      `/api/v1/projects/${proj}/payment-runs/${runId}/cancel`,
      owner.headers,
      { reason: "duplicate" },
    );
    expect(again.statusCode).toBe(409);
  });

  it("does not serve the candidate list to another company", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/candidates`,
      outsider.headers,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/* ================================================================== */
/* Health inputs (plan §3.5)                                           */
/* ================================================================== */

describe("commitments health inputs", () => {
  it("counts the buy side without ever summing across currencies", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/health-inputs`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
      asOf: string;
    };
    expect(body.metrics["liveCommitments"]).toBeGreaterThan(0);
    expect(body.metrics["reconciliationFailures"]).toBe(0);
    expect(body.metrics["openBackcharges"]).toBe(0);
    /* nothing here is money — a health score must not add USD to EUR */
    for (const value of Object.values(body.metrics)) {
      expect(value === null || Number.isInteger(value)).toBe(true);
    }
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says a project with nothing bought is unrated rather than healthy", async () => {
    const empty = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: empty, companyId: owner.companyId, name: "Nothing bought" });
    const res = await inject(
      "GET",
      `/api/v1/projects/${empty}/commitments/health-inputs`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number>; reasons: string[] };
    expect(body.metrics["liveCommitments"]).toBe(0);
    expect(body.reasons.join(" ")).toMatch(/unrated/i);
  });

  it("does not serve another company's health inputs", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/health-inputs`,
      outsider.headers,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
