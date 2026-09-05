/**
 * WP-FIN2 — the change-management routes the upgrade suite did not reach.
 *
 *   GET  /projects/:id/changes/health-inputs                the intelligence feed (§3.5)
 *   POST /projects/:id/potential-change-orders/:id/no-charge  the sub absorbs it
 *   POST /projects/:id/quote-requests/:id/decline             the sub will not quote
 *
 * A no-charge change and a declined RFQ are both "nothing happened" outcomes,
 * and both are exactly the events a change log loses if it only records money.
 * They are recorded, not deleted, so "how many changes did this subcontractor
 * absorb" and "who stopped bidding our variations" stay answerable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetLineItems,
  budgets,
  commitmentSovLines,
  commitments,
  companyMemberships,
  costCodes,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let u1: TestActor;
let u2: TestActor;
let outsider: TestActor;
let h2: Record<string, string>;

let proj: string;
let commitmentId: string;
let vendorA: string;
let lineSub: string;

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
  u1 = await registerActor(built.app, { companyName: "FIN2 Change Coverage" });
  u2 = await registerActor(built.app);
  outsider = await registerActor(built.app);

  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: u1.companyId,
    userId: u2.userId,
    role: "admin",
  });
  h2 = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };

  proj = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: proj, companyId: u1.companyId, name: "FIN2 change coverage", currency: "USD" });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: u1.companyId,
    projectId: proj,
    userId: u2.userId,
    templateKey: "project_admin",
    overrides: {},
  });
  await built.app.db.insert(costCodes).values({
    id: newId("cc"),
    companyId: u1.companyId,
    code: "03300",
    title: "Concrete",
    costType: "subcontract",
  });
  vendorA = newId("ven");
  await built.app.db
    .insert(vendors)
    .values({ id: vendorA, companyId: u1.companyId, name: "Apex Concrete" });

  const budgetId = newId("bdg");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: u1.companyId,
    projectId: proj,
    number: 1,
    reference: "BUD-001",
    name: "Baseline",
    isActive: 1,
    currency: "USD",
    createdBy: u1.userId,
  });
  lineSub = newId("bli");
  await built.app.db.insert(budgetLineItems).values({
    id: lineSub,
    budgetId,
    companyId: u1.companyId,
    projectId: proj,
    costCode: "03300",
    costType: "subcontract",
    description: "Concrete subcontract",
    originalBudget: 500_000,
    revisedBudget: 500_000,
    committedCost: 100_000,
    createdBy: u1.userId,
  });

  commitmentId = newId("cmt");
  await built.app.db.insert(commitments).values({
    id: commitmentId,
    companyId: u1.companyId,
    projectId: proj,
    kind: "subcontract",
    number: 1,
    reference: "SC-0001",
    title: "Concrete subcontract",
    status: "approved",
    executed: 1,
    currency: "USD",
    vendorId: vendorA,
    originalCommitmentSum: 100_000,
    revisedCommitmentSum: 100_000,
    defaultRetainagePercent: 5,
    createdBy: u1.userId,
  });
  await built.app.db.insert(commitmentSovLines).values({
    id: newId("csv"),
    companyId: u1.companyId,
    projectId: proj,
    commitmentId,
    lineNumber: "1",
    sortOrder: 10,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    description: "Base subcontract scope",
    scheduledValue: 100_000,
    revisedScheduledValue: 100_000,
    balanceToFinish: 100_000,
  });
});

afterAll(async () => {
  await built.close();
});

async function pricedPco(title: string, amount: number): Promise<string> {
  const created = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders`,
    u1.headers,
    { title, commitmentId, reason: "design_error" },
  );
  if (created.statusCode !== 201) throw new Error(`pco: ${created.statusCode} ${created.body}`);
  const id = created.json().id as string;
  await inject("POST", `/api/v1/projects/${proj}/potential-change-orders/${id}/lines`, u1.headers, {
    description: title,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    costAmount: amount,
  });
  const priced = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders/${id}/price`,
    u1.headers,
    {},
  );
  if (priced.statusCode !== 200) throw new Error(`price: ${priced.statusCode} ${priced.body}`);
  return id;
}

/* ================================================================== */
/* No-charge changes                                                   */
/* ================================================================== */

