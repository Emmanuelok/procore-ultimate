import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetChanges,
  budgetLineItems,
  budgets,
  commitmentChanges,
  commitmentSovLines,
  commitments,
  companyMemberships,
  costCodes,
  delayEvents,
  ledgerEntries,
  primeContractChanges,
  primeContractSovLines,
  primeContracts,
  projectMemberships,
  projects,
  rfis,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  allocateProRata,
  applyMarkupStack,
  deriveBudgetLine,
  deriveChangeLine,
  markupIdentities,
  stackTotal,
  validateMarkupStack,
  type MarkupRule,
} from "./arithmetic.js";
import { assessCorTimeImpact, reconcileChangeLog } from "./reconcile.js";
import { compareQuotes } from "./quotes.js";
import { pcoPositions } from "./pcos.js";

let built: BuiltApp;
/** company owner — bypasses tool gates; author and submitter throughout */
let u1: TestActor;
/** company admin — the INDEPENDENT approver every segregation test needs */
let u2: TestActor;
/** project_manager member: change_management = standard (never admin) */
let u3: TestActor;
/** read_only member */
let u4: TestActor;
/** an actor in a different company entirely */
let outsider: TestActor;

let h1: Record<string, string>;
let h2: Record<string, string>;
let h3: Record<string, string>;
let h4: Record<string, string>;

let projA: string;
let projB: string;
let contractId: string;
let commitmentId: string;
let budgetId: string;
let lineSub: string; // budget line 03300 / subcontract
let lineLab: string; // budget line 01100 / labour
let vendorA: string;
let vendorB: string;
let rfiId: string;
let delayEventId: string;

/* the chain, threaded through the HTTP tests in order */
let eventId: string;
let pcoSub: string;
let pcoLab: string;
let rfqA: string;
let rfqB: string;
let corId: string;
let primePkgId: string;
let commitmentPkgId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

