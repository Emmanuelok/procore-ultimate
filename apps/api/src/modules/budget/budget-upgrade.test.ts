/**
 * Integration tests for the platform-upgrade wave of the budget module:
 * the job-to-date double-count fixes (regressions with hand-worked numbers),
 * the reconciliation engine and its postings, drill-down, insights,
 * variance, cash flow, saved views, ERP import, contingency linkage, the
 * scheduler job, and every audit bug fixed in index.ts — each with a
 * regression test — plus tenant-isolation negatives on the new routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  budgetChanges,
  budgetLineItems,
  budgetPostings,
  budgetReconciliations,
  changeOrderPackages,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  companyMemberships,
  contingencies,
  contingencyDrawdowns,
  costCodes,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  primeContractChanges,
  primeContracts,
  projectMemberships,
  projects,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
/** company owner — requester */
let u1: TestActor;
/** company admin — the independent approver */
let u2: TestActor;
/** project_manager member: budget = standard */
let u3: TestActor;
/** read_only member */
let u4: TestActor;
/** a different company entirely */
let outsider: TestActor;
let h2: Record<string, string>;
let h3: Record<string, string>;
let h4: Record<string, string>;

let proj: string;
let ccCip: string;
let ccRebar: string;
let ccElec: string;
let ccCont: string;
let budgetId: string;
let lineCip: string;
let lineRebar: string;
let lineElec: string;
let lineCont: string;
let commitmentId: string;
let sovLineId: string;

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

const today = (): string => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function lineById(id: string) {
  const rows = await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.id, id));
  return rows[0]!;
}

async function mkInvoice(number: number, lineId: string, cumulative: number, status = "approved", sov: string | null = sovLineId) {
  const id = newId("inv");
  await built.app.db.insert(invoices).values({
    id,
    companyId: u1.companyId,
    projectId: proj,
    kind: "subcontractor_invoice",
    number,
    reference: `INV-${number}`,
    status,
    currency: "USD",
    commitmentId,
    billingDate: daysAgo(90 - number * 30),
    approvedAt: new Date(Date.now() - (90 - number * 30) * 86_400_000).toISOString(),
    createdBy: u1.userId,
  });
  await built.app.db.insert(invoiceLineItems).values({
    id: newId("ili"),
    companyId: u1.companyId,
    projectId: proj,
    invoiceId: id,
    lineNumber: "1",
    commitmentSovLineId: sov,
    budgetLineItemId: lineId,
    description: "Progress",
    previousBilled: number === 1 ? 0 : 100_000,
    thisPeriodWork: number === 1 ? cumulative : cumulative - 100_000,
    totalCompletedAndStored: cumulative,
    amount: cumulative,
  });
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app);
  u2 = await registerActor(built.app);
  u3 = await registerActor(built.app);
  u4 = await registerActor(built.app);
  outsider = await registerActor(built.app);
  for (const [actor, role] of [[u2, "admin"], [u3, "member"], [u4, "member"]] as const) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: u1.companyId, userId: actor.userId, role });
  }
  h2 = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };
  h3 = { authorization: `Bearer ${u3.accessToken}`, "x-company-id": u1.companyId };
  h4 = { authorization: `Bearer ${u4.accessToken}`, "x-company-id": u1.companyId };

  proj = newId("prj");
  await built.app.db.insert(projects).values({ id: proj, companyId: u1.companyId, name: "Upgrade A", startDate: daysAgo(120), finishDate: daysAgo(-240) });
  await built.app.db.insert(projectMemberships).values([
    { id: newId("pm"), companyId: u1.companyId, projectId: proj, userId: u3.userId, templateKey: "project_manager", overrides: {} },
    { id: newId("pm"), companyId: u1.companyId, projectId: proj, userId: u4.userId, templateKey: "read_only", overrides: {} },
  ]);

  ccCip = newId("cc");
  ccRebar = newId("cc");
  ccElec = newId("cc");
  ccCont = newId("cc");
  const div03 = newId("cc");
  const div16 = newId("cc");
  const div99 = newId("cc");
  await built.app.db.insert(costCodes).values([
    { id: div03, companyId: u1.companyId, code: "03", title: "Concrete" },
    { id: div16, companyId: u1.companyId, code: "16", title: "Electrical" },
    { id: div99, companyId: u1.companyId, code: "99", title: "Reserves" },
    { id: ccCip, companyId: u1.companyId, code: "03300", title: "Cast-in-place concrete", division: "03", costType: "subcontract", parentId: div03 },
    { id: ccRebar, companyId: u1.companyId, code: "03310", title: "Rebar", division: "03", costType: "material", parentId: div03 },
    { id: ccElec, companyId: u1.companyId, code: "16100", title: "Electrical", division: "16", costType: "subcontract", parentId: div16 },
    { id: ccCont, companyId: u1.companyId, code: "99-CONT", title: "Contingency", division: "99", parentId: div99 },
  ]);

  const created = await inject("POST", `/api/v1/projects/${proj}/budgets`, u1.headers, { name: "GMP", currency: "USD", isActive: true });
  budgetId = created.json().id as string;
  const mk = async (costCodeId: string, description: string, originalBudget: number, extra: Record<string, unknown> = {}) => {
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/lines`, u1.headers, { costCodeId, description, originalBudget, ...extra });
    if (res.statusCode !== 201) throw new Error(`line: ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  };
  lineCip = await mk(ccCip, "Concrete", 1_000_000, { percentComplete: 0.5 });
  lineRebar = await mk(ccRebar, "Rebar", 200_000);
  lineElec = await mk(ccElec, "Electrical", 300_000);
  lineCont = await mk(ccCont, "Contingency", 100_000, { lineKind: "contingency", costType: "other" });

  commitmentId = newId("cmt");
  await built.app.db.insert(commitments).values({
    id: commitmentId,
    companyId: u1.companyId,
    projectId: proj,
    kind: "subcontract",
    number: 1,
    reference: "SC-001",
    title: "Concrete sub",
    status: "approved",
    executed: 1,
    currency: "USD",
    originalCommitmentSum: 900_000,
    revisedCommitmentSum: 900_000,
    startDate: daysAgo(90),
    estimatedCompletionDate: daysAgo(-90),
    createdBy: u1.userId,
  });
  sovLineId = newId("csl");
  await built.app.db.insert(commitmentSovLines).values({
    id: sovLineId,
    companyId: u1.companyId,
    projectId: proj,
    commitmentId,
    lineNumber: "1",
    budgetLineItemId: lineCip,
    description: "Concrete scope",
    scheduledValue: 900_000,
    revisedScheduledValue: 900_000,
  });
});

