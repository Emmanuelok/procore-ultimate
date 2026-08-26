import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  bonds,
  commitmentSovLines,
  commitments,
  companyMemberships,
  contacts,
  insuranceCertificates,
  ledgerEntries,
  primeContracts,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  assertAllocationSums,
  computeCommitmentTotals,
  deriveSovLine,
  resolveScheduledValue,
} from "./arithmetic.js";
import { evaluateCompliance, DEFAULT_REQUIREMENTS } from "./compliance.js";

let built: BuiltApp;
let owner: TestActor; // company owner — creates commitments
let approver: TestActor; // project_admin — approves
let issuer: TestActor; // project_admin — cuts payments
let reader: TestActor; // read_only — must be refused every write
let outsider: TestActor; // different company entirely

let approverH: Record<string, string>;
let issuerH: Record<string, string>;
let readerH: Record<string, string>;

let projA: string; // subcontract lifecycle, SOV, change orders, budget rollups
let projB: string; // compliance + payments
let projC: string; // currency, permissions, empty-budget honesty

let vendorA: string;
let vendorB: string;
let contactA: string;
let primeA: string;
let budgetA: string;
let budgetLine1: string; // 03-300 subcontract, revised 120000
let budgetLine2: string; // 03-310 subcontract, revised 60000
let budgetLine3: string; // 05-100 subcontract, revised 40000 — never bought
let certB: string; // employers_liability certificate for vendorB

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  approver = await registerActor(built.app);
  issuer = await registerActor(built.app);
  reader = await registerActor(built.app);
  outsider = await registerActor(built.app);

  for (const actor of [approver, issuer, reader]) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: actor.userId,
      role: "member",
    });
  }
  const headersFor = (a: TestActor) => ({
    authorization: `Bearer ${a.accessToken}`,
    "x-company-id": owner.companyId,
  });
  approverH = headersFor(approver);
  issuerH = headersFor(issuer);
  readerH = headersFor(reader);

  projA = newId("prj");
  projB = newId("prj");
  projC = newId("prj");
  for (const [id, name] of [
    [projA, "Commitments A"],
    [projB, "Commitments B"],
    [projC, "Commitments C"],
  ] as const) {
    await built.app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  }
  for (const projectId of [projA, projB, projC]) {
    for (const [actor, templateKey] of [
      [approver, "project_admin"],
      [issuer, "project_admin"],
      [reader, "read_only"],
    ] as const) {
      await built.app.db.insert(projectMemberships).values({
        id: newId("pm"),
        companyId: owner.companyId,
        projectId,
        userId: actor.userId,
        templateKey,
        overrides: {},
      });
    }
  }

  vendorA = newId("ven");
  vendorB = newId("ven");
  await built.app.db.insert(vendors).values([
    { id: vendorA, companyId: owner.companyId, name: "Apex Concrete Ltd" },
    { id: vendorB, companyId: owner.companyId, name: "Meridian Mechanical" },
  ]);
  contactA = newId("con");
  await built.app.db.insert(contacts).values({
    id: contactA,
    companyId: owner.companyId,
    vendorId: vendorA,
    name: "Dana Reyes",
  });

  primeA = newId("pcn");
  await built.app.db.insert(primeContracts).values({
    id: primeA,
    companyId: owner.companyId,
    projectId: projA,
    number: 1,
    reference: "PC-0001",
    title: "Main works",
    createdBy: owner.userId,
  });

  budgetA = newId("bdg");
  await built.app.db.insert(budgets).values({
    id: budgetA,
    companyId: owner.companyId,
    projectId: projA,
    number: 1,
    reference: "BUD-0001",
    name: "Control budget",
    isActive: 1,
    currency: "USD",
    createdBy: owner.userId,
  });
  budgetLine1 = newId("bli");
  budgetLine2 = newId("bli");
  budgetLine3 = newId("bli");
  await built.app.db.insert(budgetLineItems).values([
    {
      id: budgetLine1,
      budgetId: budgetA,
      companyId: owner.companyId,
      projectId: projA,
      costCode: "03-300",
      costType: "subcontract",
      description: "Cast-in-place concrete",
      originalBudget: 120000,
      revisedBudget: 120000,
      createdBy: owner.userId,
    },
    {
      id: budgetLine2,
      budgetId: budgetA,
      companyId: owner.companyId,
      projectId: projA,
      costCode: "03-310",
      costType: "subcontract",
      description: "Concrete finishing",
      originalBudget: 60000,
      revisedBudget: 60000,
      createdBy: owner.userId,
    },
    {
      id: budgetLine3,
      budgetId: budgetA,
      companyId: owner.companyId,
      projectId: projA,
      costCode: "05-100",
      costType: "subcontract",
      description: "Structural steel",
      originalBudget: 40000,
      revisedBudget: 40000,
      createdBy: owner.userId,
    },
  ]);

  certB = newId("cert");
  await built.app.db.insert(insuranceCertificates).values({
    id: certB,
    companyId: owner.companyId,
    projectId: null,
    vendorId: vendorB,
    subjectName: "Meridian Mechanical",
    policyType: "employers_liability",
    validFrom: isoDaysFromNow(-180),
    validTo: isoDaysFromNow(180),
    limitOfIndemnity: 5_000_000,
    currency: "USD",
    verifiedAt: new Date().toISOString(),
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/* ================================================================== */
/* Pure arithmetic                                                     */
/* ================================================================== */

describe("SOV arithmetic", () => {
  it("derives revised value, completion and retainage from the stored inputs", () => {
    const d = deriveSovLine({
      scheduledValue: 100000,
      changeOrderValue: 10000,
      previousBilled: 40000,
      previousStoredMaterials: 0,
      thisPeriodWork: 15000,
      thisPeriodStoredMaterials: 0,
      materialsPresentlyStored: 5000,
      retainagePercent: 10,
      retainageReleased: 0,
    });
    expect(d.revisedScheduledValue).toBe(110000);
    expect(d.totalCompletedAndStored).toBe(60000);
    expect(d.percentComplete).toBeCloseTo(54.5455, 3);
    expect(d.balanceToFinish).toBe(50000);
    expect(d.retainageHeld).toBe(6000);
  });

  it("reports a zero-value line as 0% complete rather than NaN or 100%", () => {
    const d = deriveSovLine({
      scheduledValue: 0,
      changeOrderValue: 0,
      previousBilled: 0,
      previousStoredMaterials: 0,
      thisPeriodWork: 0,
      thisPeriodStoredMaterials: 0,
      materialsPresentlyStored: 0,
      retainagePercent: 10,
      retainageReleased: 0,
    });
    expect(d.percentComplete).toBe(0);
    expect(Number.isNaN(d.percentComplete)).toBe(false);
  });

  it("extends a measured line and refuses a third disagreeing figure", () => {
    expect(resolveScheduledValue(undefined, 250, 44).value).toBe(11000);
    expect(resolveScheduledValue(11000, 250, 44).error).toBeNull();
    const bad = resolveScheduledValue(12000, 250, 44);
    expect(bad.error).toContain("does not equal quantity x unitRate");
  });

  it("keeps originalCommitmentSum free of change-order lines", () => {
    const totals = computeCommitmentTotals(
      [
        {
          scheduledValue: 100000,
          changeOrderValue: 10000,
          revisedScheduledValue: 110000,
          totalCompletedAndStored: 0,
          retainageHeld: 0,
          retainageReleased: 0,
        },
        // a line appended by a change order: no original value at all
        {
          scheduledValue: 0,
          changeOrderValue: 5000,
          revisedScheduledValue: 5000,
          totalCompletedAndStored: 0,
          retainageHeld: 0,
          retainageReleased: 0,
        },
      ],
      [
        { status: "approved", amount: 15000 },
        { status: "pending_in_house_review", amount: 3000 },
        { status: "draft", amount: 900 },
        { status: "rejected", amount: 99999 },
      ],
    );
    expect(totals.originalCommitmentSum).toBe(100000);
    expect(totals.approvedChangeSum).toBe(15000);
    expect(totals.revisedCommitmentSum).toBe(115000);
    expect(totals.pendingChangeSum).toBe(3000);
    expect(totals.draftChangeSum).toBe(900);
  });

  it("refuses a change-order allocation that does not equal its amount", () => {
    const line = {
      sovLineId: null,
      costCode: "03-300",
      costType: "subcontract",
      description: "x",
      budgetLineItemId: null,
    };
    expect(assertAllocationSums(1000, [{ ...line, amount: 1000 }]).ok).toBe(true);
    const bad = assertAllocationSums(1000, [{ ...line, amount: 900 }]);
    expect(bad.ok).toBe(false);
  });
});

describe("compliance evaluation (pure)", () => {
  const commitment = {
    id: "c1",
    vendorId: "v1",
    currency: "USD",
    revisedCommitmentSum: 100000,
    requiresLienWaiver: 0,
    paymentHold: 0,
    complianceHoldReason: null,
  };

  it("reports unknown, not compliant, when no requirement is recorded", () => {
    const r = evaluateCompliance({
      commitment,
      requirements: DEFAULT_REQUIREMENTS,
      certificates: [],
      certificateLimits: new Map(),
      bonds: [],
      lienWaivers: [],
      vendorStatus: "active",
      asOf: "2026-06-01",
    });
    expect(r.status).toBe("unknown");
    expect(r.requirementsKnown).toBe(false);
    expect(r.note).toContain("cannot be asserted");
  });

  it("blocks on an expired certificate when strictness is block", () => {
    const r = evaluateCompliance({
      commitment,
      requirements: {
        ...DEFAULT_REQUIREMENTS,
        strictness: "block",
        requiredPolicyTypes: ["employers_liability"],
      },
      certificates: [
        {
          id: "cert1",
          projectId: null,
          policyId: null,
          vendorId: "v1",
          subjectName: "V",
          policyType: "employers_liability",
          validFrom: "2025-01-01",
          validTo: "2026-05-01",
          status: "active",
          verifiedAt: null,
        },
      ],
      certificateLimits: new Map(),
      bonds: [],
      lienWaivers: [],
      vendorStatus: "active",
      asOf: "2026-06-01",
    });
    expect(r.status).toBe("blocked");
    expect(r.blocking[0]?.code).toBe("certificate_expired");
    expect(r.blocking[0]?.expiredOn).toBe("2026-05-01");
    expect(r.blocking[0]?.daysExpired).toBe(31);
  });

  it("warns rather than blocks on the same certificate at strictness warn", () => {
    const r = evaluateCompliance({
      commitment,
      requirements: {
        ...DEFAULT_REQUIREMENTS,
        strictness: "warn",
        requiredPolicyTypes: ["employers_liability"],
      },
      certificates: [],
      certificateLimits: new Map(),
      bonds: [],
      lienWaivers: [],
      vendorStatus: "active",
      asOf: "2026-06-01",
    });
    expect(r.status).toBe("warning");
    expect(r.blocking).toHaveLength(0);
    expect(r.warnings[0]?.code).toBe("certificate_missing");
  });

  it("blocks on an explicit payment hold even when strictness is off", () => {
    const r = evaluateCompliance({
      commitment: { ...commitment, paymentHold: 1, complianceHoldReason: "Defective works" },
      requirements: { ...DEFAULT_REQUIREMENTS, strictness: "off" },
      certificates: [],
      certificateLimits: new Map(),
      bonds: [],
      lienWaivers: [],
      vendorStatus: "active",
      asOf: "2026-06-01",
    });
    expect(r.status).toBe("blocked");
    expect(r.blocking[0]?.code).toBe("payment_hold");
    expect(r.blocking[0]?.message).toBe("Defective works");
  });

  it("refuses to compare a limit written in another currency", () => {
    const r = evaluateCompliance({
      commitment,
      requirements: {
        ...DEFAULT_REQUIREMENTS,
        strictness: "block",
        requiredPolicyTypes: ["employers_liability"],
        minimumInsuranceLimit: 1_000_000,
      },
      certificates: [
        {
          id: "cert1",
          projectId: null,
          policyId: null,
          vendorId: "v1",
          subjectName: "V",
          policyType: "employers_liability",
          validFrom: "2026-01-01",
          validTo: "2027-01-01",
          status: "active",
          verifiedAt: null,
        },
      ],
      certificateLimits: new Map([["cert1", { limit: 5_000_000, currency: "EUR" }]]),
      bonds: [],
      lienWaivers: [],
      vendorStatus: "active",
      asOf: "2026-06-01",
    });
    const finding = r.findings.find((f) => f.code === "certificate_limit_below_requirement");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("cannot be tested");
  });
});

/* ================================================================== */
/* Commitment CRUD                                                     */
/* ================================================================== */

let subA: string; // SC-0001 on projA
let sovLine1: string;
let sovLine2: string;

describe("commitment creation", () => {
  it("creates a subcontract whose sum is the sum of its schedule of values", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Concrete package",
      vendorId: vendorA,
      vendorContactId: contactA,
      primeContractId: primeA,
      currency: "usd",
      defaultRetainagePercent: 10,
      pricingType: "lump_sum",
      inclusions: "Formwork, reinforcement placement",
      exclusions: "Testing, winter protection",
      compliance: { strictness: "warn", requiredPolicyTypes: ["employers_liability"] },
      sovLines: [
        {
          description: "Foundations",
          budgetLineItemId: budgetLine1,
          scheduledValue: 100000,
        },
        {
          description: "Slabs on grade",
          budgetLineItemId: budgetLine2,
          quantity: 2500,
          unitRate: 20,
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    subA = body.commitment.id;
    expect(body.commitment.reference).toBe("SC-0001");
    expect(body.commitment.currency).toBe("USD");
    expect(body.commitment.originalCommitmentSum).toBe(150000);
    expect(body.commitment.revisedCommitmentSum).toBe(150000);
    expect(body.commitment.status).toBe("draft");
    expect(body.sovLines).toHaveLength(2);
    sovLine1 = body.sovLines[0].id;
    sovLine2 = body.sovLines[1].id;
    // the measured line's scheduled value IS quantity x rate
    expect(body.sovLines[1].scheduledValue).toBe(50000);
    // cost code and cost type inherited from the bound budget line
    expect(body.sovLines[0].costCode).toBe("03-300");
    expect(body.sovLines[0].costType).toBe("subcontract");
    expect(body.vendor.name).toBe("Apex Concrete Ltd");
  });

  it("holds the SOV identity on read", async () => {
    const res = await inject("GET", `/api/v1/commitments/${subA}/sov`, owner.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identity.reconciles).toBe(true);
    expect(body.identity.sovTotal).toBe(150000);
    expect(body.identity.commitmentSum).toBe(150000);
    expect(body.totals.revisedScheduledValue).toBe(150000);
  });

  it("numbers purchase orders in the same project sequence but labels them PO", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/commitments`, owner.headers, {
      kind: "purchase_order",
      title: "Rebar supply",
      vendorId: vendorA,
      taxable: true,
      taxPercent: 8.5,
      shipTo: "Gate 3, North yard",
      deliveryDate: isoDaysFromNow(30),
      sovLines: [{ description: "Grade 60 rebar", quantity: 40, unitRate: 950 }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.commitment.reference).toBe("PO-0002");
    expect(body.commitment.revisedCommitmentSum).toBe(38000);
    // tax is derived from the PO sum, never typed
    expect(body.commitment.taxAmount).toBe(3230);
  });

  it("refuses purchase-order fields on a subcontract", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Bad subcontract",
      vendorId: vendorA,
      shipTo: "Gate 3",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("purchase-order fields");
  });

  it("refuses a vendor that is not in the directory", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Ghost vendor",
      vendorId: newId("ven"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("directory vendor");
  });

  it("refuses a prime contract belonging to another project", async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Cross-project",
      vendorId: vendorA,
      primeContractId: primeA,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("prime contract on this project");
  });

  it("refuses a budget line belonging to another project", async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Cross-project budget",
      vendorId: vendorA,
      sovLines: [{ description: "x", budgetLineItemId: budgetLine1, scheduledValue: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("budget line on this project");
  });

  it("refuses a measured line whose scheduled value disagrees with quantity x rate", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/sov-lines`, owner.headers, {
      description: "Mismatched",
      quantity: 10,
      unitRate: 100,
      scheduledValue: 999,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("does not equal quantity x unitRate");
  });
});

/* ================================================================== */
/* Approval and segregation of duties                                  */
/* ================================================================== */

describe("commitment approval", () => {
  it("refuses to approve a commitment with no schedule of values", async () => {
    const created = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Empty",
      vendorId: vendorA,
    });
    const id = created.json().commitment.id;
    const res = await inject(`POST`, `/api/v1/commitments/${id}/approve`, approverH, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("no schedule of values");
  });

  it("refuses self-approval by the author (ADR 0004)", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/approve`, owner.headers, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
    expect(res.json().details.role).toBe("created_by");
  });

  it("approves when a second person does it, and rolls committed cost onto the budget", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/approve`, approverH, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.commitment.status).toBe("approved");
    expect(body.commitment.approvedBy).toBe(approver.userId);
    expect(body.commitment.executed).toBe(0);

    const lines = await built.app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetA));
    const l1 = lines.find((l) => l.id === budgetLine1);
    const l2 = lines.find((l) => l.id === budgetLine2);
    expect(l1?.committedCost).toBe(100000);
    expect(l2?.committedCost).toBe(50000);
    expect(l1?.pendingCommitments).toBe(0);
  });

  it("freezes the schedule of values once the commitment is approved", async () => {
    const add = await inject("POST", `/api/v1/commitments/${subA}/sov-lines`, owner.headers, {
      description: "Sneaky extra",
      scheduledValue: 5000,
    });
    expect(add.statusCode).toBe(409);
    expect(add.json().message).toContain("moves only through change orders");

    const money = await inject(
      "PATCH",
      `/api/v1/commitment-sov-lines/${sovLine1}`,
      owner.headers,
      { scheduledValue: 999999 },
    );
    // refused loudly rather than silently dropped
    expect(money.statusCode).toBe(409);
    expect(money.json().message).toContain("scheduledValue");
    const after = await built.app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.id, sovLine1));
    expect(after[0]?.scheduledValue).toBe(100000);
  });

  it("still allows re-coding and describing an approved line", async () => {
    const res = await inject("PATCH", `/api/v1/commitment-sov-lines/${sovLine1}`, owner.headers, {
      description: "Foundations and pile caps",
      notes: "Split confirmed with the QS",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe("Foundations and pile caps");
  });

  it("records execution as a flag, separate from approval", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/execute`, approverH, {
      signedContractReceivedDate: isoDaysFromNow(-1),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().commitment.executed).toBe(1);
    expect(res.json().commitment.executedBy).toBe(approver.userId);
    const again = await inject("POST", `/api/v1/commitments/${subA}/execute`, approverH, {});
    expect(again.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* Change orders                                                       */
/* ================================================================== */

let ccoA: string;

describe("commitment change orders", () => {
  it("refuses a change order whose lines do not sum to its amount", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/changes`, owner.headers, {
      title: "Bad allocation",
      amount: 15000,
      lines: [{ sovLineId: sovLine1, description: "extra", amount: 10000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("must equal the amount");
  });

  it("refuses an allocation pointing at another commitment's SOV line", async () => {
    const other = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Other",
      vendorId: vendorA,
      sovLines: [{ description: "y", scheduledValue: 100 }],
    });
    const otherLine = other.json().sovLines[0].id;
    const res = await inject("POST", `/api/v1/commitments/${subA}/changes`, owner.headers, {
      title: "Wrong line",
      amount: 100,
      lines: [{ sovLineId: otherLine, description: "x", amount: 100 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("does not belong to this commitment");
  });

  it("creates a draft change order outside the commitment sum", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subA}/changes`, owner.headers, {
      title: "Rock excavation and extra pour",
      reason: "unforeseen_condition",
      scheduleImpactDays: 4,
      lines: [
        { sovLineId: sovLine1, description: "Additional excavation", amount: 10000 },
        {
          description: "Temporary shoring (new scope)",
          costCode: "03-300",
          costType: "subcontract",
          budgetLineItemId: budgetLine1,
          amount: 5000,
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    ccoA = res.json().id;
    expect(res.json().amount).toBe(15000);
    expect(res.json().status).toBe("draft");

    const view = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    expect(view.json().commitment.draftChangeSum).toBe(15000);
    expect(view.json().commitment.revisedCommitmentSum).toBe(150000);
  });

  it("moves a submitted change order into pending, still outside the sum", async () => {
    const res = await inject("POST", `/api/v1/commitment-changes/${ccoA}/submit`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending_in_house_review");
    const view = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    expect(view.json().commitment.pendingChangeSum).toBe(15000);
    expect(view.json().commitment.draftChangeSum).toBe(0);
    expect(view.json().commitment.revisedCommitmentSum).toBe(150000);
  });

  it("refuses approval by the author and by the submitter", async () => {
    const res = await inject("POST", `/api/v1/commitment-changes/${ccoA}/approve`, owner.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("approves the change order and moves the value onto the schedule of values", async () => {
    const res = await inject("POST", `/api/v1/commitment-changes/${ccoA}/approve`, approverH);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().revisedCommitmentSum).toBe(165000);

    const view = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    const c = view.json().commitment;
    expect(c.originalCommitmentSum).toBe(150000); // untouched, forever
    expect(c.approvedChangeSum).toBe(15000);
    expect(c.revisedCommitmentSum).toBe(165000);
    expect(c.pendingChangeSum).toBe(0);

    const lines = view.json().sovLines;
    const bumped = lines.find((l: { id: string }) => l.id === sovLine1);
    expect(bumped.changeOrderValue).toBe(10000);
    expect(bumped.scheduledValue).toBe(100000);
    expect(bumped.revisedScheduledValue).toBe(110000);

    const appended = lines.find((l: { isChangeOrderLine: number }) => l.isChangeOrderLine === 1);
    expect(appended).toBeTruthy();
    expect(appended.scheduledValue).toBe(0);
    expect(appended.changeOrderValue).toBe(5000);
    expect(appended.lineNumber).toBe("CO-001.1");
  });

  it("rolls the approved change through to the budget line's committed cost", async () => {
    const rows = await built.app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLine1));
    expect(rows[0]?.committedCost).toBe(115000); // 100000 + 10000 + 5000
  });

  it("executes the change order without moving the sum a second time", async () => {
    const before = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    const res = await inject("POST", `/api/v1/commitment-changes/${ccoA}/execute`, approverH, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("executed");
    const after = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    expect(after.json().commitment.revisedCommitmentSum).toBe(
      before.json().commitment.revisedCommitmentSum,
    );
    expect(after.json().commitment.approvedChangeSum).toBe(15000);
  });

  it("refuses to void an executed change order", async () => {
    const res = await inject("POST", `/api/v1/commitment-changes/${ccoA}/void`, approverH, {
      reason: "changed our mind",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("negative change order");
  });

  it("refuses to edit an approved change order", async () => {
    const res = await inject("PATCH", `/api/v1/commitment-changes/${ccoA}`, owner.headers, {
      amount: 1,
    });
    expect(res.statusCode).toBe(409);
  });

  it("takes a negative change order back off the commitment sum", async () => {
    const created = await inject("POST", `/api/v1/commitments/${subA}/changes`, owner.headers, {
      title: "Credit: shoring not required",
      lines: [{ sovLineId: sovLine1, description: "Credit", amount: -4000 }],
    });
    const id = created.json().id;
    expect(created.json().amount).toBe(-4000);
    await inject("POST", `/api/v1/commitment-changes/${id}/submit`, owner.headers);
    const approved = await inject("POST", `/api/v1/commitment-changes/${id}/approve`, approverH);
    expect(approved.statusCode).toBe(200);
    const view = await inject("GET", `/api/v1/commitments/${subA}`, owner.headers);
    expect(view.json().commitment.approvedChangeSum).toBe(11000);
    expect(view.json().commitment.revisedCommitmentSum).toBe(161000);
  });

  it("reconciles every identity after all that", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/commitments/rollups/reconcile`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reconciles).toBe(true);
    expect(body.failingCount).toBe(0);
    const sub = body.results.find((r: { commitmentId: string }) => r.commitmentId === subA);
    expect(sub.checks.every((c: { reconciles: boolean }) => c.reconciles)).toBe(true);
  });
});

/* ================================================================== */
/* Compliance gating on payment                                        */
/* ================================================================== */

let subB: string; // on projB, vendorB, strictness block
let payB: string;

describe("compliance gating", () => {
  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Mechanical package",
      vendorId: vendorB,
      defaultRetainagePercent: 10,
      requiresLienWaiver: false,
      compliance: {
        strictness: "block",
        requiredPolicyTypes: ["employers_liability"],
        minimumInsuranceLimit: 1_000_000,
      },
      sovLines: [{ description: "Plant room", scheduledValue: 80000 }],
    });
    subB = res.json().commitment.id;
    await inject("POST", `/api/v1/commitments/${subB}/approve`, approverH, {});
    await inject("POST", `/api/v1/commitments/${subB}/execute`, approverH, {});
    // put some billing on the schedule so retainage is actually held
    const lineId = res.json().sovLines[0].id;
    await built.app.db
      .update(commitmentSovLines)
      .set({
        previousBilled: 40000,
        totalCompletedAndStored: 40000,
        retainageHeld: 4000,
        percentComplete: 50,
        balanceToFinish: 40000,
      })
      .where(eq(commitmentSovLines.id, lineId));
    await built.app.db
      .update(commitments)
      .set({ totalInvoiced: 36000, retainageHeld: 4000 })
      .where(eq(commitments.id, subB));
  });

  it("reports the commitment as compliant while the certificate is in date", async () => {
    const res = await inject("GET", `/api/v1/commitments/${subB}/compliance`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("compliant");
    expect(res.json().requirementsKnown).toBe(true);
    expect(res.json().evidence.certificatesConsidered).toBeGreaterThan(0);
  });

  it("schedules and approves a payment while the vendor is compliant", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 30000,
      method: "ach",
    });
    expect(res.statusCode).toBe(201);
    payB = res.json().payment.id;
    expect(res.json().payment.status).toBe("scheduled");
    const approved = await inject(
      "POST",
      `/api/v1/commitment-payments/${payB}/approve`,
      approverH,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().payment.approvedBy).toBe(approver.userId);
  });

  it("REFUSES to issue once the certificate expires, naming the certificate and the date", async () => {
    const expiredOn = isoDaysFromNow(-9);
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: expiredOn })
      .where(eq(insuranceCertificates.id, certB));

    const res = await inject("POST", `/api/v1/commitment-payments/${payB}/issue`, issuerH, {});
    expect(res.statusCode).toBe(409);
    const details = res.json().details;
    expect(details.control).toBe("compliance_gate");
    expect(details.strictness).toBe("block");
    expect(details.blocking[0].code).toBe("certificate_expired");
    expect(details.blocking[0].expiredOn).toBe(expiredOn);
    expect(details.blocking[0].daysExpired).toBe(9);
    expect(res.json().message).toContain("uninsured");
  });

  it("lands a newly scheduled payment straight on hold while cover is lapsed", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 1000,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment.status).toBe("on_hold");
    expect(res.json().payment.holdReason).toContain("expired");
    expect(res.json().compliance.status).toBe("blocked");
  });

  it("surfaces the lapse on the project compliance register, worst first", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projB}/commitments/compliance`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.blocked).toBeGreaterThanOrEqual(1);
    expect(body.entries[0].compliance.status).toBe("blocked");
    expect(body.entries[0].vendorName).toBe("Meridian Mechanical");
  });

  it("lets the payment through once cover is reinstated, and derives totalPaid from it", async () => {
    await built.app.db
      .update(insuranceCertificates)
      .set({ validTo: isoDaysFromNow(365) })
      .where(eq(insuranceCertificates.id, certB));
    const res = await inject("POST", `/api/v1/commitment-payments/${payB}/issue`, issuerH, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe("issued");
    expect(res.json().payment.issuedBy).toBe(issuer.userId);
    expect(res.json().position.totalPaid).toBe(30000);
    expect(res.json().position.outstandingToPay).toBe(6000); // 36000 invoiced - 30000 paid
  });

  it("refuses a payment below the required insurance limit in the same currency", async () => {
    await built.app.db
      .update(insuranceCertificates)
      .set({ limitOfIndemnity: 250_000 })
      .where(eq(insuranceCertificates.id, certB));
    const res = await inject("GET", `/api/v1/commitments/${subB}/compliance`, owner.headers);
    expect(res.json().status).toBe("blocked");
    expect(res.json().blocking[0].code).toBe("certificate_limit_below_requirement");
    await built.app.db
      .update(insuranceCertificates)
      .set({ limitOfIndemnity: 5_000_000 })
      .where(eq(insuranceCertificates.id, certB));
  });

  it("blocks on a missing bond when the commitment requires one", async () => {
    await inject("PATCH", `/api/v1/commitments/${subB}`, owner.headers, {
      compliance: {
        strictness: "block",
        requiredPolicyTypes: ["employers_liability"],
        requiredBondTypes: ["performance"],
        minimumBondPercent: 10,
      },
    });
    const missing = await inject("GET", `/api/v1/commitments/${subB}/compliance`, owner.headers);
    expect(missing.json().blocking.map((f: { code: string }) => f.code)).toContain("bond_missing");

    await built.app.db.insert(bonds).values({
      id: newId("bond"),
      companyId: owner.companyId,
      projectId: projB,
      number: "B-1",
      bondType: "performance",
      guarantor: "Surety Co",
      principalVendorId: vendorB,
      amount: 8000,
      currency: "USD",
      status: "active",
      expiryAt: isoDaysFromNow(365),
      createdBy: owner.userId,
    });
    const present = await inject("GET", `/api/v1/commitments/${subB}/compliance`, owner.headers);
    expect(present.json().status).toBe("compliant");
  });
});

/* ================================================================== */
/* Payments — segregation, ceilings, retainage                         */
/* ================================================================== */

describe("payments", () => {
  it("refuses a payment against an unapproved commitment", async () => {
    const draft = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Unapproved",
      vendorId: vendorA,
      sovLines: [{ description: "x", scheduledValue: 1000 }],
    });
    const res = await inject(
      "POST",
      `/api/v1/commitments/${draft.json().commitment.id}/payments`,
      owner.headers,
      { amount: 100 },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("uncontrolled cost");
  });

  it("refuses a payment that would exceed the revised commitment sum", async () => {
    const res = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 60000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("above its revised commitment sum");
  });

  it("refuses self-approval of a payment", async () => {
    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 2000,
    });
    const id = created.json().payment.id;
    const res = await inject("POST", `/api/v1/commitment-payments/${id}/approve`, owner.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("refuses to issue an unapproved payment, and refuses the approver issuing their own", async () => {
    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 2000,
    });
    const id = created.json().payment.id;
    const unapproved = await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    expect(unapproved.statusCode).toBe(409);
    expect(unapproved.json().message).toContain("has not been approved");

    await inject("POST", `/api/v1/commitment-payments/${id}/approve`, approverH);
    const selfIssue = await inject(
      "POST",
      `/api/v1/commitment-payments/${id}/issue`,
      approverH,
      {},
    );
    expect(selfIssue.statusCode).toBe(403);
    expect(selfIssue.json().details.control).toBe("no_self_issue");

    const ok = await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    expect(ok.statusCode).toBe(200);
  });

  it("releases retainage across the schedule of values and refuses over-release", async () => {
    const tooMuch = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 0,
      retainageReleasedAmount: 9999,
    });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().message).toContain("retainage still available");

    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 1500,
      retainageReleasedAmount: 1500,
    });
    const id = created.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${id}/approve`, approverH);
    const issued = await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    expect(issued.statusCode).toBe(200);

    const lines = await built.app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, subB));
    expect(lines[0]?.retainageReleased).toBe(1500);
    expect(lines[0]?.retainageHeld).toBe(2500);
    const view = await inject("GET", `/api/v1/commitments/${subB}`, owner.headers);
    expect(view.json().commitment.retainageHeld).toBe(2500);
    expect(view.json().commitment.retainageReleased).toBe(1500);
  });

  it("blocks issuing while an explicit payment hold is on the commitment", async () => {
    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 500,
    });
    const id = created.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${id}/approve`, approverH);
    await inject("POST", `/api/v1/commitments/${subB}/hold`, owner.headers, {
      reason: "Defective ductwork not rectified",
    });
    const res = await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().details.blocking[0].code).toBe("payment_hold");
    expect(res.json().message).toContain("Defective ductwork");

    await inject("POST", `/api/v1/commitments/${subB}/release-hold`, approverH, {});
    const after = await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    expect(after.statusCode).toBe(200);
  });

  it("refuses to void a cleared payment", async () => {
    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 100,
    });
    const id = created.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${id}/approve`, approverH);
    await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    await inject("POST", `/api/v1/commitment-payments/${id}/clear`, issuerH, {});
    const res = await inject("POST", `/api/v1/commitment-payments/${id}/void`, owner.headers, {
      reason: "mistake",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("cannot be voided");
  });

  it("keeps totalPaid derived from the payment register after a void", async () => {
    const before = await inject("GET", `/api/v1/commitments/${subB}/position`, owner.headers);
    const created = await inject("POST", `/api/v1/commitments/${subB}/payments`, owner.headers, {
      amount: 250,
    });
    const id = created.json().payment.id;
    await inject("POST", `/api/v1/commitment-payments/${id}/approve`, approverH);
    await inject("POST", `/api/v1/commitment-payments/${id}/issue`, issuerH, {});
    const mid = await inject("GET", `/api/v1/commitments/${subB}/position`, owner.headers);
    expect(mid.json().totalPaid).toBe(before.json().totalPaid + 250);
    await inject("POST", `/api/v1/commitment-payments/${id}/void`, owner.headers, {
      reason: "duplicate",
    });
    const after = await inject("GET", `/api/v1/commitments/${subB}/position`, owner.headers);
    expect(after.json().totalPaid).toBe(before.json().totalPaid);
  });
});

