/**
 * Integration tests for the platform-upgrade wave of the prime contract
 * module: the audit bugs (each with a regression), the PCCO → budget chain,
 * compliance documents and their gate, application void, multi-receipt
 * settlement and ageing, stored materials, retainage, change analytics, the
 * AIA export, the compliance-expiry job, health inputs, and tenant negatives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  budgetChanges,
  budgetLineItems,
  companyMemberships,
  contacts,
  contracts,
  costCodes,
  ledgerEntries,
  primeContractComplianceDocuments,
  primeContractSovLines,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor; // company owner — raises contracts and applications
let certifier: TestActor; // project_admin — approves, certifies, verifies
let reader: TestActor; // read_only
let outsider: TestActor; // another company
let certifierHeaders: Record<string, string>;
let readerHeaders: Record<string, string>;

let proj: string;
let contractId: string;
let sovLines: Array<{ id: string; lineNumber: string }> = [];
let budgetId: string;
let budgetLineA: string;
let budgetLineB: string;

const api = (path: string): string => `/api/v1${path}`;
const today = (): string => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

interface Injected {
  statusCode: number;
  json: <T = Record<string, unknown>>() => T;
  body: string;
}

const call = async (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> => {
  const res = await built.app.inject({
    method,
    url: api(path),
    headers: options.headers ?? owner.headers,
    ...(options.payload !== undefined ? { payload: options.payload as object } : {}),
  });
  return res as unknown as Injected;
};

const idOf = (lineNumber: string): string => sovLines.find((l) => l.lineNumber === lineNumber)!.id;

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  certifier = await registerActor(built.app);
  reader = await registerActor(built.app);
  outsider = await registerActor(built.app);
  for (const actor of [certifier, reader]) {
    await built.app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: actor.userId, role: "member" });
  }
  certifierHeaders = { authorization: `Bearer ${certifier.accessToken}`, "x-company-id": owner.companyId };
  readerHeaders = { authorization: `Bearer ${reader.accessToken}`, "x-company-id": owner.companyId };
  proj = newId("prj");
  await built.app.db.insert(projects).values({ id: proj, companyId: owner.companyId, name: "Prime lifecycle" });
  await built.app.db.insert(projectMemberships).values([
    { id: newId("pm"), companyId: owner.companyId, projectId: proj, userId: certifier.userId, templateKey: "project_admin", overrides: {} },
    { id: newId("pm"), companyId: owner.companyId, projectId: proj, userId: reader.userId, templateKey: "read_only", overrides: {} },
  ]);
  const ccA = newId("cc");
  const ccB = newId("cc");
  await built.app.db.insert(costCodes).values([
    { id: ccA, companyId: owner.companyId, code: "03-100", title: "Concrete", costType: "subcontract" },
    { id: ccB, companyId: owner.companyId, code: "16-100", title: "Electrical", costType: "subcontract" },
  ]);
  // the active budget the PCCO chain must land in
  const budget = await call("POST", `/projects/${proj}/budgets`, { payload: { name: "GMP", currency: "USD", isActive: true } });
  budgetId = budget.json<{ id: string }>().id;
  const a = await call("POST", `/budgets/${budgetId}/lines`, { payload: { costCodeId: ccA, description: "Concrete", originalBudget: 600_000 } });
  budgetLineA = a.json<{ id: string }>().id;
  const b = await call("POST", `/budgets/${budgetId}/lines`, { payload: { costCodeId: ccB, description: "Electrical", originalBudget: 400_000 } });
  budgetLineB = b.json<{ id: string }>().id;
});

afterAll(async () => {
  await built.app.close();
});

/* ================================================================== */
/* Contract-level bugs                                                 */
/* ================================================================== */