afterAll(async () => {
  await built.app.close();
});

/* ================================================================== */
/* The double count — the production blocker                          */
/* ================================================================== */

describe("job-to-date cost counts each dollar once", () => {
  it("takes the latest cumulative invoice per SOV line: 100k then 250k is 250k, not 350k", async () => {
    await mkInvoice(1, lineCip, 100_000);
    await mkInvoice(2, lineCip, 250_000);
    const summary = await inject("GET", `/api/v1/budgets/${budgetId}/summary`, u1.headers);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().components.invoicedToDate.value).toBe(250_000);
    expect(summary.json().components.invoicedToDate.reasons.join(" ")).toMatch(/superseded/);
    expect(summary.json().components.jobToDateCosts.value).toBe(250_000);

    const res = await inject("POST", `/api/v1/budgets/${budgetId}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.jobToDateCosts).toBe(true);
    const line = await lineById(lineCip);
    expect(line.jobToDateCosts).toBe(250_000);
    expect(line.committedCost).toBe(900_000);
    // remaining_budget: 1,000,000 − 250,000
    expect(line.forecastToComplete).toBe(750_000);
    expect(line.forecastFinal).toBe(1_000_000);
  });

  it("does not add a commitment payment on top of the invoice it paid: 250k invoiced + 225k paid is 250k, not 475k", async () => {
    // What invoicing/payments.ts does when a payment posts: +amount on
    // directCosts AND jobToDateCosts, with the allocation stamped on the payment.
    const paymentId = newId("pay");
    await built.app.db.insert(commitmentPayments).values({
      id: paymentId,
      companyId: u1.companyId,
      projectId: proj,
      commitmentId,
      invoiceId: null,
      number: 1,
      reference: "PAY-001",
      status: "paid",
      amount: 225_000,
      currency: "USD",
      paymentDate: daysAgo(5),
      detail: { budgetPostedAt: new Date().toISOString(), budgetAllocation: [{ budgetLineItemId: lineCip, amount: 225_000 }] },
      createdBy: u1.userId,
    });
    const before = await lineById(lineCip);
    await built.app.db
      .update(budgetLineItems)
      .set({ directCosts: before.directCosts + 225_000, jobToDateCosts: before.jobToDateCosts + 225_000 })
      .where(eq(budgetLineItems.id, lineCip));
    expect((await lineById(lineCip)).jobToDateCosts).toBe(475_000);

    const summary = await inject("GET", `/api/v1/budgets/${budgetId}/summary`, u1.headers);
    expect(summary.json().components.paidToDate.value).toBe(225_000);
    expect(summary.json().components.jobToDateCosts.value).toBe(250_000);
    expect(summary.json().components.jobToDateCosts.inputs.nonCommitmentDirectCosts).toBe(0);
    expect(summary.json().drift.jobToDateCosts).toBe(-225_000);

    const res = await inject("POST", `/api/v1/budgets/${budgetId}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied.paidToDate).toBe(true);
    expect(res.json().driftCount).toBeGreaterThan(0);
    expect(res.json().drift.find((d: { component: string }) => d.component === "jobToDateCosts")).toMatchObject({ stored: 475_000, rebuilt: 250_000, delta: -225_000 });
    expect((await lineById(lineCip)).jobToDateCosts).toBe(250_000);
  });

  it("keeps genuine direct cost (payroll) on top: 250k invoiced + 40k labour is 290k", async () => {
    const before = await lineById(lineCip);
    await built.app.db.update(budgetLineItems).set({ directCosts: before.directCosts + 40_000 }).where(eq(budgetLineItems.id, lineCip));
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect((await lineById(lineCip)).jobToDateCosts).toBe(290_000);
    const summary = await inject("GET", `/api/v1/budgets/${budgetId}/summary`, u1.headers);
    expect(summary.json().components.jobToDateCosts.value).toBe(290_000);
    expect(summary.json().drift.jobToDateCosts).toBe(0);
  });

  it("counts a commitment SOV line reduced to zero as zero committed, not its original value", async () => {
    const zeroed = newId("csl");
    await built.app.db.insert(commitmentSovLines).values({
      id: zeroed,
      companyId: u1.companyId,
      projectId: proj,
      commitmentId,
      lineNumber: "2",
      budgetLineItemId: lineElec,
      description: "Deducted scope",
      scheduledValue: 50_000,
      changeOrderValue: -50_000,
      revisedScheduledValue: 0,
    });
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect((await lineById(lineElec)).committedCost).toBe(0);
  });

  it("records the reconciliation with its postings, and the drift lands in the ledger", async () => {
    const runs = await inject("GET", `/api/v1/budgets/${budgetId}/reconciliations`, u1.headers);
    expect(runs.statusCode).toBe(200);
    expect(runs.json().total).toBeGreaterThanOrEqual(4);
    const first = runs.json().items[runs.json().items.length - 1];
    expect(first.reference).toBe("RC-001");
    const detail = await inject("GET", `/api/v1/budget-reconciliations/${first.id}`, u1.headers);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().trigger).toBe("manual");

    const postings = await built.app.db.select().from(budgetPostings).where(eq(budgetPostings.budgetLineItemId, lineCip));
    const invoiced = postings.filter((p) => p.component === "invoicedToDate");
    expect(invoiced).toHaveLength(1);
    expect(invoiced[0]?.sourceReference).toBe("INV-2");
    expect(invoiced[0]?.amount).toBe(250_000);
    expect(postings.find((p) => p.component === "paidToDate")?.amount).toBe(225_000);

    const ledger = await built.app.db.select().from(ledgerEntries).where(eq(ledgerEntries.objectType, "budget_reconciliation"));
    expect(ledger.length).toBeGreaterThanOrEqual(4);
  });

  it("explains a line's numbers row by row (#500)", async () => {
    const res = await inject("GET", `/api/v1/budget-lines/${lineCip}/transactions`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const byComponent = new Map(body.components.map((c: { component: string }) => [c.component, c])) as Map<string, { value: number | null; stored: number; drift: number | null; rows: Array<{ reference: string; amount: number }>; basis: string }>;
    expect(byComponent.get("committedCost")?.value).toBe(900_000);
    expect(byComponent.get("committedCost")?.rows.map((r) => r.reference)).toEqual(["SC-001 / 1"]);
    expect(byComponent.get("invoicedToDate")?.rows.map((r) => r.reference)).toEqual(["INV-2"]);
    expect(byComponent.get("paidToDate")?.rows[0]?.amount).toBe(225_000);
    expect(byComponent.get("jobToDateCosts")?.value).toBe(290_000);
    expect(byComponent.get("jobToDateCosts")?.drift).toBe(0);
    expect(body.postings.length).toBeGreaterThan(0);
    expect(body.lastReconciliation.reference).toMatch(/^RC-/);
    expect(body.currency).toBe("USD");
  });

  it("runs the nightly reconciliation on the scheduler, idempotently, with the system actor", async () => {
    const before = await built.app.db.select().from(budgetPostings).where(eq(budgetPostings.budgetId, budgetId));
    const status = await built.app.scheduler.runNow("budget.reconcile");
    expect(status.state).toBe("succeeded");
    expect((status.lastResult as { budgets: number }).budgets).toBeGreaterThanOrEqual(1);
    const after = await built.app.db.select().from(budgetPostings).where(eq(budgetPostings.budgetId, budgetId));
    expect(after.length).toBe(before.length);
    const runs = await built.app.db.select().from(budgetReconciliations).where(eq(budgetReconciliations.budgetId, budgetId));
    const scheduled = runs.filter((r) => r.trigger === "scheduled");
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
    expect(scheduled[0]?.runBy).toBeNull();
    // a clean run raises no drift signal; the earlier drifted run raised exactly one
    const open = await built.app.db.select().from(signals).where(eq(signals.detector, "budget.cost_drift"));
    expect(open.length).toBe(1);
  });
});

