/**
 * WP-FIN2 — change-management upgrade coverage.
 *
 *   markup schedules (#554)     project default, per-contract override,
 *                               value bands, and a COR that actually carries
 *                               the markup the contract says it does
 *   tier configuration (#563)   one/two/three tier stage lists and the
 *                               package route refusing a skipped stage
 *   ageing / cycle time /       #560-#562 analytics off the materialised
 *   pass-down (#560-562)        change_status_history
 *
 *   regressions                 quotes.ts:480  re-pricing an approved PCO
 *                               requests.ts:775 rejected COR locking its PCOs
 *                               pcos.ts:556    voiding a PCO inside a live COR
 *                               execute.ts:948 SOV decomposition after
 *                                              executing a commitment package
 *                               execute.ts:422 one currency-aware budget sync
 *                               quotes.ts:66   respondedAt validation
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  budgetLineItems,
  budgets,
  commitmentSovLines,
  commitments,
  companyMemberships,
  costCodes,
  primeContractSovLines,
  primeContracts,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { rulesForSubtotal, validateSchedule } from "./markups.js";
import { TIER_DEFINITIONS, skippedStages } from "./config.js";
import { bucketOf, median, percentile, stageOfStatus, stageTimeline } from "./analytics.js";
import type { MarkupRule } from "./arithmetic.js";

let built: BuiltApp;
let u1: TestActor; // owner — author/submitter
let u2: TestActor; // company admin — the independent approver
let outsider: TestActor;

let h2: Record<string, string>;

let proj: string;
let contractId: string;
let commitmentId: string;
let vendorA: string;
let budgetId: string;
let lineSub: string;

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

const OH_PROFIT: MarkupRule[] = [
  { kind: "percent", label: "Overhead", basis: "cost", rate: 10 },
  { kind: "percent", label: "Profit", basis: "running_total", rate: 5 },
];

beforeAll(async () => {
  built = await buildTestApp();
  u1 = await registerActor(built.app, { companyName: "FIN2 Change Co" });
  u2 = await registerActor(built.app);
  outsider = await registerActor(built.app);

  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: u1.companyId,
    userId: u2.userId,
    role: "admin",
  });
  h2 = {
    authorization: `Bearer ${u2.accessToken}`,
    "x-company-id": u1.companyId,
  };

  proj = newId("prj");
  await built.app.db.insert(projects).values({
    id: proj,
    companyId: u1.companyId,
    name: "FIN2 changes",
    currency: "USD",
  });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: u1.companyId,
    projectId: proj,
    userId: u2.userId,
    templateKey: "project_admin",
    overrides: {},
  });

  await built.app.db.insert(costCodes).values({
    id: newId("cc"),
    companyId: u1.companyId,
    code: "03300",
    title: "Concrete",
    costType: "subcontract",
  });

  vendorA = newId("ven");
  await built.app.db
    .insert(vendors)
    .values({ id: vendorA, companyId: u1.companyId, name: "Apex Concrete" });

  contractId = newId("pc");
  await built.app.db.insert(primeContracts).values({
    id: contractId,
    companyId: u1.companyId,
    projectId: proj,
    number: 1,
    reference: "PC-001",
    title: "Main contract",
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
    projectId: proj,
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
    projectId: proj,
    number: 1,
    reference: "BUD-001",
    name: "Baseline",
    isActive: 1,
    currency: "USD",
    createdBy: u1.userId,
  });
  lineSub = newId("bli");
  await built.app.db.insert(budgetLineItems).values({
    id: lineSub,
    budgetId,
    companyId: u1.companyId,
    projectId: proj,
    costCode: "03300",
    costType: "subcontract",
    description: "Concrete subcontract",
    originalBudget: 500_000,
    revisedBudget: 500_000,
    committedCost: 100_000,
    createdBy: u1.userId,
  });

  commitmentId = newId("cmt");
  await built.app.db.insert(commitments).values({
    id: commitmentId,
    companyId: u1.companyId,
    projectId: proj,
    kind: "subcontract",
    number: 1,
    reference: "SC-0001",
    title: "Concrete subcontract",
    status: "approved",
    executed: 1,
    currency: "USD",
    vendorId: vendorA,
    primeContractId: contractId,
    originalCommitmentSum: 100_000,
    revisedCommitmentSum: 100_000,
    defaultRetainagePercent: 5,
    createdBy: u1.userId,
  });
  await built.app.db.insert(commitmentSovLines).values({
    id: newId("csv"),
    companyId: u1.companyId,
    projectId: proj,
    commitmentId,
    lineNumber: "1",
    sortOrder: 10,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    description: "Base subcontract scope",
    scheduledValue: 100_000,
    revisedScheduledValue: 100_000,
    balanceToFinish: 100_000,
  });
});

afterAll(async () => {
  await built.close();
});

/** A PCO priced from its cost lines, stopping short of submission. */
async function pcoPricedOnly(title: string, amount: number): Promise<string> {
  const created = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders`,
    u1.headers,
    {
      title,
      commitmentId,
      reason: "design_error",
    },
  );
  const id = created.json().id as string;
  await inject("POST", `/api/v1/projects/${proj}/potential-change-orders/${id}/lines`, u1.headers, {
    description: title,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    costAmount: amount,
  });
  const priced = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders/${id}/price`,
    u1.headers,
    {},
  );
  if (priced.statusCode !== 200) throw new Error(`price failed: ${priced.body}`);
  return id;
}