/* ================================================================== */
/* Rollups                                                             */
/* ================================================================== */

describe("rollups", () => {
  it("reports committed cost by cost code against the budget", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/commitments/rollups/by-cost-code`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const usd = body.buckets.find((b: { currency: string }) => b.currency === "USD");
    const row = usd.rows.find(
      (r: { costCode: string; costType: string }) =>
        r.costCode === "03-300" && r.costType === "subcontract",
    );
    expect(row.originalCommitted).toBe(100000);
    expect(row.changeOrders).toBe(11000);
    expect(row.revisedCommitted).toBe(111000);
    expect(row.revisedBudget.value).toBe(120000);
    expect(row.remainingToCommit.value).toBe(9000);
    expect(row.percentBoughtOut.value).toBeCloseTo(92.5, 3);
  });

  it("produces a buyout log with projected savings and unbought lines", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/commitments/rollups/buyout-log`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.budgetId).toBe(budgetA);
    expect(body.currency).toBe("USD");
    const steel = body.rows.find((r: { costCode: string }) => r.costCode === "05-100");
    expect(steel.committed).toBe(0);
    expect(steel.projectedSavings).toBe(40000);
    expect(steel.commitmentCount).toBe(0);
    const concrete = body.rows.find((r: { costCode: string }) => r.costCode === "03-300");
    expect(concrete.committed).toBe(111000);
    expect(concrete.projectedSavings).toBe(9000);
    expect(body.unboughtLineCount).toBe(1);
    expect(body.totals.revisedBudget).toBe(220000);
    expect(body.totals.committed).toBe(161000);
  });

  it("refuses to invent a buyout log where there is no budget", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projC}/commitments/rollups/buyout-log`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetId).toBeNull();
    expect(res.json().totals).toBeNull();
    expect(res.json().rows).toHaveLength(0);
    expect(res.json().notes[0]).toContain("no figure is invented");
  });

  it("returns remaining-to-commit as null with reasons when no budget exists", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projC}/commitments/rollups/by-cost-code`,
      owner.headers,
    );
    const bucket = res.json().buckets[0];
    expect(bucket.rows.length).toBeGreaterThan(0);
    expect(bucket.rows[0].remainingToCommit.value).toBeNull();
    expect(bucket.rows[0].remainingToCommit.reasons[0]).toContain("No active budget");
  });

  it("buckets by currency and never adds two currencies together", async () => {
    const eur = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "purchase_order",
      title: "European plant hire",
      vendorId: vendorA,
      currency: "EUR",
      sovLines: [{ description: "Tower crane", costCode: "01-540", scheduledValue: 25000 }],
    });
    const id = eur.json().commitment.id;
    await inject("POST", `/api/v1/commitments/${id}/approve`, approverH, {});

    const res = await inject(
      "GET",
      `/api/v1/projects/${projC}/commitments/rollups/by-cost-code`,
      owner.headers,
    );
    const body = res.json();
    expect(body.mixedCurrency).toBe(true);
    expect(body.currencies).toEqual(["EUR", "USD"]);
    const eurBucket = body.buckets.find((b: { currency: string }) => b.currency === "EUR");
    expect(eurBucket.totals.revisedCommitted).toBe(25000);
    const usdBucket = body.buckets.find((b: { currency: string }) => b.currency === "USD");
    expect(usdBucket.totals.revisedCommitted).not.toBe(
      eurBucket.totals.revisedCommitted + usdBucket.totals.revisedCommitted,
    );
    expect(body.notes.some((n: string) => n.includes("never added together"))).toBe(true);
  });

  it("reports per-currency subtotals on the list rather than one wrong number", async () => {
    const res = await inject("GET", `/api/v1/projects/${projC}/commitments`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().mixedCurrency).toBe(true);
    const currencies = res
      .json()
      .totalsByCurrency.map((t: { currency: string }) => t.currency)
      .sort();
    expect(currencies).toEqual(["EUR", "USD"]);
  });

  it("re-materializes the rollups idempotently", async () => {
    const first = await inject(
      "POST",
      `/api/v1/projects/${projA}/commitments/rollups/sync`,
      owner.headers,
      {},
    );
    expect(first.statusCode).toBe(200);
    const second = await inject(
      "POST",
      `/api/v1/projects/${projA}/commitments/rollups/sync`,
      owner.headers,
      {},
    );
    expect(second.json().budgetLinesUpdated).toBe(0);
    const rows = await built.app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, budgetLine1));
    // 100000 original + 6000 net change on line 1 + 5000 appended change line
    expect(rows[0]?.committedCost).toBe(111000);
  });
});