/* ================================================================== */
/* Audit bugs — one regression each                                    */
/* ================================================================== */

describe("owner_change guards", () => {
  let draftPkg: string;
  let commitmentPkg: string;
  let executedPkg: string;

  it("refuses a draft package, a commitment package, and accepts an executed prime package once", async () => {
    const mkPkg = async (kind: string, status: string, number: number) => {
      const id = newId("cop");
      await built.app.db.insert(changeOrderPackages).values({ id, companyId: u1.companyId, projectId: proj, kind, number, reference: `PCO-${number}`, title: `Package ${number}`, status, amount: 25_000, createdBy: u1.userId });
      return id;
    };
    draftPkg = await mkPkg("prime_contract", "draft", 1);
    commitmentPkg = await mkPkg("commitment", "executed", 2);
    executedPkg = await mkPkg("prime_contract", "executed", 3);
    const raise = (sourceId: string) =>
      inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, {
        kind: "owner_change",
        title: "Owner funded",
        lines: [{ lineItemId: lineElec, amount: 25_000 }],
        sourceType: "change_order_package",
        sourceId,
      });
    const a = await raise(draftPkg);
    expect(a.statusCode).toBe(400);
    expect(a.json().message).toMatch(/not executed/);
    const b = await raise(commitmentPkg);
    expect(b.statusCode).toBe(400);
    expect(b.json().message).toMatch(/commitment package/);
    const c = await raise(executedPkg);
    expect(c.statusCode).toBe(201);
    const d = await raise(executedPkg);
    expect(d.statusCode).toBe(409);
    expect(d.json().message).toMatch(/already carries this instrument/);
  });

  it("refuses a package the changes module already funded automatically", async () => {
    const funded = newId("cop");
    await built.app.db.insert(changeOrderPackages).values({ id: funded, companyId: u1.companyId, projectId: proj, kind: "prime_contract", number: 4, reference: "PCO-4", title: "Auto-funded", status: "executed", amount: 1, budgetChangeId: "bch_elsewhere", createdBy: u1.userId });
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, {
      kind: "owner_change",
      title: "Twice",
      lines: [{ lineItemId: lineElec, amount: 1 }],
      sourceType: "change_order_package",
      sourceId: funded,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already funded/);
  });

  it("accepts an executed prime contract change order as the instrument, and refuses an unexecuted one", async () => {
    const pc = newId("pct");
    await built.app.db.insert(primeContracts).values({ id: pc, companyId: u1.companyId, projectId: proj, number: 1, reference: "PC-001", title: "Owner agreement", status: "approved", executed: 1, currency: "USD", originalContractSum: 1, revisedContractSum: 1, createdBy: u1.userId });
    const executed = newId("pcc");
    const pending = newId("pcc");
    await built.app.db.insert(primeContractChanges).values([
      { id: executed, companyId: u1.companyId, projectId: proj, primeContractId: pc, number: 1, reference: "PCCO-001", title: "Executed", status: "executed", amount: 5_000, createdBy: u1.userId },
      { id: pending, companyId: u1.companyId, projectId: proj, primeContractId: pc, number: 2, reference: "PCCO-002", title: "Pending", status: "pending_owner_approval", amount: 5_000, createdBy: u1.userId },
    ]);
    const ok = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, { kind: "owner_change", title: "PCCO", lines: [{ lineItemId: lineElec, amount: 5_000 }], sourceType: "prime_contract_change", sourceId: executed });
    expect(ok.statusCode).toBe(201);
    const no = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, { kind: "owner_change", title: "PCCO", lines: [{ lineItemId: lineElec, amount: 5_000 }], sourceType: "prime_contract_change", sourceId: pending });
    expect(no.statusCode).toBe(400);
    expect(no.json().message).toMatch(/not executed/);
  });
});