const OH_PROFIT_BOND: MarkupRule[] = [
  { kind: "percent", label: "Overhead", basis: "cost", rate: 10 },
  { kind: "percent", label: "Profit", basis: "running_total", rate: 5 },
  { kind: "percent", label: "Bond", basis: "running_total", rate: 1 },
];

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app, { companyName: "Change Co" });
  u2 = await registerActor(built.app);
  u3 = await registerActor(built.app);
  u4 = await registerActor(built.app);
  outsider = await registerActor(built.app);

  for (const [actor, role] of [
    [u2, "admin"],
    [u3, "member"],
    [u4, "member"],
  ] as const) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: u1.companyId,
      userId: actor.userId,
      role,
    });
  }
  h1 = u1.headers;
  h2 = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };
  h3 = { authorization: `Bearer ${u3.accessToken}`, "x-company-id": u1.companyId };
  h4 = { authorization: `Bearer ${u4.accessToken}`, "x-company-id": u1.companyId };

  projA = newId("prj");
  projB = newId("prj");
  await built.app.db.insert(projects).values([
    {
      id: projA,
      companyId: u1.companyId,
      name: "Tower A",
      currency: "USD",
      settings: {
        changeManagementTier: "two_tier",
        changeMarkups: OH_PROFIT_BOND,
      },
    },
    { id: projB, companyId: u1.companyId, name: "Depot B", currency: "USD" },
  ]);
  for (const projectId of [projA, projB]) {
    await built.app.db.insert(projectMemberships).values([
      {
        id: newId("pm"),
        companyId: u1.companyId,
        projectId,
        userId: u3.userId,
        templateKey: "project_manager",
        overrides: {},
      },
      {
        id: newId("pm"),
        companyId: u1.companyId,
        projectId,
        userId: u4.userId,
        templateKey: "read_only",
        overrides: {},
      },
    ]);
  }

  await built.app.db.insert(costCodes).values([
    { id: newId("cc"), companyId: u1.companyId, code: "03300", title: "Cast-in-place concrete", costType: "subcontract" },
    { id: newId("cc"), companyId: u1.companyId, code: "01100", title: "General labour", costType: "labour" },
  ]);

  vendorA = newId("ven");
  vendorB = newId("ven");
  await built.app.db.insert(vendors).values([
    { id: vendorA, companyId: u1.companyId, name: "Apex Concrete" },
    { id: vendorB, companyId: u1.companyId, name: "Bedrock Forming" },
  ]);

  contractId = newId("pc");
  await built.app.db.insert(primeContracts).values({
    id: contractId,
    companyId: u1.companyId,
    projectId: projA,
    number: 1,
    reference: "PC-001",
    title: "Main construction contract",
    status: "approved",
    executed: 1,
    currency: "USD",
    originalContractSum: 1_000_000,
    revisedContractSum: 1_000_000,
    defaultRetainagePercent: 5,
    createdBy: u1.userId,
  });
  await built.app.db.insert(primeContractSovLines).values({
    id: newId("sov"),
    companyId: u1.companyId,
    projectId: projA,
    primeContractId: contractId,
    lineNumber: "1",
    sortOrder: 10,
    costCode: "03300",
    costType: "subcontract",
    description: "Base scope",
    scheduledValue: 1_000_000,
    revisedScheduledValue: 1_000_000,
    balanceToFinish: 1_000_000,
  });

  budgetId = newId("bdg");
  await built.app.db.insert(budgets).values({
    id: budgetId,
    companyId: u1.companyId,
    projectId: projA,
    number: 1,
    reference: "BUD-001",
    name: "Baseline",
    status: "locked",
    isActive: 1,
    currency: "USD",
    originalBudgetTotal: 700_000,
    revisedBudgetTotal: 700_000,
    createdBy: u1.userId,
  });
  lineSub = newId("bli");
  lineLab = newId("bli");
  await built.app.db.insert(budgetLineItems).values([
    {
      id: lineSub,
      budgetId,
      companyId: u1.companyId,
      projectId: projA,
      costCode: "03300",
      costType: "subcontract",
      description: "Concrete subcontract",
      originalBudget: 500_000,
      revisedBudget: 500_000,
      committedCost: 400_000,
      forecastMethod: "remaining_budget",
      forecastToComplete: 500_000,
      forecastFinal: 500_000,
      createdBy: u1.userId,
    },
    {
      id: lineLab,
      budgetId,
      companyId: u1.companyId,
      projectId: projA,
      costCode: "01100",
      costType: "labour",
      description: "Self-performed labour",
      originalBudget: 200_000,
      revisedBudget: 200_000,
      forecastMethod: "manual",
      forecastToComplete: 200_000,
      forecastFinal: 200_000,
      createdBy: u1.userId,
    },
  ]);

  commitmentId = newId("cmt");
  await built.app.db.insert(commitments).values({
    id: commitmentId,
    companyId: u1.companyId,
    projectId: projA,
    kind: "subcontract",
    number: 1,
    reference: "SC-0001",
    title: "Concrete subcontract",
    status: "approved",
    executed: 1,
    currency: "USD",
    vendorId: vendorA,
    primeContractId: contractId,
    originalCommitmentSum: 400_000,
    revisedCommitmentSum: 400_000,
    defaultRetainagePercent: 5,
    createdBy: u1.userId,
  });
  await built.app.db.insert(commitmentSovLines).values({
    id: newId("csv"),
    companyId: u1.companyId,
    projectId: projA,
    commitmentId,
    lineNumber: "1",
    sortOrder: 10,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    description: "Base subcontract scope",
    scheduledValue: 400_000,
    revisedScheduledValue: 400_000,
    balanceToFinish: 400_000,
  });

  rfiId = newId("rfi");
  await built.app.db.insert(rfis).values({
    id: rfiId,
    companyId: u1.companyId,
    projectId: projA,
    number: 42,
    subject: "Slab thickness at grid C4",
    question: "Drawing S-201 shows 200mm; spec says 250mm. Which governs?",
    status: "closed",
    officialResponse: "250mm governs. Revise placement.",
    createdBy: u1.userId,
  });

  delayEventId = newId("dly");
  await built.app.db.insert(delayEvents).values({
    id: delayEventId,
    companyId: u1.companyId,
    projectId: projA,
    number: 7,
    title: "Slab redesign hold",
    cause: "design_change",
    excusable: 1,
    compensable: 1,
    status: "open",
    startDate: "2026-04-01",
    durationDays: 6,
    tiaResult: { completionDeltaDays: 3, computedAt: "2026-04-20T00:00:00.000Z" },
    raisedBy: u1.userId,
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* 1. The markup stack — hand-worked figures                           */
/* ================================================================== */

describe("markup stack", () => {
  const lines = [
    { costAmount: 40_000, costType: "labour" as const, quantity: null },
    { costAmount: 25_000, costType: "material" as const, quantity: null },
    { costAmount: 5_000, costType: "equipment" as const, quantity: null },
    { costAmount: 30_000, costType: "subcontract" as const, quantity: null },
  ];

  it("compounds in sequence: 10% OH, 5% profit, 1% bond on 100,000 = 116,655", () => {
    const r = applyMarkupStack(lines, OH_PROFIT_BOND);
    expect(r.costSubtotal).toBe(100_000);
    expect(r.applied.map((a) => a.amount)).toEqual([10_000, 5_500, 1_155]);
    expect(r.applied.map((a) => a.runningTotalAfter)).toEqual([110_000, 115_500, 116_655]);
    expect(r.markupTotal).toBe(16_655);
    expect(r.total).toBe(116_655);
    expect(r.reasons).toEqual([]);
  });

  it("the SAME rates on a cost basis produce 116,000 — the order-of-application dispute, in numbers", () => {
    const flat: MarkupRule[] = OH_PROFIT_BOND.map((m) => ({ ...m, basis: "cost" }));
    const r = applyMarkupStack(lines, flat);
    expect(r.applied.map((a) => a.amount)).toEqual([10_000, 5_000, 1_000]);
    expect(r.total).toBe(116_000);
    expect(applyMarkupStack(lines, OH_PROFIT_BOND).total - r.total).toBe(655);
  });

  it("records the basis each step multiplied, so the stack is reproducible on paper", () => {
    const r = applyMarkupStack(lines, OH_PROFIT_BOND);
    expect(r.applied.map((a) => a.basisAmount)).toEqual([100_000, 110_000, 115_500]);
    expect(r.applied.map((a) => a.sequence)).toEqual([1, 2, 3]);
  });

  it("honours an explicit sequence over array order", () => {
    const reordered: MarkupRule[] = [
      { kind: "percent", label: "Bond", basis: "running_total", rate: 1, sequence: 3 },
      { kind: "percent", label: "Overhead", basis: "cost", rate: 10, sequence: 1 },
      { kind: "percent", label: "Profit", basis: "running_total", rate: 5, sequence: 2 },
    ];
    const r = applyMarkupStack(lines, reordered);
    expect(r.applied.map((a) => a.label)).toEqual(["Overhead", "Profit", "Bond"]);
    expect(r.total).toBe(116_655);
  });

  it("narrows a cost basis to named cost types", () => {
    const r = applyMarkupStack(lines, [
      { kind: "percent", label: "Overhead", basis: "cost", rate: 10, costTypes: ["labour", "material"] },
    ]);
    expect(r.applied[0]!.basisAmount).toBe(65_000);
    expect(r.applied[0]!.amount).toBe(6_500);
    expect(r.costByType["subcontract"]).toBe(30_000);
  });

  it("applies a contractual cap and says which cap bit", () => {
    const r = applyMarkupStack(lines, [
      { kind: "percent", label: "OH&P", basis: "cost", rate: 10, maxAmount: 7_500 },
    ]);
    expect(r.applied[0]!.computedAmount).toBe(10_000);
    expect(r.applied[0]!.amount).toBe(7_500);
    expect(r.applied[0]!.cappedBy).toBe(7_500);
    expect(r.total).toBe(107_500);
  });

  it("takes the same markup off a value-engineering credit", () => {
    const credit = [{ costAmount: -50_000, costType: "subcontract" as const, quantity: null }];
    const r = applyMarkupStack(credit, OH_PROFIT_BOND);
    expect(r.applied.map((a) => a.amount)).toEqual([-5_000, -2_750, -577.5]);
    expect(r.total).toBe(-58_327.5);
  });

  it("a fixed amount multiplies nothing and still compounds under later markups", () => {
    const r = applyMarkupStack(lines, [
      { kind: "fixed_amount", label: "Mobilisation", basis: "none", rate: 2_500 },
      { kind: "percent", label: "Profit", basis: "running_total", rate: 5 },
    ]);
    expect(r.applied[0]!.amount).toBe(2_500);
    expect(r.applied[1]!.basisAmount).toBe(102_500);
    expect(r.applied[1]!.amount).toBe(5_125);
  });

  it("a per-unit markup over lines with no quantity is UNKNOWN, not zero", () => {
    const r = applyMarkupStack(lines, [
      { kind: "per_unit", label: "Crane hours", basis: "quantity", rate: 40 },
    ]);
    expect(r.applied[0]!.amount).toBe(0);
    expect(r.reasons.join(" ")).toContain("unknown, not zero");
    expect(stackTotal(r).value).toBeNull();
    expect(stackTotal(r).reasons.length).toBeGreaterThan(0);
  });

  it("a per-unit markup computes when the lines carry quantities", () => {
    const measured = [
      { costAmount: 10_000, costType: "labour" as const, quantity: 120 },
      { costAmount: 5_000, costType: "equipment" as const, quantity: 30 },
    ];
    const r = applyMarkupStack(measured, [
      { kind: "per_unit", label: "Crane hours", basis: "quantity", rate: 40 },
    ]);
    expect(r.quantityTotal).toBe(150);
    expect(r.applied[0]!.amount).toBe(6_000);
    expect(stackTotal(r).value).toBe(21_000);
  });

  it("a markup charged on prior markups, placed first, is refused as unknown", () => {
    const r = applyMarkupStack(lines, [
      { kind: "percent", label: "Insurance", basis: "markups_to_date", rate: 2 },
    ]);
    expect(r.applied[0]!.amount).toBe(0);
    expect(r.reasons.join(" ")).toContain("first in the stack");
  });

  it("markup identities reconcile", () => {
    const r = applyMarkupStack(lines, OH_PROFIT_BOND);
    expect(markupIdentities(r).every((i) => i.ok)).toBe(true);
  });
});

describe("markup stack validation", () => {
  const problems = (rules: MarkupRule[]) => validateMarkupStack(rules).join(" ");

  it("refuses two markups with the same label", () => {
    expect(
      problems([
        { kind: "percent", label: "Bond", basis: "cost", rate: 1 },
        { kind: "percent", label: " bond ", basis: "cost", rate: 1 },
      ]),
    ).toContain("charged twice");
  });

  it("refuses a percentage outside 0–100", () => {
    expect(problems([{ kind: "percent", label: "OH", basis: "cost", rate: 150 }])).toContain(
      "outside 0–100%",
    );
    expect(problems([{ kind: "percent", label: "OH", basis: "cost", rate: -5 }])).toContain(
      "negative markup rate",
    );
  });

  it("refuses a percentage on a quantity basis and a fixed amount on a cost basis", () => {
    expect(problems([{ kind: "percent", label: "OH", basis: "quantity", rate: 5 }])).toContain(
      "not a percentage basis",
    );
    expect(
      problems([{ kind: "fixed_amount", label: "Fee", basis: "cost", rate: 500 }]),
    ).toContain('basis must be "none"');
  });

  it("refuses cost-type narrowing on a compounding basis", () => {
    expect(
      problems([
        { kind: "percent", label: "OH", basis: "cost", rate: 10 },
        { kind: "percent", label: "Profit", basis: "running_total", rate: 5, costTypes: ["labour"] },
      ]),
    ).toContain("cannot be narrowed to a cost type");
  });

  it("accepts a well-formed stack", () => {
    expect(validateMarkupStack(OH_PROFIT_BOND)).toEqual([]);
  });
});

/* ================================================================== */
/* 2. Line derivation and allocation                                   */
/* ================================================================== */

describe("change line derivation", () => {
  it("derives cost from quantity x rate", () => {
    const r = deriveChangeLine({ quantity: 200, unitRate: 50 });
    expect(r.ok && r.line.costAmount).toBe(10_000);
  });

  it("refuses a stated cost that contradicts the quantity and rate", () => {
    const r = deriveChangeLine({ quantity: 200, unitRate: 50, costAmount: 12_000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("contradict");
  });

  it("refuses a line with no priced basis at all", () => {
    const r = deriveChangeLine({});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("a note, not a cost");
  });

  it("derives revenue as cost plus line markup, and taxes the revenue", () => {
    const r = deriveChangeLine({
      costAmount: 10_000,
      markupKind: "percent",
      markupPercent: 15,
      taxPercent: 10,
    });
    expect(r.ok && r.line.markupAmount).toBe(1_500);
    expect(r.ok && r.line.revenueAmount).toBe(11_500);
    expect(r.ok && r.line.taxAmount).toBe(1_150);
    expect(r.ok && r.line.margin).toBe(1_500);
  });

  it("refuses a per-unit line markup with no quantity", () => {
    const r = deriveChangeLine({ costAmount: 1_000, markupKind: "per_unit", markupPercent: 5 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("unknown, not zero");
  });
});

describe("pro-rata allocation", () => {
  it("makes the parts sum to the whole exactly, parking the residual", () => {
    const r = allocateProRata(
      [
        { key: "a", weight: 1 },
        { key: "b", weight: 1 },
        { key: "c", weight: 1 },
      ],
      10_000,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(10_000);
    expect(r.legs.map((l) => l.amount).reduce((a, b) => a + b, 0)).toBeCloseTo(10_000, 6);
    expect(r.legs.filter((l) => l.residual !== 0)).toHaveLength(1);
  });

  it("scales a partial approval across every leg and records the factor", () => {
    const r = allocateProRata(
      [
        { key: "sub", weight: 44_000 },
        { key: "lab", weight: 10_000 },
      ],
      60_000,
    );
    expect(r.ok && r.legs.map((l) => l.amount)).toEqual([48_888.89, 11_111.11]);
    expect(r.ok && r.total).toBe(60_000);
    expect(r.ok && r.scale).toBeCloseTo(1.1111, 4);
  });

  it("refuses to allocate against a zero basis", () => {
    const r = allocateProRata([{ key: "a", weight: 0 }], 5_000);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("no basis to spread");
  });
});

describe("budget line derivation under an owner change", () => {
  const base = {
    originalBudget: 500_000,
    budgetModifications: 0,
    jobToDateCosts: 100_000,
    percentComplete: 0,
    forecastToComplete: 400_000,
  };

  it("re-settles a remaining-budget forecast", () => {
    const d = deriveBudgetLine({ ...base, approvedChanges: 50_000, forecastMethod: "remaining_budget" });
    expect(d.revisedBudget).toBe(550_000);
    expect(d.forecastToComplete).toBe(450_000);
    expect(d.forecastFinal).toBe(550_000);
    expect(d.projectedOverUnder).toBe(0);
  });

  it("leaves a manual forecast alone and says why", () => {
    const d = deriveBudgetLine({ ...base, approvedChanges: 50_000, forecastMethod: "manual" });
    expect(d.revisedBudget).toBe(550_000);
    expect(d.forecastToComplete).toBe(400_000);
    expect(d.projectedOverUnder).toBe(50_000);
    expect(d.reasons.join(" ")).toContain("does not derive from the revised budget");
  });

  it("re-settles a percent-complete forecast", () => {
    const d = deriveBudgetLine({
      ...base,
      approvedChanges: 50_000,
      percentComplete: 0.25,
      forecastMethod: "percent_complete",
    });
    expect(d.forecastToComplete).toBe(412_500);
  });
});

/* ================================================================== */
/* 3. Change events — provenance                                       */
/* ================================================================== */

describe("change events", () => {
  it("raises an event from an answered RFI and verifies the provenance link", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-events`, h1, {
      title: "Slab thickness increased to 250mm at grid C4",
      description: "RFI-042 answer supersedes S-201.",
      eventType: "design_change",
      scope: "out_of_scope",
      reason: "design_error",
      originType: "rfi",
      originId: rfiId,
      primeContractId: contractId,
      roughOrderOfMagnitude: 60_000,
      scheduleImpactDays: 5,
      identifiedDate: "2026-04-02",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    eventId = body.event.id;
    expect(body.event.reference).toBe("CE-001");
    expect(body.event.status).toBe("open");
    expect(body.origin.verified).toBe(true);
    expect(body.origin.label).toContain("RFI-042");
    // the tier is snapshotted from the project, not re-read at display time
    expect(body.event.tier).toBe("two_tier");
  });

  it("refuses a provenance link that does not resolve", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-events`, h1, {
      title: "Bogus origin",
      originType: "rfi",
      originId: "rfi_does_not_exist",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("does not resolve");
  });

  it("refuses an origin kind with no originId", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-events`, h1, {
      title: "Unsourced",
      originType: "drawing_revision",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("originId is required");
  });

  it("records an origin kind the platform holds no register for, and marks it unverified", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-events`, h1, {
      title: "Raised at the weekly coordination meeting",
      originType: "meeting",
      originId: "mtg-2026-04-08",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().origin.verified).toBe(false);
    expect(res.json().origin.reasons.join(" ")).toContain("unverified");
  });

  it("refuses a prime contract from another project", async () => {
    const res = await inject("POST", `/api/v1/projects/${projB}/change-events`, h1, {
      title: "Wrong contract",
      primeContractId: contractId,
    });
    expect(res.statusCode).toBe(400);
  });

  it("carries cost lines and totals them by cost type", async () => {
    const a = await inject("POST", `/api/v1/projects/${projA}/change-events/${eventId}/lines`, h1, {
      description: "Additional concrete and placement",
      costCode: "03300",
      costType: "subcontract",
      budgetLineItemId: lineSub,
      costAmount: 40_000,
    });
    expect(a.statusCode).toBe(201);
    const b = await inject("POST", `/api/v1/projects/${projA}/change-events/${eventId}/lines`, h1, {
      description: "Self-performed rebar adjustment",
      costCode: "01100",
      costType: "labour",
      budgetLineItemId: lineLab,
      quantity: 200,
      unitRate: 50,
    });
    expect(b.statusCode).toBe(201);
    expect(b.json().totals.costSubtotal).toBe(50_000);
    expect(b.json().totals.costByType.subcontract).toBe(40_000);
    expect(b.json().totals.costByType.labour).toBe(10_000);
  });

  it("filters the event list", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/change-events?eventType=design_change`,
      h1,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].reference).toBe("CE-001");
  });

  it("refuses a read-only member's write and an outsider entirely", async () => {
    const readOnly = await inject("POST", `/api/v1/projects/${projA}/change-events`, h4, {
      title: "Should not exist",
    });
    expect(readOnly.statusCode).toBe(403);
    const stranger = await inject(
      "GET",
      `/api/v1/projects/${projA}/change-events`,
      outsider.headers,
    );
    expect(stranger.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* 4. Potential change orders + RFQ                                    */
/* ================================================================== */

describe("potential change orders", () => {
  it("prices the subcontracted half against the commitment", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      changeEventId: eventId,
      title: "Apex — thicker slab",
      commitmentId,
      reason: "design_error",
    });
    expect(res.statusCode).toBe(201);
    pcoSub = res.json().id;
    expect(res.json().reference).toBe("PCO-001");
    // the vendor is inherited from the commitment rather than typed twice
    expect(res.json().vendorId).toBe(vendorA);

    const line = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/lines`,
      h1,
      {
        description: "Additional 50mm slab depth",
        costCode: "03300",
        costType: "subcontract",
        budgetLineItemId: lineSub,
        costAmount: 40_000,
      },
    );
    expect(line.statusCode).toBe(201);
  });

  it("refuses a PCO whose vendor contradicts its commitment", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      title: "Mismatched vendor",
      commitmentId,
      vendorId: vendorB,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("different");
  });

  it("refuses to price a PCO with no cost lines", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      title: "Empty",
    });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${created.json().id}/price`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("guess wearing a number");
  });

  it("refuses a stated estimate that disagrees with the lines", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/price`,
      h1,
      { estimatedAmount: 41_000 },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("does not agree with the cost lines");
  });

  it("prices from the lines", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/price`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().pco.estimatedAmount).toBe(40_000);
    expect(res.json().pco.amount).toBe(40_000);
    expect(res.json().pco.status).toBe("priced");
  });

  it("prices the self-performed half too", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      changeEventId: eventId,
      title: "Self-performed rebar adjustment",
    });
    pcoLab = created.json().id;
    await inject("POST", `/api/v1/projects/${projA}/potential-change-orders/${pcoLab}/lines`, h1, {
      description: "Rebar adjustment labour",
      costCode: "01100",
      costType: "labour",
      budgetLineItemId: lineLab,
      quantity: 200,
      unitRate: 50,
    });
    const priced = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoLab}/price`,
      h1,
      {},
    );
    expect(priced.json().pco.estimatedAmount).toBe(10_000);
  });
});

