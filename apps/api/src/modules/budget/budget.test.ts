import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  changeOrderPackages,
  commitmentSovLines,
  commitments,
  companyMemberships,
  costCodes,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  projectMemberships,
  projects,
  wbsSegments,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import {
  computeForecast,
  diffSnapshots,
  legVerdict,
  reconcile,
  revisedBudgetOf,
  rollUpByWbs,
  rollUpTotals,
  sumInCurrency,
  wbsAncestors,
  ZERO_LINE,
  type SnapshotLine,
} from "./calc.js";

let built: BuiltApp;
/** company owner — bypasses tool gates, acts as requester and as approver */
let u1: TestActor;
/** company admin — the INDEPENDENT approver every segregation test needs */
let u2: TestActor;
/** project_manager member: budget = standard (can request, cannot approve) */
let u3: TestActor;
/** read_only member: budget = read */
let u4: TestActor;
/** an actor in a different company entirely */
let outsider: TestActor;

let h2: Record<string, string>;
let h3: Record<string, string>;
let h4: Record<string, string>;

let projA: string;
let projB: string;

let ccConcrete: string; // 03
let ccCip: string; // 03/03300, subcontract
let ccRebar: string; // 03/03310, material
let ccElec: string; // 16
let ccElecSub: string; // 16/16100, subcontract
let ccContingency: string; // 99-CONT
let ccInactive: string; // 07999, inactive
let wbsSegA: string;

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/** ISO date n days before today — a capture may never be dated in the future. */
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const CAPTURE_1 = daysAgo(40);
const BACKDATED = daysAgo(50);
const TRANSFER_2 = daysAgo(20);
const CAPTURE_2 = daysAgo(10);
const LATE_CAPTURE = daysAgo(45);

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app);
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
  h2 = { authorization: `Bearer ${u2.accessToken}`, "x-company-id": u1.companyId };
  h3 = { authorization: `Bearer ${u3.accessToken}`, "x-company-id": u1.companyId };
  h4 = { authorization: `Bearer ${u4.accessToken}`, "x-company-id": u1.companyId };

  projA = newId("prj");
  projB = newId("prj");
  await built.app.db.insert(projects).values([
    { id: projA, companyId: u1.companyId, name: "Budget A" },
    { id: projB, companyId: u1.companyId, name: "Budget B" },
  ]);
  for (const projectId of [projA, projB]) {
    await built.app.db.insert(projectMemberships).values([
      {
        id: newId("pm"),
        companyId: u1.companyId,
        projectId,
        userId: u3.userId,
        // budget = "standard": may request a movement, may never approve one
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

  // The REAL cost-code structure (core.ts). Budget lines bind to these rows;
  // the module refuses to invent a parallel hierarchy.
  ccConcrete = newId("cc");
  ccCip = newId("cc");
  ccRebar = newId("cc");
  ccElec = newId("cc");
  ccElecSub = newId("cc");
  ccContingency = newId("cc");
  ccInactive = newId("cc");
  await built.app.db.insert(costCodes).values([
    { id: ccConcrete, companyId: u1.companyId, code: "03", title: "Concrete" },
    {
      id: ccCip,
      companyId: u1.companyId,
      code: "03300",
      title: "Cast-in-place concrete",
      division: "03",
      costType: "subcontract",
      parentId: ccConcrete,
    },
    {
      id: ccRebar,
      companyId: u1.companyId,
      code: "03310",
      title: "Reinforcement",
      division: "03",
      costType: "material",
      parentId: ccConcrete,
    },
    { id: ccElec, companyId: u1.companyId, code: "16", title: "Electrical" },
    {
      id: ccElecSub,
      companyId: u1.companyId,
      code: "16100",
      title: "Electrical subcontract",
      costType: "subcontract",
      parentId: ccElec,
    },
    { id: ccContingency, companyId: u1.companyId, code: "99-CONT", title: "Contingency" },
    {
      id: ccInactive,
      companyId: u1.companyId,
      code: "07999",
      title: "Retired code",
      isActive: 0,
    },
  ]);

  wbsSegA = newId("wbs");
  await built.app.db.insert(wbsSegments).values({
    id: wbsSegA,
    companyId: u1.companyId,
    projectId: projA,
    name: "Cost code",
    segmentType: "cost_code",
    position: 1,
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* calc.ts — the arithmetic, in isolation                              */
/* ================================================================== */

describe("calc: cost-report identities", () => {
  it("derives revised budget as original + modifications + approved changes", () => {
    const line = {
      ...ZERO_LINE,
      originalBudget: 100_000,
      budgetModifications: -10_000,
      approvedChanges: 25_000,
      // deliberately non-zero: a PENDING change is exposure, never budget
      pendingBudgetChanges: 40_000,
    };
    expect(revisedBudgetOf(line)).toBe(115_000);
  });

  it("reconciles every stored total back to the identities it claims", () => {
    const totals = rollUpTotals([
      {
        ...ZERO_LINE,
        originalBudget: 100_000,
        budgetModifications: -10_000,
        approvedChanges: 5_000,
        jobToDateCosts: 30_000,
        revisedBudget: 95_000,
        forecastToComplete: 70_000,
        forecastFinal: 100_000,
        projectedOverUnder: -5_000,
      },
      {
        ...ZERO_LINE,
        originalBudget: 50_000,
        budgetModifications: 10_000,
        approvedChanges: 0,
        jobToDateCosts: 10_000,
        revisedBudget: 60_000,
        forecastToComplete: 45_000,
        forecastFinal: 55_000,
        projectedOverUnder: 5_000,
      },
    ]);
    expect(totals.revisedBudgetTotal).toBe(155_000);
    expect(totals.varianceTotal).toBe(0);
    for (const identity of reconcile(totals)) {
      expect(identity.ok, `${identity.identity} (delta ${identity.delta})`).toBe(true);
    }
  });

  it("totals a WBS rollup at every level of the tree", () => {
    const mk = (wbsPath: string, amount: number) => ({
      ...ZERO_LINE,
      originalBudget: amount,
      revisedBudget: amount,
      forecastToComplete: amount,
      forecastFinal: amount,
      projectedOverUnder: 0,
      wbsPath,
    });
    const nodes = rollUpByWbs([
      mk("03/03300", 200_000),
      mk("03/03310", 100_000),
      mk("16/16100", 50_000),
    ]);
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    expect(byKey.get("03")?.totals.revisedBudgetTotal).toBe(300_000);
    expect(byKey.get("03")?.lineCount).toBe(2);
    expect(byKey.get("03/03300")?.totals.revisedBudgetTotal).toBe(200_000);
    expect(byKey.get("16")?.totals.revisedBudgetTotal).toBe(50_000);
    expect(wbsAncestors("03/03300/03310")).toEqual(["03", "03/03300", "03/03300/03310"]);
  });
});

describe("calc: forecasting", () => {
  const base = {
    ...ZERO_LINE,
    originalBudget: 100_000,
    jobToDateCosts: 40_000,
    percentComplete: 0.5,
  };

  it("remaining_budget spends the balance of the budget", () => {
    const r = computeForecast("remaining_budget", base);
    expect(r.forecastToComplete).toBe(60_000);
    expect(r.forecastFinal).toBe(100_000);
    expect(r.projectedOverUnder).toBe(0);
  });

  it("percent_complete prices the remaining WORK at the budgeted rate", () => {
    const r = computeForecast("percent_complete", base);
    expect(r.forecastToComplete).toBe(50_000);
    expect(r.forecastFinal).toBe(90_000);
    expect(r.projectedOverUnder).toBe(10_000);
  });

  it("productivity_trend extrapolates the rate achieved so far — and reports the overrun", () => {
    const r = computeForecast("productivity_trend", { ...base, jobToDateCosts: 60_000 });
    // £60k spent to reach 50% ⇒ £120k at completion against a £100k budget
    expect(r.forecastFinal).toBe(120_000);
    expect(r.projectedOverUnder).toBe(-20_000);
  });

  it("unit_rate_trend re-rates the remaining quantity at the actual rate", () => {
    const r = computeForecast("unit_rate_trend", {
      ...base,
      quantity: 1000,
      unitRate: 100,
      jobToDateCosts: 60_000,
      percentComplete: 0.5,
    });
    // 500 units cost £60k ⇒ £120/unit; 500 remaining ⇒ £60k to complete
    expect(r.forecastToComplete).toBe(60_000);
    expect(r.forecastFinal).toBe(120_000);
    expect(r.inputs["actualUnitRate"]).toBe(120);
  });

  it("committed_plus_pending never forecasts less than what is already signed for", () => {
    const r = computeForecast("committed_plus_pending", {
      ...base,
      committedCost: 130_000,
      jobToDateCosts: 40_000,
    });
    expect(r.forecastFinal).toBe(130_000);
    expect(r.projectedOverUnder).toBe(-30_000);
  });

  it("returns null with reasons — never a fabricated zero — when inputs are missing", () => {
    const manual = computeForecast("manual", base);
    expect(manual.forecastToComplete).toBeNull();
    expect(manual.reasons[0]).toMatch(/requires an explicit forecastToComplete/i);

    const noProgress = computeForecast("percent_complete", { ...base, percentComplete: 0 });
    expect(noProgress.forecastFinal).toBeNull();
    expect(noProgress.reasons.join(" ")).toMatch(/percent complete/i);

    const notMeasured = computeForecast("unit_rate_trend", base);
    expect(notMeasured.forecastToComplete).toBeNull();
    expect(notMeasured.reasons.join(" ")).toMatch(/measured line/i);
  });
});

describe("calc: transfers must balance, and currencies never mix", () => {
  const leg = (id: string, amount: number) => ({
    lineItemId: id,
    costCode: id,
    costType: "other" as const,
    amount,
  });

  it("accepts a balanced transfer and reports what moved", () => {
    const v = legVerdict("transfer", [leg("a", -10_000), leg("b", 10_000)]);
    expect(v.error).toBeNull();
    expect(v.analysis.net).toBe(0);
    expect(v.analysis.amount).toBe(10_000);
    expect(v.analysis.sources).toHaveLength(1);
  });

  it("refuses a transfer that does not net to zero", () => {
    const v = legVerdict("transfer", [leg("a", -10_000), leg("b", 5_000)]);
    expect(v.error).toMatch(/balance to zero/i);
    expect(v.analysis.net).toBe(-5_000);
  });

  it("refuses a net-zero owner_change and a line that appears on two legs", () => {
    expect(legVerdict("owner_change", [leg("a", -100), leg("b", 100)]).error).toMatch(
      /must change the budget total/i,
    );
    expect(legVerdict("transfer", [leg("a", -100), leg("a", 100)]).error).toMatch(
      /more than one leg/i,
    );
    expect(legVerdict("transfer", []).error).toMatch(/at least one line/i);
  });

  it("excludes foreign-currency rows from a sum and says so", () => {
    const mixed = sumInCurrency(
      [
        { amount: 100, currency: "USD" },
        { amount: 250, currency: "USD" },
        { amount: 9_999, currency: "EUR" },
      ],
      "USD",
      "commitment",
    );
    expect(mixed.value).toBe(350);
    expect(mixed.excluded).toBe(1);
    expect(mixed.reasons.join(" ")).toMatch(/never summed across currencies/i);

    const empty = sumInCurrency([], "USD", "commitment");
    expect(empty.value).toBeNull();
    expect(empty.reasons).toHaveLength(1);
  });
});

describe("calc: snapshot diff", () => {
  const line = (costCode: string, revised: number, forecast: number): SnapshotLine => ({
    lineItemId: `li_${costCode}`,
    costCode,
    costType: "subcontract",
    description: `Line ${costCode}`,
    wbsPath: null,
    lineKind: "standard",
    originalBudget: revised,
    budgetModifications: 0,
    approvedChanges: 0,
    revisedBudget: revised,
    committedCost: 0,
    pendingCommitments: 0,
    directCosts: 0,
    jobToDateCosts: 0,
    forecastMethod: "remaining_budget",
    forecastToComplete: forecast,
    forecastFinal: forecast,
    projectedOverUnder: revised - forecast,
    percentComplete: 0,
  });

  it("reports added, removed, changed and unchanged lines with per-field deltas", () => {
    const diff = diffSnapshots(
      { lines: [line("03300", 100, 100), line("03310", 50, 50)], totals: { revisedBudgetTotal: 150 } },
      { lines: [line("03300", 120, 130), line("16100", 20, 20)], totals: { revisedBudgetTotal: 140 } },
    );
    expect(diff.added.map((l) => l.costCode)).toEqual(["16100"]);
    expect(diff.removed.map((l) => l.costCode)).toEqual(["03310"]);
    expect(diff.changed).toHaveLength(1);
    const fields = new Map(diff.changed[0]!.fields.map((f) => [f.field, f]));
    expect(fields.get("revisedBudget")?.delta).toBe(20);
    expect(fields.get("forecastFinal")?.delta).toBe(30);
    expect(fields.get("projectedOverUnder")?.delta).toBe(-10);
    expect(diff.totals).toEqual([
      { field: "revisedBudgetTotal", from: 150, to: 140, delta: -10 },
    ]);
  });

  it("counts an untouched line as unchanged rather than as a change of zero", () => {
    const diff = diffSnapshots(
      { lines: [line("03300", 100, 100)], totals: {} },
      { lines: [line("03300", 100, 100)], totals: {} },
    );
    expect(diff.unchangedCount).toBe(1);
    expect(diff.changed).toHaveLength(0);
  });
});

/* ================================================================== */
/* Budgets                                                             */
/* ================================================================== */

let budgetMain: string;
let budgetSnap: string;
let budgetFc: string;
let budgetImport: string;
let budgetRoll: string;

describe("Budgets", () => {
  it("creates a budget, auto-numbers it and binds it to the project's WBS segments", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/budgets`, u1.headers, {
      name: "Baseline budget",
      description: "M2 baseline",
      wbsSegmentIds: [wbsSegA],
      isActive: true,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    budgetMain = body.id;
    expect(body.reference).toBe("BUD-001");
    expect(body.status).toBe("draft");
    expect(body.isActive).toBe(1);
    expect(body.currency).toBe("USD");
    expect(body.wbsSegmentIds).toEqual([wbsSegA]);
  });

  it("refuses a WBS segment that is not on this project", async () => {
    const res = await inject("POST", `/api/v1/projects/${projA}/budgets`, u1.headers, {
      name: "Bad WBS",
      wbsSegmentIds: [newId("wbs")],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/wbsSegmentIds not found/i);
  });

  it("creates the remaining budgets and keeps exactly one active per project", async () => {
    for (const [name, target] of [
      ["Snapshot budget", "snap"],
      ["Forecast budget", "fc"],
      ["Import budget", "import"],
    ] as const) {
      const res = await inject("POST", `/api/v1/projects/${projA}/budgets`, u1.headers, { name });
      expect(res.statusCode).toBe(201);
      const id = res.json().id as string;
      if (target === "snap") budgetSnap = id;
      if (target === "fc") budgetFc = id;
      if (target === "import") budgetImport = id;
    }
    const rollRes = await inject("POST", `/api/v1/projects/${projB}/budgets`, u1.headers, {
      name: "Rollup budget",
      isActive: true,
    });
    budgetRoll = rollRes.json().id;

    const activate = await inject("POST", `/api/v1/budgets/${budgetSnap}/activate`, u1.headers);
    expect(activate.statusCode).toBe(200);
    const list = await inject(
      "GET",
      `/api/v1/projects/${projA}/budgets?isActive=true`,
      u1.headers,
    );
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe(budgetSnap);

    // put it back so the main budget is the project's active one
    await inject("POST", `/api/v1/budgets/${budgetMain}/activate`, u1.headers);
  });

  it("enforces the budget tool level: read-only members read, standard members write", async () => {
    const read = await inject("GET", `/api/v1/projects/${projA}/budgets`, h4);
    expect(read.statusCode).toBe(200);
    const write = await inject("POST", `/api/v1/projects/${projA}/budgets`, h4, {
      name: "Not allowed",
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().message).toMatch(/standard access to budget/i);
  });

  it("hides another company's budget entirely", async () => {
    const res = await inject("GET", `/api/v1/budgets/${budgetMain}`, outsider.headers);
    expect(res.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Budget line items                                                   */
/* ================================================================== */

let lineA: string; // 03300 / subcontract  100,000
let lineB: string; // 03310 / material      50,000
let lineC: string; // 99-CONT / other       25,000  (contingency)
let lineD: string; // 16100 / subcontract   40,000

describe("Budget line items", () => {
  it("binds a line to a real cost code and materializes the WBS path from its parents", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCodeId: ccCip,
      description: "Cast-in-place structure",
      originalBudget: 100_000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    lineA = body.id;
    expect(body.costCode).toBe("03300");
    // costType defaults from the cost code itself, not from a guess
    expect(body.costType).toBe("subcontract");
    expect(body.wbsPath).toBe("03/03300");
    expect(body.revisedBudget).toBe(100_000);
    // default method is remaining_budget: nothing spent ⇒ all of it to come
    expect(body.forecastMethod).toBe("remaining_budget");
    expect(body.forecastToComplete).toBe(100_000);
    expect(body.forecastFinal).toBe(100_000);
    expect(body.projectedOverUnder).toBe(0);
  });

  it("refuses a cost code that is not in the project's structure", async () => {
    const unknown = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCode: "99-NOPE",
      description: "Invented code",
      originalBudget: 1_000,
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toMatch(/does not define a parallel one/i);

    const inactive = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCodeId: ccInactive,
      description: "Retired code",
      originalBudget: 1_000,
    });
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().message).toMatch(/inactive/i);
  });

  it("creates the rest of the baseline, resolving cost codes by their code string", async () => {
    const b = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCode: "03310",
      description: "Reinforcement supply",
      originalBudget: 50_000,
    });
    expect(b.statusCode).toBe(201);
    lineB = b.json().id;
    expect(b.json().costType).toBe("material");

    const c = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCode: "99-CONT",
      description: "Construction contingency",
      lineKind: "contingency",
      originalBudget: 25_000,
    });
    expect(c.statusCode).toBe(201);
    lineC = c.json().id;
    expect(c.json().lineKind).toBe("contingency");
    expect(c.json().costType).toBe("other");

    const d = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCode: "16100",
      description: "Electrical subcontract",
      originalBudget: 40_000,
    });
    expect(d.statusCode).toBe(201);
    lineD = d.json().id;

    const budget = await inject("GET", `/api/v1/budgets/${budgetMain}`, u1.headers);
    expect(budget.json().lineCount).toBe(4);
    expect(budget.json().originalBudgetTotal).toBe(215_000);
    expect(budget.json().revisedBudgetTotal).toBe(215_000);
    for (const identity of budget.json().reconciliation) expect(identity.ok).toBe(true);
  });

  it("refuses a second line on the same cost code × cost type coordinate", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/lines`, u1.headers, {
      costCodeId: ccCip,
      costType: "subcontract",
      description: "Duplicate coordinate",
      originalBudget: 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/exactly one line/i);
  });

  it("extends a measured line and refuses a budget that disagrees with quantity × rate", async () => {
    const bad = await inject("POST", `/api/v1/budgets/${budgetImport}/lines`, u1.headers, {
      costCodeId: ccCip,
      description: "Measured slab",
      unit: "m3",
      quantity: 400,
      unitRate: 250,
      originalBudget: 99_000,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/quantity × unitRate/i);

    const ok = await inject("POST", `/api/v1/budgets/${budgetImport}/lines`, u1.headers, {
      costCodeId: ccCip,
      description: "Measured slab",
      unit: "m3",
      quantity: 400,
      unitRate: 250,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().originalBudget).toBe(100_000);
  });

  it("recomputes forecast and variance when costs are booked against a line", async () => {
    const res = await inject("PATCH", `/api/v1/budget-lines/${lineD}`, u1.headers, {
      directCosts: 45_000,
      percentComplete: 0.5,
      forecastMethod: "productivity_trend",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobToDateCosts).toBe(45_000);
    // £45k to reach 50% ⇒ £90k at completion on a £40k budget: a £50k overrun
    expect(body.forecastFinal).toBe(90_000);
    expect(body.projectedOverUnder).toBe(-50_000);

    const budget = await inject("GET", `/api/v1/budgets/${budgetMain}`, u1.headers);
    expect(budget.json().varianceTotal).toBe(-50_000);
    expect(budget.json().jobToDateCostsTotal).toBe(45_000);

    // put the line back to a clean state for the change tests below
    await inject("PATCH", `/api/v1/budget-lines/${lineD}`, u1.headers, {
      directCosts: 0,
      jobToDateCosts: 0,
      percentComplete: 0,
      forecastMethod: "remaining_budget",
    });
  });

  it("filters, sorts and totals the line grid", async () => {
    const res = await inject(
      "GET",
      `/api/v1/budgets/${budgetMain}/lines?costType=subcontract&sort=revisedBudget`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((l: { costCode: string }) => l.costCode)).toEqual(["03300", "16100"]);
    expect(body.filteredTotals.revisedBudgetTotal).toBe(140_000);
    expect(body.currency).toBe("USD");

    const search = await inject(
      "GET",
      `/api/v1/budgets/${budgetMain}/lines?q=contingency`,
      u1.headers,
    );
    expect(search.json().total).toBe(1);
  });
});

/* ================================================================== */
/* Bulk create + CSV import                                            */
/* ================================================================== */

describe("Bulk create and CSV import", () => {
  it("bulk-creates lines in one transaction and refuses a duplicate coordinate in the batch", async () => {
    const dup = await inject("POST", `/api/v1/budgets/${budgetImport}/lines/bulk`, u1.headers, {
      lines: [
        { costCode: "03310", description: "Rebar", originalBudget: 10_000 },
        { costCode: "03310", description: "Rebar again", originalBudget: 20_000 },
      ],
    });
    expect(dup.statusCode).toBe(400);
    expect(JSON.stringify(dup.json().details)).toMatch(/Duplicate WBS coordinate/i);

    const before = await inject("GET", `/api/v1/budgets/${budgetImport}`, u1.headers);
    const ok = await inject("POST", `/api/v1/budgets/${budgetImport}/lines/bulk`, u1.headers, {
      lines: [
        { costCode: "03310", description: "Rebar supply", originalBudget: 30_000 },
        { costCode: "16100", description: "Electrical", originalBudget: 20_000 },
      ],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().created).toBe(2);
    const after = await inject("GET", `/api/v1/budgets/${budgetImport}`, u1.headers);
    expect(after.json().originalBudgetTotal).toBe(
      before.json().originalBudgetTotal + 50_000,
    );
  });

  it("validates a CSV without writing anything when dryRun is set", async () => {
    const csv = [
      "cost_code,description,quantity,unit_rate,notes,mystery_column",
      "99-CONT,Contingency,,,carried at bid,ignored",
      "03,Concrete allowance,,,,",
    ].join("\n");
    const res = await inject("POST", `/api/v1/budgets/${budgetImport}/lines/import`, u1.headers, {
      csv,
      dryRun: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.parsedRows).toBe(2);
    expect(body.readyRows).toBe(2);
    expect(body.unknownColumns).toContain("mystery_column");
    expect(body.issues).toHaveLength(0);

    const budget = await inject("GET", `/api/v1/budgets/${budgetImport}`, u1.headers);
    expect(budget.json().lineCount).toBe(3);
  });

  it("reports the offending row and writes nothing when a CSV cell is not a number", async () => {
    const csv = [
      "cost_code,description,original_budget",
      "99-CONT,Contingency,twenty thousand",
    ].join("\n");
    const res = await inject("POST", `/api/v1/budgets/${budgetImport}/lines/import`, u1.headers, {
      csv,
    });
    expect(res.statusCode).toBe(400);
    const issues = (res.json().details as { issues: { row: number; field: string }[] }).issues;
    expect(issues[0]).toMatchObject({ row: 2, field: "originalBudget" });
    const budget = await inject("GET", `/api/v1/budgets/${budgetImport}`, u1.headers);
    expect(budget.json().lineCount).toBe(3);
  });

  it("imports a CSV and upserts amounts onto an existing coordinate", async () => {
    const created = await inject(
      "POST",
      `/api/v1/budgets/${budgetImport}/lines/import`,
      u1.headers,
      {
        csv: [
          "cost_code,description,original_budget,line_kind",
          '"99-CONT","Construction contingency","25,000",contingency',
        ].join("\n"),
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().created).toBe(1);

    const upserted = await inject(
      "POST",
      `/api/v1/budgets/${budgetImport}/lines/import`,
      u1.headers,
      {
        csv: ["cost_code,description,original_budget", "99-CONT,Contingency uplift,40000"].join(
          "\n",
        ),
        mode: "upsert",
      },
    );
    expect(upserted.statusCode).toBe(201);
    expect(upserted.json().updated).toBe(1);
    expect(upserted.json().created).toBe(0);

    const lines = await inject(
      "GET",
      `/api/v1/budgets/${budgetImport}/lines?costCode=99-CONT`,
      u1.headers,
    );
    expect(lines.json().items[0].originalBudget).toBe(40_000);
    expect(lines.json().total).toBe(1);
  });

  it("refuses a CSV with no cost_code column", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetImport}/lines/import`, u1.headers, {
      csv: "description,original_budget\nSomething,100",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cost_code column/i);
  });
});

/* ================================================================== */
/* Budget changes                                                      */
/* ================================================================== */

let transfer1: string;
let draw1: string;
let ownerChange1: string;
let coPackage: string;

const lineById = async (id: string) => {
  const rows = await built.app.db
    .select()
    .from(budgetLineItems)
    .where(eq(budgetLineItems.id, id))
    .limit(1);
  return rows[0]!;
};

describe("Budget changes: transfers, approval and the audit of every movement", () => {
  it("locks the budget so amounts can only move through an approved change", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/lock`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("locked");
    expect(res.json().lockedBy).toBe(u1.userId);

    const edit = await inject("PATCH", `/api/v1/budget-lines/${lineA}`, u1.headers, {
      originalBudget: 999_999,
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toMatch(/only through an approved budget change/i);

    // actuals and progress are NOT frozen by the lock — they keep accruing
    const actual = await inject("PATCH", `/api/v1/budget-lines/${lineA}`, u1.headers, {
      percentComplete: 0.1,
    });
    expect(actual.statusCode).toBe(200);
  });

  it("creates a two-leg transfer that balances to zero", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, h3, {
      title: "Move slab underspend to rebar",
      reason: "Rebar rates came in above the estimate",
      fromLineItemId: lineA,
      toLineItemId: lineB,
      amount: 10_000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    transfer1 = body.id;
    expect(body.reference).toBe("BC-001");
    expect(body.status).toBe("draft");
    expect(body.kind).toBe("transfer");
    expect(body.amount).toBe(10_000);
    expect(body.netEffect).toBe(0);
    expect(body.lines).toHaveLength(2);
    expect(body.requestedBy).toBe(u3.userId);
  });

  it("refuses an unbalanced transfer and says by how much", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      title: "Unfunded uplift",
      lines: [
        { lineItemId: lineA, amount: -10_000 },
        { lineItemId: lineB, amount: 5_000 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/balance to zero/i);
    expect((res.json().details as { net: number }).net).toBe(-5_000);
  });

  it("refuses a leg against a line that is not on this budget", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      title: "Cross-budget transfer",
      lines: [
        { lineItemId: lineA, amount: -1_000 },
        { lineItemId: newId("bli"), amount: 1_000 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not on this budget/i);
  });

  it("submitting moves the legs into pending exposure without touching the budget", async () => {
    const res = await inject("POST", `/api/v1/budget-changes/${transfer1}/submit`, h3);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending_approval");
    expect(res.json().requestedAt).toBeTruthy();

    expect((await lineById(lineA)).pendingBudgetChanges).toBe(-10_000);
    expect((await lineById(lineB)).pendingBudgetChanges).toBe(10_000);
    // a pending transfer is exposure, never budget
    expect((await lineById(lineA)).revisedBudget).toBe(100_000);
  });

  it("refuses approval by a user without budget admin", async () => {
    const res = await inject("POST", `/api/v1/budget-changes/${transfer1}/approve`, h3);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/admin access to budget/i);
  });

  it("applies an approved transfer and keeps the budget total unchanged", async () => {
    const res = await inject("POST", `/api/v1/budget-changes/${transfer1}/approve`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");
    expect(res.json().approvedBy).toBe(u1.userId);

    const a = await lineById(lineA);
    const b = await lineById(lineB);
    expect(a.budgetModifications).toBe(-10_000);
    expect(a.revisedBudget).toBe(90_000);
    expect(a.pendingBudgetChanges).toBe(0);
    expect(b.budgetModifications).toBe(10_000);
    expect(b.revisedBudget).toBe(60_000);

    const budget = await inject("GET", `/api/v1/budgets/${budgetMain}`, u1.headers);
    expect(budget.json().revisedBudgetTotal).toBe(215_000);
    expect(budget.json().budgetModificationsTotal).toBe(0);
    // a locked budget that has taken an approved change is "revised"
    expect(budget.json().status).toBe("revised");
    for (const identity of budget.json().reconciliation) expect(identity.ok).toBe(true);
  });

  it("refuses self-approval — the requester may not approve their own movement", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      kind: "contingency_draw",
      title: "Draw contingency for slab overrun",
      reason: "Unforeseen ground conditions",
      fromLineItemId: lineC,
      toLineItemId: lineA,
      amount: 5_000,
    });
    expect(created.statusCode).toBe(201);
    draw1 = created.json().id;
    await inject("POST", `/api/v1/budget-changes/${draw1}/submit`, u1.headers);

    const selfApprove = await inject("POST", `/api/v1/budget-changes/${draw1}/approve`, u1.headers);
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().message).toMatch(/may not be the person who requested it/i);

    // the movement is still pending — a refused approval changes nothing
    expect((await lineById(lineC)).pendingBudgetChanges).toBe(-5_000);
    expect((await lineById(lineC)).revisedBudget).toBe(25_000);
  });

  it("lets an independent approver release the same draw", async () => {
    const res = await inject("POST", `/api/v1/budget-changes/${draw1}/approve`, h2);
    expect(res.statusCode).toBe(200);
    expect(res.json().approvedBy).toBe(u2.userId);
    expect(res.json().approvedBy).not.toBe(res.json().requestedBy);

    expect((await lineById(lineC)).revisedBudget).toBe(20_000);
    expect((await lineById(lineA)).revisedBudget).toBe(95_000);
    const budget = await inject("GET", `/api/v1/budgets/${budgetMain}`, u1.headers);
    expect(budget.json().revisedBudgetTotal).toBe(215_000);
  });

  it("refuses a contingency draw that does not source from a contingency line", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      kind: "contingency_draw",
      title: "Pretend draw",
      fromLineItemId: lineB,
      toLineItemId: lineA,
      amount: 1_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/kind 'contingency'/i);
  });

  it("refuses an owner change with no executed change order behind it", async () => {
    const noSource = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      kind: "owner_change",
      title: "Unbacked uplift",
      lines: [{ lineItemId: lineD, amount: 30_000 }],
    });
    expect(noSource.statusCode).toBe(400);
    expect(noSource.json().message).toMatch(/signed instrument/i);

    const badSource = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      kind: "owner_change",
      title: "Unbacked uplift",
      sourceType: "change_order_package",
      sourceId: newId("cop"),
      lines: [{ lineItemId: lineD, amount: 30_000 }],
    });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().message).toMatch(/change order package on this project/i);
  });

  it("raises the budget total only for an owner change backed by a package", async () => {
    coPackage = newId("cop");
    await built.app.db.insert(changeOrderPackages).values({
      id: coPackage,
      companyId: u1.companyId,
      projectId: projA,
      kind: "prime_contract",
      number: 1,
      reference: "PCCO-001",
      title: "Owner-directed additional switchgear",
      status: "executed",
      amount: 30_000,
      createdBy: u1.userId,
    });
    const created = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, h3, {
      kind: "owner_change",
      title: "PCCO-001 additional switchgear",
      sourceType: "change_order_package",
      sourceId: coPackage,
      lines: [{ lineItemId: lineD, amount: 30_000 }],
    });
    expect(created.statusCode).toBe(201);
    ownerChange1 = created.json().id;
    expect(created.json().netEffect).toBe(30_000);

    await inject("POST", `/api/v1/budget-changes/${ownerChange1}/submit`, h3);
    const approved = await inject(
      "POST",
      `/api/v1/budget-changes/${ownerChange1}/approve`,
      u1.headers,
    );
    expect(approved.statusCode).toBe(200);

    const d = await lineById(lineD);
    // owner money lands in approvedChanges, NOT in budgetModifications
    expect(d.approvedChanges).toBe(30_000);
    expect(d.budgetModifications).toBe(0);
    expect(d.revisedBudget).toBe(70_000);

    const budget = await inject("GET", `/api/v1/budgets/${budgetMain}`, u1.headers);
    expect(budget.json().revisedBudgetTotal).toBe(245_000);
    expect(budget.json().approvedChangesTotal).toBe(30_000);
    expect(budget.json().originalBudgetTotal).toBe(215_000);
    for (const identity of budget.json().reconciliation) expect(identity.ok).toBe(true);
  });

  it("refuses a movement that would drive a line's revised budget below zero", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      title: "Strip the rebar line",
      fromLineItemId: lineB,
      toLineItemId: lineA,
      amount: 200_000,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers);

    const approve = await inject("POST", `/api/v1/budget-changes/${id}/approve`, h2);
    expect(approve.statusCode).toBe(409);
    expect(approve.json().message).toMatch(/negative revised budget/i);

    // voiding a pending movement returns the exposure it was holding
    const voided = await inject("POST", `/api/v1/budget-changes/${id}/void`, u1.headers);
    expect(voided.statusCode).toBe(200);
    expect(voided.json().status).toBe("void");
    expect((await lineById(lineB)).pendingBudgetChanges).toBe(0);
  });

  it("records a rejection as evidence, and refuses a rejection by the requester", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetMain}/changes`, u1.headers, {
      title: "Speculative transfer",
      fromLineItemId: lineA,
      toLineItemId: lineB,
      amount: 1_000,
    });
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers);

    const selfReject = await inject("POST", `/api/v1/budget-changes/${id}/reject`, u1.headers, {
      reason: "Changed my mind",
    });
    expect(selfReject.statusCode).toBe(403);

    const rejected = await inject("POST", `/api/v1/budget-changes/${id}/reject`, h2, {
      reason: "No commercial justification supplied",
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe("rejected");
    expect(rejected.json().rejectedBy).toBe(u2.userId);
    expect(rejected.json().rejectionReason).toMatch(/justification/i);
    expect((await lineById(lineA)).pendingBudgetChanges).toBe(0);
  });

  it("refuses to void an approved movement — the money has already moved", async () => {
    const res = await inject("POST", `/api/v1/budget-changes/${transfer1}/void`, u1.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/reversing change/i);
  });

  it("refuses to edit a movement once it has left draft", async () => {
    const res = await inject("PATCH", `/api/v1/budget-changes/${transfer1}`, u1.headers, {
      title: "Rewritten after the fact",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/approval record/i);
  });

  it("replays every approved movement and reconstructs the stored revised total", async () => {
    const res = await inject("GET", `/api/v1/budgets/${budgetMain}/movements`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openingTotal).toBe(215_000);
    expect(body.closingTotal).toBe(245_000);
    expect(body.storedRevisedTotal).toBe(245_000);
    expect(body.reconcilesToRevisedTotal).toBe(true);
    // 2 balanced transfers × 2 legs + 1 owner change × 1 leg
    expect(body.movementCount).toBe(5);
    const last = body.movements[body.movements.length - 1];
    expect(last.kind).toBe("owner_change");
    expect(last.sourceId).toBe(coPackage);
    expect(last.budgetTotalAfter).toBe(245_000);
    for (const m of body.movements) {
      expect(m.approvedBy).toBeTruthy();
      expect(m.approvedBy).not.toBe(m.requestedBy);
    }
  });

  it("writes every consequential movement to the hash-chained ledger", async () => {
    const rows = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, u1.companyId),
          eq(ledgerEntries.objectType, "budget_change"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.some((r) => r.action === "state_change")).toBe(true);
    expect(rows.every((r) => r.entryHash.length === 64)).toBe(true);
  });
});

/* ================================================================== */
/* Snapshots                                                           */
/* ================================================================== */

let snapLineA: string;
let snapLineB: string;
let snap1: string;
let snap2: string;

describe("Budget snapshots: immutable period captures", () => {
  it("captures the whole line set with a content hash", async () => {
    const a = await inject("POST", `/api/v1/budgets/${budgetSnap}/lines`, u1.headers, {
      costCodeId: ccCip,
      description: "Structure",
      originalBudget: 200_000,
    });
    snapLineA = a.json().id;
    const b = await inject("POST", `/api/v1/budgets/${budgetSnap}/lines`, u1.headers, {
      costCodeId: ccRebar,
      description: "Rebar",
      originalBudget: 80_000,
    });
    snapLineB = b.json().id;

    const res = await inject("POST", `/api/v1/budgets/${budgetSnap}/snapshots`, u1.headers, {
      name: "August close",
      kind: "monthly_close",
      asOfDate: CAPTURE_1,
      periodStart: daysAgo(70),
      periodEnd: CAPTURE_1,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    snap1 = body.id;
    expect(body.reference).toBe("BS-001");
    expect(body.lineCount).toBe(2);
    expect(body.contentHash).toHaveLength(64);
    expect(body.totals.revisedBudgetTotal).toBe(280_000);
    expect(body.capturedBy).toBe(u1.userId);
    expect(body).not.toHaveProperty("updatedAt");
  });

  it("verifies the capture still hashes to what was recorded", async () => {
    const res = await inject("GET", `/api/v1/budget-snapshots/${snap1}`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().hashVerified).toBe(true);
    expect(res.json().recomputedContentHash).toBe(res.json().contentHash);
    expect(res.json().immutable).toBe(true);
    expect(res.json().lines).toHaveLength(2);
  });

  it("offers no mutation route at all on a capture", async () => {
    const patch = await inject("PATCH", `/api/v1/budget-snapshots/${snap1}`, u1.headers, {
      name: "Rewritten",
    });
    expect(patch.statusCode).toBe(404);
    const del = await inject("DELETE", `/api/v1/budget-snapshots/${snap1}`, u1.headers);
    expect(del.statusCode).toBe(404);
  });

  it("refuses to edit a snapshotted period's plan amounts", async () => {
    const res = await inject("PATCH", `/api/v1/budget-lines/${snapLineA}`, u1.headers, {
      originalBudget: 250_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(new RegExp(`captured as at ${CAPTURE_1}`, "i"));

    const added = await inject("POST", `/api/v1/budgets/${budgetSnap}/lines`, u1.headers, {
      costCodeId: ccElecSub,
      description: "Late addition",
      originalBudget: 10_000,
    });
    expect(added.statusCode).toBe(409);
  });

  it("refuses a movement back-dated into a captured period", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetSnap}/changes`, u1.headers, {
      title: "Back-dated transfer",
      effectiveDate: BACKDATED,
      fromLineItemId: snapLineA,
      toLineItemId: snapLineB,
      amount: 5_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/rewrite a closed period/i);
  });

  it("accepts the same movement dated after the capture, and captures again", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetSnap}/changes`, u1.headers, {
      title: "September transfer",
      effectiveDate: TRANSFER_2,
      fromLineItemId: snapLineA,
      toLineItemId: snapLineB,
      amount: 20_000,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-changes/${id}/submit`, u1.headers);
    const approved = await inject("POST", `/api/v1/budget-changes/${id}/approve`, h2);
    expect(approved.statusCode).toBe(200);

    const res = await inject("POST", `/api/v1/budgets/${budgetSnap}/snapshots`, u1.headers, {
      name: "September close",
      asOfDate: CAPTURE_2,
    });
    expect(res.statusCode).toBe(201);
    snap2 = res.json().id;
    expect(res.json().reference).toBe("BS-002");
    expect(res.json().totals.revisedBudgetTotal).toBe(280_000);
  });

  it("refuses a capture back-dated behind one already taken", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetSnap}/snapshots`, u1.headers, {
      name: "July close, late",
      asOfDate: LATE_CAPTURE,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/cannot be back-dated/i);
  });

  it("diffs two captures line by line", async () => {
    const res = await inject(
      "GET",
      `/api/v1/budgets/${budgetSnap}/snapshots/diff?from=${snap1}&to=${snap2}`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from.reference).toBe("BS-001");
    expect(body.to.reference).toBe("BS-002");
    expect(body.changedCount).toBe(2);
    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    const byCode = new Map(
      body.changed.map((c: { costCode: string; fields: { field: string; delta: number }[] }) => [
        c.costCode,
        new Map(c.fields.map((f) => [f.field, f.delta])),
      ]),
    ) as Map<string, Map<string, number>>;
    expect(byCode.get("03300")?.get("revisedBudget")).toBe(-20_000);
    expect(byCode.get("03310")?.get("revisedBudget")).toBe(20_000);
    // the transfer nets to zero, so no budget total moved between captures
    expect(
      body.totals.find((t: { field: string }) => t.field === "revisedBudgetTotal"),
    ).toBeUndefined();

    // references work as well as ids — a reviewer thinks in "BS-001 vs BS-002"
    const byRef = await inject(
      "GET",
      `/api/v1/budgets/${budgetSnap}/snapshots/diff?from=1&to=BS-002`,
      u1.headers,
    );
    expect(byRef.statusCode).toBe(200);
    expect(byRef.json().changedCount).toBe(2);
  });

  it("refuses a diff of a capture against itself", async () => {
    const res = await inject(
      "GET",
      `/api/v1/budgets/${budgetSnap}/snapshots/diff?from=${snap1}&to=${snap1}`,
      u1.headers,
    );
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Forecasting                                                         */
/* ================================================================== */

let fcLine1: string;
let fcLine2: string;
let forecast1: string;

describe("Forecasting", () => {
  it("seeds forecast lines with costs booked against them", async () => {
    const a = await inject("POST", `/api/v1/budgets/${budgetFc}/lines`, u1.headers, {
      costCodeId: ccCip,
      description: "Structure",
      originalBudget: 100_000,
      directCosts: 40_000,
      percentComplete: 0.5,
    });
    expect(a.statusCode).toBe(201);
    fcLine1 = a.json().id;
    expect(a.json().jobToDateCosts).toBe(40_000);
    expect(a.json().forecastToComplete).toBe(60_000);

    const b = await inject("POST", `/api/v1/budgets/${budgetFc}/lines`, u1.headers, {
      costCodeId: ccElecSub,
      description: "Electrical",
      originalBudget: 60_000,
    });
    fcLine2 = b.json().id;
  });

  it("refuses a manual forecast with no figure, and a trend forecast with no progress", async () => {
    const manual = await inject("POST", `/api/v1/budgets/${budgetFc}/forecasts`, u1.headers, {
      lineItemId: fcLine1,
      method: "manual",
    });
    expect(manual.statusCode).toBe(400);
    expect((manual.json().details as { reasons: string[] }).reasons[0]).toMatch(
      /requires an explicit forecastToComplete/i,
    );

    const noProgress = await inject("POST", `/api/v1/budgets/${budgetFc}/forecasts`, u1.headers, {
      lineItemId: fcLine2,
      method: "percent_complete",
    });
    expect(noProgress.statusCode).toBe(400);
    expect((noProgress.json().details as { reasons: string[] }).reasons.join(" ")).toMatch(
      /percent complete/i,
    );
    // the line's stored figure is untouched by a refused forecast
    const line = await lineById(fcLine2);
    expect(line.forecastToComplete).toBe(60_000);
  });

  it("records a manual forecast with the method that produced it", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetFc}/forecasts`, u1.headers, {
      lineItemId: fcLine1,
      method: "manual",
      forecastToComplete: 75_000,
      percentComplete: 0.5,
      asOfDate: "2026-09-30",
      assumptions: "Two extra pours carried",
      curve: [
        { month: "2026-10", amount: 40_000 },
        { month: "2026-11", amount: 35_000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    forecast1 = body.id;
    expect(body.reference).toBe("FC-001");
    expect(body.method).toBe("manual");
    expect(body.status).toBe("draft");
    expect(body.forecastToComplete).toBe(75_000);
    expect(body.forecastFinal).toBe(115_000);
    // previous position was the line's own £100k forecast at completion
    expect(body.previousForecastFinal).toBe(100_000);
    expect(body.deltaFromPrevious).toBe(15_000);
    expect(body.curve).toHaveLength(2);
  });

  it("refuses approval by the forecast's own author", async () => {
    const submitted = await inject(
      "POST",
      `/api/v1/budget-forecasts/${forecast1}/submit`,
      u1.headers,
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().submittedBy).toBe(u1.userId);

    const selfApprove = await inject(
      "POST",
      `/api/v1/budget-forecasts/${forecast1}/approve`,
      u1.headers,
    );
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().message).toMatch(/may not be its author/i);
    // nothing moved on the line
    expect((await lineById(fcLine1)).forecastToComplete).toBe(60_000);
  });

  it("applies an independently approved forecast to the line", async () => {
    const res = await inject("POST", `/api/v1/budget-forecasts/${forecast1}/approve`, h2);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");

    const line = await lineById(fcLine1);
    expect(line.forecastMethod).toBe("manual");
    expect(line.forecastToComplete).toBe(75_000);
    expect(line.forecastFinal).toBe(115_000);
    // variance = revised − forecast at completion; negative is an overrun
    expect(line.projectedOverUnder).toBe(-15_000);

    const budget = await inject("GET", `/api/v1/budgets/${budgetFc}`, u1.headers);
    expect(budget.json().forecastFinalTotal).toBe(175_000);
    expect(budget.json().varianceTotal).toBe(-15_000);
    for (const identity of budget.json().reconciliation) expect(identity.ok).toBe(true);
  });

  it("supersedes the standing forecast when a newer one is approved", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetFc}/forecasts`, h3, {
      lineItemId: fcLine1,
      method: "productivity_trend",
      percentComplete: 0.5,
    });
    expect(created.statusCode).toBe(201);
    // £40k spent to reach 50% ⇒ £80k at completion
    expect(created.json().forecastFinal).toBe(80_000);
    expect(created.json().previousForecastFinal).toBe(115_000);
    expect(created.json().deltaFromPrevious).toBe(-35_000);

    const id = created.json().id as string;
    await inject("POST", `/api/v1/budget-forecasts/${id}/submit`, h3);
    const approved = await inject("POST", `/api/v1/budget-forecasts/${id}/approve`, u1.headers);
    expect(approved.statusCode).toBe(200);

    const list = await inject(
      "GET",
      `/api/v1/budgets/${budgetFc}/forecasts?lineItemId=${fcLine1}`,
      u1.headers,
    );
    const byRef = new Map(
      list.json().items.map((f: { reference: string; status: string }) => [f.reference, f.status]),
    );
    expect(byRef.get("FC-001")).toBe("superseded");
    expect(byRef.get("FC-002")).toBe("approved");
    expect((await lineById(fcLine1)).forecastFinal).toBe(80_000);
  });

  it("previews the computed default per line without persisting anything", async () => {
    const res = await inject(
      "GET",
      `/api/v1/budgets/${budgetFc}/forecast-preview?method=committed_plus_pending`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toBe("committed_plus_pending");
    expect(body.lineCount).toBe(2);
    const line1 = body.lines.find((l: { lineItemId: string }) => l.lineItemId === fcLine1);
    // nothing committed: the fallback is the revised budget, not the trend
    expect(line1.proposedForecastFinal).toBe(100_000);
    expect(line1.storedForecastFinal).toBe(80_000);
    expect(line1.delta).toBe(20_000);
    // the stored figure is untouched by a preview
    expect((await lineById(fcLine1)).forecastFinal).toBe(80_000);
  });

  it("returns null with reasons for lines a method cannot be applied to", async () => {
    const res = await inject(
      "GET",
      `/api/v1/budgets/${budgetFc}/forecast-preview?method=unit_rate_trend`,
      u1.headers,
    );
    const body = res.json();
    expect(body.computableCount).toBe(0);
    expect(body.uncomputableCount).toBe(2);
    expect(body.proposedForecastFinalTotal).toBeNull();
    for (const line of body.lines) {
      expect(line.proposedForecastFinal).toBeNull();
      expect(line.reasons.length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* Rollups, budget vs actual, recalculation                            */
/* ================================================================== */

let rollLine1: string; // 03300 subcontract 200,000
let rollLine2: string; // 03310 material    100,000
let rollLine3: string; // 16100 subcontract  50,000

describe("Rollups and budget vs actual", () => {
  it("seeds a budget on a second project", async () => {
    const mk = async (costCodeId: string, description: string, amount: number) => {
      const res = await inject("POST", `/api/v1/budgets/${budgetRoll}/lines`, u1.headers, {
        costCodeId,
        description,
        originalBudget: amount,
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };
    rollLine1 = await mk(ccCip, "Structure", 200_000);
    rollLine2 = await mk(ccRebar, "Rebar", 100_000);
    rollLine3 = await mk(ccElecSub, "Electrical", 50_000);
    const budget = await inject("GET", `/api/v1/budgets/${budgetRoll}`, u1.headers);
    expect(budget.json().revisedBudgetTotal).toBe(350_000);
  });

  it("rolls up by cost type, by WBS node and by cost-code division", async () => {
    const byType = await inject(
      "GET",
      `/api/v1/budgets/${budgetRoll}/rollup?by=cost_type`,
      u1.headers,
    );
    expect(byType.statusCode).toBe(200);
    const types = new Map(
      byType
        .json()
        .groups.map((g: { key: string; totals: { revisedBudgetTotal: number } }) => [
          g.key,
          g.totals.revisedBudgetTotal,
        ]),
    );
    expect(types.get("subcontract")).toBe(250_000);
    expect(types.get("material")).toBe(100_000);

    const byWbs = await inject("GET", `/api/v1/budgets/${budgetRoll}/rollup?by=wbs`, u1.headers);
    const nodes = new Map(
      byWbs
        .json()
        .groups.map((g: { key: string; totals: { revisedBudgetTotal: number }; lineCount: number }) => [
          g.key,
          g,
        ]),
    ) as Map<string, { totals: { revisedBudgetTotal: number }; lineCount: number }>;
    expect(nodes.get("03")?.totals.revisedBudgetTotal).toBe(300_000);
    expect(nodes.get("03")?.lineCount).toBe(2);
    expect(nodes.get("03/03300")?.totals.revisedBudgetTotal).toBe(200_000);
    expect(nodes.get("16")?.totals.revisedBudgetTotal).toBe(50_000);

    const byDivision = await inject(
      "GET",
      `/api/v1/budgets/${budgetRoll}/rollup?by=cost_code&depth=1`,
      u1.headers,
    );
    expect(byDivision.json().groups.map((g: { key: string }) => g.key)).toEqual(["03", "16"]);
    expect(byDivision.json().totals.revisedBudgetTotal).toBe(350_000);
    for (const identity of byDivision.json().reconciliation) expect(identity.ok).toBe(true);
  });

  it("reports committed and invoiced cost as UNKNOWN, not zero, while the source tables are empty", async () => {
    const res = await inject("GET", `/api/v1/budgets/${budgetRoll}/summary`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.revisedBudget).toBe(350_000);
    expect(body.components.committed.value).toBeNull();
    expect(body.components.committed.reasons[0]).toMatch(/unknown rather than zero/i);
    expect(body.components.invoicedToDate.value).toBeNull();
    expect(body.components.jobToDateCosts.value).toBeNull();
    expect(body.components.jobToDateCosts.reasons.join(" ")).toMatch(/cannot be stated/i);
    // direct cost IS knowable — the budget holds it itself
    expect(body.components.directCosts.value).toBe(0);
    expect(body.components.contingencyRemaining.value).toBeNull();
    expect(body.drift.committed).toBeNull();
  });

  it("skips rather than zeroes a component when its source table is empty", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetRoll}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updatedLines).toBe(0);
    expect(body.applied).toEqual({
      committedCost: false,
      pendingCommitments: false,
      jobToDateCosts: false,
      paidToDate: false,
    });
    expect(body.skipped.map((s: { component: string }) => s.component)).toEqual([
      "committedCost",
      "pendingCommitments",
      "invoicedToDate",
      "paidToDate",
      "jobToDateCosts",
    ]);
    for (const skipped of body.skipped) expect(skipped.reasons.length).toBeGreaterThan(0);
  });

  it("reads committed cost from the commitments tool and never sums across currencies", async () => {
    const mkCommitment = async (
      status: string,
      currency: string,
      number: number,
      lineId: string,
      value: number,
    ) => {
      const id = newId("cmt");
      await built.app.db.insert(commitments).values({
        id,
        companyId: u1.companyId,
        projectId: projB,
        kind: "subcontract",
        number,
        reference: `SC-${number}`,
        title: `Subcontract ${number}`,
        status,
        currency,
        executed: status === "approved" ? 1 : 0,
        originalCommitmentSum: value,
        revisedCommitmentSum: value,
        createdBy: u1.userId,
      });
      await built.app.db.insert(commitmentSovLines).values({
        id: newId("csl"),
        companyId: u1.companyId,
        projectId: projB,
        commitmentId: id,
        lineNumber: "1",
        budgetLineItemId: lineId,
        description: "Scope",
        scheduledValue: value,
        revisedScheduledValue: value,
      });
      return id;
    };
    await mkCommitment("approved", "USD", 1, rollLine1, 180_000);
    await mkCommitment("draft", "USD", 2, rollLine2, 60_000);
    // a euro subcontract on a dollar budget: excluded and disclosed
    await mkCommitment("approved", "EUR", 3, rollLine3, 999_999);

    const res = await inject("GET", `/api/v1/budgets/${budgetRoll}/summary`, u1.headers);
    const body = res.json();
    expect(body.components.committed.value).toBe(180_000);
    expect(body.components.committed.reasons.join(" ")).toMatch(
      /never summed across currencies/i,
    );
    expect(body.components.committed.inputs.excludedCurrencies).toEqual(["EUR"]);
    expect(body.components.pendingCommitments.value).toBe(60_000);
    // the stored rollup has not been refreshed yet, so the drift is visible
    expect(body.drift.committed).toBe(180_000);
  });

  it("reads job-to-date cost from approved subcontractor invoices only", async () => {
    const mkInvoice = async (status: string, number: number, lineId: string, amount: number) => {
      const id = newId("inv");
      await built.app.db.insert(invoices).values({
        id,
        companyId: u1.companyId,
        projectId: projB,
        kind: "subcontractor_invoice",
        number,
        reference: `INV-${number}`,
        status,
        currency: "USD",
        createdBy: u1.userId,
      });
      await built.app.db.insert(invoiceLineItems).values({
        id: newId("ili"),
        companyId: u1.companyId,
        projectId: projB,
        invoiceId: id,
        lineNumber: "1",
        budgetLineItemId: lineId,
        description: "Progress",
        totalCompletedAndStored: amount,
        amount,
      });
    };
    await mkInvoice("approved", 1, rollLine1, 90_000);
    // a draft invoice is not a cost incurred and must not be counted
    await mkInvoice("draft", 2, rollLine2, 45_000);

    const res = await inject("GET", `/api/v1/budgets/${budgetRoll}/summary`, u1.headers);
    const body = res.json();
    expect(body.components.invoicedToDate.value).toBe(90_000);
    expect(body.components.jobToDateCosts.value).toBe(90_000);
    expect(body.components.jobToDateCosts.reasons).toHaveLength(0);
  });

  it("pulls the source figures down onto the lines and reconciles", async () => {
    const res = await inject("POST", `/api/v1/budgets/${budgetRoll}/recalculate`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied).toEqual({
      committedCost: true,
      pendingCommitments: true,
      jobToDateCosts: true,
      // no commitment payment has been posted on this project yet
      paidToDate: false,
    });
    expect(body.skipped.map((s: { component: string }) => s.component)).toEqual(["paidToDate"]);
    expect(body.totals.committedTotal).toBe(180_000);
    expect(body.totals.pendingCommitmentsTotal).toBe(60_000);
    expect(body.totals.jobToDateCostsTotal).toBe(90_000);
    for (const identity of body.reconciliation) expect(identity.ok).toBe(true);

    const line1 = await lineById(rollLine1);
    expect(line1.committedCost).toBe(180_000);
    expect(line1.jobToDateCosts).toBe(90_000);
    // remaining_budget: £200k budget less £90k spent
    expect(line1.forecastToComplete).toBe(110_000);
    expect(line1.forecastFinal).toBe(200_000);
    expect(line1.projectedOverUnder).toBe(0);

    const summary = await inject("GET", `/api/v1/budgets/${budgetRoll}/summary`, u1.headers);
    expect(summary.json().drift.committed).toBe(0);
    expect(summary.json().drift.jobToDateCosts).toBe(0);
  });

  it("surfaces the worst overrun lines on the summary", async () => {
    await inject("PATCH", `/api/v1/budget-lines/${rollLine3}`, u1.headers, {
      forecastMethod: "manual",
      forecastToComplete: 95_000,
    });
    const res = await inject("GET", `/api/v1/budgets/${budgetRoll}/summary`, u1.headers);
    const overruns = res.json().overrunLines as { lineItemId: string; projectedOverUnder: number }[];
    expect(overruns[0]?.lineItemId).toBe(rollLine3);
    expect(overruns[0]?.projectedOverUnder).toBe(-45_000);
    expect(res.json().plan.variance).toBe(-45_000);
  });

  it("refuses to change a budget's currency once it holds lines", async () => {
    const res = await inject("PATCH", `/api/v1/budgets/${budgetRoll}`, u1.headers, {
      currency: "EUR",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/never converted implicitly/i);
  });

  it("refuses to close a budget with unresolved movements, then closes it", async () => {
    const created = await inject("POST", `/api/v1/budgets/${budgetRoll}/changes`, u1.headers, {
      title: "Left hanging",
      fromLineItemId: rollLine1,
      toLineItemId: rollLine2,
      amount: 1_000,
    });
    const id = created.json().id as string;
    const blocked = await inject("POST", `/api/v1/budgets/${budgetRoll}/close`, u1.headers);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/unresolved budget change/i);

    await inject("POST", `/api/v1/budget-changes/${id}/void`, u1.headers);
    const closed = await inject("POST", `/api/v1/budgets/${budgetRoll}/close`, u1.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");

    const edit = await inject("PATCH", `/api/v1/budget-lines/${rollLine1}`, u1.headers, {
      description: "After close",
    });
    expect(edit.statusCode).toBe(409);
  });

  it("keeps every budget's totals reconciled end to end", async () => {
    for (const id of [budgetMain, budgetSnap, budgetFc, budgetImport, budgetRoll]) {
      const res = await inject("GET", `/api/v1/budgets/${id}`, u1.headers);
      expect(res.statusCode).toBe(200);
      for (const identity of res.json().reconciliation) {
        expect(identity.ok, `${id}: ${identity.identity} (delta ${identity.delta})`).toBe(true);
      }
    }
    const stored = await built.app.db
      .select()
      .from(budgets)
      .where(eq(budgets.id, budgetMain))
      .limit(1);
    expect(stored[0]!.totalsCalculatedAt).toBeTruthy();
  });
});