describe("state transitions are claimed atomically", () => {
  it("applies the legs once when two admins approve the same change concurrently", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, h3, {
      title: "Race",
      fromLineItemId: lineRebar,
      toLineItemId: lineElec,
      amount: 10_000,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, h3);
    const before = await lineById(lineElec);
    const [a, b] = await Promise.all([
      inject("POST", `/api/v1/budget-changes/${id}/approve`, h2),
      inject("POST", `/api/v1/budget-changes/${id}/approve`, u1.headers),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const after = await lineById(lineElec);
    expect(after.budgetModifications).toBe(before.budgetModifications + 10_000);
    expect(after.pendingBudgetChanges).toBe(before.pendingBudgetChanges - 10_000);
  });

  it("refuses a second submit and a reject on a change that already moved on", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, { title: "Once", fromLineItemId: lineRebar, toLineItemId: lineElec, amount: 1_000 });
    const id = created.json().id as string;
    const [s1, s2] = await Promise.all([inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers), inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers)]);
    expect([s1.statusCode, s2.statusCode].sort()).toEqual([200, 409]);
    expect((await lineById(lineElec)).pendingBudgetChanges).toBe(1_000);
    const approved = await inject("POST", `/api/v1/budget-changes/${id}/approve`, h2);
    expect(approved.statusCode).toBe(200);
    const rejected = await inject("POST", `/api/v1/budget-changes/${id}/reject`, h2, { reason: "late" });
    expect(rejected.statusCode).toBe(409);
  });

  it("names the segregation-of-duties control in the refusal details", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, { title: "Self", fromLineItemId: lineRebar, toLineItemId: lineElec, amount: 500 });
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers);
    const res = await inject("POST", `/api/v1/budget-changes/${id}/approve`, u1.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("segregation_of_duties");
    await inject("POST", `/api/v1/budget-changes/${id}/void`, u1.headers);
  });
});

