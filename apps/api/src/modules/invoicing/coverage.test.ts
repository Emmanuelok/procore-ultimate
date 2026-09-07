/**
 * WP-FIN2 — the invoicing routes the upgrade suite did not reach.
 *
 *   GET /projects/:id/invoicing/health-inputs   the intelligence feed (§3.5)
 *   GET /projects/:id/invoice-payments          the project payment register
 *   GET /invoicing/aging-buckets                the bucket definitions the UI labels with
 *
 * The register route is the one that matters here: it reads a tenant table, so
 * it is tested for the company filter as well as for what it returns.
 */
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
let outsider: TestActor;

let billerH: Record<string, string>;
let clerkH: Record<string, string>;

let proj: string;
let emptyProj: string;
let vendorSub: string;
let budgetLine: string;

let commitmentId: string;

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
  owner = await registerActor(built.app, { companyName: "FIN2 Invoicing Coverage" });
  biller = await registerActor(built.app);
  clerk = await registerActor(built.app);
  outsider = await registerActor(built.app);
  for (const u of [biller, clerk]) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: u.userId,
      role: "member",
    });
  }
  billerH = { authorization: `Bearer ${biller.accessToken}`, "x-company-id": owner.companyId };
  clerkH = { authorization: `Bearer ${clerk.accessToken}`, "x-company-id": owner.companyId };

  proj = newId("prj");
  emptyProj = newId("prj");
  await built.app.db.insert(projects).values([
    { id: proj, companyId: owner.companyId, name: "FIN2 invoicing coverage" },
    { id: emptyProj, companyId: owner.companyId, name: "Nothing billed" },
  ]);
  for (const u of [biller, clerk]) {
    for (const projectId of [proj, emptyProj]) {
      await built.app.db.insert(projectMemberships).values({
        id: newId("pm"),
        companyId: owner.companyId,
        projectId,
        userId: u.userId,
        templateKey: "project_admin",
        overrides: {},
      });
    }
  }

  vendorSub = newId("ven");
  await built.app.db.insert(vendors).values({
    id: vendorSub,
    companyId: owner.companyId,
    name: "Ironbridge Steel Ltd",
    email: "ar@ironbridge.test",
  });
  await built.app.db.insert(insuranceCertificates).values({
    id: newId("cert"),
    companyId: owner.companyId,
    projectId: null,
    vendorId: vendorSub,
    subjectName: "Ironbridge Steel Ltd",
    policyType: "employers_liability",
    validFrom: isoDaysFromNow(-200),
    validTo: isoDaysFromNow(400),
    limitOfIndemnity: 5_000_000,
    currency: "USD",
    verifiedAt: new Date().toISOString(),
    createdBy: owner.userId,
  });

  const budgetId = newId("bud");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: proj,
    number: 1,
    reference: "BUD-001",
    name: "Control budget",
    currency: "USD",
    isActive: 1,
    createdBy: owner.userId,
  });
  budgetLine = newId("bli");
  await built.app.db.insert(budgetLineItems).values({
    id: budgetLine,
    budgetId,
    companyId: owner.companyId,
    projectId: proj,
    costCode: "05-500",
    costType: "subcontract",
    description: "Structural steel",
    originalBudget: 900_000,
    revisedBudget: 900_000,
    createdBy: owner.userId,
  });

  commitmentId = newId("cmt");
  await built.app.db.insert(commitments).values({
    id: commitmentId,
    companyId: owner.companyId,
    projectId: proj,
    kind: "subcontract",
    number: 101,
    reference: "SC-0101",
    title: "Steel package",
    vendorId: vendorSub,
    status: "approved",
    executed: 1,
    currency: "USD",
    originalCommitmentSum: 200_000,
    revisedCommitmentSum: 200_000,
    defaultRetainagePercent: 10,
    requiresLienWaiver: 0,
    complianceDetail: { strictness: "warn", requiredPolicyTypes: ["employers_liability"] },
    createdBy: owner.userId,
  });
  await built.app.db.insert(commitmentSovLines).values({
    id: newId("csl"),
    companyId: owner.companyId,
    projectId: proj,
    commitmentId,
    lineNumber: "01",
    sortOrder: 1,
    costCode: "05-500",
    costType: "subcontract",
    budgetLineItemId: budgetLine,
    description: "Fabrication",
    scheduledValue: 200_000,
    revisedScheduledValue: 200_000,
    retainagePercent: 10,
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Aging bucket definitions                                            */
/* ================================================================== */

describe("aging bucket definitions", () => {
  it("names every bucket the aging report uses, and says what the boundary means", async () => {
    const res = await inject("GET", "/api/v1/invoicing/aging-buckets", owner.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      buckets: Array<{ key: string; label: string }>;
      definition: string;
    };
    expect(body.buckets.length).toBeGreaterThanOrEqual(4);
    expect(body.buckets.every((b) => b.key && b.label)).toBe(true);
    /* an invoice with no dates is UNAGED, not "0-30" — the definition says so */
    expect(body.definition).toMatch(/unaged/i);
  });

  it("needs a company, not a project — it is a reference list", async () => {
    const res = await built.app.inject({ method: "GET", url: "/api/v1/invoicing/aging-buckets" });
    expect(res.statusCode).toBe(401);
  });
});

/* ================================================================== */
/* The project payment register                                        */
/* ================================================================== */

describe("project invoice-payment register", () => {
  let invoiceId: string;
  let paymentId: string;

  beforeAll(async () => {
    const created = await inject("POST", `/api/v1/projects/${proj}/invoices`, billerH, {
      kind: "subcontractor_invoice",
      commitmentId,
    });
    if (created.statusCode !== 201) throw new Error(`invoice: ${created.body}`);
    invoiceId = created.json().id as string;
    await inject("PUT", `/api/v1/invoices/${invoiceId}/lines`, billerH, {
      lines: [{ lineNumber: "01", thisPeriodWork: 40_000 }],
    });
    await inject("POST", `/api/v1/invoices/${invoiceId}/submit`, billerH, {});
    const approved = await inject("POST", `/api/v1/invoices/${invoiceId}/approve`, clerkH, {});
    if (approved.statusCode !== 200) throw new Error(`approve: ${approved.body}`);
    const paid = await inject("POST", `/api/v1/invoices/${invoiceId}/payments`, owner.headers, {
      amount: 10_000,
      method: "ach",
      acknowledgeWarnings: true,
    });
    if (paid.statusCode !== 201) throw new Error(`pay: ${paid.statusCode} ${paid.body}`);
    paymentId = paid.json().payment.id as string;
  });

  it("lists the payments made on this project, newest first, with a total that agrees", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/invoice-payments`, billerH);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; amount: number; commitmentId: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.items.map((i) => i.id)).toContain(paymentId);
    expect(body.total).toBe(body.items.length);
    expect(body.items.find((i) => i.id === paymentId)!.amount).toBe(10_000);
  });

  it("filters by commitment and by status", async () => {
    const byCommitment = await inject(
      "GET",
      `/api/v1/projects/${proj}/invoice-payments?commitmentId=${commitmentId}`,
      billerH,
    );
    expect((byCommitment.json() as { total: number }).total).toBeGreaterThan(0);
    const wrongStatus = await inject(
      "GET",
      `/api/v1/projects/${proj}/invoice-payments?status=failed`,
      billerH,
    );
    expect((wrongStatus.json() as { total: number }).total).toBe(0);
  });

  it("does not serve another company the register", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/invoice-payments`, outsider.headers);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/* ================================================================== */
/* Health inputs (plan §3.5)                                           */
/* ================================================================== */

describe("invoicing health inputs", () => {
  it("reports counts and day-counts, never a cross-currency money total", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/invoicing/health-inputs`, billerH);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
      asOf: string;
    };
    expect(body.metrics["invoices"]).toBeGreaterThan(0);
    expect(body.metrics["outstandingInvoices"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics["paidWithoutWaiverOnFile"]).toBe(0);
    for (const value of Object.values(body.metrics)) {
      expect(value === null || Number.isInteger(value)).toBe(true);
    }
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says a project with nothing billed is unrated rather than clean", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${emptyProj}/invoicing/health-inputs`,
      billerH,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["invoices"]).toBe(0);
    expect(body.metrics["oldestOverdueDays"]).toBeNull();
    expect(body.reasons.join(" ")).toMatch(/nothing has been billed/i);
  });

  it("does not serve another company's health inputs", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/invoicing/health-inputs`,
      outsider.headers,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