describe("quote requests", () => {
  it("refuses to send an RFQ with no due date", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/quote-requests`,
      h1,
      { vendorId: vendorA },
    );
    expect(created.statusCode).toBe(201);
    rfqA = created.json().id;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/quote-requests/${rfqA}/send`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("measurable in days");
  });

  it("sends, records a quote, and reports the turnaround", async () => {
    await inject("PATCH", `/api/v1/projects/${projA}/quote-requests/${rfqA}`, h1, {
      dueDate: "2026-04-20",
    });
    const sent = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqA}/send`, h1, {});
    expect(sent.statusCode).toBe(200);
    expect(sent.json().status).toBe("sent");

    const quoted = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqA}/quote`, h1, {
      quotedAmount: 44_000,
      quotedScheduleImpactDays: 5,
      quoteValidUntil: "2026-12-31",
      quoteNotes: "Includes pump hire.",
    });
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json().quotedAmount).toBe(44_000);
  });

  it("refuses a second live RFQ to the same subcontractor on one PCO", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/quote-requests`,
      h1,
      { vendorId: vendorA },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("two prices for it");
  });

  it("takes a competing quote and ranks the comparison", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/quote-requests`,
      h1,
      { vendorId: vendorB, dueDate: "2026-04-20" },
    );
    rfqB = created.json().id;
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqB}/send`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqB}/quote`, h1, {
      quotedAmount: 51_500,
      quotedScheduleImpactDays: 8,
    });
    const res = await inject(
      "GET",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/quote-comparison`,
      h1,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lowest.value).toBe(44_000);
    expect(body.highest.value).toBe(51_500);
    expect(body.spread.value).toBe(7_500);
    expect(body.coverage.responded).toBe(2);
    const apex = body.quotes.find((q: { vendorId: string }) => q.vendorId === vendorA);
    expect(apex.rank).toBe(1);
    expect(apex.varianceAgainstEstimate.value).toBe(4_000);
  });

  it("refuses to accept an expired quote", async () => {
    await built.app.db
      .update(commitments)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(commitments.id, commitmentId));
    const expiring = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoLab}/quote-requests`,
      h1,
      { vendorId: vendorB, dueDate: "2026-04-20" },
    );
    const id = expiring.json().id;
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/send`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/quote`, h1, {
      quotedAmount: 9_000,
      quoteValidUntil: "2020-01-01",
    });
    const res = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/accept`, h1, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("expired on 2020-01-01");
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/void`, h1, {});
  });

  it("accepting a quote sets the PCO position and keeps the estimate beside it", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqA}/accept`, h1, {});
    expect(res.statusCode).toBe(200);
    const pco = res.json().pco;
    expect(pco.estimatedAmount).toBe(40_000);
    expect(pco.quotedAmount).toBe(44_000);
    expect(pco.amount).toBe(44_000);
    expect(pco.scheduleImpactDays).toBe(5);
    const positions = pcoPositions(pco);
    expect(positions.quoteVariance.value).toBe(4_000);
    expect(positions.quoteVariancePercent.value).toBe(10);
    expect(res.json().supersededQuotes).toHaveLength(1);
  });

  it("refuses a second accepted quote against the same PCO", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${rfqB}/accept`, h1, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("One PCO carries one price");
  });

  it("refuses accepting MORE than the subcontractor quoted", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoLab}/quote-requests`,
      h1,
      { vendorId: vendorB, dueDate: "2026-04-20" },
    );
    const id = created.json().id;
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/send`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/quote`, h1, {
      quotedAmount: 9_000,
    });
    const res = await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/accept`, h1, {
      amount: 12_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("more than was quoted");
    await inject("POST", `/api/v1/projects/${projA}/quote-requests/${id}/void`, h1, {});
  });

  it("reports no lowest price at all rather than zero", () => {
    const comparison = compareQuotes(
      { id: "p1", reference: "PCO-009", estimatedAmount: 5_000, amount: 0 },
      [
        {
          id: "q1",
          reference: "RFQ-009",
          vendorId: vendorA,
          status: "sent",
          quotedAmount: null,
          quotedScheduleImpactDays: null,
          quoteValidUntil: null,
          sentAt: "2026-04-01T00:00:00.000Z",
          respondedAt: null,
        },
      ],
      new Map([[vendorA, "Apex Concrete"]]),
    );
    expect(comparison.lowest.value).toBeNull();
    expect(comparison.lowest.reasons[0]).toContain("No subcontractor has returned a price");
    expect(comparison.quotes[0]!.varianceAgainstEstimate.reasons[0]).toContain(
      "has not returned a price",
    );
    expect(comparison.recommendation).toContain("Chase before pricing");
  });
});