describe("line guards", () => {
  it("unlocks a locked line through a status-only PATCH by an admin, and nothing else", async () => {
    const lock = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, h3, { status: "locked" });
    expect(lock.statusCode).toBe(403);
    const lockedByAdmin = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, h2, { status: "locked" });
    expect(lockedByAdmin.statusCode).toBe(200);
    const edit = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, u1.headers, { description: "Nope" });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toMatch(/locked/);
    const mixed = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, h2, { status: "active", description: "Nope" });
    expect(mixed.statusCode).toBe(409);
    const byStandard = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, h3, { status: "active" });
    expect(byStandard.statusCode).toBe(403);
    const unlock = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, h2, { status: "active" });
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().status).toBe("active");
  });

  it("turns a typed forecast-to-complete into a manual forecast that a recalculation keeps", async () => {
    const res = await inject("PATCH", `/api/v1/budget-lines/${lineRebar}`, u1.headers, { forecastToComplete: 123_456 });
    expect(res.statusCode).toBe(200);
    expect(res.json().forecastMethod).toBe("manual");
    expect(res.json().forecastToComplete).toBe(123_456);
    expect(res.json().forecastNotice.join(" ")).toMatch(/manual/);
    await inject("POST", `/api/v1/budgets/${budgetId}/recalculate`, u1.headers);
    expect((await lineById(lineRebar)).forecastToComplete).toBe(123_456);
  });

  it("refuses to delete a line that a commitment SOV line points at, naming the references", async () => {
    const res = await inject("DELETE", `/api/v1/budget-lines/${lineCip}`, u1.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/commitment_sov_lines/);
    expect(res.json().details.references.length).toBeGreaterThan(0);
  });

  it("upserts a CSV that carries only a quantity without zeroing the budget, and keeps qty × rate true", async () => {
    const measured = await inject("POST", `/api/v1/budgets/${budgetId}/lines`, u1.headers, { costCode: "03310", costType: "labour", description: "Rebar fixing", quantity: 100, unitRate: 50, unit: "t" });
    expect(measured.statusCode, measured.body).toBe(201);
    expect(measured.json().originalBudget).toBe(5_000);
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/lines/import`, u1.headers, {
      csv: "cost_code,cost_type,description,quantity\n03310,labour,Rebar fixing,120\n",
      mode: "upsert",
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().updated).toBe(1);
    const line = await lineById(measured.json().id as string);
    expect(line.quantity).toBe(120);
    expect(line.unitRate).toBe(50);
    expect(line.originalBudget).toBe(6_000);
    expect(line.percentComplete).toBe(0);
  });
});

describe("snapshot guards", () => {
  let snap: string;
  it("refuses a future-dated capture and a month-end capture from a standard user", async () => {
    const future = await inject("POST", `/api/v1/budgets/${budgetId}/snapshots`, h2, { name: "Future", asOfDate: "2099-12-31" });
    expect(future.statusCode).toBe(400);
    expect(future.json().message).toMatch(/future/);
    const standard = await inject("POST", `/api/v1/budgets/${budgetId}/snapshots`, h3, { name: "Close", kind: "monthly_close", asOfDate: today() });
    expect(standard.statusCode).toBe(403);
    const manual = await inject("POST", `/api/v1/budgets/${budgetId}/snapshots`, h3, { name: "Working", kind: "manual", asOfDate: today() });
    expect(manual.statusCode).toBe(201);
    snap = manual.json().id as string;
  });

  it("voids a capture (admin, reason) so it stops guarding the period, keeping its hash", async () => {
    const frozen = await inject("GET", `/api/v1/budgets/${budgetId}`, u1.headers);
    expect(frozen.json().planEditable).toBe(false);
    const byStandard = await inject("POST", `/api/v1/budget-snapshots/${snap}/void`, h3, { reason: "oops" });
    expect(byStandard.statusCode).toBe(403);
    const res = await inject("POST", `/api/v1/budget-snapshots/${snap}/void`, h2, { reason: "Captured by mistake" });
    expect(res.statusCode).toBe(200);
    expect(res.json().void).toBe(true);
    const again = await inject("POST", `/api/v1/budget-snapshots/${snap}/void`, h2, { reason: "twice" });
    expect(again.statusCode).toBe(409);
    const detail = await inject("GET", `/api/v1/budget-snapshots/${snap}`, u1.headers);
    expect(detail.json().hashVerified).toBe(true);
    expect(detail.json().void).toBe(true);
    const list = await inject("GET", `/api/v1/budgets/${budgetId}/snapshots`, u1.headers);
    expect(list.json().items.find((s: { id: string }) => s.id === snap).void).toBe(true);
    const editable = await inject("GET", `/api/v1/budgets/${budgetId}`, u1.headers);
    expect(editable.json().planEditable).toBe(true);
    expect(editable.json().lastSnapshot).toBeNull();
  });
});

/* ================================================================== */
/* Intelligence                                                        */
/* ================================================================== */

describe("insights, variance and cash flow", () => {
  it("computes earned value from a linked schedule window and flags the anomalies with citations", async () => {
    const scheduleId = newId("sch");
    await built.app.db.insert(schedules).values({ id: scheduleId, companyId: u1.companyId, projectId: proj, name: "Master", projectStart: daysAgo(100), createdBy: u1.userId });
    await built.app.db.insert(scheduleTasks).values({ id: newId("tsk"), scheduleId, projectId: proj, name: "Concrete", wbsCode: "03300", durationDays: 200, startDate: daysAgo(100), finishDate: daysAgo(-100), percentComplete: 50 });
    const res = await inject("GET", `/api/v1/budgets/${budgetId}/insights`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe("USD");
    expect(body.linesWithScheduleWindow).toBe(1);
    const cip = body.lines.find((l: { lineItemId: string }) => l.lineItemId === lineCip);
    expect(cip.window.taskIds).toHaveLength(1);
    expect(cip.earnedValue.ev.value).toBe(500_000);
    expect(cip.earnedValue.pv.value).toBeGreaterThan(0);
    expect(cip.earnedValue.cpi.value).toBeCloseTo(500_000 / 290_000, 3);
    expect(body.earnedValue.cpi.value).not.toBeNull();
    // the electrical line is committed at 0 but carries no window: PV unavailable with a reason
    const elec = body.lines.find((l: { lineItemId: string }) => l.lineItemId === lineElec);
    expect(elec.earnedValue.pv.value).toBeNull();
    expect(elec.earnedValue.pv.reasons[0]).toMatch(/No schedule window/);
    expect(body.findings.every((f: { citations: unknown[] }) => f.citations.length > 0)).toBe(true);
    expect(body.lastReconciliation).not.toBeNull();
    const filtered = await inject("GET", `/api/v1/budgets/${budgetId}/insights?severity=critical`, u1.headers);
    expect(filtered.json().findings.every((f: { severity: string }) => f.severity === "critical")).toBe(true);
  });

  it("reports budget vs actual variance grouped by division with movement since the last capture", async () => {
    const res = await inject("GET", `/api/v1/budgets/${budgetId}/variance?by=division`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.by).toBe("division");
    expect(body.groups.map((g: { key: string }) => g.key).sort()).toEqual(["03", "16", "99"]);
    const concrete = body.groups.find((g: { key: string }) => g.key === "03");
    expect(concrete.jobToDateCosts).toBe(290_000);
    expect(concrete.lines.length).toBeGreaterThanOrEqual(2);
    expect(body.totals.spentPct).toBeGreaterThan(0);
    // the only capture was voided, so there is nothing to compare with — said, not faked
    expect(body.comparedWith).toBeNull();
    expect(body.reasons[0]).toMatch(/No period capture/);
    const missing = await inject("GET", `/api/v1/budgets/${budgetId}/variance?compareWith=BS-999`, u1.headers);
    expect(missing.statusCode).toBe(404);
  });

  it("spreads the S-curve by period and reports what could not be phased", async () => {
    const res = await inject("GET", `/api/v1/budgets/${budgetId}/cashflow`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe("USD");
    expect(body.periods.length).toBeGreaterThan(3);
    expect(body.totals.committed).toBe(900_000);
    expect(body.totals.actual).toBe(250_000);
    expect(body.totals.planned).toBeGreaterThan(0);
    const last = body.periods[body.periods.length - 1];
    expect(last.cumulativeActual).toBe(250_000);
    expect(last.cumulativeCommitted).toBe(900_000);
    expect(body.basis.actual).toMatch(/approved subcontractor invoices/);
  });
});

describe("saved views with calculated fields", () => {
  let viewId: string;
  it("refuses an invalid expression and saves a valid field set", async () => {
    const bad = await inject("POST", `/api/v1/budgets/${budgetId}/views`, u1.headers, { name: "Bad", calculatedFields: [{ key: "x", expression: "revisedBudget - profit" }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.errors[0]).toMatch(/not a budget column/);
    const res = await inject("POST", `/api/v1/budgets/${budgetId}/views`, u1.headers, {
      name: "Headroom",
      isDefault: true,
      columns: ["costCode", "revisedBudget", "headroom"],
      calculatedFields: [
        { key: "headroom", label: "Headroom", expression: "revisedBudget - committedCost", format: "currency" },
        { key: "spent_pct", label: "Spent %", expression: "pct(jobToDateCosts, revisedBudget)", format: "percent" },
      ],
    });
    expect(res.statusCode).toBe(201);
    viewId = res.json().id as string;
    expect(res.json().isDefault).toBe(1);
    expect(res.json().calculatedFields[0].reads.sort()).toEqual(["committedCost", "revisedBudget"]);
  });

  it("evaluates the view over the budget's lines, null with a reason where the arithmetic is undefined", async () => {
    const res = await inject("GET", `/api/v1/budget-views/${viewId}/rows`, u1.headers);
    expect(res.statusCode).toBe(200);
    const cip = res.json().items.find((l: { id: string }) => l.id === lineCip);
    expect(cip.calculated.headroom.value).toBe(100_000);
    expect(cip.calculated.spent_pct.value).toBe(29);
    const preview = await inject("POST", `/api/v1/budgets/${budgetId}/views/evaluate`, u1.headers, { calculatedFields: [{ key: "ratio", expression: "jobToDateCosts / directCosts" }] });
    expect(preview.statusCode).toBe(200);
    const elec = preview.json().items.find((l: { lineItemId: string }) => l.lineItemId === lineElec);
    expect(elec.calculated.ratio.value).toBeNull();
    expect(elec.calculated.ratio.reasons[0]).toMatch(/denominator is 0/);
  });

  it("lists, patches, and deletes a view; read-only members may read but not write", async () => {
    const list = await inject("GET", `/api/v1/budgets/${budgetId}/views`, h4);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((v: { id: string }) => v.id)).toContain(viewId);
    const write = await inject("PATCH", `/api/v1/budget-views/${viewId}`, h4, { name: "Nope" });
    expect(write.statusCode).toBe(403);
    const patched = await inject("PATCH", `/api/v1/budget-views/${viewId}`, h3, { name: "Headroom v2", grouping: "division" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe("Headroom v2");
    const one = await inject("GET", `/api/v1/budget-views/${viewId}`, u1.headers);
    expect(one.json().grouping).toBe("division");
    const del = await inject("DELETE", `/api/v1/budget-views/${viewId}`, u1.headers);
    expect(del.statusCode).toBe(200);
    expect((await inject("GET", `/api/v1/budget-views/${viewId}`, u1.headers)).statusCode).toBe(404);
  });
});

describe("ERP import through the GL map (#481)", () => {
  let mapId: string;
  it("lists the dialects and manages the map", async () => {
    const dialects = await inject("GET", "/api/v1/budget-erp/dialects", u1.headers);
    expect(dialects.statusCode).toBe(200);
    expect(dialects.json().items.map((d: { system: string }) => d.system)).toContain("sage");
    const created = await inject("POST", `/api/v1/projects/${proj}/gl-cost-code-maps`, u1.headers, { erpSystem: "sage", glAccount: "5100", costCode: "03300", costType: "subcontract", glDescription: "Concrete subs" });
    expect(created.statusCode).toBe(201);
    mapId = created.json().id as string;
    expect(created.json().projectId).toBeNull();
    const dupe = await inject("POST", `/api/v1/projects/${proj}/gl-cost-code-maps`, u1.headers, { erpSystem: "sage", glAccount: "5100", costCode: "03310", costType: "material" });
    expect(dupe.statusCode).toBe(409);
    const projectScoped = await inject("POST", `/api/v1/projects/${proj}/gl-cost-code-maps`, u1.headers, { erpSystem: "sage", glAccount: "5200", glSubAccount: "M", costCode: "03310", costType: "material", projectOnly: true });
    expect(projectScoped.statusCode).toBe(201);
    expect(projectScoped.json().projectId).toBe(proj);
    const list = await inject("GET", `/api/v1/projects/${proj}/gl-cost-code-maps?q=5100`, u1.headers);
    expect(list.json().total).toBe(1);
    const patched = await inject("PATCH", `/api/v1/gl-cost-code-maps/${mapId}?projectId=${proj}`, u1.headers, { glDescription: "Concrete subcontracts" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().glDescription).toBe("Concrete subcontracts");
    const noProject = await inject("PATCH", `/api/v1/gl-cost-code-maps/${mapId}`, u1.headers, { glDescription: "x" });
    expect(noProject.statusCode).toBe(400);
  });

  it("dry-runs a Sage export, names the unmapped account, then imports with provenance", async () => {
    const csv = "job,cost_code,category,description,original_estimate\nJ1,5100,,Concrete,\"1,250,000.50\"\nJ1,5200,M,Rebar,40000\nJ1,7000,,Nowhere,9\n";
    const dry = await inject("POST", `/api/v1/budgets/${budgetId}/lines/import-erp`, u1.headers, { csv, erpSystem: "sage", dryRun: true, mode: "upsert" });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().dryRun).toBe(true);
    expect(dry.json().mappedLines).toBe(2);
    expect(dry.json().unmappedRows).toBe(1);
    expect(dry.json().unmapped[0].glAccount).toBe("7000");
    const refused = await inject("POST", `/api/v1/budgets/${budgetId}/lines/import-erp`, u1.headers, { csv, erpSystem: "sage", mode: "upsert" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.unmapped[0].reason).toMatch(/No GL → cost-code mapping/);
    // the budget is locked by no capture, but plan edits go through upsert: use a fresh budget
    const fresh = await inject("POST", `/api/v1/projects/${proj}/budgets`, u1.headers, { name: "ERP baseline", currency: "USD" });
    const freshId = fresh.json().id as string;
    const ok = await inject("POST", `/api/v1/budgets/${freshId}/lines/import-erp`, u1.headers, { csv: "cost_code,category,description,original_estimate\n5100,,Concrete,\"1,250,000.50\"\n5200,M,Rebar,40000\n", erpSystem: "sage" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().created).toBe(2);
    const lines = await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.budgetId, freshId));
    const concrete = lines.find((l) => l.costCode === "03300")!;
    expect(concrete.originalBudget).toBe(1_250_000.5);
    expect((concrete.detail as { provenance: { sourceType: string; rows: unknown[] } }).provenance.sourceType).toBe("erp_import");
    expect((concrete.detail as { provenance: { rows: unknown[] } }).provenance.rows).toHaveLength(1);
    const del = await inject("DELETE", `/api/v1/gl-cost-code-maps/${mapId}?projectId=${proj}`, u1.headers);
    expect(del.statusCode).toBe(200);
  });
});

describe("contingency linkage (#499)", () => {
  let contingencyId: string;
  let linkId: string;
  it("links the contingency line to a risk contingency and refuses a working line", async () => {
    contingencyId = newId("ctg");
    await built.app.db.insert(contingencies).values({ id: contingencyId, companyId: u1.companyId, projectId: proj, name: "P80 risk contingency", currency: "USD", amount: 100_000, confidenceLevel: "p80", createdBy: u1.userId });
    const wrong = await inject("POST", `/api/v1/budget-lines/${lineElec}/contingency-links`, u1.headers, { contingencyId });
    expect(wrong.statusCode).toBe(400);
    const res = await inject("POST", `/api/v1/budget-lines/${lineCont}/contingency-links`, u1.headers, { contingencyId, notes: "Funded from the QCRA" });
    expect(res.statusCode).toBe(201);
    linkId = res.json().id as string;
    const dupe = await inject("POST", `/api/v1/budget-lines/${lineCont}/contingency-links`, u1.headers, { contingencyId });
    expect(dupe.statusCode).toBe(409);
    const view = await inject("GET", `/api/v1/budgets/${budgetId}/contingency`, u1.headers);
    expect(view.statusCode).toBe(200);
    expect(view.json().remaining.value).toBe(100_000);
    expect(view.json().items[0].links[0].agrees).toEqual({ amount: true, drawn: true });
    expect(view.json().unlinkedRiskContingencies).toEqual([]);
  });

  it("records a drawdown on the risk contingency when a contingency draw is approved", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetId}/changes`, u1.headers, { kind: "contingency_draw", title: "Draw for rebar", fromLineItemId: lineCont, toLineItemId: lineRebar, amount: 30_000 });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers);
    const approved = await inject("POST", `/api/v1/budget-changes/${id}/approve`, h2);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().contingencyDrawdownsRecorded).toBe(1);
    const drawdowns = await built.app.db.select().from(contingencyDrawdowns).where(eq(contingencyDrawdowns.contingencyId, contingencyId));
    expect(drawdowns).toHaveLength(1);
    expect(drawdowns[0]?.amount).toBe(30_000);
    expect(drawdowns[0]?.approvedBy).toBe(u2.userId);
    const view = await inject("GET", `/api/v1/budgets/${budgetId}/contingency`, u1.headers);
    expect(view.json().items[0].drawn).toBe(30_000);
    expect(view.json().items[0].remaining).toBe(70_000);
    expect(view.json().items[0].links[0].drawn).toBe(30_000);
    expect(view.json().items[0].links[0].agrees.drawn).toBe(true);
    const unlink = await inject("DELETE", `/api/v1/budget-contingency-links/${linkId}`, u1.headers);
    expect(unlink.statusCode).toBe(200);
  });
});