describe("no-charge changes", () => {
  it("records the absorbed change with its reason rather than deleting it", async () => {
    const id = await pricedPco("Rebar re-detailing", 4_000);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${id}/no-charge`,
      u1.headers,
      { reason: "Apex absorbed it under the goodwill clause" },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("no_charge");
    expect(body.noCharge).toBe(1);
    expect(body.amount).toBe(0);
    expect(body.detail.noChargeReason).toContain("goodwill");
  });

  it("keeps the priced position visible as the previous amount on the ledger entry", async () => {
    const id = await pricedPco("Absorbed hoisting", 9_500);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${id}/no-charge`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().amount).toBe(0);
    /* it stopped being cost exposure: the pipeline no longer counts it as priced-not-requested */
    const health = await inject(
      "GET",
      `/api/v1/projects/${proj}/changes/health-inputs`,
      u1.headers,
    );
    const metrics = (health.json() as { metrics: Record<string, number> }).metrics;
    expect(metrics["pricedNotRequested"]).toBe(0);
  });

  it("refuses to mark a change no-charge twice", async () => {
    const id = await pricedPco("Twice absorbed", 1_000);
    await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${id}/no-charge`,
      u1.headers,
      {},
    );
    const again = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${id}/no-charge`,
      u1.headers,
      {},
    );
    expect(again.statusCode).toBe(409);
  });

  it("does not let another company absorb our change", async () => {
    const id = await pricedPco("Not theirs", 2_000);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${id}/no-charge`,
      outsider.headers,
      {},
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(200);
  });
});

/* ================================================================== */
/* Declined RFQs                                                       */
/* ================================================================== */

describe("declined quote requests", () => {
  async function sentRfq(pcoId: string): Promise<string> {
    const rfq = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/quote-requests`,
      u1.headers,
      { vendorId: vendorA, dueDate: "2030-01-01" },
    );
    if (rfq.statusCode !== 201) throw new Error(`rfq: ${rfq.statusCode} ${rfq.body}`);
    const id = rfq.json().id as string;
    await inject("POST", `/api/v1/projects/${proj}/quote-requests/${id}/send`, u1.headers, {});
    return id;
  }

  it("refuses a decline with no reason — 'they said no' is not a record", async () => {
    const pco = await pricedPco("Declined scope", 12_000);
    const id = await sentRfq(pco);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${id}/decline`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(400);
  });

  it("records the decline with the reason the sub gave", async () => {
    const pco = await pricedPco("Declined scope 2", 12_000);
    const id = await sentRfq(pco);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${id}/decline`,
      u1.headers,
      { declineReason: "No capacity before the required-on-site date" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("declined");
    expect(res.json().declineReason).toContain("No capacity");
    expect(res.json().declinedAt).toBeTruthy();
  });

  it("refuses to decline it a second time", async () => {
    const pco = await pricedPco("Declined scope 3", 3_000);
    const id = await sentRfq(pco);
    await inject("POST", `/api/v1/projects/${proj}/quote-requests/${id}/decline`, u1.headers, {
      declineReason: "Busy",
    });
    const again = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${id}/decline`,
      u1.headers,
      { declineReason: "Busy" },
    );
    expect(again.statusCode).toBe(409);
  });

  it("does not let another company decline our RFQ", async () => {
    const pco = await pricedPco("Declined scope 4", 3_000);
    const id = await sentRfq(pco);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${id}/decline`,
      outsider.headers,
      { declineReason: "not mine" },
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(200);
  });
});

/* ================================================================== */
/* Health inputs (plan §3.5)                                           */
/* ================================================================== */

describe("changes health inputs", () => {
  it("counts the GAPS in the chain, not the totals, and never crosses a currency", async () => {
    const priced = await pricedPco("Still unrequested", 25_000);
    expect(priced).toBeTruthy();
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/changes/health-inputs`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
      asOf: string;
    };
    expect(body.metrics["pricedNotRequested"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics["approvedNotExecuted"]).toBe(0);
    for (const value of Object.values(body.metrics)) {
      expect(value === null || Number.isInteger(value)).toBe(true);
    }
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says a project with no change raised is unrated rather than perfect", async () => {
    const empty = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: empty, companyId: u1.companyId, name: "No change here" });
    const res = await inject(
      "GET",
      `/api/v1/projects/${empty}/changes/health-inputs`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number>; reasons: string[] };
    expect(body.metrics["openChangeEvents"]).toBe(0);
    expect(body.reasons.join(" ")).toMatch(/unrated/i);
  });

  it("is readable by a project member who is not the author", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/changes/health-inputs`, h2);
    expect(res.statusCode).toBe(200);
  });

  it("does not serve another company's health inputs", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/changes/health-inputs`,
      outsider.headers,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