describe("PCO approval — segregation of duties", () => {
  it("refuses the submitter approving their own PCO", async () => {
    for (const id of [pcoSub, pcoLab]) {
      const submitted = await inject(
        "POST",
        `/api/v1/projects/${projA}/potential-change-orders/${id}/submit`,
        h1,
        {},
      );
      expect(submitted.statusCode).toBe(200);
    }
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/potential-change-orders/${pcoSub}/approve`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("Segregation of duties");
  });

  it("an independent approver may approve", async () => {
    for (const id of [pcoSub, pcoLab]) {
      const res = await inject(
        "POST",
        `/api/v1/projects/${projA}/potential-change-orders/${id}/approve`,
        h2,
        {},
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("approved");
      expect(res.json().approvedBy).toBe(u2.userId);
    }
  });

  it("rolls the priced position up onto the change event", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-events/${eventId}`, h1);
    expect(res.json().rollup.estimatedCost).toBe(54_000);
    expect(res.json().rollup.latestCost).toBe(54_000);
    expect(res.json().event.roughOrderOfMagnitude).toBe(60_000);
  });
});

/* ================================================================== */
/* 5. Change order request to the owner                                */
/* ================================================================== */

describe("change order requests", () => {
  it("packages both PCOs, inherits their cost coding and applies the markup stack", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      changeEventId: eventId,
      title: "COR-001 — slab thickness increase",
      reason: "design_error",
      pcoIds: [pcoSub, pcoLab],
      markups: OH_PROFIT_BOND,
    });
    expect(res.statusCode).toBe(201);
    corId = res.json().changeOrderRequest.id;
    const totals = res.json().totals;
    expect(totals.costSubtotal).toBe(54_000);
    expect(totals.applied.map((a: { amount: number }) => a.amount)).toEqual([5_400, 2_970, 623.7]);
    expect(totals.markupTotal).toBe(8_993.7);
    expect(totals.amount).toBe(62_993.7);
    expect(res.json().changeOrderRequest.reference).toBe("COR-001");
    // the time claimed comes off the accepted subcontractor quote
    expect(res.json().changeOrderRequest.scheduleImpactDays).toBe(5);
  });

  it("inherited the budget coding, so the change can actually be posted", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-order-requests/${corId}`, h1);
    const lines = res.json().lines as Array<{
      costCode: string | null;
      costType: string;
      budgetLineItemId: string | null;
      costAmount: number;
    }>;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.costCode).sort()).toEqual(["01100", "03300"]);
    expect(lines.map((l) => l.budgetLineItemId).sort()).toEqual([lineLab, lineSub].sort());
    expect(res.json().identities.every((i: { ok: boolean }) => i.ok)).toBe(true);
  });

  it("refuses a malformed markup stack", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Bad markups",
      lines: [{ description: "Something", costAmount: 1_000 }],
      markups: [
        { kind: "percent", label: "OH", basis: "cost", rate: 10 },
        { kind: "percent", label: "oh", basis: "cost", rate: 10 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("charged twice");
  });

  it("refuses a COR with nothing underneath it", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Empty ask",
      pcoIds: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("at least one PCO or one cost line");
  });

  it("refuses to bill the same PCO to the owner twice", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Double dip",
      pcoIds: [pcoSub],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("twice");
  });

  it("records negotiation as a sequence of positions, not a final number", async () => {
    await inject("POST", `/api/v1/projects/${projA}/change-order-requests/${corId}/submit`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/change-order-requests/${corId}/review`, h2, {});
    const first = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/negotiate`,
      h2,
      { position: "owner", amount: 55_000, scheduleImpactDays: 2, note: "Bond not recoverable." },
    );
    expect(first.statusCode).toBe(200);
    const second = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/negotiate`,
      h1,
      { position: "contractor", amount: 62_000, note: "Bond is a contract requirement." },
    );
    expect(second.json().negotiation).toHaveLength(2);
    expect(second.json().negotiation[0].position).toBe("owner");
    expect(second.json().negotiation[1].amount).toBe(62_000);
  });

  it("refuses the submitter approving their own request", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/approve`,
      h1,
      { approvedAmount: 60_000 },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("refuses granting more than was asked for, or more days than were claimed", async () => {
    const more = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/approve`,
      h2,
      { approvedAmount: 70_000 },
    );
    expect(more.statusCode).toBe(400);
    expect(more.json().message).toContain("cannot be reconciled to its lines");

    const days = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/approve`,
      h2,
      { approvedAmount: 60_000, scheduleImpactApprovedDays: 9 },
    );
    expect(days.statusCode).toBe(400);
    expect(days.json().message).toContain("never more");
  });

  it("a partial approval keeps the ask and the grant apart", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/approve`,
      h2,
      { approvedAmount: 60_000, scheduleImpactApprovedDays: 3, ownerResponseDate: "2026-05-01" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("partially_approved");
    expect(res.json().amount).toBe(62_993.7);
    expect(res.json().approvedAmount).toBe(60_000);
    expect(res.json().scheduleImpactApprovedDays).toBe(3);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projA}/change-order-requests/${corId}`,
      h1,
    );
    expect(detail.json().commercial.gap).toBe(2_993.7);
  });

  it("keeps a contractual cap alive across a recalculation", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Capped OH&P",
      lines: [
        { description: "Extra works", costCode: "03300", costType: "subcontract", costAmount: 100_000 },
      ],
      markups: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 15, maxAmount: 10_000 }],
    });
    expect(created.json().totals.markupTotal).toBe(10_000);
    const id = created.json().changeOrderRequest.id;
    const again = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${id}/recalculate`,
      h1,
      {},
    );
    // the cap survives the round-trip through the stored stack
    expect(again.json().totals.markupTotal).toBe(10_000);
    expect(again.json().totals.applied[0].cappedBy).toBe(10_000);
    expect(again.json().totals.applied[0].computedAmount).toBe(15_000);
    await inject("POST", `/api/v1/projects/${projA}/change-order-requests/${id}/withdraw`, h1, {});
  });

  it("uses the contract's standard markup stack when none is sent", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Default markups",
      lines: [
        { description: "Extra works", costCode: "03300", costType: "subcontract", costAmount: 100_000 },
      ],
    });
    expect(created.json().totals.applied.map((a: { label: string }) => a.label)).toEqual([
      "Overhead",
      "Profit",
      "Bond",
    ]);
    expect(created.json().totals.amount).toBe(116_655);
    await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${created.json().changeOrderRequest.id}/withdraw`,
      h1,
      {},
    );
  });

  it("freezes the cost lines once the request has been put to the owner", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/lines`,
      h1,
      { description: "Sneaky extra", costAmount: 5_000 },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("frozen");
  });
});