/* ================================================================== */
/* Access control, tenancy and the record                              */
/* ================================================================== */

describe("access control and the record", () => {
  it("refuses a write from a read-only project member", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/commitments`, readerH, {
      kind: "subcontract",
      title: "Not allowed",
      vendorId: vendorA,
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows a read-only member to read", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/commitments`, readerH);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it("does not leak a commitment to another company", async () => {
    const res = await inject("GET", `/api/v1/commitments/${subA}`, outsider.headers);
    expect(res.statusCode).toBe(404);
  });

  it("refuses to delete an approved commitment but deletes a draft", async () => {
    const approvedDelete = await inject("DELETE", `/api/v1/commitments/${subA}`, owner.headers);
    expect(approvedDelete.statusCode).toBe(409);

    const draft = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "purchase_order",
      title: "Disposable",
      vendorId: vendorA,
    });
    const id = draft.json().commitment.id;
    const res = await inject("DELETE", `/api/v1/commitments/${id}`, owner.headers);
    expect(res.statusCode).toBe(204);
    const gone = await inject("GET", `/api/v1/commitments/${id}`, owner.headers);
    expect(gone.statusCode).toBe(404);
  });

  it("refuses to change the currency of a commitment that carries value", async () => {
    const res = await inject("PATCH", `/api/v1/commitments/${subA}`, owner.headers, {
      currency: "GBP",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("silently change meaning");
  });

  it("refuses to change the vendor on an approved commitment", async () => {
    const res = await inject("PATCH", `/api/v1/commitments/${subA}`, owner.headers, {
      vendorId: vendorB,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("counterparty is the contract");
  });

  it("refuses to complete a commitment with an open change order", async () => {
    const open = await inject("POST", `/api/v1/commitments/${subA}/changes`, owner.headers, {
      title: "Still open",
      amount: 1,
      lines: [{ sovLineId: sovLine1, description: "x", amount: 1 }],
    });
    const res = await inject("POST", `/api/v1/commitments/${subA}/complete`, approverH, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("still open");
    await inject("POST", `/api/v1/commitment-changes/${open.json().id}/void`, approverH, {
      reason: "not proceeding",
    });
    const ok = await inject("POST", `/api/v1/commitments/${subA}/complete`, approverH, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json().commitment.status).toBe("complete");
  });

  it("reports billability separately from approval", async () => {
    const draft = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Billability probe",
      vendorId: vendorA,
      sovLines: [{ description: "x", scheduledValue: 5000 }],
    });
    const id = draft.json().commitment.id;
    expect(draft.json().billable.billable).toBe(false);
    expect(draft.json().billable.reason).toContain("has not been approved");

    const approved = await inject("POST", `/api/v1/commitments/${id}/approve`, approverH, {});
    expect(approved.json().billable.billable).toBe(false);
    expect(approved.json().billable.reason).toContain("not executed");

    const executed = await inject("POST", `/api/v1/commitments/${id}/execute`, approverH, {});
    expect(executed.json().billable.billable).toBe(true);
    expect(executed.json().billable.reason).toBeNull();
  });

  it("replaces a whole schedule of values before billing, and refuses after", async () => {
    const created = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "subcontract",
      title: "Spreadsheet SOV",
      vendorId: vendorA,
      sovLines: [{ description: "Placeholder", scheduledValue: 1 }],
    });
    const id = created.json().commitment.id;
    const res = await inject("PUT", `/api/v1/commitments/${id}/sov`, owner.headers, {
      lines: [
        { lineNumber: "01", description: "Mobilisation", scheduledValue: 12000 },
        { lineNumber: "02.1", description: "Ductwork", quantity: 300, unitRate: 65 },
        { lineNumber: "02.2", description: "Insulation", scheduledValue: 8000 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lineCount).toBe(3);
    const view = await inject("GET", `/api/v1/commitments/${id}/sov`, owner.headers);
    expect(view.json().identity.reconciles).toBe(true);
    expect(view.json().identity.sovTotal).toBe(39500);

    await inject("POST", `/api/v1/commitments/${id}/approve`, approverH, {});
    const after = await inject("PUT", `/api/v1/commitments/${id}/sov`, owner.headers, {
      lines: [{ description: "Too late", scheduledValue: 1 }],
    });
    expect(after.statusCode).toBe(409);
  });

  it("says it does not know rather than saying compliant when no requirement is recorded", async () => {
    const created = await inject("POST", `/api/v1/projects/${projC}/commitments`, owner.headers, {
      kind: "purchase_order",
      title: "Stationery",
      vendorId: vendorA,
      requiresLienWaiver: false,
      sovLines: [{ description: "Site office supplies", scheduledValue: 400 }],
    });
    const res = await inject(
      "GET",
      `/api/v1/commitments/${created.json().commitment.id}/compliance`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("unknown");
    expect(res.json().requirementsKnown).toBe(false);
    expect(res.json().note).toContain("Record the policy and bond types");
  });

  it("exposes the invoice read side with a currency-honest rollup", async () => {
    const res = await inject("GET", `/api/v1/commitments/${subB}/invoices`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe("USD");
    expect(res.json().billing.invoiceCount).toBe(0);
    expect(res.json().billing.foreignCurrencyInvoices).toBe(0);
    expect(res.json().billing.note).toBeNull();
  });

  it("ledgers every consequential mutation with its actor", async () => {
    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "commitment"),
        ),
      );
    expect(entries.length).toBeGreaterThan(5);
    expect(entries.some((e) => e.action === "create")).toBe(true);
    expect(entries.some((e) => e.action === "state_change")).toBe(true);
    expect(entries.some((e) => e.actorId === approver.userId)).toBe(true);

    const payments = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "commitment_payment"),
        ),
      );
    expect(payments.some((e) => e.actorId === issuer.userId)).toBe(true);

    const verify = await built.app.inject({
      method: "GET",
      url: "/api/v1/ledger/verify",
      headers: owner.headers,
    });
    if (verify.statusCode === 200) expect(verify.json().valid).toBe(true);
  });
});
