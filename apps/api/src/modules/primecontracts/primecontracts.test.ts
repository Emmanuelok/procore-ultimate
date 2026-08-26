import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  billingPeriods,
  companyMemberships,
  paymentApplications,
  primeContractSovLines,
  primeContracts,
  projectMemberships,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  changeSums,
  checkSovAgainstContract,
  computeApplication,
  derivePeriodValues,
  effectiveRetainage,
  executionDateProblem,
  formatMoney,
  percentCompleteOf,
  rollForward,
  sovTotals,
  validatePeriodValues,
  type BillableLine,
  type RetainageTerms,
} from "./sov.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let built: BuiltApp;
let owner: TestActor; // company owner — raises contracts and applications
let certifier: TestActor; // project_admin — approves and certifies
let reader: TestActor; // read_only — may look, may not touch
let certifierHeaders: Record<string, string>;
let readerHeaders: Record<string, string>;

let projBilling: string; // the full lifecycle: SOV -> execute -> two applications
let projSov: string; // schedule-of-values identity refusals
let projChange: string; // change orders into the contract sum and the SOV
let projPortfolio: string; // currency discipline + permissions

const api = (path: string): string => `/api/v1${path}`;
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const today = (): string => iso(new Date());
const daysFromNow = (n: number): string => iso(new Date(Date.now() + n * 86_400_000));

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

/** A four-line, 1,000,000 schedule of values that totals the contract sum. */
const STANDARD_SOV = [
  { lineNumber: "01", description: "General conditions", scheduledValue: 100_000 },
  { lineNumber: "02", description: "Sitework", scheduledValue: 250_000 },
  { lineNumber: "03", description: "Concrete", scheduledValue: 400_000 },
  { lineNumber: "04", description: "Finishes", scheduledValue: 250_000 },
];

async function createContract(
  projectId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await call("POST", `/projects/${projectId}/prime-contracts`, { payload });
  if (res.statusCode !== 201) throw new Error(`createContract: ${res.statusCode} ${res.body}`);
  return res.json();
}

const line = (
  body: { g703: Array<Record<string, unknown>> },
  lineNumber: string,
): Record<string, unknown> => {
  const found = body.g703.find((l) => l["lineNumber"] === lineNumber);
  if (!found) throw new Error(`no G703 line ${lineNumber}`);
  return found;
};

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  certifier = await registerActor(built.app);
  reader = await registerActor(built.app);
  for (const actor of [certifier, reader]) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: actor.userId,
      role: "member",
    });
  }
  certifierHeaders = {
    authorization: `Bearer ${certifier.accessToken}`,
    "x-company-id": owner.companyId,
  };
  readerHeaders = {
    authorization: `Bearer ${reader.accessToken}`,
    "x-company-id": owner.companyId,
  };

  projBilling = newId("prj");
  projSov = newId("prj");
  projChange = newId("prj");
  projPortfolio = newId("prj");
  for (const [id, name] of [
    [projBilling, "Prime billing"],
    [projSov, "Prime SOV"],
    [projChange, "Prime changes"],
    [projPortfolio, "Prime portfolio"],
  ] as const) {
    await built.app.db.insert(projects).values({ id, companyId: owner.companyId, name });
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: id,
      userId: certifier.userId,
      templateKey: "project_admin",
      overrides: {},
    });
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: id,
      userId: reader.userId,
      templateKey: "read_only",
      overrides: {},
    });
  }
});

afterAll(async () => {
  await built?.close();
});

/* ================================================================== */
/* 1. The pure arithmetic (sov.ts)                                     */
/* ================================================================== */

const bl = (over: Partial<BillableLine> & { id: string; scheduledValue: number }): BillableLine => ({
  lineNumber: over.id,
  description: "line",
  sortOrder: 0,
  billingMethod: "percent_complete",
  costCode: null,
  costType: null,
  costCodeId: null,
  budgetLineItemId: null,
  unit: null,
  quantity: null,
  unitRate: null,
  changeOrderValue: 0,
  previousBilled: 0,
  previousStoredMaterials: 0,
  materialsPresentlyStored: 0,
  thisPeriodWork: 0,
  thisPeriodStoredMaterials: 0,
  retainagePercent: 10,
  retainageHeld: 0,
  retainageReleased: 0,
  isChangeOrderLine: 0,
  changeOrderPackageId: null,
  ...over,
});

const TERMS_10_5_AT_50: RetainageTerms = {
  workPercent: 10,
  materialsPercent: 10,
  reductionThresholdPercent: 50,
  reducedPercent: 5,
};

