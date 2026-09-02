/**
 * WP-FIN2 — commitments upgrade coverage.
 *
 * Everything this wave added to the buy side, plus a regression test for each
 * audit finding it fixed:
 *
 *   backcharges (#538)          raise -> issue (negative CCO) -> reserved
 *                               against payment -> settle / void
 *   closeout + final release    checklist with evidence, refusal without it,
 *   (#539)                      final release = remaining retainage exactly
 *   contract documents          generate -> route -> sign in order -> execute,
 *   (#525-527)                  and the e-sign webhook doing the same
 *   payment runs (#586-594)     one currency, two people, one issue path
 *   compliance sweep (#532)     the scheduler job and the upcoming register
 *
 *   regressions                 payments.ts:476 approval invalidation
 *                               payments.ts:718 failed payment retainage
 *                               changes.ts:644  deleted SOV line at approval
 *                               changes.ts:205  cross-tenant package id
 *                               rollups.ts:114  per-line PO tax
 *                               rollups.ts:264  pending CCO budget exposure
 *                               sov.ts:374      atomic schedule replacement
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  backcharges,
  budgetLineItems,
  budgets,
  commitmentPayments,
  commitmentSovLines,
  commitments,
  companyMemberships,
  insuranceCertificates,
  notifications,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { purchaseOrderTax } from "./rollups.js";
import { defaultCloseoutItems, evaluateCloseout } from "./closeout.js";

let built: BuiltApp;
let owner: TestActor;
let second: TestActor; // approver / issuer — segregation needs a second pair of hands
let third: TestActor; // issuer where approve and issue must differ again
let outsider: TestActor; // a different company entirely

let secondH: Record<string, string>;
let thirdH: Record<string, string>;

let proj: string;
let projOther: string;
let vendor: string;
let cert: string;
let budgetId: string;
let budgetLine: string;

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
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
  projOther = newId("prj");
  await built.app.db.insert(projects).values([
    { id: proj, companyId: owner.companyId, name: "FIN2 commitments" },
    { id: projOther, companyId: owner.companyId, name: "FIN2 commitments — other" },
  ]);
  for (const projectId of [proj, projOther]) {
    for (const actor of [second, third]) {
      await built.app.db.insert(projectMemberships).values({
        id: newId("pm"),
        companyId: owner.companyId,
        projectId,
        userId: actor.userId,
        templateKey: "project_admin",
        overrides: {},
      });
    }
  }

  vendor = newId("ven");
  await built.app.db.insert(vendors).values({
    id: vendor,
    companyId: owner.companyId,
    name: "Northgate Steel",
    email: "accounts@northgate.test",
  });
  cert = newId("cert");
  await built.app.db.insert(insuranceCertificates).values({
    id: cert,
    companyId: owner.companyId,
    projectId: null,
    vendorId: vendor,
    subjectName: "Northgate Steel",
    policyType: "employers_liability",
    validFrom: isoDaysFromNow(-200),
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
    costCode: "05-100",
    costType: "subcontract",
    description: "Structural steel",
    originalBudget: 500000,
    revisedBudget: 500000,
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

/** An approved, executed subcontract with a two-line schedule. */
async function makeCommitment(
  opts: { title: string; lines: Array<Record<string, unknown>>; projectId?: string; retainage?: number } ,
): Promise<{ id: string; sovLineIds: string[] }> {
  const res = await inject("POST", `/api/v1/projects/${opts.projectId ?? proj}/commitments`, owner.headers, {
    kind: "subcontract",
    title: opts.title,
    vendorId: vendor,
    defaultRetainagePercent: opts.retainage ?? 10,
    requiresLienWaiver: false,
    compliance: { strictness: "warn", requiredPolicyTypes: ["employers_liability"] },
    sovLines: opts.lines,
  });
  if (res.statusCode !== 201) throw new Error(`makeCommitment failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  await inject("POST", `/api/v1/commitments/${body.commitment.id}/approve`, secondH, {});
  await inject("POST", `/api/v1/commitments/${body.commitment.id}/execute`, secondH, {});
  return {
    id: body.commitment.id,
    sovLineIds: (body.sovLines as Array<{ id: string }>).map((l) => l.id),
  };
}

/* ================================================================== */
/* Pure engines                                                        */
/* ================================================================== */

describe("purchase-order tax (pure)", () => {
  const header = { kind: "purchase_order", taxable: 1, taxPercent: 10, taxAmount: null };

  it("taxes ONLY the taxable lines when any line carries the flag", () => {
    const tax = purchaseOrderTax(header, [
      { taxable: 1, taxPercent: null, revisedScheduledValue: 1000 },
      { taxable: 0, taxPercent: null, revisedScheduledValue: 3000 },
      { taxable: 0, taxPercent: null, revisedScheduledValue: 5000 },
    ]);
    // the header rate applied to the ONE taxable line, not all four
    expect(tax).toBe(100);
  });

  it("prefers the line's own rate over the header rate", () => {
    const tax = purchaseOrderTax(header, [
      { taxable: 1, taxPercent: 20, revisedScheduledValue: 1000 },
      { taxable: 1, taxPercent: null, revisedScheduledValue: 1000 },
    ]);
    expect(tax).toBe(300);
  });

  it("falls back to the header when no line is flagged at all", () => {
    const tax = purchaseOrderTax(header, [
      { taxable: 0, taxPercent: null, revisedScheduledValue: 1000 },
      { taxable: 0, taxPercent: null, revisedScheduledValue: 1000 },
    ]);
    expect(tax).toBe(200);
  });

  it("is null on a subcontract — there is no PO tax to state", () => {
    expect(purchaseOrderTax({ ...header, kind: "subcontract" }, [])).toBeNull();
  });
});

describe("closeout checklist (pure)", () => {
  it("fails while a required item is outstanding and names it", () => {
    const items = defaultCloseoutItems("subcontract").map((i) => ({ ...i, done: false }));
    const result = evaluateCloseout(items);
    expect(result.passes).toBe(false);
    expect(result.outstanding.length).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toContain(result.outstanding[0]!.label);
  });

  it("passes once every required item is done with evidence behind it", () => {
    const items = defaultCloseoutItems("subcontract").map((i) => ({
      ...i,
      done: true,
      evidenceType: "document",
      evidenceId: "doc-1",
    }));
    expect(evaluateCloseout(items).passes).toBe(true);
  });

  it("refuses a tick with no evidence on an item that is not auto-verified", () => {
    const items = defaultCloseoutItems("subcontract").map((i) => ({ ...i, done: true }));
    const manual = items.filter((i) => !i.autoVerified && i.required);
    const result = evaluateCloseout(items);
    if (manual.length > 0) {
      expect(result.passes).toBe(false);
      expect(result.unevidenced.length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* Backcharges (#538)                                                  */
/* ================================================================== */

describe("backcharges", () => {
  let commitmentId: string;
  let backchargeId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Steel erection",
      lines: [{ description: "Erection", budgetLineItemId: budgetLine, scheduledValue: 100000 }],
    });
    commitmentId = c.id;
  });

  it("raises a draft backcharge with its reason code and evidence", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/backcharges`, owner.headers, {
      reasonCode: "cleanup",
      title: "Site cleanup after steel",
      amount: 4000,
      evidence: [{ type: "punch_item", id: "pnc-1", label: "Debris left in bay 3" }],
    });
    expect(res.statusCode).toBe(201);
    backchargeId = res.json().id;
    expect(res.json().status).toBe("draft");
    expect(res.json().reference).toMatch(/^BC-\d{4}$/);
    expect(res.json().currency).toBe("USD");
  });

  it("refuses a backcharge against an unapproved commitment", async () => {
    const draft = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Not approved yet",
      vendorId: vendor,
      sovLines: [{ description: "Anything", scheduledValue: 100 }],
    });
    const res = await inject(
      "POST",
      `/api/v1/commitments/${draft.json().commitment.id}/backcharges`,
      owner.headers,
      { reasonCode: "cleanup", title: "Too early", amount: 10 },
    );
    expect(res.statusCode).toBe(409);
  });

  it("refuses to issue one with no evidence behind it", async () => {
    const created = await inject("POST", `/api/v1/commitments/${commitmentId}/backcharges`, owner.headers, {
      reasonCode: "defective_work",
      title: "Assertion only",
      amount: 500,
    });
    const res = await inject("POST", `/api/v1/backcharges/${created.json().id}/issue`, owner.headers, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("evidence");
    await inject("POST", `/api/v1/backcharges/${created.json().id}/void`, owner.headers, {
      reason: "test cleanup",
    });
  });

  it("issues by raising a NEGATIVE commitment change order, still pending approval", async () => {
    const res = await inject("POST", `/api/v1/backcharges/${backchargeId}/issue`, owner.headers, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().backcharge.status).toBe("issued");
    const changeId = res.json().commitmentChangeId as string;
    const change = await inject("GET", `/api/v1/commitment-changes/${changeId}`, owner.headers);
    expect(change.statusCode).toBe(200);
    expect(change.json().amount).toBe(-4000);
    expect(change.json().status).toBe("pending_in_house_review");
    // the sum has NOT moved yet — a pending change is outside it
    const detail = await inject("GET", `/api/v1/commitments/${commitmentId}`, owner.headers);
    expect(detail.json().commitment.revisedCommitmentSum).toBe(100000);
  });

  it("RESERVES the open backcharge against the next payment", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/payments`, owner.headers, {
      amount: 99_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("reserved for open backcharges");
    expect(res.json().details.reservedForBackcharges).toBe(4000);
    expect(res.json().details.ceiling).toBe(96_000);
  });

  it("lets a payment inside the reserved ceiling through, warning about the reservation", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/payments`, owner.headers, {
      amount: 90_000,
    });
    expect(res.statusCode).toBe(201);
    expect((res.json().warnings as string[]).join(" ")).toContain("backcharges are open");
  });

  it("settles at an agreed lower figure and rewrites the change order with it", async () => {
    const res = await inject("POST", `/api/v1/backcharges/${backchargeId}/dispute`, owner.headers, {
      reason: "Sub says the debris was ours",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("disputed");
    const settled = await inject("POST", `/api/v1/backcharges/${backchargeId}/settle`, owner.headers, {
      agreedAmount: 1500,
      note: "Split the cleanup 60/40",
    });
    expect(settled.statusCode).toBe(200);
    expect(settled.json().amount).toBe(1500);
    const row = (
      await built.app.db.select().from(backcharges).where(eq(backcharges.id, backchargeId)).limit(1)
    )[0]!;
    const change = await inject("GET", `/api/v1/commitment-changes/${row.commitmentChangeId!}`, owner.headers);
    expect(change.json().amount).toBe(-1500);
  });

  it("refuses a settlement above the backcharge raised", async () => {
    const res = await inject("POST", `/api/v1/backcharges/${backchargeId}/settle`, owner.headers, {
      agreedAmount: 9999,
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports the open recovery per currency on the project summary", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/backcharges/summary`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().openCount).toBeGreaterThanOrEqual(1);
    expect(res.json().openByCurrency).toEqual(
      expect.arrayContaining([expect.objectContaining({ currency: "USD" })]),
    );
  });

  it("does not leak a backcharge to another company", async () => {
    const res = await inject("GET", `/api/v1/backcharges/${backchargeId}`, outsider.headers);
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Closeout and final release (#539)                                   */
/* ================================================================== */

describe("closeout and final release", () => {
  let commitmentId: string;
  let sovLineId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Cladding",
      lines: [{ description: "Cladding", scheduledValue: 200000 }],
    });
    commitmentId = c.id;
    sovLineId = c.sovLineIds[0]!;
    // bill it and hold retainage so there is something to release
    await built.app.db
      .update(commitmentSovLines)
      .set({
        previousBilled: 200000,
        totalCompletedAndStored: 200000,
        retainageHeld: 20000,
        percentComplete: 100,
        balanceToFinish: 0,
      })
      .where(eq(commitmentSovLines.id, sovLineId));
    await built.app.db
      .update(commitments)
      .set({ totalInvoiced: 180000, retainageHeld: 20000 })
      .where(eq(commitments.id, commitmentId));
  });

  it("serves the checklist with the platform-verified items already answered", async () => {
    const res = await inject("GET", `/api/v1/commitments/${commitmentId}/closeout`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("open");
    expect(res.json().remainingRetainage).toBe(20000);
    expect(res.json().items.length).toBeGreaterThan(3);
    expect(res.json().items.some((i: { autoVerified: boolean }) => i.autoVerified)).toBe(true);
  });

  it("refuses a tick with nothing behind it", async () => {
    const manual = (
      await inject("GET", `/api/v1/commitments/${commitmentId}/closeout`, owner.headers)
    ).json().items.find((i: { autoVerified: boolean; required: boolean }) => !i.autoVerified && i.required);
    const res = await inject(
      "PUT",
      `/api/v1/commitments/${commitmentId}/closeout/items/${manual.key}`,
      owner.headers,
      { done: true },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("evidenceId");
  });

  it("refuses the final release while the checklist does not pass", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/final-release`, owner.headers, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().details.control).toBe("closeout_checklist");
    expect(res.json().details.outstanding.length).toBeGreaterThan(0);
  });

  it("releases exactly the remaining retainage when the checklist is overridden, with the reason recorded", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/final-release`, owner.headers, {
      overrideReason: "Client instructed release ahead of the O&M manuals",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment.amount).toBe(20000);
    expect(res.json().payment.retainageReleasedAmount).toBe(20000);
    // scheduled, NOT issued — the two-person path still applies
    expect(res.json().payment.status).toBe("scheduled");
    expect(res.json().payment.detail.kind).toBe("final_release");
    expect(res.json().payment.detail.closeoutOverrideReason).toContain("Client instructed");
  });

  it("refuses a second final release while the first stands", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/final-release`, owner.headers, {
      overrideReason: "again",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already exists");
  });

  it("zeroes the retainage held once the final release is approved and issued", async () => {
    const closeout = await inject("GET", `/api/v1/commitments/${commitmentId}/closeout`, owner.headers);
    const paymentId = closeout.json().finalReleasePaymentId as string;
    expect(paymentId).toBeTruthy();
    const approved = await inject("POST", `/api/v1/commitment-payments/${paymentId}/approve`, secondH, {});
    expect(approved.statusCode).toBe(200);
    const issued = await inject("POST", `/api/v1/commitment-payments/${paymentId}/issue`, thirdH, {
      acknowledgeWarnings: true,
    });
    expect(issued.statusCode).toBe(200);
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.retainageHeld).toBe(0);
  });

  it("refuses a second final release once the first has been issued", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/final-release`, owner.headers, {
      overrideReason: "nothing left",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("already exists");
  });

  it("refuses a final release on a commitment holding no retainage at all", async () => {
    const c = await makeCommitment({
      title: "Nothing held",
      lines: [{ description: "Scope", scheduledValue: 1000 }],
    });
    const res = await inject("POST", `/api/v1/commitments/${c.id}/final-release`, owner.headers, {
      overrideReason: "nothing to release",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("No retainage remains");
  });
});

/* ================================================================== */
/* Contract documents and signature routing (#525-527)                 */
/* ================================================================== */

describe("contract documents", () => {
  let commitmentId: string;
  let docId: string;
  let webhookPath: string;

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Roofing package",
      vendorId: vendor,
      defaultRetainagePercent: 5,
      sovLines: [{ description: "Roofing", scheduledValue: 75000 }],
    });
    commitmentId = res.json().commitment.id;
  });

  it("lists the code-resident templates with their merge fields", async () => {
    const res = await inject("GET", "/api/v1/contract-templates", owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((t: { key: string }) => t.key === "subcontract_standard")).toBe(true);
  });

  it("generates a versioned document whose merge data IS the commitment", async () => {
    const res = await inject(
      "POST",
      `/api/v1/commitments/${commitmentId}/documents/generate`,
      owner.headers,
      { templateKey: "subcontract_standard" },
    );
    expect(res.statusCode).toBe(201);
    docId = res.json().id;
    expect(res.json().version).toBe(1);
    expect(res.json().status).toBe("draft");
    expect(res.json().sha256).toBeTruthy();
    expect(res.json().html).toContain("75000");
    // the merge data is the audit trail of what was rendered
    expect(res.json().mergeData.reference).toBeTruthy();
  });

  it("refuses a template that renders a different kind", async () => {
    const res = await inject(
      "POST",
      `/api/v1/commitments/${commitmentId}/documents/generate`,
      owner.headers,
      { templateKey: "purchase_order_standard", kind: "subcontract" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("routes it for signature, moving the commitment out for signature and minting the token once", async () => {
    const res = await inject("POST", `/api/v1/contract-documents/${docId}/route`, owner.headers, {
      signers: [
        { name: "Us Ltd", email: "contracts@us.test", role: "Contractor" },
        { name: "Northgate Steel", email: "signing@northgate.test", role: "Subcontractor" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("out_for_signature");
    expect(res.json().webhookToken).toBeTruthy();
    webhookPath = res.json().webhookPath as string;
    const commitment = await inject("GET", `/api/v1/commitments/${commitmentId}`, owner.headers);
    expect(commitment.json().commitment.status).toBe("out_for_signature");
  });

  it("refuses signature out of order", async () => {
    const res = await inject("POST", `/api/v1/contract-documents/${docId}/sign`, owner.headers, {
      order: 2,
      method: "wet_ink",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("sign in order");
  });

  it("records the first signature by hand and the second through the e-sign webhook, then executes", async () => {
    const first = await inject("POST", `/api/v1/contract-documents/${docId}/sign`, owner.headers, {
      order: 1,
      method: "wet_ink",
      reference: "scan-001",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().complete).toBe(false);

    const hook = await built.app.inject({
      method: "POST",
      url: `/api/v1${webhookPath.replace("/api/v1", "")}`,
      payload: { event: "signed", signerOrder: 2, method: "e_signature", reference: "env-77" },
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json().complete).toBe(true);

    const doc = await inject("GET", `/api/v1/contract-documents/${docId}`, owner.headers);
    expect(doc.json().status).toBe("signed");
    const commitment = await inject("GET", `/api/v1/commitments/${commitmentId}`, owner.headers);
    expect(commitment.json().commitment.executed).toBe(1);
    expect(commitment.json().commitment.signedContractReceivedDate).toBeTruthy();
  });

  it("refuses an unknown webhook token", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/v1/contract-documents/webhook/not-a-real-token-at-all",
      payload: { event: "signed" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("never voids a signed document — it is evidence", async () => {
    const res = await inject("POST", `/api/v1/contract-documents/${docId}/void`, owner.headers, {
      reason: "changed our minds",
    });
    expect(res.statusCode).toBe(409);
  });

  it("does not leak a document to another company", async () => {
    const res = await inject("GET", `/api/v1/contract-documents/${docId}`, outsider.headers);
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Payment runs (#586-594)                                             */
/* ================================================================== */

describe("payment runs", () => {
  let commitmentId: string;
  let payA: string;
  let payB: string;
  let runId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Groundworks",
      lines: [{ description: "Groundworks", scheduledValue: 300000 }],
    });
    commitmentId = c.id;
    for (const amount of [10000, 15000]) {
      const res = await inject("POST", `/api/v1/commitments/${commitmentId}/payments`, owner.headers, {
        amount,
        method: "ach",
      });
      const id = res.json().payment.id as string;
      await inject("POST", `/api/v1/commitment-payments/${id}/approve`, secondH, {});
      if (payA === undefined) payA = id;
      else payB = id;
    }
  });

  it("gathers approved scheduled payments in ONE currency", async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/payment-runs`, owner.headers, {
      name: "Week 12 ACH run",
      scheduledDate: isoDaysFromNow(2),
      currency: "USD",
      paymentIds: [payA, payB],
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().id;
    expect(res.json().paymentCount).toBe(2);
    expect(res.json().totalAmount).toBe(25000);
    expect(res.json().status).toBe("draft");
  });

  it("refuses a payment in another currency joining the run", async () => {
    const eur = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Euro package",
      vendorId: vendor,
      currency: "EUR",
      sovLines: [{ description: "Euro scope", scheduledValue: 5000 }],
    });
    const eurId = eur.json().commitment.id as string;
    await inject("POST", `/api/v1/commitments/${eurId}/approve`, secondH, {});
    const pay = await inject("POST", `/api/v1/commitments/${eurId}/payments`, owner.headers, {
      amount: 1000,
    });
    const res = await inject("POST", `/api/v1/projects/${proj}/payment-runs/${runId}/members`, owner.headers, {
      add: [pay.json().payment.id],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("one currency");
  });

  it("refuses the run's author approving it", async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/payment-runs/${runId}/approve`, owner.headers, {});
    expect(res.statusCode).toBe(403);
  });

  it("issues every member through the same core as a single payment", async () => {
    const approved = await inject(
      "POST",
      `/api/v1/projects/${proj}/payment-runs/${runId}/approve`,
      secondH,
      {},
    );
    expect(approved.statusCode).toBe(200);
    const res = await inject("POST", `/api/v1/projects/${proj}/payment-runs/${runId}/issue`, thirdH, {
      acknowledgeWarnings: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().issued).toHaveLength(2);
    for (const id of [payA, payB]) {
      const row = (
        await built.app.db.select().from(commitmentPayments).where(eq(commitmentPayments.id, id)).limit(1)
      )[0]!;
      expect(row.status).toBe("issued");
      expect(row.issuedBy).toBe(third.userId);
    }
    const position = await inject("GET", `/api/v1/commitments/${commitmentId}`, owner.headers);
    expect(position.json().position.totalPaid).toBe(25000);
  });

  it("produces a remittance advice per payee naming the invoices it settles", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/payment-runs/${runId}/remittances`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
    expect(res.json().items[0].html).toContain("Remittance");
  });

  it("refuses issuing the same run twice", async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/payment-runs/${runId}/issue`, thirdH, {});
    expect(res.statusCode).toBe(409);
  });

  it("does not leak a run to another company", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/payment-runs/${runId}`, outsider.headers);
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Compliance sweep (#532)                                             */
/* ================================================================== */

describe("proactive compliance expiry alerting", () => {
  let commitmentId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Expiring cover package",
      lines: [{ description: "Scope", scheduledValue: 50000 }],
    });
    commitmentId = c.id;
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: isoDaysFromNow(6) })
      .where(eq(insuranceCertificates.id, cert));
  });

  afterAll(async () => {
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: isoDaysFromNow(400) })
      .where(eq(insuranceCertificates.id, cert));
  });

  it("lists the cover about to run out on commitments that still owe money", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/compliance/upcoming?days=30`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ commitmentId: string; line: number; renewalRequest: string; daysUntilExpiry: number }>;
    const mine = items.find((i) => i.commitmentId === commitmentId);
    expect(mine).toBeDefined();
    expect(mine!.daysUntilExpiry).toBeLessThanOrEqual(7);
    expect(mine!.line).toBe(7);
    expect(mine!.renewalRequest).toContain("expires on");
    expect(res.json().byLine.within7).toBeGreaterThanOrEqual(1);
    expect(res.json().note).toContain("has not run");
  });

  it("notifies the project on the first sweep and stays quiet on the second", async () => {
    const before = await built.app.db.select().from(notifications);
    const first = await built.app.scheduler.runNow("commitments.compliance-sweep");
    expect(first.lastError).toBeNull();
    const afterFirst = await built.app.db.select().from(notifications);
    expect(afterFirst.length).toBeGreaterThan(before.length);

    const second = await built.app.scheduler.runNow("commitments.compliance-sweep");
    expect(second.lastError).toBeNull();
    const afterSecond = await built.app.db.select().from(notifications);
    // idempotent: the same certificate on the same line does not notify twice
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  it("records when the sweep last ran", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/compliance/upcoming`,
      owner.headers,
    );
    expect(res.json().lastSweptAt).toBeTruthy();
    expect(res.json().note).toBeNull();
  });

  it("refuses the upcoming register to another company", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/compliance/upcoming`,
      outsider.headers,
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Audit regressions                                                   */
/* ================================================================== */

describe("regression: an approved payment's figures cannot be changed under the approval", () => {
  let paymentId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Approval invalidation",
      lines: [{ description: "Scope", scheduledValue: 100000 }],
    });
    const res = await inject("POST", `/api/v1/commitments/${c.id}/payments`, owner.headers, {
      amount: 100,
      method: "check",
    });
    paymentId = res.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${paymentId}/approve`, secondH, {});
  });

  it("clears the approval when the amount moves, and says so", async () => {
    const res = await inject("PATCH", `/api/v1/commitment-payments/${paymentId}`, owner.headers, {
      amount: 50000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvalInvalidated).toBe(true);
    expect(res.json().approvedBy).toBeNull();
  });

  it("then refuses to issue it — nobody has approved 50,000", async () => {
    const res = await inject("POST", `/api/v1/commitment-payments/${paymentId}/issue`, thirdH, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/approv/i);
  });

  it("leaves the approval alone for a note-only edit", async () => {
    await inject("POST", `/api/v1/commitment-payments/${paymentId}/approve`, secondH, {});
    const res = await inject("PATCH", `/api/v1/commitment-payments/${paymentId}`, owner.headers, {
      notes: "Chased the bank reference",
    });
    expect(res.json().approvalInvalidated).toBe(false);
    expect(res.json().approvedBy).toBe(second.userId);
  });
});

describe("regression: a failed payment returns the retainage it released", () => {
  let commitmentId: string;
  let paymentId: string;

  beforeAll(async () => {
    const c = await makeCommitment({
      title: "Bounced cheque",
      lines: [{ description: "Scope", scheduledValue: 100000 }],
    });
    commitmentId = c.id;
    await built.app.db
      .update(commitmentSovLines)
      .set({
        previousBilled: 100000,
        totalCompletedAndStored: 100000,
        retainageHeld: 10000,
        percentComplete: 100,
        balanceToFinish: 0,
      })
      .where(eq(commitmentSovLines.id, c.sovLineIds[0]!));
    await built.app.db
      .update(commitments)
      .set({ totalInvoiced: 90000, retainageHeld: 10000 })
      .where(eq(commitments.id, commitmentId));

    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/payments`, owner.headers, {
      amount: 5000,
      retainageReleasedAmount: 5000,
    });
    paymentId = res.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${paymentId}/approve`, secondH, {});
    await inject("POST", `/api/v1/commitment-payments/${paymentId}/issue`, thirdH, {
      acknowledgeWarnings: true,
    });
  });

  it("holds 5,000 less retainage once the release is issued", async () => {
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.retainageHeld).toBe(5000);
  });

  it("puts it back when the payment fails", async () => {
    const res = await inject("POST", `/api/v1/commitment-payments/${paymentId}/fail`, owner.headers, {
      reason: "Cheque returned unpaid",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("failed");
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.retainageHeld).toBe(10000);
  });

  it("does not put it back TWICE when the failed payment is then voided", async () => {
    const res = await inject("POST", `/api/v1/commitment-payments/${paymentId}/void`, owner.headers, {
      reason: "Superseded by a re-issue",
    });
    expect(res.statusCode).toBe(200);
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.retainageHeld).toBe(10000);
  });

  it("then permits the legitimate re-release the drift would have blocked", async () => {
    const res = await inject("POST", `/api/v1/commitments/${commitmentId}/payments`, owner.headers, {
      amount: 10000,
      retainageReleasedAmount: 10000,
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("regression: a change order allocation cannot point at a deleted SOV line", () => {
  let commitmentId: string;
  let lineToDelete: string;
  let changeId: string;

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Vanishing line",
      vendorId: vendor,
      sovLines: [
        { description: "Keep", scheduledValue: 60000 },
        { description: "Delete me", scheduledValue: 40000 },
      ],
    });
    commitmentId = res.json().commitment.id;
    lineToDelete = res.json().sovLines[1].id;
    const change = await inject("POST", `/api/v1/commitments/${commitmentId}/changes`, owner.headers, {
      title: "Extra work",
      amount: 5000,
      lines: [{ sovLineId: lineToDelete, description: "Extra work on the deleted line", amount: 5000 }],
    });
    changeId = change.json().id;
  });

  it("REFUSES to delete a schedule line a live change order allocates value to", async () => {
    const res = await inject(
      "DELETE",
      `/api/v1/commitment-sov-lines/${lineToDelete}`,
      owner.headers,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("allocate value to this line");
    expect(res.json().details.changeOrders.length).toBe(1);
  });

  it("and if the line vanishes anyway, REFUSES the approval naming the missing id", async () => {
    /* the belt to the route's braces: the line is removed underneath the change */
    await built.app.db
      .delete(commitmentSovLines)
      .where(eq(commitmentSovLines.id, lineToDelete));
    await inject("POST", `/api/v1/commitments/${commitmentId}/approve`, secondH, {});
    await inject("POST", `/api/v1/commitment-changes/${changeId}/submit`, owner.headers, {});
    const res = await inject("POST", `/api/v1/commitment-changes/${changeId}/approve`, secondH, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no longer exist");
    expect(res.json().details.missingSovLineIds).toContain(lineToDelete);
  });

  it("leaves the change register and the schedule agreeing on the approved change sum", async () => {
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.approvedChangeSum).toBe(0);
  });
});

describe("regression: change-order ids from another project are refused", () => {
  it("refuses a changeOrderPackageId that is not on this project", async () => {
    const c = await makeCommitment({
      title: "Dangling reference",
      lines: [{ description: "Scope", scheduledValue: 10000 }],
    });
    const res = await inject("POST", `/api/v1/commitments/${c.id}/changes`, owner.headers, {
      title: "With a bogus package",
      amount: 100,
      changeOrderPackageId: "cop_not_real",
      lines: [{ sovLineId: null, description: "New scope", amount: 100 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("changeOrderPackageId");
  });

  it("refuses a potentialChangeOrderId that is not on this project", async () => {
    const c = await makeCommitment({
      title: "Dangling PCO reference",
      lines: [{ description: "Scope", scheduledValue: 10000 }],
    });
    const res = await inject("POST", `/api/v1/commitments/${c.id}/changes`, owner.headers, {
      title: "With a bogus PCO",
      amount: 100,
      potentialChangeOrderId: "pco_not_real",
      lines: [{ sovLineId: null, description: "New scope", amount: 100 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("potentialChangeOrderId");
  });
});

describe("regression: pending change orders reach the budget's pending exposure", () => {
  it("puts a priced-but-unapproved CCO into pendingCommitments, not into committedCost", async () => {
    const c = await makeCommitment({
      title: "Pending exposure",
      lines: [{ description: "Scope", budgetLineItemId: budgetLine, scheduledValue: 20000 }],
    });
    const before = (
      await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.id, budgetLine)).limit(1)
    )[0]!;
    const change = await inject("POST", `/api/v1/commitments/${c.id}/changes`, owner.headers, {
      title: "Priced, not yet approved",
      amount: 7000,
      lines: [{ sovLineId: c.sovLineIds[0]!, description: "Priced, not yet approved", amount: 7000 }],
    });
    expect(change.statusCode).toBe(201);
    await inject("POST", `/api/v1/commitment-changes/${change.json().id}/submit`, owner.headers, {});
    await inject("POST", `/api/v1/projects/${proj}/commitments/rollups/sync`, owner.headers, {});
    const after = (
      await built.app.db.select().from(budgetLineItems).where(eq(budgetLineItems.id, budgetLine)).limit(1)
    )[0]!;
    expect(after.pendingCommitments - before.pendingCommitments).toBeCloseTo(7000, 2);
    expect(after.committedCost).toBeCloseTo(before.committedCost, 2);
  });
});

describe("regression: replacing a schedule of values is all or nothing", () => {
  it("leaves the OLD schedule intact when one replacement line is bad", async () => {
    const res = await inject("POST", `/api/v1/projects/${proj}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Atomic replacement",
      vendorId: vendor,
      sovLines: [{ description: "Original", scheduledValue: 12345 }],
    });
    const id = res.json().commitment.id as string;
    const replace = await inject("PUT", `/api/v1/commitments/${id}/sov`, owner.headers, {
      lines: [
        { description: "Good", scheduledValue: 1000 },
        { description: "Bad budget binding", scheduledValue: 2000, budgetLineItemId: "bli_not_real" },
      ],
    });
    expect(replace.statusCode).toBeGreaterThanOrEqual(400);
    const sov = await inject("GET", `/api/v1/commitments/${id}/sov`, owner.headers);
    expect(sov.json().lines).toHaveLength(1);
    expect(sov.json().lines[0].description).toBe("Original");
    expect(sov.json().identity.reconciles).toBe(true);
  });
});