/* ================================================================== */
/* 6. Execution — three ledgers, one transaction                       */
/* ================================================================== */

describe("prime contract execution", () => {
  it("refuses a package containing a request the owner has not approved", async () => {
    const draft = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Unapproved",
      lines: [{ description: "Something", costCode: "03300", costType: "subcontract", costAmount: 1_000 }],
    });
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "prime_contract",
      title: "Premature",
      memberIds: [draft.json().changeOrderRequest.id],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("never what we asked for");
  });

  it("builds the package on the GRANTED amount", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "prime_contract",
      title: "PCCO-001 — slab thickness increase",
      memberIds: [corId],
    });
    expect(res.statusCode).toBe(201);
    primePkgId = res.json().id;
    expect(res.json().reference).toBe("PCCO-001");
    expect(res.json().amount).toBe(60_000);
    expect(res.json().scheduleImpactDays).toBe(3);
  });

  it("refuses execution before approval, and refuses the submitter approving", async () => {
    const early = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h1,
      {},
    );
    expect(early.statusCode).toBe(409);
    await inject("POST", `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/submit`, h1, {});
    const self = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/approve`,
      h1,
      {},
    );
    expect(self.statusCode).toBe(403);
    const ok = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/approve`,
      h2,
      {},
    );
    expect(ok.statusCode).toBe(200);
  });

  it("refuses to amend a prime contract that was never executed, and changes nothing", async () => {
    await built.app.db
      .update(primeContracts)
      .set({ executed: 0 })
      .where(eq(primeContracts.id, contractId));
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("has not been executed");
    const [row] = await built.app.db
      .select()
      .from(primeContracts)
      .where(eq(primeContracts.id, contractId));
    expect(row!.revisedContractSum).toBe(1_000_000);
    await built.app.db
      .update(primeContracts)
      .set({ executed: 1 })
      .where(eq(primeContracts.id, contractId));
  });

  it("refuses execution by a standard-level user — execution is admin only", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h3,
      {},
    );
    expect(res.statusCode).toBe(403);
  });

  it("refuses to execute an amount that moved since the caller read it", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h1,
      { expectedAmount: 62_993.7 },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("before signing");
  });

  it("executes: contract sum, schedule of values and budget all move together", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h1,
      { expectedAmount: 60_000, signedDate: "2026-05-04" },
    );
    expect(res.statusCode).toBe(200);
    const x = res.json().execution;

    // 1. the allocation scaled the partial approval across every cost code
    expect(x.scale).toBeCloseTo(1.1111, 4);
    expect(x.legs.map((l: { amount: number }) => l.amount)).toEqual([48_888.89, 11_111.11]);
    expect(x.identities.every((i: { ok: boolean }) => i.ok)).toBe(true);

    // 2. the prime contract
    expect(x.contractSums.approvedChangeSum).toBe(60_000);
    expect(x.contractSums.revisedContractSum).toBe(1_060_000);
    const [contract] = await built.app.db
      .select()
      .from(primeContracts)
      .where(eq(primeContracts.id, contractId));
    expect(contract!.revisedContractSum).toBe(1_060_000);
    expect(contract!.balanceToFinish).toBe(1_060_000);

    // 3. the schedule of values — APPENDED, never edited
    const sov = await built.app.db
      .select()
      .from(primeContractSovLines)
      .where(eq(primeContractSovLines.primeContractId, contractId));
    const appended = sov.filter((l) => l.isChangeOrderLine === 1);
    expect(appended).toHaveLength(2);
    expect(appended.map((l) => l.lineNumber).sort()).toEqual(["CO-001.1", "CO-001.2"]);
    expect(
      Math.round(appended.reduce((s, l) => s + l.revisedScheduledValue, 0) * 100) / 100,
    ).toBe(60_000);
    const base = sov.filter((l) => l.isChangeOrderLine === 0);
    expect(base.reduce((s, l) => s + l.revisedScheduledValue, 0)).toBe(1_000_000);

    // 4. the executed prime contract change
    const [pcc] = await built.app.db
      .select()
      .from(primeContractChanges)
      .where(eq(primeContractChanges.changeOrderPackageId, primePkgId));
    expect(pcc!.status).toBe("executed");
    expect(pcc!.amount).toBe(60_000);
    expect(pcc!.revisedContractSum).toBe(1_060_000);
    expect(pcc!.executedBy).toBe(u1.userId);

    // 5. the budget
    expect(x.budget.applied).toBe(true);
    expect(x.budget.linesMoved).toBe(2);
    const [bc] = await built.app.db
      .select()
      .from(budgetChanges)
      .where(eq(budgetChanges.sourceId, primePkgId));
    expect(bc!.kind).toBe("owner_change");
    expect(bc!.status).toBe("approved");
    expect(bc!.netEffect).toBe(60_000);
    expect(bc!.requestedBy).toBe(u1.userId);
    expect(bc!.approvedBy).toBe(u2.userId);
    expect(bc!.requestedBy).not.toBe(bc!.approvedBy);

    const lines = await built.app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.budgetId, budgetId));
    const sub = lines.find((l) => l.id === lineSub)!;
    const lab = lines.find((l) => l.id === lineLab)!;
    expect(sub.approvedChanges).toBe(48_888.89);
    expect(sub.revisedBudget).toBe(548_888.89);
    // remaining_budget re-settles off the new funded amount
    expect(sub.forecastToComplete).toBe(548_888.89);
    expect(sub.projectedOverUnder).toBe(0);
    // a manual forecast is NOT quietly republished by a funding change
    expect(lab.approvedChanges).toBe(11_111.11);
    expect(lab.revisedBudget).toBe(211_111.11);
    expect(lab.forecastToComplete).toBe(200_000);
    expect(lab.projectedOverUnder).toBe(11_111.11);
    expect(x.budget.forecastNotes.join(" ")).toContain("does not derive from the revised budget");

    const [budget] = await built.app.db.select().from(budgets).where(eq(budgets.id, budgetId));
    expect(budget!.approvedChangesTotal).toBe(60_000);
    expect(budget!.revisedBudgetTotal).toBe(760_000);
    // a locked budget that takes an approved change becomes "revised"
    expect(budget!.status).toBe("revised");

    // 6. the package now says what it became
    const pkg = res.json().package;
    expect(pkg.status).toBe("executed");
    expect(pkg.primeContractChangeId).toBe(pcc!.id);
    expect(pkg.budgetChangeId).toBe(bc!.id);
    expect(pkg.signedDate).toBe("2026-05-04");
  });

  it("refuses to execute the same package twice", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/execute`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(409);
  });

  it("refuses to void an executed package", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${primePkgId}/void`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Reverse it with a further change order");
  });
});

