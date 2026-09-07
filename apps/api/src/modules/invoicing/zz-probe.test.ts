import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetLineItems,
  budgets,
  commitmentSovLines,
  commitments,
  companyMemberships,
  insuranceCertificates,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor;
let biller: TestActor;
let clerk: TestActor;
let ownerH: Record<string, string>;
let billerH: Record<string, string>;
let clerkH: Record<string, string>;
let projA: string;
let vendorSub: string;
let budgetLine: string;

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const inject = (m: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  built.app.inject({ method: m, url, headers, ...(payload !== undefined ? { payload } : {}) });

let seq = 0;
async function makeCommitment(billed: number) {
  seq += 1;
  const id = newId("cmt");
  await built.app.db.insert(commitments).values({
    id,
    companyId: owner.companyId,
    projectId: projA,
    kind: "subcontract",
    number: 500 + seq,
    reference: `PB-${String(500 + seq).padStart(4, "0")}`,
    title: `Probe ${seq}`,
    vendorId: vendorSub,
    status: "approved",
    executed: 1,
    currency: "USD",
    originalCommitmentSum: 200000,
    revisedCommitmentSum: 200000,
    defaultRetainagePercent: 10,
    requiresLienWaiver: 0,
    retainageHeld: Math.round(billed * 0.1 * 100) / 100,
    complianceDetail: { strictness: "warn", requiredPolicyTypes: ["employers_liability"] },
    createdBy: owner.userId,
  });
  const line1 = newId("csl");
  await built.app.db.insert(commitmentSovLines).values([
    {
      id: line1,
      companyId: owner.companyId,
      projectId: projA,
      commitmentId: id,
      lineNumber: "01",
      sortOrder: 1,
      costCode: "05-500",
      costType: "subcontract",
      budgetLineItemId: budgetLine,
      description: "Fabrication",
      scheduledValue: 150000,
      revisedScheduledValue: 150000,
      retainagePercent: 10,
      previousBilled: billed,
      totalCompletedAndStored: billed,
      retainageHeld: Math.round(billed * 0.1 * 100) / 100,
      balanceToFinish: 150000 - billed,
    },
  ]);
  return { id, line1 };
}

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  biller = await registerActor(built.app);
  clerk = await registerActor(built.app);
  for (const u of [biller, clerk]) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: u.userId, role: "member" });
  }
  ownerH = { authorization: `Bearer ${owner.accessToken}`, "x-company-id": owner.companyId };
  billerH = { authorization: `Bearer ${biller.accessToken}`, "x-company-id": owner.companyId };
  clerkH = { authorization: `Bearer ${clerk.accessToken}`, "x-company-id": owner.companyId };
  projA = newId("prj");
  await built.app.db.insert(projects).values({ id: projA, companyId: owner.companyId, name: "Probe project" });
  for (const u of [biller, clerk]) {
    await built.app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId: projA, userId: u.userId, templateKey: "project_admin", overrides: {} });
  }
  vendorSub = newId("ven");
  await built.app.db.insert(vendors).values({ id: vendorSub, companyId: owner.companyId, name: "Probe Vendor", email: "v@probe.test" });
  await built.app.db.insert(insuranceCertificates).values({
    id: newId("cert"),
    companyId: owner.companyId,
    projectId: null,
    vendorId: vendorSub,
    subjectName: "Probe Vendor",
    policyType: "employers_liability",
    validFrom: iso(-200),
    validTo: iso(400),
    limitOfIndemnity: 5_000_000,
    currency: "USD",
    verifiedAt: new Date().toISOString(),
    createdBy: owner.userId,
  });
  const budgetId = newId("bud");
  await built.app.db.insert(budgets).values({ id: budgetId, companyId: owner.companyId, projectId: projA, number: 1, reference: "BUD-001", name: "B", currency: "USD", isActive: 1, createdBy: owner.userId });
  budgetLine = newId("bli");
  await built.app.db.insert(budgetLineItems).values({ id: budgetLine, budgetId, companyId: owner.companyId, projectId: projA, costCode: "05-500", costType: "subcontract", description: "Steel", originalBudget: 900000, revisedBudget: 900000, createdBy: owner.userId });
});

afterAll(async () => { await built.close(); });

describe("PROBE: retainageReleasedAmount on the invoicing pay route", () => {
  it("records a release that never reaches the schedule of values", async () => {
    const { id: cmt } = await makeCommitment(80000);
    const before = await inject("GET", `/api/v1/commitments/${cmt}`, billerH);
    expect(before.statusCode).toBe(200);
    const heldBefore = before.json().commitment.retainageHeld as number;

    const created = await inject("POST", `/api/v1/projects/${projA}/invoices`, billerH, { kind: "subcontractor_invoice", commitmentId: cmt });
    expect(created.statusCode).toBe(201);
    const invId = created.json().id as string;
    const put = await inject("PUT", `/api/v1/invoices/${invId}/lines`, billerH, { lines: [{ lineNumber: "01", thisPeriodWork: 10000 }] });
    expect(put.statusCode).toBe(200);
    expect((await inject("POST", `/api/v1/invoices/${invId}/submit`, billerH, {})).statusCode).toBe(200);
    const appr = await inject("POST", `/api/v1/invoices/${invId}/approve`, ownerH, {});
    expect(appr.statusCode).toBe(200);

    const pay = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 9000,
      status: "issued",
      retainageReleasedAmount: 8000,
    });
    // eslint-disable-next-line no-console
    console.log("PAY:", pay.statusCode, pay.body.slice(0, 400));
    expect(pay.statusCode).toBe(201);

    const after = await inject("GET", `/api/v1/commitments/${cmt}`, billerH);
    const heldAfter = after.json().commitment.retainageHeld as number;
    // eslint-disable-next-line no-console
    console.log("RETAINAGE HELD before/after:", heldBefore, heldAfter);

    // now try to release the same retainage again through the commitments register
    const sched = await inject("POST", `/api/v1/commitments/${cmt}/payments`, billerH, {
      amount: 8000,
      retainageReleasedAmount: 8000,
    });
    // eslint-disable-next-line no-console
    console.log("SECOND RELEASE SCHEDULE:", sched.statusCode, sched.body.slice(0, 400));
    expect(true).toBe(true);
  });
});
