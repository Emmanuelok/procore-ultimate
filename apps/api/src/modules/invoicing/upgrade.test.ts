/**
 * WP-FIN2 — invoicing upgrade coverage.
 *
 *   register service            ONE owner of every commitment_payments
 *   (register.ts)               transition, so the invoicing route and the
 *                               commitments route cannot disagree
 *   line-level approval (#573)  certify a line at less than billed, with a note
 *   compliance gate (#575/#590) expired cover stops the invoice pay route too
 *   vendor portal (#567-568)    token identity, self-service invoice, waiver
 *                               signature, RFQ response
 *   ERP export (#582)           one currency per batch, or a stated refusal
 *
 *   regressions                 payments.ts:569 double payment
 *                               payments.ts:311 approver may not also pay
 *                               invoices.ts:326 approved-as-noted shortfall
 *                               reports.ts:78   outstanding uses the certified
 *                                               figure
 *                               retainage.ts:319 cross-project release
 *                               retainage.ts:704 unvalidated waiver id
 *                               retainage.ts:795 accumulating release column
 *                               waivers.ts:648  excusing a waiver is admin+SoD
 *                               waivers.ts:148  the waiver must COVER the payment
 *                               invoices.ts:853 unpaidOnly paging
 *                               periods.ts:199  live invoice count
 *                               invoices.ts:1332 submission window
 *
 * Each block bills its OWN commitment: the module allows one open invoice per
 * contract, which is a control, not an accident.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  commitmentSovLines,
  commitments,
  companyMemberships,
  insuranceCertificates,
  invoices,
  lienWaivers,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { certifiedOf, outstandingOf } from "./shared.js";

let built: BuiltApp;
let owner: TestActor; // company owner — approves (bypasses tool gates)
let biller: TestActor; // raises and submits
let clerk: TestActor; // reviews and pays
let outsider: TestActor;

let billerH: Record<string, string>;
let clerkH: Record<string, string>;

let projA: string;
let projB: string; // the project the cross-project release must not touch
let vendorSub: string;
let cert: string;
let budgetId: string;
let budgetLine: string;

let commOther: string; // on projB, with retainage held
let commOtherL1: string;

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

let commitmentSeq = 0;

/**
 * A fresh executed subcontract with two schedule lines, so each block bills
 * against its own contract without tripping the one-open-invoice rule.
 */
async function makeCommitment(opts: {
  projectId?: string;
  strictness?: "off" | "warn" | "block";
  requiresLienWaiver?: boolean;
  billed?: number; // pre-bill line 01 and hold 10% retainage against it
} = {}): Promise<{ id: string; line1: string; line2: string }> {
  commitmentSeq += 1;
  const id = newId("cmt");
  const projectId = opts.projectId ?? projA;
  await built.app.db.insert(commitments).values({
    id,
    companyId: owner.companyId,
    projectId,
    kind: "subcontract",
    number: 100 + commitmentSeq,
    reference: `SC-${String(100 + commitmentSeq).padStart(4, "0")}`,
    title: `Package ${commitmentSeq}`,
    vendorId: vendorSub,
    status: "approved",
    executed: 1,
    currency: "USD",
    originalCommitmentSum: 200000,
    revisedCommitmentSum: 200000,
    defaultRetainagePercent: 10,
    requiresLienWaiver: opts.requiresLienWaiver ? 1 : 0,
    complianceDetail: {
      strictness: opts.strictness ?? "warn",
      requiredPolicyTypes: ["employers_liability"],
    },
    ...(opts.billed ? { retainageHeld: Math.round(opts.billed * 0.1 * 100) / 100 } : {}),
    createdBy: owner.userId,
  });
  const line1 = newId("csl");
  const line2 = newId("csl");
  await built.app.db.insert(commitmentSovLines).values([
    {
      id: line1,
      companyId: owner.companyId,
      projectId,
      commitmentId: id,
      lineNumber: "01",
      sortOrder: 1,
      costCode: "05-500",
      costType: "subcontract",
      budgetLineItemId: projectId === projA ? budgetLine : null,
      description: "Fabrication",
      scheduledValue: 150000,
      revisedScheduledValue: 150000,
      retainagePercent: 10,
      ...(opts.billed
        ? {
            previousBilled: opts.billed,
            totalCompletedAndStored: opts.billed,
            retainageHeld: Math.round(opts.billed * 0.1 * 100) / 100,
            balanceToFinish: 150000 - opts.billed,
          }
        : {}),
    },
    {
      id: line2,
      companyId: owner.companyId,
      projectId,
      commitmentId: id,
      lineNumber: "02",
      sortOrder: 2,
      costCode: "05-510",
      costType: "material",
      budgetLineItemId: projectId === projA ? budgetLine : null,
      description: "Erection",
      scheduledValue: 50000,
      revisedScheduledValue: 50000,
      retainagePercent: 10,
    },
  ]);
  return { id, line1, line2 };
}