describe("contract list, links and void", () => {
  it("searches inside the WHERE clause so counts and pages agree", async () => {
    const first = await call("POST", `/projects/${proj}/prime-contracts`, { payload: { title: "Alpha tower", originalContractSum: 1_000_000, defaultRetainagePercent: 10, contractDate: daysAgo(30), paymentTermsDays: 30 } });
    expect(first.statusCode).toBe(201);
    contractId = first.json<{ id: string }>().id;
    const second = await call("POST", `/projects/${proj}/prime-contracts`, { payload: { title: "Beta annex", originalContractSum: 10 } });
    expect(second.statusCode).toBe(201);
    const res = await call("GET", `/projects/${proj}/prime-contracts?q=alpha&pageSize=1`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; items: Array<{ title: string }> }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe("Alpha tower");
    const escaped = await call("GET", `/projects/${proj}/prime-contracts?q=%25`);
    expect(escaped.json<{ total: number }>().total).toBe(0);
  });

  it("validates contractId and ownerContactId on PATCH as on create", async () => {
    const foreign = newId("ctr");
    await built.app.db.insert(contracts).values({ id: foreign, companyId: outsider.companyId, projectId: newId("prj"), name: "Theirs", form: "custom", createdBy: outsider.userId } as typeof contracts.$inferInsert);
    const res = await call("PATCH", `/prime-contracts/${contractId}`, { payload: { contractId: foreign } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/contractId/);
    const contact = await call("PATCH", `/prime-contracts/${contractId}`, { payload: { ownerContactId: "ct_nobody" } });
    expect(contact.statusCode).toBe(400);
    expect(contact.json<{ message: string }>().message).toMatch(/ownerContactId/);
    const contactId = newId("ct");
    await built.app.db.insert(contacts).values({ id: contactId, companyId: owner.companyId, name: "Owner's rep" });
    const ok = await call("PATCH", `/prime-contracts/${contractId}`, { payload: { ownerContactId: contactId } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ ownerContactId: string }>().ownerContactId).toBe(contactId);
  });

  it("builds the SOV, adds a line in one transaction, and refuses to absorb base scope into a CO line", async () => {
    const put = await call("PUT", `/prime-contracts/${contractId}/sov`, {
      payload: {
        lines: [
          { lineNumber: "01", description: "Concrete", scheduledValue: 550_000, costCode: "03-100", costType: "subcontract", budgetLineItemId: budgetLineA },
          { lineNumber: "02", description: "Electrical", scheduledValue: 400_000, costCode: "16-100", costType: "subcontract", budgetLineItemId: budgetLineB },
          { lineNumber: "03", description: "Fees", scheduledValue: 50_000 },
        ],
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    const view = await call("GET", `/prime-contracts/${contractId}`);
    expect(view.json<{ sov: { identity: { ok: boolean } } }>().sov.identity.ok).toBe(true);
    const grown = await call("POST", `/prime-contracts/${contractId}/sov/lines`, { payload: { lineNumber: "04", description: "Extra scope", scheduledValue: 25_000, raiseContractSum: true } });
    expect(grown.statusCode).toBe(201);
    const after = await call("GET", `/prime-contracts/${contractId}`);
    expect(after.json<{ originalContractSum: number; sov: { identity: { ok: boolean } } }>().originalContractSum).toBe(1_025_000);
    expect(after.json<{ sov: { identity: { ok: boolean } } }>().sov.identity.ok).toBe(true);
    const sov = await call("GET", `/prime-contracts/${contractId}/sov`);
    sovLines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
    // a change-order line to try absorbing into
    await built.app.db.insert(primeContractSovLines).values({ id: newId("sov"), companyId: owner.companyId, projectId: proj, primeContractId: contractId, lineNumber: "CO-X", description: "CO scope", scheduledValue: 0, revisedScheduledValue: 0, isChangeOrderLine: 1 });
    const refreshed = await call("GET", `/prime-contracts/${contractId}/sov`);
    const co = refreshed.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines.find((l) => l.lineNumber === "CO-X")!;
    // the browser cannot put a body on DELETE, so the absorb target is also
    // accepted as a query parameter — the guard has to hold on both paths
    const del = await call("DELETE", `/prime-contracts/${contractId}/sov/lines/${idOf("04")}?absorbIntoLineId=${co.id}`);
    expect(del.statusCode).toBe(400);
    expect(del.json<{ message: string }>().message).toMatch(/appended by a change order/);
    await built.app.db.delete(primeContractSovLines).where(eq(primeContractSovLines.id, co.id));
    const absorbed = await call("DELETE", `/prime-contracts/${contractId}/sov/lines/${idOf("04")}`, { payload: { absorbIntoLineId: idOf("03") } });
    expect(absorbed.statusCode).toBe(200);
    sovLines = (await call("GET", `/prime-contracts/${contractId}/sov`)).json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
  });

  it("approves and executes, then refuses to void an executed contract with a billing history", async () => {
    const approve = await call("POST", `/prime-contracts/${contractId}/approve`, { payload: {}, headers: certifierHeaders });
    expect(approve.statusCode).toBe(200);
    const exec = await call("POST", `/prime-contracts/${contractId}/execute`, { payload: { executionDate: today() }, headers: certifierHeaders });
    expect(exec.statusCode).toBe(200);
    const noReason = await call("POST", `/prime-contracts/${contractId}/status`, { payload: { status: "void" }, headers: certifierHeaders });
    expect(noReason.statusCode).toBe(400);
    const open = await call("POST", `/prime-contracts/${contractId}/billings`, { payload: { billingDate: today() } });
    expect(open.statusCode).toBe(201);
    const res = await call("POST", `/prime-contracts/${contractId}/status`, { payload: { status: "void", reason: "mistake" }, headers: certifierHeaders });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/terminated, never voided/);
  });
});

/* ================================================================== */
/* Applications: compliance gate, void, identities, receipts           */
/* ================================================================== */

describe("applications", () => {
  let app1: string;
  let docId: string;

  it("keeps the contract reconciled while a draft is edited, reporting the draft work separately", async () => {
    const list = await call("GET", `/prime-contracts/${contractId}/billings`);
    app1 = list.json<{ items: Array<{ id: string }> }>().items[0]!.id;
    const edit = await call("PUT", `/prime-contracts/${contractId}/billings/${app1}/lines`, { payload: { lines: [{ sovLineId: idOf("01"), thisPeriodWork: 100_000 }] } });
    expect(edit.statusCode).toBe(200);
    const view = await call("GET", `/prime-contracts/${contractId}`);
    const body = view.json<{ reconciled: boolean; totalBilled: number; draftBilled: number; identities: Array<{ ok: boolean }> }>();
    expect(body.reconciled).toBe(true);
    expect(body.totalBilled).toBe(0);
    expect(body.draftBilled).toBe(100_000);
    expect(body.identities.every((i) => i.ok)).toBe(true);
  });

  it("gates submission on required compliance documents, and verification needs a second pair of eyes", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/compliance`, { payload: { kind: "insurance_certificate", title: "General liability", required: true, expiryDate: daysAgo(-200) } });
    expect(created.statusCode).toBe(201);
    docId = created.json<{ id: string }>().id;
    expect(created.json<{ status: string }>().status).toBe("missing");
    const optional = await call("POST", `/prime-contracts/${contractId}/compliance`, { payload: { kind: "other", title: "Nice to have", required: false } });
    expect(optional.statusCode).toBe(201);
    const blocked = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/submit`, { payload: { certifiedByContractorName: "A. Contractor" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ details: { control: string; blocking: unknown[] } }>().details.control).toBe("compliance_gate");
    const gate = await call("GET", `/prime-contracts/${contractId}/compliance`);
    expect(gate.json<{ gate: { ok: boolean; blocking: unknown[] } }>().gate.ok).toBe(false);
    const received = await call("PATCH", `/prime-compliance/${docId}`, { payload: { status: "received", reference: "GL-2026-001", issuer: "Acme Insurance" } });
    expect(received.statusCode).toBe(200);
    const selfVerify = await call("POST", `/prime-compliance/${docId}/verify`, { payload: {} });
    expect(selfVerify.statusCode).toBe(403);
    expect(selfVerify.json<{ details: { control: string } }>().details.control).toBe("segregation_of_duties");
    const verified = await call("POST", `/prime-compliance/${docId}/verify`, { payload: {}, headers: certifierHeaders });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ status: string; verifiedBy: string }>().verifiedBy).toBe(certifier.userId);
    const readerWrite = await call("PATCH", `/prime-compliance/${docId}`, { payload: { notes: "x" }, headers: readerHeaders });
    expect(readerWrite.statusCode).toBe(403);
    const submitted = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/submit`, { payload: { certifiedByContractorName: "A. Contractor" } });
    expect(submitted.statusCode).toBe(200);
  });

  it("blocks a second application while one is rejected, voids the rejected one, and resets the SOV mirror", async () => {
    const rejected = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/reject`, { payload: { reason: "Wrong period" }, headers: certifierHeaders });
    expect(rejected.statusCode).toBe(200);
    const blocked = await call("POST", `/prime-contracts/${contractId}/billings`, { payload: { billingDate: today() } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ message: string }>().message).toMatch(/rejected/);
    const complete = await call("POST", `/prime-contracts/${contractId}/status`, { payload: { status: "complete" }, headers: certifierHeaders });
    expect(complete.statusCode).toBe(409);
    const byStandard = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/void`, { payload: { reason: "start over" }, headers: readerHeaders });
    expect(byStandard.statusCode).toBe(403);
    const voided = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/void`, { payload: { reason: "Wrong period — raising again" }, headers: certifierHeaders });
    expect(voided.statusCode).toBe(200);
    expect(voided.json<{ application: { status: string } }>().application.status).toBe("void");
    const sov = await call("GET", `/prime-contracts/${contractId}/sov`);
    const one = sov.json<{ lines: Array<{ lineNumber: string; thisPeriodWork: number; totalCompletedAndStored: number }> }>().lines.find((l) => l.lineNumber === "01")!;
    expect(one.thisPeriodWork).toBe(0);
    expect(one.totalCompletedAndStored).toBe(0);
    const again = await call("POST", `/prime-contracts/${contractId}/billings/${app1}/void`, { payload: { reason: "twice" }, headers: certifierHeaders });
    expect(again.statusCode).toBe(409);
    const view = await call("GET", `/prime-contracts/${contractId}`);
    expect(view.json<{ draftBilled: number; reconciled: boolean }>().draftBilled).toBe(0);
    expect(view.json<{ reconciled: boolean }>().reconciled).toBe(true);
  });

  let app2: string;
  it("opens a fresh application that does not inherit the voided figures, certifies it, and refuses to void a certified one", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/billings`, { payload: { billingDate: today() } });
    expect(created.statusCode).toBe(201);
    app2 = created.json<{ application: { id: string }; g702: { totalCompletedAndStored: number } }>().application.id;
    expect(created.json<{ g702: { totalCompletedAndStored: number } }>().g702.totalCompletedAndStored).toBe(0);
    const edit = await call("PUT", `/prime-contracts/${contractId}/billings/${app2}/lines`, { payload: { lines: [{ sovLineId: idOf("01"), thisPeriodWork: 200_000 }, { sovLineId: idOf("02"), thisPeriodWork: 200_000 }] } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json<{ g702: { currentPaymentDue: number } }>().g702.currentPaymentDue).toBe(360_000);
    await call("POST", `/prime-contracts/${contractId}/billings/${app2}/submit`, { payload: { certifiedByContractorName: "A. Contractor" } });
    const selfCertify = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/certify`, { payload: {} });
    expect(selfCertify.statusCode).toBe(403);
    expect(selfCertify.json<{ details: { control: string } }>().details.control).toBe("no_self_certification");
    const certified = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/certify`, {
      payload: { certifiedAmount: 350_000, certifier: { name: "O. Architect", documentHash: "sha256:abc" } },
      headers: certifierHeaders,
    });
    expect(certified.statusCode).toBe(200);
    expect(certified.json<{ application: { status: string; detail: { certifier: { name: string } } } }>().application.status).toBe("partially_certified");
    expect(certified.json<{ application: { detail: { certifier: { name: string } } } }>().application.detail.certifier.name).toBe("O. Architect");
    const noVoid = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/void`, { payload: { reason: "no" }, headers: certifierHeaders });
    expect(noVoid.statusCode).toBe(409);
  });

  it("records receipts one at a time: 300k of 350k stays certified, the balance settles it, and over-payment is refused", async () => {
    const first = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/pay`, { payload: { paidAmount: 300_000, paidAt: today(), paymentReference: "WIRE-1" }, headers: certifierHeaders });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ application: { status: string; paidAmount: number } }>().application.status).toBe("partially_certified");
    expect(first.json<{ application: { paidAmount: number } }>().application.paidAmount).toBe(300_000);
    expect(first.json<{ settlement: { outstanding: number; state: string } }>().settlement).toMatchObject({ outstanding: 50_000, state: "partially_paid" });
    const over = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/receipts`, { payload: { amount: 60_000 }, headers: certifierHeaders });
    expect(over.statusCode).toBe(400);
    expect(over.json<{ message: string }>().message).toMatch(/exceeds/);
    const second = await call("POST", `/prime-contracts/${contractId}/billings/${app2}/receipts`, { payload: { amount: 50_000, method: "check", paymentReference: "CHK-9" }, headers: certifierHeaders });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ settlement: { state: string } }>().settlement.state).toBe("paid");
    expect(second.json<{ application: { status: string } }>().application.status).toBe("paid");
    const receipts = await call("GET", `/prime-contracts/${contractId}/billings/${app2}/receipts`);
    expect(receipts.json<{ total: number; paid: number; outstanding: number }>()).toMatchObject({ total: 2, paid: 350_000, outstanding: 0 });
    const contract = await call("GET", `/prime-contracts/${contractId}`);
    expect(contract.json<{ totalPaid: number }>().totalPaid).toBe(350_000);
    const receiptId = receipts.json<{ items: Array<{ id: string }> }>().items[1]!.id;
    const voided = await call("POST", `/owner-payment-receipts/${receiptId}/void`, { payload: { reason: "Bounced" }, headers: certifierHeaders });
    expect(voided.statusCode).toBe(200);
    expect(voided.json<{ application: { status: string; paidAmount: number } }>().application.status).toBe("partially_certified");
    expect(voided.json<{ application: { paidAmount: number } }>().application.paidAmount).toBe(300_000);
    const aging = await call("GET", `/prime-contracts/${contractId}/receivables`);
    expect(aging.statusCode).toBe(200);
    expect(aging.json<{ totals: { outstanding: number } }>().totals.outstanding).toBe(50_000);
    expect(aging.json<{ items: Array<{ dueDate: string | null; bucket: string }> }>().items[0]?.dueDate).not.toBeNull();
    expect(aging.json<{ paymentTermsDays: number }>().paymentTermsDays).toBe(30);
  });

  it("exports the AIA G702/G703 as data and as CSV", async () => {
    const json = await call("GET", `/prime-contracts/${contractId}/billings/${app2}/export`);
    expect(json.statusCode).toBe(200);
    const body = json.json<{ form: string; g702: Record<string, unknown>; g703: unknown[]; g703Totals: Record<string, number> }>();
    expect(body.form).toMatch(/G702/);
    expect(body.g702["8. CURRENT PAYMENT DUE"]).toBe(360_000);
    expect(body.g702["AMOUNT CERTIFIED"]).toBe(350_000);
    expect(body.g703).toHaveLength(3);
    expect(body.g703Totals["G. TOTAL COMPLETED AND STORED TO DATE"]).toBe(400_000);
    const csv = await built.app.inject({ method: "GET", url: api(`/prime-contracts/${contractId}/billings/${app2}/export?format=csv`), headers: owner.headers });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toMatch(/AIA G703 — CONTINUATION SHEET/);
    expect(csv.body).toMatch(/TOTALS/);
  });
});