describe("health inputs and tenant isolation", () => {
  it("exposes cost health for the active budget", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/budget/health-inputs`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetId).toBe(budgetId);
    expect(res.json().metrics.spentShare).toBeGreaterThan(0);
    expect(res.json().metrics.driftCount).not.toBeNull();
    expect(typeof res.json().metrics.criticalFindings).toBe("number");
    const empty = newId("prj");
    await built.app.db.insert(projects).values({ id: empty, companyId: u1.companyId, name: "Empty" });
    const none = await inject("GET", `/api/v1/projects/${empty}/budget/health-inputs`, u1.headers);
    expect(none.json().metrics.spentShare).toBeNull();
    expect(none.json().reasons[0]).toMatch(/no active budget/);
  });

  it("hides every upgrade route from another company", async () => {
    for (const path of [
      `/api/v1/budgets/${budgetId}/insights`,
      `/api/v1/budgets/${budgetId}/variance`,
      `/api/v1/budgets/${budgetId}/cashflow`,
      `/api/v1/budgets/${budgetId}/reconciliations`,
      `/api/v1/budgets/${budgetId}/contingency`,
      `/api/v1/budgets/${budgetId}/views`,
      `/api/v1/budget-lines/${lineCip}/transactions`,
    ]) {
      const res = await inject("GET", path, outsider.headers);
      expect(res.statusCode, path).toBe(404);
    }
    expect((await inject("POST", `/api/v1/budgets/${budgetId}/reconcile`, outsider.headers)).statusCode).toBe(404);
    expect((await inject("POST", `/api/v1/budget-lines/${lineCont}/contingency-links`, outsider.headers, { contingencyId: "x" })).statusCode).toBe(404);
    expect((await inject("GET", `/api/v1/projects/${proj}/gl-cost-code-maps`, outsider.headers)).statusCode).toBe(403);
    expect((await inject("GET", `/api/v1/projects/${proj}/budget/health-inputs`, outsider.headers)).statusCode).toBe(403);
    // a change carrying an outsider's line id never resolves
    const changes = await built.app.db.select().from(budgetChanges).where(eq(budgetChanges.budgetId, budgetId));
    expect(changes.length).toBeGreaterThan(0);
  });
});