/** A quoted (not yet accepted) RFQ against a PCO that is still open to pricing. */
async function quotedRfq(pcoId: string, amount: number): Promise<string> {
  const rfq = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/quote-requests`,
    u1.headers,
    { vendorId: vendorA, dueDate: "2030-01-01" },
  );
  if (rfq.statusCode !== 201) throw new Error(`rfq failed: ${rfq.body}`);
  const quoteId = rfq.json().id as string;
  await inject("POST", `/api/v1/projects/${proj}/quote-requests/${quoteId}/send`, u1.headers, {});
  const quoted = await inject(
    "POST",
    `/api/v1/projects/${proj}/quote-requests/${quoteId}/quote`,
    u1.headers,
    {
      quotedAmount: amount,
    },
  );
  if (quoted.statusCode !== 200) throw new Error(`quote failed: ${quoted.body}`);
  return quoteId;
}

/** A priced, approved PCO against the commitment, ready to be requested or packaged. */
async function pricedPco(title: string, amount: number): Promise<string> {
  const created = await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders`,
    u1.headers,
    {
      title,
      commitmentId,
      reason: "design_error",
    },
  );
  const id = created.json().id as string;
  await inject("POST", `/api/v1/projects/${proj}/potential-change-orders/${id}/lines`, u1.headers, {
    description: title,
    costCode: "03300",
    costType: "subcontract",
    budgetLineItemId: lineSub,
    costAmount: amount,
  });
  await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders/${id}/price`,
    u1.headers,
    {},
  );
  await inject(
    "POST",
    `/api/v1/projects/${proj}/potential-change-orders/${id}/submit`,
    u1.headers,
    {},
  );
  await inject("POST", `/api/v1/projects/${proj}/potential-change-orders/${id}/approve`, h2, {});
  return id;
}

/* ================================================================== */
/* Pure engines                                                        */
/* ================================================================== */

describe("markup schedule (pure)", () => {
  it("picks the band the cost subtotal falls in", () => {
    const schedule = {
      rules: [] as MarkupRule[],
      bands: [
        {
          upTo: 50_000,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 15 }] as MarkupRule[],
        },
        {
          upTo: 250_000,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 10 }] as MarkupRule[],
        },
        {
          upTo: null,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 5 }] as MarkupRule[],
        },
      ],
    };
    expect(rulesForSubtotal(schedule, 20_000).rules[0]!.rate).toBe(15);
    expect(rulesForSubtotal(schedule, 50_000).rules[0]!.rate).toBe(15);
    expect(rulesForSubtotal(schedule, 50_001).rules[0]!.rate).toBe(10);
    expect(rulesForSubtotal(schedule, 900_000).rules[0]!.rate).toBe(5);
  });

  it("bands a CREDIT by its magnitude, so a -20,000 omission carries the 20,000 band", () => {
    const schedule = {
      rules: [] as MarkupRule[],
      bands: [
        {
          upTo: 50_000,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 15 }] as MarkupRule[],
        },
        {
          upTo: null,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 5 }] as MarkupRule[],
        },
      ],
    };
    expect(rulesForSubtotal(schedule, -20_000).rules[0]!.rate).toBe(15);
  });

  it("falls back to the default rules when no band matches", () => {
    const schedule = {
      rules: OH_PROFIT,
      bands: [{ upTo: 10, rules: [] as MarkupRule[] }],
    };
    const { rules, band } = rulesForSubtotal(schedule, 100_000);
    expect(band).toBeNull();
    expect(rules).toHaveLength(2);
  });

  it("refuses bands that are not ascending, and an open band that is not last", () => {
    const problems = validateSchedule({
      rules: [],
      bands: [
        { upTo: null, rules: [] },
        { upTo: 100, rules: [] },
      ],
    });
    expect(problems.join(" ")).toContain("open-ended but is not the last");

    const descending = validateSchedule({
      rules: [],
      bands: [
        { upTo: 100_000, rules: [] },
        { upTo: 50_000, rules: [] },
      ],
    });
    expect(descending.join(" ")).toContain("must be above the previous band");
  });

  it("carries the stack validator's own complaints through, labelled by band", () => {
    const problems = validateSchedule({
      rules: [],
      bands: [
        {
          upTo: null,
          rules: [{ kind: "percent", label: "Bad", basis: "cost", rate: 400 }] as MarkupRule[],
        },
      ],
    });
    expect(problems[0]).toContain("Band 1:");
  });
});

describe("tier definitions (pure)", () => {
  it("states the stage list each tier demands", () => {
    expect(TIER_DEFINITIONS.one_tier.stages).toEqual(["event", "package"]);
    expect(TIER_DEFINITIONS.two_tier.stages).toContain("cor");
    expect(TIER_DEFINITIONS.three_tier.stages).toEqual(["event", "pco", "rfq", "cor", "package"]);
    expect(TIER_DEFINITIONS.three_tier.packageWithoutCor).toBe(false);
  });

  it("names the stage a three-tier member skipped", () => {
    expect(
      skippedStages(
        { tier: "three_tier", requireQuoteForSubcontract: false },
        {
          hasCor: false,
          hasAcceptedQuote: false,
          subcontract: true,
        },
      ),
    ).toEqual(["cor"]);
    expect(
      skippedStages(
        { tier: "three_tier", requireQuoteForSubcontract: true },
        {
          hasCor: true,
          hasAcceptedQuote: false,
          subcontract: true,
        },
      ),
    ).toEqual(["rfq"]);
    expect(
      skippedStages(
        { tier: "two_tier", requireQuoteForSubcontract: true },
        {
          hasCor: false,
          hasAcceptedQuote: false,
          subcontract: true,
        },
      ),
    ).toEqual([]);
  });
});

describe("ageing and cycle-time maths (pure)", () => {
  it("buckets days at the exact boundaries", () => {
    expect(bucketOf(0)).toBe("0-7");
    expect(bucketOf(7)).toBe("0-7");
    expect(bucketOf(8)).toBe("8-30");
    expect(bucketOf(30)).toBe("8-30");
    expect(bucketOf(31)).toBe("31-60");
    expect(bucketOf(61)).toBe("60+");
  });

  it("returns null rather than zero for a median of nothing", () => {
    expect(median([])).toBeNull();
    expect(percentile([], 90)).toBeNull();
  });

  it("computes a median and a p90 over a known set", () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("maps each chain status onto the stage it represents", () => {
    expect(stageOfStatus("potential_change_order", "priced")).toBe("priced");
    expect(stageOfStatus("change_order_request", "submitted")).toBe("submitted");
    expect(stageOfStatus("change_order_package", "executed")).toBe("executed");
    expect(stageOfStatus("potential_change_order", "not_a_status")).toBeNull();
  });

  it("turns a dated transition list into per-stage timestamps, keeping the FIRST time a stage was reached", () => {
    const timeline = stageTimeline("2026-01-01T00:00:00.000Z", [
      {
        objectType: "potential_change_order",
        objectId: "p1",
        toStatus: "priced",
        at: "2026-01-02T00:00:00.000Z",
      },
      {
        objectType: "potential_change_order",
        objectId: "p1",
        toStatus: "submitted",
        at: "2026-01-05T00:00:00.000Z",
      },
      {
        objectType: "potential_change_order",
        objectId: "p1",
        toStatus: "priced",
        at: "2026-01-09T00:00:00.000Z",
      },
    ]);
    expect(timeline.identified).toBe("2026-01-01T00:00:00.000Z");
    expect(timeline.priced).toBe("2026-01-02T00:00:00.000Z");
    expect(timeline.submitted).toBe("2026-01-05T00:00:00.000Z");
  });
});

/* ================================================================== */
/* Markup schedules over HTTP (#554)                                   */
/* ================================================================== */

describe("markup schedules", () => {
  it("says plainly that NOTHING is configured rather than implying zero is contractual", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-markups`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toBeNull();
    expect(res.json().note).toContain("ZERO markup");
  });

  it("refuses a schedule a standard user tries to save — markups are the contract", async () => {
    const standard = await registerActor(built.app);
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: u1.companyId,
      userId: standard.userId,
      role: "member",
    });
    await built.app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: u1.companyId,
      projectId: proj,
      userId: standard.userId,
      templateKey: "project_manager",
      overrides: {},
    });
    const res = await inject(
      "PUT",
      `/api/v1/projects/${proj}/change-markups`,
      {
        authorization: `Bearer ${standard.accessToken}`,
        "x-company-id": u1.companyId,
      },
      { name: "Sneaky", rules: OH_PROFIT },
    );
    expect(res.statusCode).toBe(403);
  });

  it("saves the project default with value bands", async () => {
    const res = await inject("PUT", `/api/v1/projects/${proj}/change-markups`, u1.headers, {
      name: "Standard OH&P",
      rules: OH_PROFIT,
      bands: [
        {
          upTo: 50_000,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 15 }],
        },
        {
          upTo: null,
          rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 5 }],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bands).toHaveLength(2);
  });

  it("refuses an invalid stack with the validator's own words", async () => {
    const res = await inject("PUT", `/api/v1/projects/${proj}/change-markups`, u1.headers, {
      name: "Broken",
      rules: [{ kind: "percent", label: "Nope", basis: "cost", rate: 400 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.problems.length).toBeGreaterThan(0);
  });

  it("resolves the band a subtotal attracts, and says which schedule it came from", async () => {
    const small = await inject(
      "GET",
      `/api/v1/projects/${proj}/change-markups/resolve?subtotal=10000`,
      u1.headers,
    );
    expect(small.json().source).toBe("project");
    expect(small.json().rules[0].rate).toBe(15);
    const large = await inject(
      "GET",
      `/api/v1/projects/${proj}/change-markups/resolve?subtotal=800000`,
      u1.headers,
    );
    expect(large.json().rules[0].rate).toBe(5);
  });

  it("lets a prime contract override the project schedule", async () => {
    const res = await inject(
      "PUT",
      `/api/v1/projects/${proj}/change-markups?primeContractId=${contractId}`,
      u1.headers,
      {
        name: "PC-001 negotiated",
        rules: [{ kind: "percent", label: "OH&P", basis: "cost", rate: 8 }],
      },
    );
    expect(res.statusCode).toBe(200);
    const resolved = await inject(
      "GET",
      `/api/v1/projects/${proj}/change-markups/resolve?subtotal=10000&primeContractId=${contractId}`,
      u1.headers,
    );
    expect(resolved.json().source).toBe("prime_contract");
    expect(resolved.json().rules[0].rate).toBe(8);
  });

  it("refuses a contract override for a contract on another project", async () => {
    const other = newId("prj");
    await built.app.db
      .insert(projects)
      .values({ id: other, companyId: u1.companyId, name: "Elsewhere" });
    const res = await inject(
      "PUT",
      `/api/v1/projects/${other}/change-markups?primeContractId=${contractId}`,
      u1.headers,
      { name: "Wrong project", rules: [] },
    );
    expect(res.statusCode).toBe(400);
  });

  it("a COR raised with no explicit markups CARRIES the contract's schedule", async () => {
    const pcoId = await pricedPco("Banded markup PCO", 10_000);
    const res = await inject("POST", `/api/v1/projects/${proj}/change-order-requests`, u1.headers, {
      title: "Owner request with contractual markup",
      primeContractId: contractId,
      pcoIds: [pcoId],
    });
    expect(res.statusCode).toBe(201);
    const cor = res.json().changeOrderRequest;
    expect(cor.detail.markupSource).toBe("prime_contract");
    expect(res.json().totals.markupTotal).toBeCloseTo(800, 2); // 8% of the 10,000 cost subtotal
    expect(res.json().totals.amount).toBeCloseTo(10_800, 2);
  });

  it("does not leak a schedule to another company", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-markups`, outsider.headers);
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Tier configuration (#563)                                           */
/* ================================================================== */

describe("tier configuration", () => {
  it("defaults to two tier and reports where that came from", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-config`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("two_tier");
    expect(res.json().source).toBe("default");
    expect(res.json().tiers).toHaveLength(3);
  });

  it("stores a three-tier configuration", async () => {
    const res = await inject("PUT", `/api/v1/projects/${proj}/change-config`, u1.headers, {
      tier: "three_tier",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("three_tier");
    expect(res.json().source).toBe("config");
    expect(res.json().stages).toContain("rfq");
  });

  it("REFUSES a commitment package whose PCO skipped the owner request", async () => {
    const pcoId = await pricedPco("Skipped the COR", 5_000);
    const res = await inject("POST", `/api/v1/projects/${proj}/change-order-packages`, u1.headers, {
      kind: "commitment",
      title: "Straight to the sub",
      commitmentId,
      memberIds: [pcoId],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().details.tier).toBe("three_tier");
    expect(res.json().details.members[0].skipped).toContain("cor");
  });

  it("permits it again once the project is back on two tier", async () => {
    await inject("PUT", `/api/v1/projects/${proj}/change-config`, u1.headers, {
      tier: "two_tier",
    });
    const pcoId = await pricedPco("Two-tier package", 5_000);
    const res = await inject("POST", `/api/v1/projects/${proj}/change-order-packages`, u1.headers, {
      kind: "commitment",
      title: "Two-tier package",
      commitmentId,
      memberIds: [pcoId],
    });
    expect(res.statusCode).toBe(201);
  });

  it("refuses configuration by a non-admin", async () => {
    const res = await inject("PUT", `/api/v1/projects/${proj}/change-config`, outsider.headers, {
      tier: "one_tier",
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* Regression: a quote cannot silently re-price an approved PCO        */
/* ================================================================== */

describe("regression: accepting a quote never re-prices a committed position", () => {
  it("refuses acceptance against a PCO that has been approved since the RFQ went out", async () => {
    const pcoId = await pcoPricedOnly("Approved before the quote landed", 10_000);
    const quoteId = await quotedRfq(pcoId, 15_000);
    /* the sub's price arrives AFTER an independent approver signed off 10,000 */
    await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/submit`,
      u1.headers,
      {},
    );
    await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/approve`,
      h2,
      {},
    );

    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${quoteId}/accept`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("cannot re-price");

    /* and the approved figure is untouched */
    const pco = await inject(
      "GET",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}`,
      u1.headers,
    );
    expect(pco.json().pco.amount).toBeCloseTo(10_000, 2);
  });

  it("refuses acceptance against a PCO already inside an owner request", async () => {
    const pcoId = await pcoPricedOnly("Inside a COR", 10_000);
    const quoteId = await quotedRfq(pcoId, 12_000);
    const cor = await inject("POST", `/api/v1/projects/${proj}/change-order-requests`, u1.headers, {
      title: "Owner ask",
      primeContractId: contractId,
      pcoIds: [pcoId],
    });
    expect(cor.statusCode).toBe(201);
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${quoteId}/accept`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/owner change order request|change order package/);
  });

  it("refuses a respondedAt that is not a timestamp, with 400 rather than a database error", async () => {
    const pcoId = await pcoPricedOnly("Bad timestamp", 1_000);
    const rfq = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/quote-requests`,
      u1.headers,
      { vendorId: vendorA, dueDate: "2030-01-01" },
    );
    const quoteId = rfq.json().id as string;
    await inject("POST", `/api/v1/projects/${proj}/quote-requests/${quoteId}/send`, u1.headers, {});
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/quote-requests/${quoteId}/quote`,
      u1.headers,
      {
        quotedAmount: 900,
        respondedAt: "today",
      },
    );
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Regression: rejected CORs release their PCOs                        */
/* ================================================================== */

describe("regression: a rejected owner request releases its priced positions", () => {
  it("clears changeOrderRequestId so the PCOs can be re-requested", async () => {
    const pcoId = await pricedPco("Rejected then re-requested", 8_000);
    const cor = await inject("POST", `/api/v1/projects/${proj}/change-order-requests`, u1.headers, {
      title: "First ask",
      primeContractId: contractId,
      pcoIds: [pcoId],
    });
    const corId = cor.json().changeOrderRequest.id as string;
    await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-requests/${corId}/submit`,
      u1.headers,
      {},
    );
    const rejected = await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-requests/${corId}/reject`,
      h2,
      { rejectionReason: "Not our scope" },
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().detail.releasedPcoIds).toContain(pcoId);

    const again = await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-requests`,
      u1.headers,
      {
        title: "Revised ask",
        primeContractId: contractId,
        pcoIds: [pcoId],
      },
    );
    expect(again.statusCode).toBe(201);
  });
});

/* ================================================================== */
/* Regression: a PCO inside a live COR cannot be voided                */
/* ================================================================== */

describe("regression: voiding a PCO inside a live owner request", () => {
  it("refuses, naming the request the owner has already been asked under", async () => {
    const pcoId = await pcoPricedOnly("Locked into a COR", 6_000);
    const cor = await inject("POST", `/api/v1/projects/${proj}/change-order-requests`, u1.headers, {
      title: "Live ask",
      primeContractId: contractId,
      pcoIds: [pcoId],
    });
    const corId = cor.json().changeOrderRequest.id as string;
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/void`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain(cor.json().changeOrderRequest.reference);

    await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-requests/${corId}/withdraw`,
      u1.headers,
      {},
    );
    const after = await inject(
      "POST",
      `/api/v1/projects/${proj}/potential-change-orders/${pcoId}/void`,
      u1.headers,
      {},
    );
    expect(after.statusCode).toBe(200);
    expect(after.json().status).toBe("void");
  });
});

/* ================================================================== */
/* Regression: executing a commitment package keeps the decomposition  */
/* ================================================================== */

describe("regression: commitment package execution keeps the original sum frozen", () => {
  let pkgId: string;

  it("executes through the commitments module's own allocation path", async () => {
    const pcoId = await pricedPco("Executed change", 10_000);
    const pkg = await inject("POST", `/api/v1/projects/${proj}/change-order-packages`, u1.headers, {
      kind: "commitment",
      title: "Subcontract CO 1",
      commitmentId,
      memberIds: [pcoId],
    });
    expect(pkg.statusCode).toBe(201);
    pkgId = pkg.json().id;
    await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-packages/${pkgId}/submit`,
      u1.headers,
      {},
    );
    await inject("POST", `/api/v1/projects/${proj}/change-order-packages/${pkgId}/approve`, h2, {});
    const res = await inject(
      "POST",
      `/api/v1/projects/${proj}/change-order-packages/${pkgId}/execute`,
      u1.headers,
      {},
    );
    expect(res.statusCode).toBe(200);
  });

  it("leaves originalCommitmentSum at 100,000 with the change in approvedChangeSum", async () => {
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.originalCommitmentSum).toBe(100_000);
    expect(row.approvedChangeSum).toBe(10_000);
    expect(row.revisedCommitmentSum).toBe(110_000);
  });

  it("writes the appended SOV line as change-order value, not scheduled value", async () => {
    const lines = await built.app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    const appended = lines.filter((l) => l.isChangeOrderLine === 1);
    expect(appended.length).toBeGreaterThan(0);
    expect(appended[0]!.scheduledValue).toBe(0);
    expect(appended[0]!.changeOrderValue).toBe(10_000);
  });

  it("still reconciles after a full rollup sync — the identity survives the round trip", async () => {
    const sync = await inject(
      "POST",
      `/api/v1/projects/${proj}/commitments/rollups/sync`,
      u1.headers,
      {},
    );
    expect(sync.statusCode).toBe(200);
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/commitments/rollups/reconcile`,
      u1.headers,
    );
    const mine = (
      res.json().results as Array<{
        commitmentId: string;
        reconciles: boolean;
        failing: unknown[];
      }>
    ).find((r) => r.commitmentId === commitmentId);
    expect(mine?.failing).toEqual([]);
    expect(mine?.reconciles).toBe(true);
    const row = (
      await built.app.db.select().from(commitments).where(eq(commitments.id, commitmentId)).limit(1)
    )[0]!;
    expect(row.originalCommitmentSum).toBe(100_000);
    expect(row.approvedChangeSum).toBe(10_000);
  });

  it("moved the committed cost onto the budget line through the currency-aware sync", async () => {
    const line = (
      await built.app.db
        .select()
        .from(budgetLineItems)
        .where(eq(budgetLineItems.id, lineSub))
        .limit(1)
    )[0]!;
    expect(line.committedCost).toBeCloseTo(110_000, 2);
  });
});

/* ================================================================== */
/* Ageing, cycle time and pass-down over HTTP                          */
/* ================================================================== */

describe("change analytics", () => {
  it("ages every live PCO, COR and package, oldest first, with money per bucket", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-log/ageing`, u1.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.buckets.map((b: { bucket: string }) => b.bucket)).toEqual([
      "0-7",
      "8-30",
      "31-60",
      "60+",
    ]);
    // sorted oldest first
    const days = body.items.map((i: { daysInStatus: number }) => i.daysInStatus);
    expect([...days].sort((a: number, b: number) => b - a)).toEqual(days);
    // terminal states are not "ageing"
    expect(body.items.every((i: { status: string }) => i.status !== "executed")).toBe(true);
  });

  it("reports cycle times from the materialised status history", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-log/cycle-time`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().overall)).toBe(true);
    expect(
      res
        .json()
        .overall.some(
          (s: { from: string; to: string }) => s.from === "identified" && s.to === "priced",
        ),
    ).toBe(true);
    expect(res.json().note).toBeNull();
  });

  it("lists cost passed down with nothing billed to the owner", async () => {
    const res = await inject("GET", `/api/v1/projects/${proj}/change-log/pass-down`, u1.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.costDownNeverBilled).toBeGreaterThanOrEqual(1);
    expect(res.json().costDownNeverBilled[0].reason).toBeTruthy();
    expect(res.json().summary.note).toContain("never summed");
  });

  it("adds change ratios against the original contract sum to the movement report", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${proj}/change-log/contract-movement?primeContractId=${contractId}`,
      u1.headers,
    );
    expect(res.statusCode).toBe(200);
    const contract = (
      res.json().contracts as Array<{
        primeContractId: string;
        approvedChangePercent: unknown;
        pendingChangePercent: unknown;
      }>
    ).find((c) => c.primeContractId === contractId);
    expect(contract?.approvedChangePercent).toBeDefined();
    expect(contract?.pendingChangePercent).toBeDefined();
  });

  it("refuses every analytics route to another company", async () => {
    for (const path of ["ageing", "cycle-time", "pass-down"]) {
      const res = await inject(
        "GET",
        `/api/v1/projects/${proj}/change-log/${path}`,
        outsider.headers,
      );
      expect(res.statusCode).toBe(403);
    }
  });
});