/* ================================================================== */
/* Change orders → budget                                              */
/* ================================================================== */

describe("prime change orders fund the budget", () => {
  let changeId: string;
  it("refuses edits once a change is under review or approved", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/changes`, { payload: { title: "Extra concrete", amount: 40_000, lines: [{ sovLineId: idOf("01"), description: "More slab", amount: 40_000 }] } });
    expect(created.statusCode).toBe(201);
    changeId = created.json<{ id: string }>().id;
    const okEdit = await call("PATCH", `/prime-contracts/${contractId}/changes/${changeId}`, { payload: { title: "Extra concrete (rev)" } });
    expect(okEdit.statusCode).toBe(200);
    await call("POST", `/prime-contracts/${contractId}/changes/${changeId}/submit`, { payload: {} });
    const pending = await call("PATCH", `/prime-contracts/${contractId}/changes/${changeId}`, { payload: { amount: 400_000 } });
    expect(pending.statusCode).toBe(409);
    const approved = await call("POST", `/prime-contracts/${contractId}/changes/${changeId}/approve`, { payload: { ownerApproval: { name: "The Owner", documentHash: "sha256:pcco" } }, headers: certifierHeaders });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<{ detail: { ownerApproval: { name: string } } }>().detail.ownerApproval.name).toBe("The Owner");
    const afterApproval = await call("PATCH", `/prime-contracts/${contractId}/changes/${changeId}`, { payload: { amount: 400_000 } });
    expect(afterApproval.statusCode).toBe(409);
    expect(afterApproval.json<{ message: string }>().message).toMatch(/already approved/);
  });

  it("executes: the contract sum, the SOV and the budget's approvedChanges all rise by the same amount", async () => {
    const before = (await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.id, budgetLineA)))[0]!;
    const res = await call("POST", `/prime-contracts/${contractId}/changes/${changeId}/execute`, { payload: { executedDate: today() }, headers: certifierHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ budget: { applied: boolean; budgetChangeId: string; linesMoved: number; amount: number }; contract: { revisedContractSum: number; sov: { identity: { ok: boolean } } } }>();
    expect(body.budget.applied).toBe(true);
    expect(body.budget.linesMoved).toBe(1);
    expect(body.budget.amount).toBe(40_000);
    expect(body.contract.revisedContractSum).toBe(1_065_000);
    expect(body.contract.sov.identity.ok).toBe(true);
    const after = (await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.id, budgetLineA)))[0]!;
    expect(after.approvedChanges).toBe(before.approvedChanges + 40_000);
    expect(after.revisedBudget).toBe(before.revisedBudget + 40_000);
    const bc = (await built.app.db.select().from(budgetChanges).where(eq(budgetChanges.id, body.budget.budgetChangeId)))[0]!;
    expect(bc.kind).toBe("owner_change");
    expect(bc.status).toBe("approved");
    expect(bc.sourceType).toBe("prime_contract_change");
    expect(bc.sourceId).toBe(changeId);
    expect(bc.netEffect).toBe(40_000);
    // the same instrument cannot fund the budget a second time by hand
    const twice = await call("POST", `/budgets/${budgetId}/changes`, { payload: { kind: "owner_change", title: "again", lines: [{ lineItemId: budgetLineA, amount: 40_000 }], sourceType: "prime_contract_change", sourceId: changeId } });
    expect(twice.statusCode).toBe(409);
    const ledger = await built.app.db.select().from(ledgerEntries).where(eq(ledgerEntries.objectId, body.budget.budgetChangeId));
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to execute a change whose lines cannot land on the active budget", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/changes`, { payload: { title: "Uncoded", amount: 1_000, lines: [{ description: "Mystery", amount: 1_000 }] } });
    const id = created.json<{ id: string }>().id;
    await call("POST", `/prime-contracts/${contractId}/changes/${id}/submit`, { payload: {} });
    await call("POST", `/prime-contracts/${contractId}/changes/${id}/approve`, { payload: {}, headers: certifierHeaders });
    const res = await call("POST", `/prime-contracts/${contractId}/changes/${id}/execute`, { payload: {}, headers: certifierHeaders });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/do not resolve to a line of budget/);
  });

  it("reports the register analytics", async () => {
    const res = await call("GET", `/prime-contracts/${contractId}/changes/analytics`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ executed: { count: number; amount: number; shareOfOriginal: number }; byStatus: Array<{ status: string }>; cycleTimeDays: { samples: number } }>();
    expect(body.executed.count).toBe(1);
    expect(body.executed.amount).toBe(40_000);
    expect(body.executed.shareOfOriginal).toBeCloseTo(40_000 / 1_025_000, 4);
    expect(body.cycleTimeDays.samples).toBe(2);
  });

  it("sends a change back for correction, then voids one that will never be executed", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/changes`, { payload: { title: "Mispriced", amount: 5_000, lines: [{ sovLineId: idOf("01"), description: "Slab trim", amount: 5_000 }] } });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    await call("POST", `/prime-contracts/${contractId}/changes/${id}/submit`, { payload: {} });
    // Sent back: the author may edit and resubmit — without this outcome a
    // reviewer's only adverse verdict is a dead end.
    const back = await call("POST", `/prime-contracts/${contractId}/changes/${id}/reject`, { payload: { reason: "Rate is wrong", outcome: "revise_and_resubmit" }, headers: certifierHeaders });
    expect(back.statusCode).toBe(200);
    expect(back.json<{ status: string }>().status).toBe("revise_and_resubmit");
    const edited = await call("PATCH", `/prime-contracts/${contractId}/changes/${id}`, { payload: { amount: 6_000, lines: [{ sovLineId: idOf("01"), description: "Slab trim", amount: 6_000 }] } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ amount: number }>().amount).toBe(6_000);
    await call("POST", `/prime-contracts/${contractId}/changes/${id}/submit`, { payload: {} });
    const rejected = await call("POST", `/prime-contracts/${contractId}/changes/${id}/reject`, { payload: { reason: "Not proceeding" }, headers: certifierHeaders });
    expect(rejected.json<{ status: string }>().status).toBe("rejected");
    // A rejected change order cannot be edited or resubmitted — void is its
    // only exit, and it must leave the exposure figures at zero.
    expect((await call("PATCH", `/prime-contracts/${contractId}/changes/${id}`, { payload: { amount: 1 } })).statusCode).toBe(409);
    expect((await call("POST", `/prime-contracts/${contractId}/changes/${id}/submit`, { payload: {} })).statusCode).toBe(409);
    const readOnly = await call("POST", `/prime-contracts/${contractId}/changes/${id}/void`, { payload: { reason: "no" }, headers: readerHeaders });
    expect(readOnly.statusCode).toBe(403);
    const noReason = await call("POST", `/prime-contracts/${contractId}/changes/${id}/void`, { payload: {} });
    expect(noReason.statusCode).toBe(400);
    const voided = await call("POST", `/prime-contracts/${contractId}/changes/${id}/void`, { payload: { reason: "Withdrawn by the owner" }, headers: certifierHeaders });
    expect(voided.statusCode).toBe(200);
    expect(voided.json<{ status: string }>().status).toBe("void");
    expect((await call("POST", `/prime-contracts/${contractId}/changes/${id}/void`, { payload: { reason: "again" }, headers: certifierHeaders })).statusCode).toBe(409);
    const ledger = await built.app.db.select().from(ledgerEntries).where(eq(ledgerEntries.objectId, id));
    expect(ledger.some((e) => e.action === "state_change")).toBe(true);
    // the executed change order is a signed instrument: it is reversed, never voided
    const executedVoid = await call("POST", `/prime-contracts/${contractId}/changes/${changeId}/void`, { payload: { reason: "no" }, headers: certifierHeaders });
    expect(executedVoid.statusCode).toBe(409);
    expect(executedVoid.json<{ message: string }>().message).toMatch(/reverse it with a further change order/);
    const outsiderVoid = await call("POST", `/prime-contracts/${contractId}/changes/${id}/void`, { payload: { reason: "x" }, headers: outsider.headers });
    expect(outsiderVoid.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Stored materials, retainage, sweep, health, tenancy                  */
/* ================================================================== */

describe("stored materials, retainage, sweep, health, tenancy", () => {
  let itemId: string;
  it("keeps a stored-material register that must agree with column F", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/stored-materials`, { payload: { sovLineId: idOf("02"), description: "Switchgear", value: 30_000, insured: true, supplierInvoiceReference: "SUP-77", location: "off_site_bonded" } });
    expect(created.statusCode).toBe(201);
    itemId = created.json<{ id: string }>().id;
    const wrongLine = await call("POST", `/prime-contracts/${contractId}/stored-materials`, { payload: { sovLineId: "sov_nope", description: "x", value: 1 } });
    expect(wrongLine.statusCode).toBe(400);
    const list = await call("GET", `/prime-contracts/${contractId}/stored-materials`);
    expect(list.statusCode).toBe(200);
    const rec = list.json<{ reconciliation: { totals: { registerValue: number; billedValue: number; identity: { ok: boolean } } } }>().reconciliation;
    expect(rec.totals.registerValue).toBe(30_000);
    expect(rec.totals.billedValue).toBe(0);
    expect(rec.totals.identity.ok).toBe(false);
    const partial = await call("POST", `/prime-stored-materials/${itemId}/incorporate`, { payload: { value: 10_000 } });
    expect(partial.statusCode).toBe(200);
    expect(partial.json<{ status: string; incorporatedValue: number }>()).toMatchObject({ status: "partially_incorporated", incorporatedValue: 10_000 });
    const tooMuch = await call("POST", `/prime-stored-materials/${itemId}/incorporate`, { payload: { value: 50_000 } });
    expect(tooMuch.statusCode).toBe(400);
    const patched = await call("PATCH", `/prime-stored-materials/${itemId}`, { payload: { insuranceReference: "POL-1" } });
    expect(patched.statusCode).toBe(200);
    const rest = await call("POST", `/prime-stored-materials/${itemId}/incorporate`, { payload: {} });
    expect(rest.json<{ status: string }>().status).toBe("incorporated");
    const removed = await call("POST", `/prime-stored-materials/${itemId}/remove`, { payload: { reason: "Damaged" } });
    expect(removed.statusCode).toBe(200);
  });

  it("shows retainage held by line, the releases, and the proposal with its gate", async () => {
    const res = await call("GET", `/prime-contracts/${contractId}/retainage`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ held: number; byLine: Array<{ retainageHeld: number }>; proposal: { kind: string; gate: { ok: boolean; reasons: string[] } }; gate: { compliance: { ok: boolean } } }>();
    expect(body.held).toBe(40_000);
    expect(body.byLine.reduce((s, l) => s + l.retainageHeld, 0)).toBe(40_000);
    expect(body.proposal.kind).toBe("none");
    expect(body.gate.compliance.ok).toBe(true);
  });

  it("expires lapsed compliance documents on the scheduler, once", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/compliance`, { payload: { kind: "performance_bond", title: "Performance bond", status: "received", expiryDate: daysAgo(3) } });
    expect(created.statusCode).toBe(201);
    const first = await built.app.scheduler.runNow("primecontracts.compliance-expiry");
    expect(first.state).toBe("succeeded");
    expect((first.lastResult as { expired: number }).expired).toBe(1);
    const row = (await built.app.db.select().from(primeContractComplianceDocuments).where(eq(primeContractComplianceDocuments.id, created.json<{ id: string }>().id)))[0]!;
    expect(row.status).toBe("expired");
    const second = await built.app.scheduler.runNow("primecontracts.compliance-expiry");
    expect((second.lastResult as { expired: number }).expired).toBe(0);
    const gate = await call("GET", `/prime-contracts/${contractId}/compliance`);
    expect(gate.json<{ gate: { ok: boolean; blocking: Array<{ problem: string }> } }>().gate.blocking[0]?.problem).toMatch(/expired/);
    // a renewed certificate goes back on file
    const renewed = await call("PATCH", `/prime-compliance/${row.id}`, { payload: { expiryDate: daysAgo(-365) } });
    expect(renewed.json<{ status: string }>().status).toBe("received");
    const waived = await call("POST", `/prime-compliance/${row.id}/waive`, { payload: { reason: "Owner waived the bond in writing" }, headers: certifierHeaders });
    expect(waived.json<{ status: string }>().status).toBe("waived");
    const deleted = await call("DELETE", `/prime-compliance/${row.id}`, { headers: certifierHeaders });
    expect(deleted.statusCode).toBe(200);
  });

  it("exposes revenue health inputs", async () => {
    const res = await call("GET", `/projects/${proj}/prime-contracts/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ currency: string; metrics: { billedShare: number; overdueReceivables: number; complianceBlocking: number; executedContracts: number } }>();
    expect(body.currency).toBe("USD");
    expect(body.metrics.executedContracts).toBe(1);
    expect(body.metrics.billedShare).toBeGreaterThan(0);
    expect(body.metrics.complianceBlocking).toBe(0);
    expect(typeof body.metrics.overdueReceivables).toBe("number");
  });

  it("hides every lifecycle route from another company", async () => {
    for (const path of [
      `/prime-contracts/${contractId}/compliance`,
      `/prime-contracts/${contractId}/stored-materials`,
      `/prime-contracts/${contractId}/retainage`,
      `/prime-contracts/${contractId}/receivables`,
      `/prime-contracts/${contractId}/changes/analytics`,
      `/prime-stored-materials/${itemId}`,
    ]) {
      const res = await call("GET", path, { headers: outsider.headers });
      expect(res.statusCode, path).toBe(404);
    }
    expect((await call("POST", `/prime-stored-materials/${itemId}/incorporate`, { payload: {}, headers: outsider.headers })).statusCode).toBe(404);
    expect((await call("GET", `/projects/${proj}/prime-contracts/health-inputs`, { headers: outsider.headers })).statusCode).toBe(403);
    const readerOnly = await call("POST", `/prime-contracts/${contractId}/stored-materials`, { payload: { sovLineId: idOf("02"), description: "x", value: 1 }, headers: readerHeaders });
    expect(readerOnly.statusCode).toBe(403);
  });
});