describe("commitment execution — the other half of the same change", () => {
  it("executes the subcontract change order and moves committed cost", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "commitment",
      title: "CCO-001 — Apex thicker slab",
      memberIds: [pcoSub],
    });
    expect(created.statusCode).toBe(201);
    commitmentPkgId = created.json().id;
    expect(created.json().reference).toBe("CCO-001");
    expect(created.json().amount).toBe(44_000);

    await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${commitmentPkgId}/submit`,
      h1,
      {},
    );
    await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${commitmentPkgId}/approve`,
      h2,
      {},
    );
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${commitmentPkgId}/execute`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(200);
    const x = res.json().execution;
    expect(x.commitmentSums.approvedChangeSum).toBe(44_000);
    expect(x.commitmentSums.revisedCommitmentSum).toBe(444_000);
    expect(x.identities.every((i: { ok: boolean }) => i.ok)).toBe(true);

    const [commitment] = await built.app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId));
    expect(commitment!.revisedCommitmentSum).toBe(444_000);
    expect(commitment!.balanceToFinish).toBe(444_000);

    const sov = await built.app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    const appended = sov.filter((l) => l.isChangeOrderLine === 1);
    expect(appended).toHaveLength(1);
    // the PCO's own estimate scaled up to the ACCEPTED quote
    expect(appended[0]!.revisedScheduledValue).toBe(44_000);
    expect(appended[0]!.budgetLineItemId).toBe(lineSub);

    const [cc] = await built.app.db
      .select()
      .from(commitmentChanges)
      .where(eq(commitmentChanges.changeOrderPackageId, commitmentPkgId));
    expect(cc!.reference).toBe("SC-0001-CCO-001");
    expect(cc!.status).toBe("executed");
    expect(cc!.potentialChangeOrderId).toBe(pcoSub);

    // committed cost on the budget line re-derived from the SOV, not incremented
    const [line] = await built.app.db
      .select()
      .from(budgetLineItems)
      .where(eq(budgetLineItems.id, lineSub));
    expect(line!.committedCost).toBe(444_000);
    expect(x.budget.linesMoved).toBe(1);
  });

  it("refuses a commitment package spanning two subcontracts", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "commitment",
      title: "Mixed",
      memberIds: [pcoSub, pcoLab],
    });
    expect(res.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* 7. The change log                                                   */
/* ================================================================== */

describe("change log", () => {
  it("reconciles every headline figure back to the rows underneath it", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mixedCurrency).toBe(false);
    const r = body.reconciliation;
    expect(r.currency).toBe("USD");
    expect(r.ok).toBe(true);
    expect(r.identities.every((i: { ok: boolean }) => i.ok)).toBe(true);

    expect(r.packages.executedPrimeTotal).toBe(60_000);
    expect(r.packages.executedCommitmentTotal).toBe(44_000);

    const movement = r.contractMovement[0];
    expect(movement.reference).toBe("PC-001");
    expect(movement.originalContractSum).toBe(1_000_000);
    expect(movement.approvedChangeSum).toBe(60_000);
    expect(movement.revisedContractSum).toBe(1_060_000);
    expect(movement.executedPackageTotal).toBe(60_000);
    expect(movement.executedChangeTotal).toBe(60_000);
    expect(movement.ok).toBe(true);
  });

  it("shows the change margin: owner revenue against subcontract cost", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    const r = res.json().reconciliation;
    const margin = r.margins.find((m: { changeEventId: string }) => m.changeEventId === eventId);
    expect(margin.revenue).toBe(60_000);
    expect(margin.cost).toBe(44_000);
    expect(margin.margin).toBe(16_000);
    expect(margin.marginPercent.value).toBeCloseTo(26.6667, 3);
    expect(r.unattributedExecutedRevenue).toBe(0);
  });

  it("keeps the ask and the grant apart, and reports the gap", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    const r = res.json().reconciliation;
    expect(r.cors.requestedTotal).toBe(62_993.7);
    expect(r.cors.approvedTotal).toBe(60_000);
    expect(r.cors.negotiationGap).toBe(2_993.7);
    expect(r.cors.approvalRatePercent.value).toBeGreaterThan(95);
    expect(r.cors.approvalRatePercent.value).toBeLessThan(96);
    expect(r.cors.daysClaimed).toBe(5);
    expect(r.cors.daysApproved).toBe(3);
  });

  it("reports the quote variance against our own estimate", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    const r = res.json().reconciliation;
    expect(r.pcos.quoteVarianceAgainstEstimate.value).toBe(4_000);
  });

  it("walks the funnel from identified exposure to executed money", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    const funnel = res.json().reconciliation.funnel as Array<{
      stage: string;
      events: number;
      amount: number;
    }>;
    const stage = (name: string) => funnel.find((f) => f.stage === name)!;
    expect(stage("identified").amount).toBe(60_000);
    expect(stage("priced").amount).toBe(54_000);
    expect(stage("submitted").amount).toBe(62_993.7);
    expect(stage("approved").amount).toBe(60_000);
    expect(stage("executed").amount).toBe(60_000);
    expect(stage("executed").events).toBe(1);
  });

  it("renders the contract-sum movement as a running log that agrees with itself", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log/contract-movement`, h1);
    expect(res.statusCode).toBe(200);
    const contract = res.json().contracts[0];
    expect(contract.reconciles).toBe(true);
    expect(contract.executedChanges).toHaveLength(1);
    expect(contract.executedChanges[0].runningContractSum).toBe(1_060_000);
    expect(contract.executedChanges[0].agrees).toBe(true);
  });

  it("a read-only member may read the log", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h4);
    expect(res.statusCode).toBe(200);
  });

  it("catches a broken chain rather than rendering it as fine", () => {
    const r = reconcileChangeLog({
      currency: "USD",
      events: [],
      pcos: [],
      cors: [
        {
          id: "cor1",
          changeEventId: null,
          primeContractId: "pc1",
          changeOrderPackageId: "pkg1",
          status: "approved",
          amount: 50_000,
          approvedAmount: 50_000,
          scheduleImpactDays: 0,
          scheduleImpactApprovedDays: 0,
          pcoIds: [],
        },
      ],
      packages: [
        {
          id: "pkg1",
          kind: "prime_contract",
          status: "executed",
          changeEventId: null,
          primeContractId: "pc1",
          commitmentId: null,
          memberIds: ["cor1"],
          amount: 50_000,
          scheduleImpactDays: 0,
          primeContractChangeId: "pcc1",
          commitmentChangeId: null,
          budgetChangeId: null,
        },
      ],
      contracts: [
        {
          id: "pc1",
          reference: "PC-001",
          currency: "USD",
          originalContractSum: 1_000_000,
          // deliberately wrong: the contract says 40k, the rows say 50k
          approvedChangeSum: 40_000,
          pendingChangeSum: 0,
          revisedContractSum: 1_040_000,
        },
      ],
      primeChanges: [
        { id: "pcc1", parentId: "pc1", changeOrderPackageId: "pkg1", status: "executed", amount: 50_000 },
      ],
      commitmentChanges: [],
    });
    expect(r.ok).toBe(false);
    const broken = r.contractMovement[0]!.identities.find((i) => !i.ok)!;
    expect(broken.identity).toContain("approvedChangeSum");
    expect(broken.delta).toBe(10_000);
  });
});