describe("sov.ts — schedule of values arithmetic", () => {
  it("splits base scope from appended change-order scope", () => {
    const totals = sovTotals([
      bl({ id: "01", scheduledValue: 600_000 }),
      bl({ id: "02", scheduledValue: 400_000 }),
      bl({ id: "CO-001.1", scheduledValue: 50_000, isChangeOrderLine: 1 }),
    ]);
    expect(totals.baseScope).toBe(1_000_000);
    expect(totals.changeOrderScope).toBe(50_000);
    expect(totals.revisedScheduledValue).toBe(1_050_000);
  });

  it("reconciles a balanced schedule against the contract sum", () => {
    const check = checkSovAgainstContract(
      [bl({ id: "01", scheduledValue: 600_000 }), bl({ id: "02", scheduledValue: 400_000 })],
      { originalContractSum: 1_000_000, approvedChangeSum: 0, currency: "USD" },
    );
    expect(check.ok).toBe(true);
    expect(check.discrepancy).toBe(0);
    expect(check.message).toMatch(/reconciles/);
  });

  it("names the discrepancy — amount and direction — when the schedule over-states", () => {
    const check = checkSovAgainstContract(
      [bl({ id: "01", scheduledValue: 600_000 }), bl({ id: "02", scheduledValue: 412_500 })],
      { originalContractSum: 1_000_000, approvedChangeSum: 0, currency: "USD" },
    );
    expect(check.ok).toBe(false);
    expect(check.direction).toBe("over");
    expect(check.discrepancy).toBe(12_500);
    expect(check.message).toContain("12,500.00");
    expect(check.message).toContain("1,012,500.00");
    expect(check.message).toContain("over by");
  });

  it("identifies WHICH leg fails — base scope vs change-order scope", () => {
    const check = checkSovAgainstContract(
      [
        bl({ id: "01", scheduledValue: 1_000_000 }),
        bl({ id: "CO-001.1", scheduledValue: 30_000, isChangeOrderLine: 1 }),
      ],
      { originalContractSum: 1_000_000, approvedChangeSum: 50_000, currency: "USD" },
    );
    expect(check.ok).toBe(false);
    expect(check.legs[0]?.ok).toBe(true); // base scope is fine
    expect(check.legs[1]?.ok).toBe(false); // the change-order leg is 20,000 short
    expect(check.legs[1]?.delta).toBe(-20_000);
    expect(check.message).toContain("under by");
  });

  it("computes the hand-worked G702 ladder for a first application", () => {
    const lines = [
      { line: bl({ id: "01", scheduledValue: 100_000 }), work: 50_000, stored: 0 },
      { line: bl({ id: "02", scheduledValue: 250_000 }), work: 100_000, stored: 0 },
      { line: bl({ id: "03", scheduledValue: 400_000 }), work: 0, stored: 60_000 },
      { line: bl({ id: "04", scheduledValue: 250_000 }), work: 0, stored: 0 },
    ];
    const result = computeApplication({
      contract: { originalContractSum: 1_000_000, approvedChangeSum: 0, currency: "USD" },
      lines: lines.map((l) => ({
        line: l.line,
        derived: {
          thisPeriodWork: l.work,
          thisPeriodStoredMaterials: l.stored,
          materialsPresentlyStored: l.stored,
          basis: "amount" as const,
        },
      })),
      terms: TERMS_10_5_AT_50,
      lessPreviousCertificates: 0,
    });
    const g = result.g702;
    expect(g.contractSumToDate).toBe(1_000_000);
    expect(g.completedToDate).toBe(150_000);
    expect(g.storedMaterials).toBe(60_000);
    expect(g.totalCompletedAndStored).toBe(210_000);
    expect(g.retainageWork).toBe(15_000);
    expect(g.retainageMaterials).toBe(6_000);
    expect(g.totalRetainage).toBe(21_000);
    expect(g.totalEarnedLessRetainage).toBe(189_000);
    expect(g.currentPaymentDue).toBe(189_000);
    expect(g.balanceToFinishPlusRetainage).toBe(811_000);
    expect(g.percentComplete).toBe(21);
  });

  it("proves every G702 identity on the computed application", () => {
    const result = computeApplication({
      contract: { originalContractSum: 500_000, approvedChangeSum: 25_000, currency: "USD" },
      lines: [
        {
          line: bl({ id: "01", scheduledValue: 525_000 }),
          derived: {
            thisPeriodWork: 262_500,
            thisPeriodStoredMaterials: 0,
            materialsPresentlyStored: 0,
            basis: "amount",
          },
        },
      ],
      terms: { ...TERMS_10_5_AT_50, reductionThresholdPercent: null, reducedPercent: null },
      lessPreviousCertificates: 0,
    });
    expect(result.identities.every((i) => i.ok)).toBe(true);
    expect(result.g702.contractSumToDate).toBe(525_000);
    expect(result.g702.totalRetainage).toBe(26_250);
  });

  it("holds the full rate below the reduction threshold", () => {
    const eff = effectiveRetainage(TERMS_10_5_AT_50, 49.9);
    expect(eff.stepDownApplied).toBe(false);
    expect(eff.workPercent).toBe(10);
    expect(eff.note).toBeNull();
  });

  it("steps retainage down at exactly the threshold and says so", () => {
    const eff = effectiveRetainage(TERMS_10_5_AT_50, 50);
    expect(eff.stepDownApplied).toBe(true);
    expect(eff.workPercent).toBe(5);
    expect(eff.materialsPercent).toBe(5);
    expect(eff.note).toMatch(/stepped down to 5%/);
  });

  it("never fabricates a percent complete on a zero-value line", () => {
    const pc = percentCompleteOf(0, 0, "Line 07");
    expect(pc.value).toBeNull();
    expect(pc.reasons[0]).toMatch(/undefined against it, not 0/);
  });

  it("refuses two spellings of the same period figure", () => {
    const d = derivePeriodValues(bl({ id: "01", scheduledValue: 100_000 }), {
      thisPeriodWork: 10_000,
      percentComplete: 20,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reasons[0]).toMatch(/same figure spelled differently/);
  });

  it("refuses a percent-complete entry against a zero-value line", () => {
    const d = derivePeriodValues(bl({ id: "07", scheduledValue: 0 }), { percentComplete: 50 });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reasons[0]).toMatch(/cannot be converted into an amount/);
  });

  it("refuses stored material when the absolute and the delta disagree", () => {
    const d = derivePeriodValues(
      bl({ id: "03", scheduledValue: 400_000, previousStoredMaterials: 60_000 }),
      { materialsPresentlyStored: 100_000, thisPeriodStoredMaterials: 10_000 },
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reasons[0]).toMatch(/disagrees with/);
  });

  it("extends a unit-price line at its rate, and refuses one with no rate", () => {
    const priced = derivePeriodValues(
      bl({ id: "05", scheduledValue: 50_000, unitRate: 125, billingMethod: "unit_price" }),
      { thisPeriodQuantity: 40 },
    );
    expect(priced.ok).toBe(true);
    if (priced.ok) expect(priced.value.thisPeriodWork).toBe(5_000);
    const unpriced = derivePeriodValues(
      bl({ id: "06", scheduledValue: 50_000, billingMethod: "unit_price" }),
      { thisPeriodQuantity: 40 },
    );
    expect(unpriced.ok).toBe(false);
    if (!unpriced.ok) expect(unpriced.reasons[0]).toMatch(/no unit rate/);
  });

  it("refuses to bill past a line's scheduled value and names the overage", () => {
    const reasons = validatePeriodValues(
      bl({ id: "03", scheduledValue: 400_000, previousBilled: 380_000 }),
      {
        thisPeriodWork: 40_000,
        thisPeriodStoredMaterials: 0,
        materialsPresentlyStored: 0,
        basis: "amount",
      },
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("420,000.00");
    expect(reasons[0]).toContain("over-billed by 20,000.00");
  });

  it("buckets change orders by status — only executed reaches the contract sum", () => {
    const sums = changeSums(1_000_000, [
      { status: "executed", amount: 50_000 },
      { status: "approved", amount: 30_000 },
      { status: "draft", amount: 10_000 },
      { status: "rejected", amount: 99_000 },
    ]);
    expect(sums.approvedChangeSum).toBe(50_000);
    expect(sums.pendingChangeSum).toBe(30_000);
    expect(sums.draftChangeSum).toBe(10_000);
    expect(sums.revisedContractSum).toBe(1_050_000);
  });

  it("refuses an execution date that precedes the award or the approval", () => {
    expect(
      executionDateProblem({
        executionDate: "2026-01-01",
        contractDate: "2026-02-01",
        approvedAt: null,
      }),
    ).toMatch(/before it is awarded/);
    expect(
      executionDateProblem({
        executionDate: "2026-03-01",
        contractDate: "2026-02-01",
        approvedAt: "2026-04-02T10:00:00.000Z",
      }),
    ).toMatch(/before it is approved/);
    expect(
      executionDateProblem({
        executionDate: "2026-02-01",
        contractDate: "2026-02-01",
        approvedAt: "2026-02-01T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("rolls this period into previous, and nothing else", () => {
    const rolled = rollForward({
      sovLineId: "l1",
      lineNumber: "03",
      description: "Concrete",
      sortOrder: 0,
      billingMethod: "percent_complete",
      costCode: null,
      costType: null,
      costCodeId: null,
      budgetLineItemId: null,
      unit: null,
      quantity: null,
      unitRate: null,
      isChangeOrderLine: 0,
      changeOrderPackageId: null,
      scheduledValue: 400_000,
      changeOrderValue: 0,
      revisedScheduledValue: 400_000,
      previousBilled: 100_000,
      thisPeriodWork: 50_000,
      previousStoredMaterials: 10_000,
      thisPeriodStoredMaterials: 5_000,
      materialsPresentlyStored: 15_000,
      workCompletedToDate: 150_000,
      totalCompletedAndStored: 165_000,
      percentComplete: 41.25,
      balanceToFinish: 235_000,
      retainagePercent: 10,
      retainageWork: 15_000,
      retainageMaterials: 1_500,
      retainageHeldToDate: 16_500,
      retainageThisPeriod: 6_500,
      retainageReleased: 0,
      amount: 48_500,
      reasons: [],
    });
    expect(rolled.previousBilled).toBe(150_000);
    expect(rolled.previousStoredMaterials).toBe(15_000);
    expect(rolled.thisPeriodWork).toBe(0);
    expect(rolled.retainageHeld).toBe(16_500);
  });

  it("formats money for the refusal prose without depending on a locale", () => {
    expect(formatMoney(1234567.891)).toBe("1,234,567.89");
    expect(formatMoney(-12500)).toBe("-12,500.00");
    expect(formatMoney(0)).toBe("0.00");
  });
});

/* ================================================================== */
/* 2. Contract CRUD, approval and execution                            */
/* ================================================================== */

let contractId: string;

describe("prime contract lifecycle", () => {
  it("creates a prime contract with a reference, a sum and its retainage terms", async () => {
    const created = await createContract(projBilling, {
      title: "Owner agreement — East Tower",
      pricingType: "lump_sum",
      currency: "USD",
      originalContractSum: 1_000_000,
      defaultRetainagePercent: 10,
      retainage: { materialsPercent: 10, reductionThresholdPercent: 50, reducedPercent: 5 },
      contractDate: daysFromNow(-30),
      startDate: daysFromNow(-20),
      paymentTermsDays: 30,
    });
    contractId = created["id"] as string;
    expect(created["reference"]).toBe("PC-001");
    expect(created["status"]).toBe("draft");
    expect(created["executed"]).toBe(0);
    expect(created["revisedContractSum"]).toBe(1_000_000);
    expect(created["balanceToFinish"]).toBe(1_000_000);
    expect((created["retainageTerms"] as Record<string, unknown>)["reducedPercent"]).toBe(5);
  });

  it("refuses a contract write from a read-only member and allows the read", async () => {
    const write = await call("POST", `/projects/${projBilling}/prime-contracts`, {
      payload: { title: "Nope" },
      headers: readerHeaders,
    });
    expect(write.statusCode).toBe(403);
    const read = await call("GET", `/prime-contracts/${contractId}`, { headers: readerHeaders });
    expect(read.statusCode).toBe(200);
  });

  it("hides another company's prime contract entirely", async () => {
    const outsider = await registerActor(built.app);
    const res = await call("GET", `/prime-contracts/${contractId}`, {
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("accepts a schedule of values that totals the contract sum", async () => {
    const res = await call("PUT", `/prime-contracts/${contractId}/sov`, {
      payload: { lines: STANDARD_SOV },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ identity: { ok: boolean; sovTotal: number } }>();
    expect(body.identity.ok).toBe(true);
    expect(body.identity.sovTotal).toBe(1_000_000);
  });

  it("refuses execution while the contract is unapproved", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/execute`, {
      payload: { executionDate: today() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/approve it before/);
  });

  it("refuses self-approval of a prime contract", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/approve`, { payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ message: string }>().message).toMatch(/segregation of duties/);
  });

  it("approves under a second pair of eyes", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/approve`, {
      payload: {},
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; approvedBy: string }>();
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe(certifier.userId);
  });

  it("refuses an execution date that precedes the award", async () => {
    await call("PATCH", `/prime-contracts/${contractId}`, {
      payload: { contractDate: daysFromNow(5) },
    });
    const res = await call("POST", `/prime-contracts/${contractId}/execute`, {
      payload: { executionDate: today() },
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/before it is awarded/);
    await call("PATCH", `/prime-contracts/${contractId}`, {
      payload: { contractDate: daysFromNow(-30) },
    });
  });

  it("executes, and only then is the contract billable", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/execute`, {
      payload: { executionDate: today(), signedContractReceivedDate: today() },
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ executed: number; executionDate: string; reconciled: boolean }>();
    expect(body.executed).toBe(1);
    expect(body.executionDate).toBe(today());
    expect(body.reconciled).toBe(true);
  });

  it("refuses to retype the contract sum of an executed contract", async () => {
    const res = await call("PATCH", `/prime-contracts/${contractId}`, {
      payload: { originalContractSum: 1_200_000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/executed change order/);
  });

  it("refuses to replace the schedule of values once executed", async () => {
    const res = await call("PUT", `/prime-contracts/${contractId}/sov`, {
      payload: { lines: STANDARD_SOV },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/signed instrument/);
  });
});

/* ================================================================== */
/* 3. The SOV-equals-contract-sum identity                             */
/* ================================================================== */

describe("schedule of values — the identity is the point", () => {
  let sovContract: string;

  it("refuses a schedule that does not total the contract sum, naming the gap", async () => {
    const created = await createContract(projSov, {
      title: "Identity harness",
      originalContractSum: 1_000_000,
      defaultRetainagePercent: 5,
    });
    sovContract = created["id"] as string;
    const res = await call("PUT", `/prime-contracts/${sovContract}/sov`, {
      payload: {
        lines: [
          { lineNumber: "01", description: "A", scheduledValue: 600_000 },
          { lineNumber: "02", description: "B", scheduledValue: 412_500 },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ message: string; details: { discrepancy: number; direction: string } }>();
    expect(body.message).toContain("12,500.00");
    expect(body.details.discrepancy).toBe(12_500);
    expect(body.details.direction).toBe("over");
  });

  it("lets the schedule define the sum when told to, bottom-up", async () => {
    const res = await call("PUT", `/prime-contracts/${sovContract}/sov`, {
      payload: {
        lines: [
          { lineNumber: "01", description: "A", scheduledValue: 600_000 },
          { lineNumber: "02", description: "B", scheduledValue: 412_500 },
        ],
        syncContractSum: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const detail = await call("GET", `/prime-contracts/${sovContract}`);
    expect(detail.json<{ originalContractSum: number }>().originalContractSum).toBe(1_012_500);
    expect(detail.json<{ reconciled: boolean }>().reconciled).toBe(true);
  });

  it("refuses to move the contract sum without saying where it lands", async () => {
    const res = await call("PATCH", `/prime-contracts/${sovContract}`, {
      payload: { originalContractSum: 1_112_500 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ details: { discrepancy: number } }>().details.discrepancy).toBe(-100_000);
  });

  it("grows the contract with a line that brings its own scope", async () => {
    const res = await call("POST", `/prime-contracts/${sovContract}/sov/lines`, {
      payload: {
        lineNumber: "03",
        description: "C",
        scheduledValue: 100_000,
        raiseContractSum: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const detail = await call("GET", `/prime-contracts/${sovContract}`);
    const body = detail.json<{ originalContractSum: number; reconciled: boolean }>();
    expect(body.originalContractSum).toBe(1_112_500);
    expect(body.reconciled).toBe(true);
  });

  it("refuses a new line that would put the schedule out of balance", async () => {
    const res = await call("POST", `/prime-contracts/${sovContract}/sov/lines`, {
      payload: { lineNumber: "04", description: "D", scheduledValue: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toContain("1.00");
  });

  it("refuses a line-value edit that unbalances the sheet", async () => {
    const sov = await call("GET", `/prime-contracts/${sovContract}/sov`);
    const lines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
    const target = lines.find((l) => l.lineNumber === "01")!;
    const res = await call("PATCH", `/prime-contracts/${sovContract}/sov/lines/${target.id}`, {
      payload: { scheduledValue: 650_000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ details: { discrepancy: number } }>().details.discrepancy).toBe(50_000);
  });

  it("moves value between lines when told where it comes from", async () => {
    const sov = await call("GET", `/prime-contracts/${sovContract}/sov`);
    const lines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
    const from = lines.find((l) => l.lineNumber === "02")!;
    const to = lines.find((l) => l.lineNumber === "01")!;
    const res = await call("PATCH", `/prime-contracts/${sovContract}/sov/lines/${to.id}`, {
      payload: { scheduledValue: 650_000, absorbIntoLineId: from.id },
    });
    expect(res.statusCode).toBe(200);
    const after = await call("GET", `/prime-contracts/${sovContract}/sov`);
    const body = after.json<{ identity: { ok: boolean }; lines: Array<{ lineNumber: string; scheduledValue: number }> }>();
    expect(body.identity.ok).toBe(true);
    expect(body.lines.find((l) => l.lineNumber === "01")?.scheduledValue).toBe(650_000);
    expect(body.lines.find((l) => l.lineNumber === "02")?.scheduledValue).toBe(362_500);
  });

  it("deletes a line by absorbing its value into another", async () => {
    const sov = await call("GET", `/prime-contracts/${sovContract}/sov`);
    const lines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
    const doomed = lines.find((l) => l.lineNumber === "03")!;
    const keeper = lines.find((l) => l.lineNumber === "01")!;
    const res = await call("DELETE", `/prime-contracts/${sovContract}/sov/lines/${doomed.id}`, {
      payload: { absorbIntoLineId: keeper.id },
    });
    expect(res.statusCode).toBe(200);
    const after = await call("GET", `/prime-contracts/${sovContract}/sov`);
    expect(after.json<{ identity: { ok: boolean } }>().identity.ok).toBe(true);
    expect(
      after
        .json<{ lines: Array<{ lineNumber: string; scheduledValue: number }> }>()
        .lines.find((l) => l.lineNumber === "01")?.scheduledValue,
    ).toBe(750_000);
  });

  it("takes a contract sum reduction out of a named line", async () => {
    const sov = await call("GET", `/prime-contracts/${sovContract}/sov`);
    const lines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
    const target = lines.find((l) => l.lineNumber === "02")!;
    const res = await call("PATCH", `/prime-contracts/${sovContract}`, {
      payload: { originalContractSum: 1_100_000, absorbIntoLineId: target.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ originalContractSum: number; reconciled: boolean }>();
    expect(body.originalContractSum).toBe(1_100_000);
    expect(body.reconciled).toBe(true);
    const after = await call("GET", `/prime-contracts/${sovContract}/sov`);
    expect(
      after
        .json<{ lines: Array<{ lineNumber: string; scheduledValue: number }> }>()
        .lines.find((l) => l.lineNumber === "02")?.scheduledValue,
    ).toBe(350_000);
  });

  it("refuses a duplicate line number", async () => {
    const res = await call("PUT", `/prime-contracts/${sovContract}/sov`, {
      payload: {
        lines: [
          { lineNumber: "01", description: "A", scheduledValue: 500_000 },
          { lineNumber: "01", description: "A again", scheduledValue: 612_500 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/Duplicate SOV line number/);
  });
});

/* ================================================================== */
/* 4. Progress billing — the G702/G703 application                     */
/* ================================================================== */

describe("progress billing", () => {
  let application1: string;
  let application2: string;
  let sovLines: Array<{ id: string; lineNumber: string }> = [];

  it("refuses to bill an unexecuted contract", async () => {
    const draft = await createContract(projBilling, {
      title: "Not executed",
      originalContractSum: 10_000,
    });
    const res = await call("POST", `/prime-contracts/${draft["id"] as string}/billings`, {
      payload: { billingDate: today() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/not executed/);
  });

  it("opens an application auto-populated from the schedule of values", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings`, {
      payload: { billingDate: today(), periodStart: daysFromNow(-30), periodEnd: today() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      application: { id: string; reference: string; status: string; contractSumToDate: number };
      g703: Array<{ lineNumber: string; scheduledValue: number; previousBilled: number }>;
      g702: { totalCompletedAndStored: number; currentPaymentDue: number };
    }>();
    application1 = body.application.id;
    expect(body.application.reference).toBe("PA-001");
    expect(body.application.status).toBe("draft");
    expect(body.application.contractSumToDate).toBe(1_000_000);
    expect(body.g703).toHaveLength(4);
    expect(body.g703.every((l) => l.previousBilled === 0)).toBe(true);
    expect(body.g702.totalCompletedAndStored).toBe(0);
    expect(body.g702.currentPaymentDue).toBe(0);
    const sov = await call("GET", `/prime-contracts/${contractId}/sov`);
    sovLines = sov.json<{ lines: Array<{ id: string; lineNumber: string }> }>().lines;
  });

  it("refuses a second open application on the same contract", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings`, {
      payload: { billingDate: today() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/still open/);
  });

  const idOf = (lineNumber: string): string =>
    sovLines.find((l) => l.lineNumber === lineNumber)!.id;

  it("computes the hand-worked AIA figures for application 1", async () => {
    const res = await call("PUT", `/prime-contracts/${contractId}/billings/${application1}/lines`, {
      payload: {
        lines: [
          { sovLineId: idOf("01"), thisPeriodWork: 50_000 },
          { sovLineId: idOf("02"), thisPeriodWork: 100_000 },
          { sovLineId: idOf("03"), materialsPresentlyStored: 60_000 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      g702: Record<string, number>;
      g703: Array<Record<string, unknown>>;
      identities: Array<{ ok: boolean }>;
      reconciled: boolean;
    }>();
    expect(body.g702["completedToDate"]).toBe(150_000);
    expect(body.g702["storedMaterials"]).toBe(60_000);
    expect(body.g702["totalCompletedAndStored"]).toBe(210_000);
    expect(body.g702["retainageWork"]).toBe(15_000);
    expect(body.g702["retainageMaterials"]).toBe(6_000);
    expect(body.g702["totalRetainage"]).toBe(21_000);
    expect(body.g702["totalEarnedLessRetainage"]).toBe(189_000);
    expect(body.g702["lessPreviousCertificates"]).toBe(0);
    expect(body.g702["currentPaymentDue"]).toBe(189_000);
    expect(body.g702["balanceToFinishPlusRetainage"]).toBe(811_000);
    expect(body.reconciled).toBe(true);
  });

  it("prints the G703 continuation sheet line by line", async () => {
    const res = await call("GET", `/prime-contracts/${contractId}/billings/${application1}`);
    const body = res.json<{ g703: Array<Record<string, unknown>> }>();
    expect(line(body, "01")["percentComplete"]).toBe(50);
    expect(line(body, "02")["totalCompletedAndStored"]).toBe(100_000);
    expect(line(body, "03")["materialsPresentlyStored"]).toBe(60_000);
    expect(line(body, "03")["balanceToFinish"]).toBe(340_000);
    expect(line(body, "04")["totalCompletedAndStored"]).toBe(0);
    const sheetTotal = body.g703.reduce(
      (s, l) => s + (l["totalCompletedAndStored"] as number),
      0,
    );
    expect(sheetTotal).toBe(210_000);
  });

  it("refuses to bill more than a line's scheduled value", async () => {
    const res = await call("PUT", `/prime-contracts/${contractId}/billings/${application1}/lines`, {
      payload: { lines: [{ sovLineId: idOf("01"), thisPeriodWork: 150_000 }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ message: string; details: { reasons: string[] } }>();
    expect(body.details.reasons[0]).toMatch(/over-billed by 50,000.00/);
  });

  it("leaves the schedule of values' carried-forward columns untouched while a draft", async () => {
    const sov = await call("GET", `/prime-contracts/${contractId}/sov`);
    const lines = sov.json<{
      lines: Array<{ lineNumber: string; previousBilled: number; thisPeriodWork: number }>;
    }>().lines;
    const one = lines.find((l) => l.lineNumber === "01")!;
    expect(one.previousBilled).toBe(0); // only certification moves this
    expect(one.thisPeriodWork).toBe(50_000); // but the live position is mirrored
  });

  it("records the contractor's sworn certification on submission", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application1}/submit`, {
      payload: { certifiedByContractorName: "R. Okonkwo, Project Executive", notaryReference: "N-8841" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      application: {
        status: string;
        certifiedByContractorName: string;
        contractorCertifiedAt: string | null;
        submittedBy: string;
      };
    }>();
    expect(body.application.status).toBe("submitted");
    expect(body.application.certifiedByContractorName).toContain("Okonkwo");
    expect(body.application.contractorCertifiedAt).not.toBeNull();
    expect(body.application.submittedBy).toBe(owner.userId);
  });

  it("refuses line edits once submitted", async () => {
    const res = await call("PUT", `/prime-contracts/${contractId}/billings/${application1}/lines`, {
      payload: { lines: [{ sovLineId: idOf("01"), thisPeriodWork: 10_000 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/frozen/);
  });

  it("refuses certification by the person who submitted it", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application1}/certify`, {
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ message: string }>().message).toMatch(/segregation of duties/);
  });

  it("refuses to certify more than was applied for", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application1}/certify`, {
      payload: { certifiedAmount: 200_000 },
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/never more/);
  });

  it("certifies, and the schedule of values rolls forward", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application1}/certify`, {
      payload: { certificationNotes: "Certified in full." },
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ application: { status: string; certifiedAmount: number; certifiedBy: string } }>();
    expect(body.application.status).toBe("certified");
    expect(body.application.certifiedAmount).toBe(189_000);
    expect(body.application.certifiedBy).toBe(certifier.userId);

    const sov = await call("GET", `/prime-contracts/${contractId}/sov`);
    const lines = sov.json<{
      lines: Array<{
        lineNumber: string;
        previousBilled: number;
        previousStoredMaterials: number;
        thisPeriodWork: number;
        retainageHeld: number;
      }>;
    }>().lines;
    const one = lines.find((l) => l.lineNumber === "01")!;
    expect(one.previousBilled).toBe(50_000);
    expect(one.thisPeriodWork).toBe(0);
    expect(one.retainageHeld).toBe(5_000);
    const three = lines.find((l) => l.lineNumber === "03")!;
    expect(three.previousStoredMaterials).toBe(60_000);
    expect(three.retainageHeld).toBe(6_000);
  });

  it("updates the contract's billed position from the certified lines", async () => {
    const res = await call("GET", `/prime-contracts/${contractId}`);
    const body = res.json<{
      totalBilled: number;
      retainageHeld: number;
      balanceToFinish: number;
      reconciled: boolean;
      identities: Array<{ identity: string; ok: boolean }>;
    }>();
    expect(body.totalBilled).toBe(210_000);
    expect(body.retainageHeld).toBe(21_000);
    expect(body.balanceToFinish).toBe(790_000);
    expect(body.reconciled).toBe(true);
    expect(body.identities.every((i) => i.ok)).toBe(true);
  });

  it("refuses to reopen a certified application", async () => {
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application1}/reopen`, {
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/does not reopen/);
  });

  it("steps retainage down once the work passes the threshold", async () => {
    const created = await call("POST", `/prime-contracts/${contractId}/billings`, {
      payload: { billingDate: today(), periodStart: today(), periodEnd: daysFromNow(30) },
    });
    expect(created.statusCode).toBe(201);
    application2 = created.json<{ application: { id: string; reference: string } }>().application.id;
    expect(
      created.json<{ application: { reference: string } }>().application.reference,
    ).toBe("PA-002");

    const res = await call("PUT", `/prime-contracts/${contractId}/billings/${application2}/lines`, {
      payload: {
        lines: [
          { sovLineId: idOf("01"), thisPeriodWork: 50_000 },
          { sovLineId: idOf("02"), thisPeriodWork: 150_000 },
          { sovLineId: idOf("03"), thisPeriodWork: 250_000, materialsPresentlyStored: 0 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ g702: Record<string, number>; g703: Array<Record<string, unknown>> }>();
    expect(body.g702["totalCompletedAndStored"]).toBe(600_000);
    expect(body.g702["retainagePercentWork"]).toBe(5);
    expect(body.g702["totalRetainage"]).toBe(30_000);
    expect(body.g702["totalEarnedLessRetainage"]).toBe(570_000);
    expect(body.g702["lessPreviousCertificates"]).toBe(189_000);
    expect(body.g702["currentPaymentDue"]).toBe(381_000);
    expect(body.g702["balanceToFinishPlusRetainage"]).toBe(430_000);
  });

  it("reconciles the sum of line amounts to the current payment due", async () => {
    const res = await call("GET", `/prime-contracts/${contractId}/billings/${application2}`);
    const body = res.json<{ g702: Record<string, number>; g703: Array<Record<string, unknown>> }>();
    const sumOfLines = body.g703.reduce((s, l) => s + (l["amount"] as number), 0);
    expect(Math.round(sumOfLines * 100) / 100).toBe(body.g702["currentPaymentDue"]);
    expect(line(body, "03")["thisPeriodStoredMaterials"]).toBe(-60_000);
    expect(line(body, "03")["retainageThisPeriod"]).toBe(6_500);
  });

  it("reopens an application that has not been certified", async () => {
    await call("POST", `/prime-contracts/${contractId}/billings/${application2}/submit`, {
      payload: { certifiedByContractorName: "R. Okonkwo" },
    });
    const res = await call("POST", `/prime-contracts/${contractId}/billings/${application2}/reopen`, {
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ application: { status: string; submittedBy: string | null } }>();
    expect(body.application.status).toBe("draft");
    expect(body.application.submittedBy).toBeNull();
  });

  it("carries a certification shortfall onto the next application", async () => {
    await call("POST", `/prime-contracts/${contractId}/billings/${application2}/submit`, {
      payload: { certifiedByContractorName: "R. Okonkwo" },
    });
    const certified = await call(
      "POST",
      `/prime-contracts/${contractId}/billings/${application2}/certify`,
      {
        payload: { certifiedAmount: 350_000, certificationNotes: "31,000 disputed on concrete." },
        headers: certifierHeaders,
      },
    );
    expect(certified.statusCode).toBe(200);
    expect(certified.json<{ application: { status: string } }>().application.status).toBe(
      "partially_certified",
    );

    const third = await call("POST", `/prime-contracts/${contractId}/billings`, {
      payload: { billingDate: daysFromNow(31) },
    });
    expect(third.statusCode).toBe(201);
    const body = third.json<{ g702: Record<string, number> }>();
    // 189,000 + 350,000 actually certified — not the 570,000 applied for
    expect(body.g702["lessPreviousCertificates"]).toBe(539_000);
    expect(body.g702["currentPaymentDue"]).toBe(31_000);
  });

  it("refuses to bill into a locked billing period", async () => {
    const periodId = newId("bp");
    await built.app.db.insert(billingPeriods).values({
      id: periodId,
      companyId: owner.companyId,
      projectId: projBilling,
      number: 99,
      reference: "BP-099",
      name: "Locked month",
      status: "locked",
      startDate: daysFromNow(60),
      endDate: daysFromNow(90),
      billingDate: daysFromNow(90),
      createdBy: owner.userId,
    });
    const open = await built.app.db
      .select({ id: paymentApplications.id })
      .from(paymentApplications)
      .where(
        and(
          eq(paymentApplications.primeContractId, contractId),
          eq(paymentApplications.status, "draft"),
        ),
      );
    for (const row of open) {
      await built.app.db
        .update(paymentApplications)
        .set({ status: "void" })
        .where(eq(paymentApplications.id, row.id));
    }
    const res = await call("POST", `/prime-contracts/${contractId}/billings`, {
      payload: { billingDate: daysFromNow(90), billingPeriodId: periodId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/is locked/);
  });
});

/* ================================================================== */
/* 5. Change orders into the contract sum and the SOV                  */
/* ================================================================== */

describe("prime contract change orders", () => {
  let coContract: string;
  let changeId: string;

  it("sets up an executed contract to change", async () => {
    const created = await createContract(projChange, {
      title: "Change harness",
      originalContractSum: 500_000,
      defaultRetainagePercent: 10,
      contractDate: daysFromNow(-10),
    });
    coContract = created["id"] as string;
    await call("PUT", `/prime-contracts/${coContract}/sov`, {
      payload: {
        lines: [
          { lineNumber: "01", description: "Base A", scheduledValue: 300_000, costCode: "03-100" },
          { lineNumber: "02", description: "Base B", scheduledValue: 200_000 },
        ],
      },
    });
    await call("POST", `/prime-contracts/${coContract}/approve`, {
      payload: {},
      headers: certifierHeaders,
    });
    const executed = await call("POST", `/prime-contracts/${coContract}/execute`, {
      payload: { executionDate: today() },
      headers: certifierHeaders,
    });
    expect(executed.json<{ executed: number }>().executed).toBe(1);
  });

  it("raises a change order without touching the contract sum", async () => {
    const res = await call("POST", `/prime-contracts/${coContract}/changes`, {
      payload: {
        title: "Owner-directed lobby upgrade",
        reason: "client_request",
        scheduleImpactDays: 5,
        lines: [
          { description: "Stone flooring", amount: 40_000, costCode: "09-600" },
          { description: "Lighting", amount: 10_000 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; reference: string; amount: number; status: string }>();
    changeId = body.id;
    expect(body.reference).toBe("PCCO-001");
    expect(body.amount).toBe(50_000);
    expect(body.status).toBe("draft");
    const contract = await call("GET", `/prime-contracts/${coContract}`);
    const view = contract.json<{ revisedContractSum: number; draftChangeSum: number }>();
    expect(view.revisedContractSum).toBe(500_000); // drafts are NOT in the sum
    expect(view.draftChangeSum).toBe(50_000);
  });

  it("refuses an allocation that does not account for the whole amount", async () => {
    const res = await call("POST", `/prime-contracts/${coContract}/changes`, {
      payload: {
        title: "Mis-allocated",
        amount: 20_000,
        lines: [{ description: "Only part of it", amount: 5_000 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/must account for the whole amount/);
  });

  it("refuses execution before approval", async () => {
    await call("POST", `/prime-contracts/${coContract}/changes/${changeId}/submit`, { payload: {} });
    const res = await call("POST", `/prime-contracts/${coContract}/changes/${changeId}/execute`, {
      payload: {},
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toMatch(/only after it is approved/);
  });

  it("moves a submitted change into the pending bucket, still outside the sum", async () => {
    const contract = await call("GET", `/prime-contracts/${coContract}`);
    const view = contract.json<{
      revisedContractSum: number;
      pendingChangeSum: number;
      draftChangeSum: number;
    }>();
    expect(view.revisedContractSum).toBe(500_000);
    expect(view.pendingChangeSum).toBe(50_000);
    expect(view.draftChangeSum).toBe(0);
  });

  it("refuses approval by the person who raised and submitted it", async () => {
    const res = await call("POST", `/prime-contracts/${coContract}/changes/${changeId}/approve`, {
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ message: string }>().message).toMatch(/segregation of duties/);
  });

  it("executes the change: the sum rises and the SOV gains appended lines", async () => {
    const approved = await call(
      "POST",
      `/prime-contracts/${coContract}/changes/${changeId}/approve`,
      { payload: {}, headers: certifierHeaders },
    );
    expect(approved.statusCode).toBe(200);
    const res = await call("POST", `/prime-contracts/${coContract}/changes/${changeId}/execute`, {
      payload: { executedDate: today() },
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      change: { status: string; revisedContractSum: number };
      appendedLines: Array<{ lineNumber: string; scheduledValue: number }>;
      contract: { revisedContractSum: number; approvedChangeSum: number; reconciled: boolean };
    }>();
    expect(body.change.status).toBe("executed");
    expect(body.change.revisedContractSum).toBe(550_000);
    expect(body.appendedLines.map((l) => l.lineNumber)).toEqual(["CO-001.1", "CO-001.2"]);
    expect(body.appendedLines.map((l) => l.scheduledValue)).toEqual([40_000, 10_000]);
    expect(body.contract.approvedChangeSum).toBe(50_000);
    expect(body.contract.revisedContractSum).toBe(550_000);
    expect(body.contract.reconciled).toBe(true);
  });

  it("keeps the original lines untouched — a change order appends, it never edits", async () => {
    const sov = await call("GET", `/prime-contracts/${coContract}/sov`);
    const body = sov.json<{
      identity: { ok: boolean; sovTotal: number };
      totals: { baseScope: number; changeOrderScope: number };
      lines: Array<{ lineNumber: string; scheduledValue: number; isChangeOrderLine: number }>;
    }>();
    expect(body.identity.ok).toBe(true);
    expect(body.identity.sovTotal).toBe(550_000);
    expect(body.totals.baseScope).toBe(500_000);
    expect(body.totals.changeOrderScope).toBe(50_000);
    expect(body.lines.find((l) => l.lineNumber === "01")?.scheduledValue).toBe(300_000);
    expect(body.lines.filter((l) => l.isChangeOrderLine === 1)).toHaveLength(2);
  });

  it("refuses to edit or re-execute an executed change order", async () => {
    const edit = await call("PATCH", `/prime-contracts/${coContract}/changes/${changeId}`, {
      payload: { title: "Rewriting history" },
    });
    expect(edit.statusCode).toBe(409);
    const again = await call("POST", `/prime-contracts/${coContract}/changes/${changeId}/execute`, {
      payload: {},
      headers: certifierHeaders,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toMatch(/already executed/);
  });

  it("bills the appended change-order line on the next application", async () => {
    const created = await call("POST", `/prime-contracts/${coContract}/billings`, {
      payload: { billingDate: today() },
    });
    expect(created.statusCode).toBe(201);
    const applicationId = created.json<{ application: { id: string } }>().application.id;
    const g703 = created.json<{ g703: Array<{ lineNumber: string; source: string; id: string }> }>().g703;
    expect(g703).toHaveLength(4);
    expect(g703.find((l) => l.lineNumber === "CO-001.1")?.source).toBe("change_order");

    const sov = await call("GET", `/prime-contracts/${coContract}/sov`);
    const coLine = sov
      .json<{ lines: Array<{ id: string; lineNumber: string }> }>()
      .lines.find((l) => l.lineNumber === "CO-001.1")!;
    const res = await call("PUT", `/prime-contracts/${coContract}/billings/${applicationId}/lines`, {
      payload: { lines: [{ sovLineId: coLine.id, percentComplete: 50 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ g702: Record<string, number> }>();
    expect(body.g702["netChangeOrders"]).toBe(50_000);
    expect(body.g702["contractSumToDate"]).toBe(550_000);
    expect(body.g702["totalCompletedAndStored"]).toBe(20_000);
    expect(body.g702["totalRetainage"]).toBe(2_000);
    expect(body.g702["currentPaymentDue"]).toBe(18_000);
  });
});

/* ================================================================== */
/* 6. Portfolio, currency discipline and status                        */
/* ================================================================== */

describe("portfolio and money discipline", () => {
  it("never sums prime contracts across currencies", async () => {
    await createContract(projPortfolio, {
      title: "USD prime",
      currency: "USD",
      originalContractSum: 1_000_000,
    });
    await createContract(projPortfolio, {
      title: "EUR prime",
      currency: "EUR",
      originalContractSum: 250_000,
    });
    const res = await call("GET", `/projects/${projPortfolio}/prime-contracts/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      groups: Array<{ currency: string; revisedContractSum: number }>;
      combinedRevisedContractSum: { value: number | null; reasons: string[] };
    }>();
    expect(body.groups).toHaveLength(2);
    expect(body.groups.find((g) => g.currency === "EUR")?.revisedContractSum).toBe(250_000);
    expect(body.combinedRevisedContractSum.value).toBeNull();
    expect(body.combinedRevisedContractSum.reasons[0]).toMatch(/never summed across currencies/);
  });

  it("reports percent complete as null, not 0, on a contract with no sum", async () => {
    const created = await createContract(projPortfolio, { title: "Sum not yet agreed" });
    const res = await call("GET", `/prime-contracts/${created["id"] as string}`);
    const body = res.json<{ percentComplete: { value: number | null; reasons: string[] } }>();
    expect(body.percentComplete.value).toBeNull();
    expect(body.percentComplete.reasons).toHaveLength(1);
  });

  it("lists and filters prime contracts on a project", async () => {
    const res = await call(
      "GET",
      `/projects/${projPortfolio}/prime-contracts?pageSize=10&status=draft`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ status: string }>; total: number }>();
    expect(body.total).toBe(3);
    expect(body.items.every((c) => c.status === "draft")).toBe(true);
  });

  it("walks the status ladder and refuses illegal transitions", async () => {
    const created = await createContract(projPortfolio, { title: "Status ladder" });
    const id = created["id"] as string;
    const out = await call("POST", `/prime-contracts/${id}/status`, {
      payload: { status: "out_for_bid" },
      headers: certifierHeaders,
    });
    expect(out.json<{ status: string }>().status).toBe("out_for_bid");
    const jump = await call("POST", `/prime-contracts/${id}/status`, {
      payload: { status: "complete" },
      headers: certifierHeaders,
    });
    expect(jump.statusCode).toBe(409);
    const backdoor = await call("POST", `/prime-contracts/${id}/status`, {
      payload: { status: "approved" },
      headers: certifierHeaders,
    });
    expect(backdoor.statusCode).toBe(400);
    expect(backdoor.json<{ message: string }>().message).toMatch(/segregation-of-duties check/);
  });

  it("refuses to delete an executed contract and allows deleting an unbilled draft", async () => {
    const executedDelete = await call("DELETE", `/prime-contracts/${contractId}`, {
      payload: {},
      headers: certifierHeaders,
    });
    expect(executedDelete.statusCode).toBe(409);
    const created = await createContract(projPortfolio, { title: "Disposable" });
    const res = await call("DELETE", `/prime-contracts/${created["id"] as string}`, {
      payload: {},
      headers: certifierHeaders,
    });
    expect(res.statusCode).toBe(200);
    const rows = await built.app.db
      .select()
      .from(primeContracts)
      .where(eq(primeContracts.id, created["id"] as string));
    expect(rows).toHaveLength(0);
  });

  it("holds the SOV lines under the contract they belong to", async () => {
    const rows = await built.app.db
      .select()
      .from(primeContractSovLines)
      .where(eq(primeContractSovLines.primeContractId, contractId));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.projectId === projBilling)).toBe(true);
    expect(Math.round(rows.reduce((s, r) => s + r.revisedScheduledValue, 0))).toBe(1_000_000);
  });
});