/** A submitted subcontractor invoice for `amount` billed on one schedule line. */
async function submittedInvoice(
  commitmentId: string,
  amount: number,
  lineNumber = "01",
): Promise<string> {
  const created = await inject("POST", `/api/v1/projects/${projA}/invoices`, billerH, {
    kind: "subcontractor_invoice",
    commitmentId,
  });
  if (created.statusCode !== 201) throw new Error(`invoice create failed: ${created.body}`);
  const id = created.json().id as string;
  const put = await inject("PUT", `/api/v1/invoices/${id}/lines`, billerH, {
    lines: [{ lineNumber, thisPeriodWork: amount }],
  });
  if (put.statusCode !== 200) throw new Error(`lines failed: ${put.body}`);
  const submit = await inject("POST", `/api/v1/invoices/${id}/submit`, billerH, {});
  if (submit.statusCode !== 200) throw new Error(`submit failed: ${submit.body}`);
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
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

  projA = newId("prj");
  projB = newId("prj");
  await built.app.db.insert(projects).values([
    { id: projA, companyId: owner.companyId, name: "FIN2 invoicing A" },
    { id: projB, companyId: owner.companyId, name: "FIN2 invoicing B" },
  ]);
  for (const u of [biller, clerk]) {
    /* deliberately NOT members of projB — the cross-project release must fail */
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: projA,
      userId: u.userId,
      templateKey: "project_admin",
      overrides: {},
    });
  }

  vendorSub = newId("ven");
  await built.app.db.insert(vendors).values({
    id: vendorSub,
    companyId: owner.companyId,
    name: "Ironbridge Steel Ltd",
    email: "ar@ironbridge.test",
  });
  cert = newId("cert");
  await built.app.db.insert(insuranceCertificates).values({
    id: cert,
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

  budgetId = newId("bud");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: projA,
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
    projectId: projA,
    costCode: "05-500",
    costType: "subcontract",
    description: "Structural steel",
    originalBudget: 900000,
    revisedBudget: 900000,
    createdBy: owner.userId,
  });

  const other = await makeCommitment({ projectId: projB, billed: 80000 });
  commOther = other.id;
  commOtherL1 = other.line1;
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Pure: certified vs applied-for                                      */
/* ================================================================== */

describe("certified and outstanding (pure)", () => {
  it("certifies what was applied for when nothing was cut", () => {
    expect(certifiedOf({ detail: {}, currentPaymentDue: 10000 })).toBe(10000);
  });

  it("honours an approved-as-noted reduction", () => {
    expect(certifiedOf({ detail: { approvedAmount: 8000 }, currentPaymentDue: 10000 })).toBe(8000);
  });

  it("never certifies MORE than was applied for, whatever the detail says", () => {
    expect(certifiedOf({ detail: { approvedAmount: 99999 }, currentPaymentDue: 10000 })).toBe(10000);
  });

  it("reports outstanding against the certified figure, never below zero", () => {
    expect(
      outstandingOf({ detail: { approvedAmount: 8000 }, currentPaymentDue: 10000, amountPaid: 8000 }),
    ).toBe(0);
    expect(outstandingOf({ detail: {}, currentPaymentDue: 10000, amountPaid: 3000 })).toBe(7000);
    expect(outstandingOf({ detail: {}, currentPaymentDue: 10000, amountPaid: 12000 })).toBe(0);
  });
});

/* ================================================================== */
/* Line-level approval (#573) and the approved-as-noted shortfall      */
/* ================================================================== */