/* ================================================================== */
/* 8. Time impact — linked to forensics, never reinvented              */
/* ================================================================== */

describe("time impact", () => {
  it("flags time claimed with no delay event behind it", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log/time-impact`, h1);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.daysClaimed).toBe(5);
    expect(body.totals.daysApproved).toBe(3);
    expect(body.totals.daysModelled.value).toBeNull();
    expect(body.totals.requestsClaimingTimeWithNoDelayEvent).toBe(1);
    expect(body.unlinked[0].verdict).toContain("no delay event linked");
  });

  it("refuses to link a delay event from another project", async () => {
    const foreign = newId("dly");
    await built.app.db.insert(delayEvents).values({
      id: foreign,
      companyId: u1.companyId,
      projectId: projB,
      number: 1,
      title: "Elsewhere",
      cause: "weather",
      status: "open",
      startDate: "2026-04-01",
      durationDays: 2,
      raisedBy: u1.userId,
    });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/delay-events`,
      h1,
      { delayEventIds: [foreign] },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("forensics module's concept");
  });

  it("links the forensics delay event and measures the claim against the modelled impact", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-requests/${corId}/delay-events`,
      h1,
      { delayEventIds: [delayEventId] },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.linkedDelayEvents).toHaveLength(1);
    expect(body.linkedDelayEvents[0].durationDays).toBe(6);
    expect(body.modelledDays.value).toBe(3);
    expect(body.unsupportedDays.value).toBe(2);
    expect(body.verdict).toContain("unsupported");
  });

  it("says plainly when the linked delay events have never been analysed", () => {
    const assessed = assessCorTimeImpact(
      {
        id: "cor1",
        reference: "COR-009",
        title: "Access denial",
        status: "submitted",
        scheduleImpactDays: 12,
        scheduleImpactApprovedDays: 0,
      },
      ["d1"],
      [
        {
          id: "d1",
          number: 3,
          title: "Access denial",
          cause: "owner_delay",
          excusable: 1,
          compensable: 1,
          status: "open",
          startDate: "2026-03-01",
          durationDays: 12,
          completionDeltaDays: null,
        },
      ],
    );
    expect(assessed.modelledDays.value).toBeNull();
    expect(assessed.modelledDays.reasons.join(" ")).toContain("time impact analysis");
    expect(assessed.verdict).toContain("before the owner does");
  });

  it("calls a fully substantiated claim substantiated", () => {
    const assessed = assessCorTimeImpact(
      {
        id: "cor2",
        reference: "COR-010",
        title: "Rock",
        status: "approved",
        scheduleImpactDays: 4,
        scheduleImpactApprovedDays: 4,
      },
      ["d2"],
      [
        {
          id: "d2",
          number: 4,
          title: "Rock",
          cause: "unforeseen_condition",
          excusable: 1,
          compensable: 1,
          status: "closed",
          startDate: "2026-03-01",
          durationDays: 5,
          completionDeltaDays: 4,
        },
      ],
    );
    expect(assessed.unsupportedDays.value).toBe(0);
    expect(assessed.verdict).toContain("substantiated");
  });
});

/* ================================================================== */
/* 9. The refusals that protect the budget                             */
/* ================================================================== */

describe("budget posting refusals", () => {
  it("refuses to execute a change whose lines do not resolve to a budget line", async () => {
    const cor = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Uncoded extra",
      lines: [{ description: "Miscellaneous site costs", costAmount: 1_000 }],
    });
    const id = cor.json().changeOrderRequest.id;
    await inject("POST", `/api/v1/projects/${projA}/change-order-requests/${id}/submit`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/change-order-requests/${id}/approve`, h2, {
      approvedAmount: 1_000,
    });
    const pkg = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "prime_contract",
      title: "Uncoded package",
      memberIds: [id],
    });
    const pkgId = pkg.json().id;
    await inject("POST", `/api/v1/projects/${projA}/change-order-packages/${pkgId}/submit`, h1, {});
    await inject("POST", `/api/v1/projects/${projA}/change-order-packages/${pkgId}/approve`, h2, {});
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-order-packages/${pkgId}/execute`,
      h1,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("do not resolve to a line of budget");
    expect(res.json().message).toContain("Miscellaneous site costs");

    // nothing moved: the refusal happened before a single write
    const [contract] = await built.app.db
      .select()
      .from(primeContracts)
      .where(eq(primeContracts.id, contractId));
    expect(contract!.revisedContractSum).toBe(1_060_000);
    const [budget] = await built.app.db.select().from(budgets).where(eq(budgets.id, budgetId));
    expect(budget!.approvedChangesTotal).toBe(60_000);
    await inject("POST", `/api/v1/projects/${projA}/change-order-packages/${pkgId}/void`, h1, {});
  });

  it("refuses a package that totals zero", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-packages`, h1, {
      kind: "prime_contract",
      title: "Nothing",
      memberIds: [corId],
    });
    // corId is already inside an executed package
    expect(res.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* 10. Currency, ledger and access                                     */
/* ================================================================== */

describe("currency discipline", () => {
  it("refuses to add a change spanning two currencies", async () => {
    const eurCommitment = newId("cmt");
    await built.app.db.insert(commitments).values({
      id: eurCommitment,
      companyId: u1.companyId,
      projectId: projA,
      kind: "purchase_order",
      number: 2,
      reference: "PO-0002",
      title: "European formwork hire",
      status: "approved",
      executed: 1,
      currency: "EUR",
      vendorId: vendorB,
      originalCommitmentSum: 80_000,
      revisedCommitmentSum: 80_000,
      createdBy: u1.userId,
    });
    const pco = await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      title: "Extra formwork hire",
      commitmentId: eurCommitment,
    });
    const pcoId = pco.json().id;
    await inject("POST", `/api/v1/projects/${projA}/potential-change-orders/${pcoId}/lines`, h1, {
      description: "Two extra weeks of hire",
      costCode: "03300",
      costType: "subcontract",
      costAmount: 12_000,
    });
    await inject("POST", `/api/v1/projects/${projA}/potential-change-orders/${pcoId}/price`, h1, {});
    const res = await inject("POST", `/api/v1/projects/${projA}/change-order-requests`, h1, {
      primeContractId: contractId,
      title: "Mixed-currency ask",
      pcoIds: [pcoId],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("never summed across currencies");
  });

  it("splits the change log per currency rather than summing unlike things", async () => {
    const res = await inject("GET", `/api/v1/projects/${projA}/change-log`, h1);
    const body = res.json();
    expect(body.mixedCurrency).toBe(true);
    expect(body.reconciliation).toBeNull();
    expect(body.currencies).toEqual(["EUR", "USD"]);
    expect(body.groups).toHaveLength(2);
    expect(body.reasons.join(" ")).toContain("sum of unlike things");

    const usd = await inject("GET", `/api/v1/projects/${projA}/change-log?currency=USD`, h1);
    expect(usd.json().reconciliation.packages.executedPrimeTotal).toBe(60_000);
  });
});

describe("ledger", () => {
  it("ledgers the execution with its full payload, and every state change on the chain", async () => {
    const entries = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "change_order_package"),
        ),
      );
    const executed = entries.filter(
      (e) => e.objectId === primePkgId && e.action === "state_change",
    );
    expect(executed.length).toBeGreaterThanOrEqual(3);
    const execution = executed.find(
      (e) => (e.payload as Record<string, unknown> | null)?.["to"] === "executed",
    );
    expect(execution).toBeDefined();
    const payload = execution!.payload as Record<string, unknown>;
    expect(payload["amount"]).toBe(60_000);
    expect(payload["executedBy"]).toBe(u1.userId);
    expect(payload["approvedBy"]).toBe(u2.userId);
    expect(payload["budgetLinesMoved"]).toBe(2);

    const contractChange = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "prime_contract_change"),
        ),
      );
    expect(contractChange.length).toBeGreaterThanOrEqual(1);
    const budgetChange = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, u1.companyId), eq(ledgerEntries.objectType, "budget_change")),
      );
    expect(budgetChange.length).toBeGreaterThanOrEqual(1);
  });
});

describe("access", () => {
  it("a standard member may raise a change but not execute one", async () => {
    const created = await inject("POST", `/api/v1/projects/${projB}/change-events`, h3, {
      title: "Depot slab crack",
      eventType: "field_condition",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().event.reference).toBe("CE-001");
  });

  it("keeps tenants apart on every read", async () => {
    for (const path of [
      "change-events",
      "potential-change-orders",
      "quote-requests",
      "change-order-requests",
      "change-order-packages",
      "change-log",
    ]) {
      const res = await inject("GET", `/api/v1/projects/${projA}/${path}`, outsider.headers);
      expect(res.statusCode).toBe(403);
    }
  });

  it("refuses to close a change event over the top of live children", async () => {
    const created = await inject("POST", `/api/v1/projects/${projA}/change-events`, h1, {
      title: "Unresolved exposure",
      eventType: "field_condition",
    });
    const openEventId = created.json().event.id;
    await inject("POST", `/api/v1/projects/${projA}/potential-change-orders`, h1, {
      changeEventId: openEventId,
      title: "Still being priced",
    });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-events/${openEventId}/status`,
      h1,
      { status: "closed" },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("hides the exposure");
  });

  it("closes an event once every child is resolved, and stamps who closed it", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/change-events/${eventId}/status`, h1, {
      status: "closed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed");
    expect(res.json().closedBy).toBe(u1.userId);
    const frozen = await inject(
      "POST",
      `/api/v1/projects/${projA}/change-events/${eventId}/lines`,
      h1,
      { description: "Too late", costAmount: 100 },
    );
    expect(frozen.statusCode).toBe(409);
  });
});