describe("line-level approval", () => {
  let commId: string;
  let invId: string;
  let lineId: string;

  beforeAll(async () => {
    const c = await makeCommitment();
    commId = c.id;
    invId = await submittedInvoice(commId, 20000);
    const detail = await inject("GET", `/api/v1/invoices/${invId}`, owner.headers);
    lineId = (detail.json().lines as Array<{ id: string; lineNumber: string }>).find(
      (l) => l.lineNumber === "01",
    )!.id;
  });

  it("refuses the submitter reviewing their own lines", async () => {
    const res = await inject("PUT", `/api/v1/invoices/${invId}/line-approvals`, billerH, {
      decisions: [{ lineId, status: "approved" }],
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a reduction with no note behind it", async () => {
    const res = await inject("PUT", `/api/v1/invoices/${invId}/line-approvals`, owner.headers, {
      decisions: [{ lineId, status: "reduced", approvedAmount: 15000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("note");
  });

  it("refuses certifying MORE than was billed on the line", async () => {
    const res = await inject("PUT", `/api/v1/invoices/${invId}/line-approvals`, owner.headers, {
      decisions: [{ lineId, status: "reduced", approvedAmount: 30000, note: "generous" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("never more");
  });

  it("certifies the line at less than billed and moves the invoice under review", async () => {
    const res = await inject("PUT", `/api/v1/invoices/${invId}/line-approvals`, owner.headers, {
      decisions: [
        { lineId, status: "reduced", approvedAmount: 15000, note: "Erection not complete at cut-off" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().certified).toBeCloseTo(15000, 2);
    // the line bills 18,000 net of 10% retainage; certifying 15,000 is a 3,000 cut
    expect(res.json().reduction).toBeCloseTo(3000, 2);
    const inv = await inject("GET", `/api/v1/invoices/${invId}`, owner.headers);
    expect(inv.json().status).toBe("under_review");
  });

  it("carries the line decisions through to the invoice's certified amount", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/approve`, owner.headers, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved_as_noted");
    expect(res.json().certified).toBeCloseTo(15000, 2);
    expect(res.json().detail.lineCertified).toBeCloseTo(15000, 2);
  });

  it("freezes the decisions once the invoice is approved", async () => {
    const res = await inject("PUT", `/api/v1/invoices/${invId}/line-approvals`, owner.headers, {
      decisions: [{ lineId, status: "approved" }],
    });
    expect(res.statusCode).toBe(409);
  });

  it("reports outstanding against the CERTIFIED figure, not what was applied for", async () => {
    const detail = await inject("GET", `/api/v1/invoices/${invId}`, owner.headers);
    // applied for 18,000 net of retainage; certified 15,000; the 3,000 is still billable
    expect(detail.json().currentPaymentDue).toBeCloseTo(18000, 2);
    expect(detail.json().certified).toBeCloseTo(15000, 2);
    expect(detail.json().outstanding).toBeCloseTo(15000, 2);
  });

  it("drops off the aging report once the CERTIFIED figure is paid", async () => {
    const pay = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 15000,
      method: "ach",
    });
    expect(pay.statusCode).toBe(201);
    expect(pay.json().invoice.status).toBe("paid");
    const aging = await inject("GET", `/api/v1/projects/${projA}/invoicing/aging`, owner.headers);
    const refs = (aging.json().payable.byCurrency as Array<{ vendors: Array<{ invoices: Array<{ invoiceId: string }> }> }>)
      .flatMap((c) => c.vendors)
      .flatMap((v) => v.invoices)
      .map((i) => i.invoiceId);
    expect(refs).not.toContain(invId);
  });

  it("bills the shortfall again on the next application rather than losing it", async () => {
    const next = await inject("POST", `/api/v1/projects/${projA}/invoices`, billerH, {
      kind: "subcontractor_invoice",
      commitmentId: commId,
    });
    expect(next.statusCode).toBe(201);
    // 15,000 certified, so "less previous certificates" is 15,000 — not 20,000
    expect(next.json().previousPaymentsAmount).toBeCloseTo(15000, 2);
    await inject("POST", `/api/v1/invoices/${next.json().id}/void`, billerH, {
      reason: "test scaffolding",
    });
  });
});

/* ================================================================== */
/* Segregation and the compliance gate on the pay route                */
/* ================================================================== */

describe("the invoice pay route enforces the register's controls", () => {
  let commId: string;
  let invId: string;

  beforeAll(async () => {
    const c = await makeCommitment({ strictness: "block" });
    commId = c.id;
    invId = await submittedInvoice(commId, 10000);
    await inject("POST", `/api/v1/invoices/${invId}/review`, clerkH, {});
    await inject("POST", `/api/v1/invoices/${invId}/approve`, owner.headers, {});
  });

  it("refuses the APPROVER also paying it", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, owner.headers, {
      amount: 9000,
      method: "ach",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.role).toBe("approved_by");
  });

  it("REFUSES payment while the vendor's cover has lapsed and strictness blocks", async () => {
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: isoDaysFromNow(-3) })
      .where(eq(insuranceCertificates.id, cert));
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 9000,
      method: "ach",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().details.control).toBe("compliance_gate");
    expect(res.json().details.blocking[0].code).toBe("certificate_expired");
  });

  it("pays once cover is reinstated, recording the compliance position on the payment", async () => {
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: isoDaysFromNow(400) })
      .where(eq(insuranceCertificates.id, cert));
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 9000,
      method: "ach",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment.status).toBe("issued");
    expect(res.json().payment.detail.complianceAtIssue.status).toBeTruthy();
  });
});

/* ================================================================== */
/* The register service: one owner of every payment transition         */
/* ================================================================== */

describe("regression: an invoice cannot be paid twice through two registers", () => {
  let invId: string;
  let paymentId: string;

  beforeAll(async () => {
    const c = await makeCommitment({ requiresLienWaiver: true });
    invId = await submittedInvoice(c.id, 12000);
    await inject("POST", `/api/v1/invoices/${invId}/review`, clerkH, {});
    await inject("POST", `/api/v1/invoices/${invId}/approve`, owner.headers, {});
    const held = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 10800, // 12,000 billed less 10% retainage
      method: "check",
      overrideMissingWaiver: true,
      overrideReason: "Directed pending the signed waiver",
    });
    if (held.statusCode !== 201) throw new Error(`hold failed: ${held.body}`);
    paymentId = held.json().payment.id;
  });

  it("records the override ON HOLD, with nothing paid", async () => {
    const inv = (await built.app.db.select().from(invoices).where(eq(invoices.id, invId)).limit(1))[0]!;
    expect(inv.amountPaid).toBe(0);
  });

  it("refuses to release the hold while the waiver that caused it is still missing", async () => {
    const res = await inject(
      "POST",
      `/api/v1/commitment-payments/${paymentId}/release`,
      owner.headers,
      { reason: "Just let it go" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().details.control).toBe("lien_waiver_required");
  });

  it("settles the invoice when the held payment is issued through the COMMITMENTS routes", async () => {
    /* the waiver arrives and is verified — only then does the hold lift */
    const w = await inject("POST", `/api/v1/projects/${projA}/lien-waivers`, billerH, {
      waiverType: "conditional_progress",
      invoiceId: invId,
      throughDate: isoDaysFromNow(30),
      amount: 10800,
    });
    expect(w.statusCode).toBe(201);
    await built.app.db
      .update(lienWaivers)
      .set({ status: "verified", verifiedAt: new Date().toISOString() })
      .where(eq(lienWaivers.id, w.json().id));

    const released = await inject(
      "POST",
      `/api/v1/commitment-payments/${paymentId}/release`,
      owner.headers,
      { reason: "Waiver received" },
    );
    expect(released.statusCode).toBe(200);
    const approved = await inject("POST", `/api/v1/commitment-payments/${paymentId}/approve`, billerH, {});
    expect(approved.statusCode).toBe(200);
    const issued = await inject("POST", `/api/v1/commitment-payments/${paymentId}/issue`, clerkH, {
      acknowledgeWarnings: true,
    });
    expect(issued.statusCode).toBe(200);

    const inv = (await built.app.db.select().from(invoices).where(eq(invoices.id, invId)).limit(1))[0]!;
    expect(inv.amountPaid).toBeCloseTo(10800, 2);
    expect(inv.status).toBe("paid");
  });

  it("then REFUSES a second payment through the invoicing route", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 10800,
      method: "ach",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("reverses the invoice when the payment is voided through the commitments route", async () => {
    const res = await inject("POST", `/api/v1/commitment-payments/${paymentId}/void`, owner.headers, {
      reason: "Bank rejected the file",
    });
    expect(res.statusCode).toBe(200);
    const inv = (await built.app.db.select().from(invoices).where(eq(invoices.id, invId)).limit(1))[0]!;
    expect(inv.amountPaid).toBe(0);
    expect(inv.status).not.toBe("paid");
  });
});

/* ================================================================== */
/* Lien waivers: the gate must actually cover the payment              */
/* ================================================================== */

describe("regression: a waiver must cover the payment it unblocks", () => {
  let invId: string;
  let waiverId: string;

  beforeAll(async () => {
    const c = await makeCommitment({ requiresLienWaiver: true });
    invId = await submittedInvoice(c.id, 30000);
    await inject("POST", `/api/v1/invoices/${invId}/review`, clerkH, {});
    await inject("POST", `/api/v1/invoices/${invId}/approve`, owner.headers, {});
    const w = await inject("POST", `/api/v1/projects/${projA}/lien-waivers`, billerH, {
      waiverType: "conditional_progress",
      invoiceId: invId,
      throughDate: isoDaysFromNow(30),
      amount: 1,
    });
    if (w.statusCode !== 201) throw new Error(`waiver create failed: ${w.body}`);
    waiverId = w.json().id;
    await built.app.db
      .update(lienWaivers)
      .set({ status: "verified", verifiedAt: new Date().toISOString() })
      .where(eq(lienWaivers.id, waiverId));
  });

  it("does NOT let a token 1.00 waiver through a 27,000 payment", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 27000,
      method: "ach",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().details.control).toBe("lien_waiver_required");
    expect(res.json().message).toContain("none covers this payment");
  });

  it("does not let a waiver in another currency through either", async () => {
    await built.app.db
      .update(lienWaivers)
      .set({ amount: 27000, currency: "EUR" })
      .where(eq(lienWaivers.id, waiverId));
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 27000,
      method: "ach",
    });
    expect(res.statusCode).toBe(409);
  });

  it("does not let a waiver that stops short of the billing period through", async () => {
    await built.app.db
      .update(lienWaivers)
      .set({ currency: "USD", throughDate: "2000-01-01" })
      .where(eq(lienWaivers.id, waiverId));
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 27000,
      method: "ach",
    });
    expect(res.statusCode).toBe(409);
  });

  it("lets it through once the waiver covers the amount, the period and the currency", async () => {
    await built.app.db
      .update(lienWaivers)
      .set({ throughDate: isoDaysFromNow(30) })
      .where(eq(lienWaivers.id, waiverId));
    const res = await inject("POST", `/api/v1/invoices/${invId}/payments`, clerkH, {
      amount: 27000,
      method: "ach",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment.status).toBe("issued");
  });
});

describe("regression: excusing a waiver is an admin act by an independent party", () => {
  let invId: string;
  let waiverId: string;

  beforeAll(async () => {
    const c = await makeCommitment({ requiresLienWaiver: true });
    invId = await submittedInvoice(c.id, 5000);
    await inject("POST", `/api/v1/invoices/${invId}/review`, clerkH, {});
    await inject("POST", `/api/v1/invoices/${invId}/approve`, owner.headers, {});
    const w = await inject("POST", `/api/v1/projects/${projA}/lien-waivers`, billerH, {
      waiverType: "conditional_progress",
      invoiceId: invId,
      throughDate: isoDaysFromNow(30),
    });
    waiverId = w.json().id;
  });

  it("refuses the person who raised the invoice excusing its waiver", async () => {
    const res = await inject("POST", `/api/v1/lien-waivers/${waiverId}/not-required`, billerH, {
      reason: "We do not need one",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("records who excused it when a third party does it", async () => {
    const res = await inject("POST", `/api/v1/lien-waivers/${waiverId}/not-required`, owner.headers, {
      reason: "Statutory waiver not applicable in this jurisdiction",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("not_required");
    expect(res.json().detail.notRequiredBy).toBe(owner.userId);
  });

  it("surfaces the exemption as its own bucket on the outstanding report", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/lien-waivers/outstanding`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const excused = (res.json().excused ?? []) as Array<{ excusedBy: string | null; invoiceId: string }>;
    expect(excused.some((e) => e.invoiceId === invId && e.excusedBy === owner.userId)).toBe(true);
  });

  it("refuses excusing a waiver that has already been signed — the chain is past that point", async () => {
    const w = await inject("POST", `/api/v1/projects/${projA}/lien-waivers`, billerH, {
      waiverType: "conditional_progress",
      invoiceId: invId,
      throughDate: isoDaysFromNow(30),
    });
    const id = w.json().id as string;
    await inject("POST", `/api/v1/lien-waivers/${id}/request`, billerH, {});
    await inject("POST", `/api/v1/lien-waivers/${id}/send`, billerH, {});
    await inject("POST", `/api/v1/lien-waivers/${id}/sign`, billerH, {
      signedByName: "A Signer",
      signatureMethod: "wet_ink",
    });
    const res = await inject("POST", `/api/v1/lien-waivers/${id}/not-required`, owner.headers, {
      reason: "too late",
    });
    expect(res.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* Retainage releases                                                  */
/* ================================================================== */

describe("retainage releases", () => {
  let commId: string;
  let line1: string;
  let line2: string;

  beforeAll(async () => {
    const c = await makeCommitment({ billed: 150000 });
    commId = c.id;
    line1 = c.line1;
    line2 = c.line2;
  });

  it("REFUSES a release raised on project A against a commitment on project B", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/retainage-releases`, billerH, {
      scope: "commitment",
      commitmentId: commOther,
      amount: 1000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/project/i);
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commOther)).limit(1)
    )[0]!;
    expect(row.retainageHeld).toBe(8000);
    const line = (
      await built.app.db
        .select()
        .from(commitmentSovLines)
        .where(eq(commitmentSovLines.id, commOtherL1))
        .limit(1)
    )[0]!;
    expect(line.retainageHeld).toBe(8000);
  });

  it("refuses a lienWaiverId that belongs to a different commitment", async () => {
    const foreign = await built.app.db
      .select({ id: lienWaivers.id })
      .from(lienWaivers)
      .where(eq(lienWaivers.projectId, projA))
      .limit(1);
    const res = await inject("POST", `/api/v1/projects/${projA}/retainage-releases`, billerH, {
      scope: "commitment",
      commitmentId: commId,
      amount: 1000,
      lienWaiverId: foreign[0]?.id ?? "lw_not_real",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("lienWaiverId");
  });

  it("refuses to RELEASE an explicit allocation against a line that holds nothing", async () => {
    const draft = await inject("POST", `/api/v1/projects/${projA}/retainage-releases`, billerH, {
      scope: "commitment",
      commitmentId: commId,
      amount: 5000,
      lines: [
        { sovLineId: line1, amount: 2000 },
        { sovLineId: line2, amount: 3000 }, // line 02 holds no retainage
      ],
    });
    expect(draft.statusCode).toBe(201);
    const id = draft.json().id as string;
    await inject("POST", `/api/v1/retainage-releases/${id}/submit`, billerH, {});
    await inject("POST", `/api/v1/retainage-releases/${id}/approve`, owner.headers, {});
    const res = await inject("POST", `/api/v1/retainage-releases/${id}/release`, owner.headers, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("no longer fits the retainage held");
    // and nothing moved: line 02 never went negative
    const rows = await built.app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.id, line2));
    expect(rows[0]!.retainageHeld).toBe(0);
  });

  it("accumulates a second release onto the invoice rather than replacing the first", async () => {
    const invId = await submittedInvoice(commId, 1000, "02");
    const runRelease = async (amount: number): Promise<void> => {
      const draft = await inject("POST", `/api/v1/projects/${projA}/retainage-releases`, billerH, {
        scope: "commitment",
        commitmentId: commId,
        amount,
        invoiceId: invId,
      });
      if (draft.statusCode !== 201) throw new Error(`release draft failed: ${draft.body}`);
      const id = draft.json().id as string;
      const submitted = await inject("POST", `/api/v1/retainage-releases/${id}/submit`, billerH, {});
      if (submitted.statusCode !== 200) throw new Error(`submit failed: ${submitted.body}`);
      const approved = await inject("POST", `/api/v1/retainage-releases/${id}/approve`, owner.headers, {});
      if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
      const released = await inject("POST", `/api/v1/retainage-releases/${id}/release`, owner.headers, {});
      if (released.statusCode !== 200) throw new Error(`release failed: ${released.body}`);
    };
    await runRelease(3000);
    await runRelease(2000);
    const inv = (await built.app.db.select().from(invoices).where(eq(invoices.id, invId)).limit(1))[0]!;
    expect(inv.retainageReleased).toBeCloseTo(5000, 2);
  });

  it("serves the project retainage summary receivable and payable, never netted", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/retainage-summary`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().payable).toBeDefined();
    expect(res.json().receivable).toBeDefined();
  });
});

/* ================================================================== */
/* Paging, period rollups and the submission window                    */
/* ================================================================== */

describe("regression: unpaidOnly agrees with its own total", () => {
  it("filters in the WHERE clause so total and page cannot disagree", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/invoices?unpaidOnly=true&pageSize=1&page=1`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (body.total > 0) expect(body.items.length).toBe(1);
    for (const item of body.items as Array<{ outstanding: number }>) {
      expect(item.outstanding).toBeGreaterThan(0);
    }
  });
});

describe("regression: period rollups count the same invoices in both places", () => {
  it("reports invoiceCount over the live rows the money columns use", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/billing-periods`, owner.headers, {
      name: "Rollup period",
      startDate: "2027-01-01",
      endDate: "2027-01-31",
    });
    expect(created.statusCode).toBe(201);
    const periodId = created.json().id as string;
    const c = await makeCommitment();
    const draft = await inject("POST", `/api/v1/projects/${projA}/invoices`, billerH, {
      kind: "subcontractor_invoice",
      commitmentId: c.id,
      billingPeriodId: periodId,
    });
    expect(draft.statusCode).toBe(201);
    const recalc = await inject(
      "POST",
      `/api/v1/billing-periods/${periodId}/recalculate`,
      owner.headers,
      {},
    );
    expect(recalc.statusCode).toBe(200);
    const currencyCounts = ((recalc.json().detail?.currencies ?? []) as Array<{ invoiceCount: number }>).reduce(
      (s, x) => s + x.invoiceCount,
      0,
    );
    // one DRAFT invoice: excluded from both the money columns and the count
    expect(recalc.json().invoiceCount).toBe(currencyCounts);
    expect(recalc.json().invoiceCount).toBe(0);
  });
});

describe("regression: the subcontractor submission window is enforced", () => {
  let invId: string;

  beforeAll(async () => {
    const period = await inject("POST", `/api/v1/projects/${projA}/billing-periods`, owner.headers, {
      name: "Window period",
      startDate: "2027-03-01",
      endDate: "2027-03-31",
      subcontractorSubmitStart: "2027-03-20",
      subcontractorSubmitEnd: "2027-03-25",
    });
    if (period.statusCode !== 201) throw new Error(`period create failed: ${period.body}`);
    const c = await makeCommitment();
    const created = await inject("POST", `/api/v1/projects/${projA}/invoices`, billerH, {
      kind: "subcontractor_invoice",
      commitmentId: c.id,
      billingPeriodId: period.json().id,
    });
    invId = created.json().id;
    await inject("PUT", `/api/v1/invoices/${invId}/lines`, billerH, {
      lines: [{ lineNumber: "01", thisPeriodWork: 100 }],
    });
  });

  it("refuses a subcontractor invoice submitted outside the period's window", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/submit`, billerH, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().details.control).toBe("submission_window");
    expect(res.json().details.subcontractorSubmitEnd).toBe("2027-03-25");
  });

  it("permits it with a recorded override reason from an invoicing admin", async () => {
    const res = await inject("POST", `/api/v1/invoices/${invId}/submit`, owner.headers, {
      windowOverrideReason: "Period reopened by agreement with the QS",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("submitted");
  });
});

/* ================================================================== */
/* Vendor portal (#567-568)                                            */
/* ================================================================== */

describe("vendor self-service portal", () => {
  let token: string;
  let tokenId: string;
  let portalComm: string;
  let portalLine2: string;
  let portalInvoiceId: string;

  beforeAll(async () => {
    const c = await makeCommitment();
    portalComm = c.id;
    portalLine2 = c.line2;
  });

  it("mints a scoped token, shown once", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/vendor-portal/tokens`, owner.headers, {
      vendorId: vendorSub,
      label: "Ironbridge AR",
      scopes: ["invoices", "rfqs"],
    });
    expect(res.statusCode).toBe(201);
    token = res.json().token;
    tokenId = res.json().id;
    expect(token).toMatch(/^vp_/);
    expect(res.json().active).toBe(true);
  });

  it("refuses a token for a vendor outside the company", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/vendor-portal/tokens`, owner.headers, {
      vendorId: "ven_not_real",
      label: "Nope",
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves the vendor only their own project's commitments", async () => {
    const res = await built.app.inject({ method: "GET", url: `/api/v1/vendor-portal/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vendor.id).toBe(vendorSub);
    expect(body.commitments.some((c: { id: string }) => c.id === portalComm)).toBe(true);
    // projB's commitment is the same vendor but a different project — never served
    expect(body.commitments.every((c: { id: string }) => c.id !== commOther)).toBe(true);
  });

  it("rejects a bogus token with 401, never a leak", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/vendor-portal/vp_definitely_not_a_real_token",
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a scope the token was not granted", async () => {
    const limited = await inject(
      "POST",
      `/api/v1/projects/${projA}/vendor-portal/tokens`,
      owner.headers,
      { vendorId: vendorSub, label: "Invoices only", scopes: ["invoices"] },
    );
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/vendor-portal/${limited.json().token}/quote-requests`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets the vendor raise their own progress invoice against their schedule", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/vendor-portal/${token}/invoices`,
      payload: {
        commitmentId: portalComm,
        invoiceNumber: "IBS-9001",
        lines: [{ sovLineId: portalLine2, thisPeriodWork: 5000 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().invoice.status).toBe("submitted");
    expect(res.json().invoice.reference).toMatch(/^INV-/);
    expect(res.json().lines.length).toBeGreaterThan(0);
    portalInvoiceId = res.json().invoice.id;
    const stored = (
      await built.app.db.select().from(invoices).where(eq(invoices.id, portalInvoiceId)).limit(1)
    )[0]!;
    expect(stored.invoiceNumber).toBe("IBS-9001");
    expect((stored.detail as Record<string, unknown>)["source"]).toBe("vendor_portal");
  });

  it("refuses a schedule line that is not on the vendor's own commitment", async () => {
    /* the one-open-invoice rule bites first, so clear the invoice just raised */
    await inject("POST", `/api/v1/invoices/${portalInvoiceId}/void`, owner.headers, {
      reason: "test scaffolding",
    });
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/vendor-portal/${token}/invoices`,
      payload: { commitmentId: portalComm, lines: [{ sovLineId: commOtherL1, thisPeriodWork: 100 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stops working the moment the token is revoked", async () => {
    const revoke = await inject(
      "POST",
      `/api/v1/projects/${projA}/vendor-portal/tokens/${tokenId}/revoke`,
      owner.headers,
      {},
    );
    expect(revoke.statusCode).toBe(200);
    const res = await built.app.inject({ method: "GET", url: `/api/v1/vendor-portal/${token}` });
    expect(res.statusCode).toBe(401);
  });
});

/* ================================================================== */
/* ERP export (#582)                                                   */
/* ================================================================== */

describe("ERP export", () => {
  it("exports one currency of invoices with their lines and payments", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/invoicing/erp-export?currency=USD`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe("USD");
    expect(res.json().invoices.length).toBeGreaterThan(0);
    expect(res.json().invoices[0].vendorName).toBe("Ironbridge Steel Ltd");
  });

  it("emits CSV when asked for it", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/invoicing/erp-export?currency=USD&output=csv`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("csv");
    expect(res.body).toContain("invoice_reference");
    expect(res.body.split("\n")[0]).toContain("# invoices");
  });

  it("says there is nothing to export rather than inventing an empty batch", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/invoicing/erp-export?from=1900-01-01&to=1900-12-31`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBeNull();
    expect(res.json().reasons[0]).toContain("nothing to export");
  });

  it("refuses the export to another company", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/invoicing/erp-export`,
      outsider.headers,
    );
    expect(res.statusCode).toBe(403);
  });
});
