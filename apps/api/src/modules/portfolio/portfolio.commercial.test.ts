import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  callOffOrders,
  companyMemberships,
  ledgerEntries,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { portfolioModule } from "./index.js";

/**
 * WP-PORTFOLIO — frameworks, lots, mini-competitions, term contracts,
 * schedules of rates and call-off orders. Spec Vol II Domain Z #1053–#1056.
 *
 * The refusals are the point of this suite: an order off an expired
 * framework, a direct award over the threshold, an award by the person who
 * ran the competition, a call-off past a lot ceiling, certification beyond
 * the order value, and a second company that can see none of it.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let admin2Headers: Record<string, string>;
let memberHeaders: Record<string, string>;
/** a project member with the read_only template: read yes, write no */
let viewerHeaders: Record<string, string>;
let stranger: TestActor;

let projectA: string;
let projectB: string;
let vendorAlpha: string;
let vendorBeta: string;

function get(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function post(url: string, payload?: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
}
function patch(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function del(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

async function makeProject(name: string, currency = "GBP") {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    currency,
  } as typeof projects.$inferInsert);
  return id;
}

const today = new Date().toISOString().slice(0, 10);
function dateOffset(days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.hasRoute({ method: "GET", url: "/api/v1/portfolio/overview" })) {
    await app.register(portfolioModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Frameworks Test Co" });

  const admin2 = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: admin2.userId,
    role: "admin",
  });
  admin2Headers = {
    authorization: admin2.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  const member = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: member.userId,
    role: "member",
  });
  memberHeaders = {
    authorization: member.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app, { companyName: "Rival Co" });

  projectA = await makeProject("Bridge refurbishment");
  projectB = await makeProject("Depot fit-out");

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: viewer.userId,
    role: "member",
  });
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: viewer.userId,
    templateKey: "read_only",
  });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  vendorAlpha = newId("ven");
  vendorBeta = newId("ven");
  await app.db.insert(vendors).values([
    { id: vendorAlpha, companyId: owner.companyId, name: "Alpha Civils Ltd", country: "GB" },
    { id: vendorBeta, companyId: owner.companyId, name: "Beta Build Ltd", country: "GB" },
  ]);
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Frameworks and lots (#1053)                                         */
/* ================================================================== */

let frameworkId: string;
let lot1: string;
let lot2: string;
let supplierAlpha: string;
let supplierBeta: string;

describe("framework agreements and lots (#1053)", () => {
  it("creates a framework, refuses a duplicate reference and ledgers the create", async () => {
    const created = await post("/portfolio/frameworks", {
      reference: "FW-2026-CIVILS",
      title: "Civils framework 2026–2030",
      contractingAuthority: "County Council",
      currency: "gbp",
      maximumValue: 20_000_000,
      awardMode: "direct_or_mini",
      directAwardThreshold: 250_000,
      startDate: dateOffset(-30),
      endDate: dateOffset(400),
      rulesReference: "Schedule 4, call-off procedure",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().currency).toBe("GBP");
    frameworkId = created.json().id as string;

    const dup = await post("/portfolio/frameworks", {
      reference: "FW-2026-CIVILS",
      title: "Duplicate",
      currency: "GBP",
    });
    expect(dup.statusCode).toBe(409);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "framework_agreement"),
          eq(ledgerEntries.objectId, frameworkId),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);
  });

  it("goes live and adds lots that inherit the framework currency", async () => {
    const live = await post(`/portfolio/frameworks/${frameworkId}/status`, { status: "live" });
    expect(live.statusCode).toBe(200);

    const a = await post(`/portfolio/frameworks/${frameworkId}/lots`, {
      lotNumber: "1",
      title: "Minor works up to £500k",
      ceilingValue: 5_000_000,
      awardMode: "direct_or_mini",
    });
    expect(a.statusCode).toBe(201);
    expect(a.json().currency).toBe("GBP");
    lot1 = a.json().id as string;

    const b = await post(`/portfolio/frameworks/${frameworkId}/lots`, {
      lotNumber: "2",
      title: "Major works",
      ceilingValue: 800_000,
      awardMode: "mini_competition",
    });
    expect(b.statusCode).toBe(201);
    lot2 = b.json().id as string;

    const dup = await post(`/portfolio/frameworks/${frameworkId}/lots`, {
      lotNumber: "1",
      title: "Clash",
    });
    expect(dup.statusCode).toBe(409);
  });

  it("appoints suppliers and requires a reason to suspend one", async () => {
    const a = await post(`/portfolio/frameworks/${frameworkId}/suppliers`, {
      supplierName: "Alpha Civils Ltd",
      vendorId: vendorAlpha,
      lotId: lot1,
      rank: 1,
    });
    expect(a.statusCode).toBe(201);
    supplierAlpha = a.json().id as string;

    const b = await post(`/portfolio/frameworks/${frameworkId}/suppliers`, {
      supplierName: "Beta Build Ltd",
      vendorId: vendorBeta,
      lotId: lot2,
      rank: 2,
    });
    expect(b.statusCode).toBe(201);
    supplierBeta = b.json().id as string;

    const badVendor = await post(`/portfolio/frameworks/${frameworkId}/suppliers`, {
      supplierName: "Ghost Ltd",
      vendorId: "ven_nope",
    });
    expect(badVendor.statusCode).toBe(400);

    const noReason = await patch(
      `/portfolio/frameworks/${frameworkId}/suppliers/${supplierBeta}`,
      { status: "suspended" },
    );
    expect(noReason.statusCode).toBe(400);

    const suspended = await patch(
      `/portfolio/frameworks/${frameworkId}/suppliers/${supplierBeta}`,
      { status: "suspended", suspendedReason: "Financial standing check failed" },
    );
    expect(suspended.statusCode).toBe(200);
    const restored = await patch(
      `/portfolio/frameworks/${frameworkId}/suppliers/${supplierBeta}`,
      { status: "appointed" },
    );
    expect(restored.statusCode).toBe(200);
  });

  it("answers a direct-award check with the rule that bites", async () => {
    const overThreshold = await post(`/portfolio/frameworks/${frameworkId}/direct-award-check`, {
      value: 400_000,
      currency: "GBP",
    });
    expect(overThreshold.statusCode).toBe(200);
    expect(overThreshold.json().permitted).toBe(false);
    expect(overThreshold.json().reasons[0]).toMatch(/direct-award threshold/i);

    const wrongCurrency = await post(`/portfolio/frameworks/${frameworkId}/direct-award-check`, {
      value: 100,
      currency: "EUR",
    });
    expect(wrongCurrency.json().permitted).toBe(false);
    expect(wrongCurrency.json().reasons[0]).toMatch(/across currencies/i);

    const miniOnlyLot = await post(`/portfolio/frameworks/${frameworkId}/direct-award-check`, {
      value: 100_000,
      currency: "GBP",
      lotId: lot2,
    });
    expect(miniOnlyLot.json().permitted).toBe(false);
    expect(miniOnlyLot.json().reasons[0]).toMatch(/mini-competition/i);

    const ok = await post(`/portfolio/frameworks/${frameworkId}/direct-award-check`, {
      value: 100_000,
      currency: "GBP",
      lotId: lot1,
    });
    expect(ok.json().permitted).toBe(true);
  });

  it("refuses a framework write from an ordinary member", async () => {
    const res = await post(
      "/portfolio/frameworks",
      { reference: "X", title: "X", currency: "GBP" },
      memberHeaders,
    );
    expect(res.statusCode).toBe(403);
  });

  it("shows nothing to another company", async () => {
    expect((await get("/portfolio/frameworks", stranger.headers)).json().items).toHaveLength(0);
    expect((await get(`/portfolio/frameworks/${frameworkId}`, stranger.headers)).statusCode).toBe(404);
    expect(
      (
        await post(
          `/portfolio/frameworks/${frameworkId}/lots`,
          { lotNumber: "9", title: "Hijack" },
          stranger.headers,
        )
      ).statusCode,
    ).toBe(404);
  });
});

/* ================================================================== */
/* Mini-competitions (#1054)                                           */
/* ================================================================== */

let competitionId: string;

describe("mini-competitions (#1054)", () => {
  it("refuses a competition in a currency the framework is not in", async () => {
    const res = await post("/portfolio/mini-competitions", {
      reference: "MC-EUR",
      title: "Euro competition",
      frameworkId,
      currency: "EUR",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/across currencies/i);
  });

  it("refuses inviting a supplier that is not on the framework", async () => {
    const res = await post("/portfolio/mini-competitions", {
      reference: "MC-BAD",
      title: "Bad invite",
      frameworkId,
      currency: "GBP",
      invitedSupplierIds: ["fsp_nope"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs a competition end to end and refuses self-award", async () => {
    const created = await post("/portfolio/mini-competitions", {
      reference: "MC-001",
      title: "Bridge deck waterproofing",
      frameworkId,
      lotId: lot2,
      projectId: projectA,
      currency: "GBP",
      estimatedValue: 600_000,
      invitedSupplierIds: [supplierAlpha, supplierBeta],
      evaluationCriteria: [
        { key: "price", label: "Price", weight: 60, isPrice: true },
        { key: "quality", label: "Quality", weight: 40 },
      ],
      responsesDueAt: dateOffset(14),
    });
    expect(created.statusCode).toBe(201);
    competitionId = created.json().id as string;

    // responses only after issue
    const early = await post(`/portfolio/mini-competitions/${competitionId}/responses`, {
      supplierId: supplierAlpha,
      price: 500_000,
    });
    expect(early.statusCode).toBe(409);

    const issued = await post(`/portfolio/mini-competitions/${competitionId}/issue`);
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe("issued");

    const uninvited = await post(`/portfolio/mini-competitions/${competitionId}/responses`, {
      supplierId: "fsp_nope",
      price: 1,
    });
    expect(uninvited.statusCode).toBe(400);

    const a = await post(`/portfolio/mini-competitions/${competitionId}/responses`, {
      supplierId: supplierAlpha,
      price: 500_000,
      scores: { quality: 70 },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().competition.status).toBe("evaluating");

    const b = await post(`/portfolio/mini-competitions/${competitionId}/responses`, {
      supplierId: supplierBeta,
      price: 550_000,
      scores: { quality: 95 },
    });
    expect(b.statusCode).toBe(200);

    const evaluation = await get(`/portfolio/mini-competitions/${competitionId}/evaluation`);
    expect(evaluation.statusCode).toBe(200);
    expect(evaluation.json().evaluation.lowestPrice).toBe(500_000);
    expect(evaluation.json().evaluation.responses).toHaveLength(2);
    expect(evaluation.json().note).toMatch(/decision a person records/i);

    // the issuer may not award
    const self = await post(`/portfolio/mini-competitions/${competitionId}/award`, {
      supplierId: supplierAlpha,
      awardValue: 500_000,
      decisionNote: "Cheapest",
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/different hands/i);

    const awarded = await post(
      `/portfolio/mini-competitions/${competitionId}/award`,
      {
        supplierId: supplierBeta,
        awardValue: 550_000,
        decisionNote: "Quality score decisive; deck detail carries high defect risk",
      },
      admin2Headers,
    );
    expect(awarded.statusCode).toBe(200);
    expect(awarded.json().competition.status).toBe("awarded");
    expect(awarded.json().competition.awardedSupplierName).toBe("Beta Build Ltd");
    expect(typeof awarded.json().awardedAgainstIndication).toBe("boolean");

    // and the fact of awarding against the arithmetic is on the ledger
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "framework_mini_competition"),
          eq(ledgerEntries.objectId, competitionId),
        ),
      );
    expect(entries.length).toBeGreaterThan(1);

    const cancel = await post(`/portfolio/mini-competitions/${competitionId}/cancel`, {
      reason: "too late",
    });
    expect(cancel.statusCode).toBe(409);
  });

  it("cancels an abandoned competition with a reason", async () => {
    const created = await post("/portfolio/mini-competitions", {
      reference: "MC-002",
      title: "Abandoned",
      frameworkId,
      currency: "GBP",
      invitedSupplierIds: [supplierAlpha],
    });
    const id = created.json().id as string;
    const cancelled = await post(`/portfolio/mini-competitions/${id}/cancel`, {
      reason: "Scope withdrawn by the client",
      outcome: "abandoned",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("abandoned");
  });
});

/* ================================================================== */
/* Term contracts and schedules of rates (#1055)                       */
/* ================================================================== */

let termContractId: string;

describe("term contracts and schedule of rates (#1055)", () => {
  it("creates a term contract and requires an index reference when index-linked", async () => {
    const missingIndex = await post("/portfolio/term-contracts", {
      reference: "TC-BAD",
      title: "Bad",
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      adjustmentBasis: "index_linked",
    });
    expect(missingIndex.statusCode).toBe(400);

    const created = await post("/portfolio/term-contracts", {
      reference: "TC-2026-MAINT",
      title: "Measured term maintenance",
      supplierName: "Alpha Civils Ltd",
      vendorId: vendorAlpha,
      currency: "GBP",
      startDate: dateOffset(-10),
      endDate: dateOffset(700),
      maximumValue: 2_000_000,
      adjustmentPercent: 8.5,
      adjustmentBasis: "fixed_percent",
    });
    expect(created.statusCode).toBe(201);
    termContractId = created.json().id as string;

    const live = await patch(`/portfolio/term-contracts/${termContractId}`, { status: "live" });
    expect(live.statusCode).toBe(200);
  });

  it("loads a schedule of rates in bulk and refuses duplicate codes", async () => {
    const created = await post(`/portfolio/term-contracts/${termContractId}/rates`, {
      items: [
        { code: "A100", description: "Excavate trench ne 1.5m deep", unit: "m3", rate: 42.5 },
        { code: "A200", description: "Concrete C30 in foundations", unit: "m3", rate: 168 },
        { code: "A300", description: "Reinstate footway", unit: "m2", rate: 55 },
      ],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().total).toBe(3);

    const dup = await post(`/portfolio/term-contracts/${termContractId}/rates`, {
      code: "A100",
      description: "Clash",
      unit: "m3",
      rate: 1,
    });
    expect(dup.statusCode).toBe(409);

    const detail = await get(`/portfolio/term-contracts/${termContractId}`);
    expect(detail.json().rates).toHaveLength(3);
    expect(detail.json().consumption.ordered).toBe(0);
  });

  it("prices lines against the schedule, applying the adjustment and naming the gaps", async () => {
    const res = await post(`/portfolio/term-contracts/${termContractId}/price`, {
      lines: [
        { code: "A100", quantity: 10 },
        { code: "A999", quantity: 5, description: "Unknown item" },
        { code: "A300", quantity: 4, rate: 60 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const priced = res.json();
    // 42.5 × 1.085 = 46.11 (rounded), × 10 = 461.13 — the star rate is NOT adjusted
    expect(priced.lines[0].source).toBe("schedule");
    expect(priced.lines[0].rate).toBeCloseTo(46.11, 2);
    expect(priced.lines[1].source).toBe("unpriced");
    expect(priced.lines[1].amount).toBeNull();
    expect(priced.lines[2].source).toBe("star_rate");
    expect(priced.lines[2].rate).toBe(60);
    expect(priced.unpricedLines).toBe(1);
    expect(priced.reasons.some((r: string) => /could not be priced/.test(r))).toBe(true);
  });

  it("deactivates a rate and refuses to price against it", async () => {
    const detail = await get(`/portfolio/term-contracts/${termContractId}`);
    const item = detail.json().rates.find((r: { code: string }) => r.code === "A200");
    const off = await patch(`/portfolio/term-contracts/${termContractId}/rates/${item.id}`, {
      active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(0);

    const priced = await post(`/portfolio/term-contracts/${termContractId}/price`, {
      lines: [{ code: "A200", quantity: 1 }],
    });
    expect(priced.json().lines[0].source).toBe("unpriced");
    expect(priced.json().lines[0].reason).toMatch(/no longer active/i);

    // restore for the call-off tests
    await patch(`/portfolio/term-contracts/${termContractId}/rates/${item.id}`, { active: true });
  });
});

/* ================================================================== */
/* Call-off orders (#1053, #1056)                                      */
/* ================================================================== */

describe("call-off orders (#1053, #1056)", () => {
  let directOrderId: string;

  it("refuses a direct award over the framework threshold, and one with no justification", async () => {
    const noJustification = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Culvert repair",
      route: "direct_award",
      frameworkId,
      lotId: lot1,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      orderValue: 100_000,
    });
    expect(noJustification.statusCode).toBe(400);
    expect(noJustification.json().message).toMatch(/justification/i);

    const overThreshold = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Big direct award",
      route: "direct_award",
      frameworkId,
      lotId: lot1,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      orderValue: 400_000,
      justification: "Incumbent knows the asset",
    });
    expect(overThreshold.statusCode).toBe(409);
    expect(overThreshold.json().message).toMatch(/direct award is not permissible/i);
  });

  it("creates, issues and certifies a direct-award order", async () => {
    const created = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Culvert repair",
      scope: "Replace the failed culvert on the south approach",
      route: "direct_award",
      frameworkId,
      lotId: lot1,
      vendorId: vendorAlpha,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      orderValue: 120_000,
      requiredBy: dateOffset(60),
      justification: "Value within the framework's direct-award threshold; lot 1 permits it",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reference).toMatch(/^CO-\d{3}$/);
    expect(created.json().status).toBe("draft");
    directOrderId = created.json().id as string;

    const issued = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/issue`,
    );
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe("issued");
    expect(issued.json().issuedAt).toBeTruthy();

    // an issued order's value is not editable in place
    const edit = await patch(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}`,
      { orderValue: 200_000 },
    );
    expect(edit.statusCode).toBe(409);
    expect(edit.json().message).toMatch(/cannot be edited in place/i);

    const overCertify = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/certify`,
      { amount: 200_000 },
    );
    expect(overCertify.statusCode).toBe(409);

    const wrongCurrency = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/certify`,
      { amount: 10, currency: "EUR" },
    );
    expect(wrongCurrency.statusCode).toBe(400);

    const certified = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/certify`,
      { amount: 45_000, note: "Interim certificate 1" },
    );
    expect(certified.statusCode).toBe(200);
    expect(certified.json().certifiedValue).toBe(45_000);
    expect(certified.json().status).toBe("in_progress");

    const detail = await get(`/projects/${projectA}/portfolio/call-offs/${directOrderId}`);
    expect(detail.json().remainingToCertify).toBe(75_000);
    expect(detail.json().framework.reference).toBe("FW-2026-CIVILS");
  });

  it("refuses to cancel an order that has been certified against, and completes it instead", async () => {
    const cancel = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/cancel`,
      { reason: "changed our mind" },
    );
    expect(cancel.statusCode).toBe(409);

    const completed = await post(
      `/projects/${projectA}/portfolio/call-offs/${directOrderId}/complete`,
      {},
    );
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
  });

  it("places a mini-competition order only for the supplier that won", async () => {
    const wrongSupplier = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Deck waterproofing",
      route: "mini_competition",
      miniCompetitionId: competitionId,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
    });
    expect(wrongSupplier.statusCode).toBe(400);
    expect(wrongSupplier.json().message).toMatch(/was awarded to Beta Build Ltd/i);

    const created = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Deck waterproofing",
      route: "mini_competition",
      miniCompetitionId: competitionId,
      vendorId: vendorBeta,
      supplierName: "Beta Build Ltd",
      currency: "GBP",
    });
    expect(created.statusCode).toBe(201);
    // value and framework/lot inherited from the competition
    expect(created.json().orderValue).toBe(550_000);
    expect(created.json().frameworkId).toBe(frameworkId);
    expect(created.json().lotId).toBe(lot2);

    const issued = await post(
      `/projects/${projectA}/portfolio/call-offs/${created.json().id}/issue`,
    );
    // lot 2 ceiling is 800k; 550k fits
    expect(issued.statusCode).toBe(200);
  });

  it("refuses an order that would take the lot past its ceiling", async () => {
    const created = await post(`/projects/${projectB}/portfolio/call-offs`, {
      title: "Second major works package",
      route: "direct_award",
      frameworkId,
      lotId: lot2,
      supplierName: "Beta Build Ltd",
      currency: "GBP",
      orderValue: 300_000,
      justification: "Nonsense but the threshold check runs first",
    });
    // lot 2 is mini-competition only, so a direct award is refused before ceilings
    expect(created.statusCode).toBe(409);
    expect(created.json().message).toMatch(/mini-competition/i);

    // now the ceiling path: mini-competition route with an awarded competition
    const comp = await post("/portfolio/mini-competitions", {
      reference: "MC-003",
      title: "Second major works package",
      frameworkId,
      lotId: lot2,
      currency: "GBP",
      invitedSupplierIds: [supplierBeta],
    });
    const compId = comp.json().id as string;
    await post(`/portfolio/mini-competitions/${compId}/issue`);
    await post(`/portfolio/mini-competitions/${compId}/responses`, {
      supplierId: supplierBeta,
      price: 400_000,
    });
    const awarded = await post(
      `/portfolio/mini-competitions/${compId}/award`,
      { supplierId: supplierBeta, awardValue: 400_000, decisionNote: "Only compliant response" },
      admin2Headers,
    );
    expect(awarded.statusCode).toBe(200);

    const order = await post(`/projects/${projectB}/portfolio/call-offs`, {
      title: "Second major works package",
      route: "mini_competition",
      miniCompetitionId: compId,
      supplierName: "Beta Build Ltd",
      currency: "GBP",
    });
    expect(order.statusCode).toBe(201);
    // 550k + 400k = 950k against an 800k lot ceiling
    const issue = await post(
      `/projects/${projectB}/portfolio/call-offs/${order.json().id}/issue`,
    );
    expect(issue.statusCode).toBe(409);
    expect(issue.json().message).toMatch(/beyond its .* ceiling/i);
  });

  it("prices a measured term order from the schedule of rates", async () => {
    const noLines = await post(`/projects/${projectB}/portfolio/call-offs`, {
      title: "Empty measured order",
      route: "measured_term",
      termContractId,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      lines: [],
    });
    expect(noLines.statusCode).toBe(400);

    const created = await post(`/projects/${projectB}/portfolio/call-offs`, {
      title: "Footway reinstatement, Zone 3",
      route: "measured_term",
      termContractId,
      vendorId: vendorAlpha,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      lines: [
        { code: "A100", quantity: 20 },
        { code: "A300", quantity: 100 },
        { code: "NOPE", quantity: 5, description: "Not on the schedule" },
      ],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    // 20 × 46.11 + 100 × 59.68 = 922.2 + 5968 = 6890.2 (unpriced line excluded)
    expect(body.orderValue).toBeCloseTo(6890.2, 1);
    expect(body.lines).toHaveLength(3);
    expect(body.pricingReasons.some((r: string) => /could not be priced/.test(r))).toBe(true);
    expect(body.pricingReasons.some((r: string) => /8.5% adjustment/.test(r))).toBe(true);

    const issued = await post(
      `/projects/${projectB}/portfolio/call-offs/${body.id}/issue`,
    );
    expect(issued.statusCode).toBe(200);

    const consumption = await get(`/portfolio/term-contracts/${termContractId}`);
    expect(consumption.json().consumption.ordered).toBeCloseTo(6890.2, 1);
  });

  it("refuses a measured term order in a currency the term contract is not in", async () => {
    const res = await post(`/projects/${projectB}/portfolio/call-offs`, {
      title: "Euro order",
      route: "measured_term",
      termContractId,
      supplierName: "Alpha Civils Ltd",
      currency: "EUR",
      lines: [{ code: "A100", quantity: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot price this order/i);
  });

  it("buckets the project register by currency and never sums across", async () => {
    const list = await get(`/projects/${projectB}/portfolio/call-offs`);
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().byCurrency)).toBe(true);
    expect(list.json().byCurrency.every((b: { currency: string }) => b.currency.length === 3)).toBe(
      true,
    );
  });

  it("lets a read-only project member read but not write", async () => {
    const read = await get(`/projects/${projectA}/portfolio/call-offs`, viewerHeaders);
    expect(read.statusCode).toBe(200);

    const write = await post(
      `/projects/${projectA}/portfolio/call-offs`,
      {
        title: "Sneaky",
        route: "direct_award",
        frameworkId,
        supplierName: "Alpha Civils Ltd",
        currency: "GBP",
        orderValue: 1,
        justification: "x",
      },
      viewerHeaders,
    );
    expect(write.statusCode).toBe(403);

    // and no access at all to a project they are not a member of
    const other = await get(`/projects/${projectB}/portfolio/call-offs`, viewerHeaders);
    expect(other.statusCode).toBe(403);
  });

  it("gives another company nothing on the project routes", async () => {
    const list = await get(`/projects/${projectA}/portfolio/call-offs`, stranger.headers);
    expect(list.statusCode).toBe(403);
    const create = await post(
      `/projects/${projectA}/portfolio/call-offs`,
      {
        title: "Hijack",
        route: "direct_award",
        frameworkId,
        supplierName: "x",
        currency: "GBP",
        orderValue: 1,
        justification: "x",
      },
      stranger.headers,
    );
    expect(create.statusCode).toBe(403);

    const rows = await app.db
      .select()
      .from(callOffOrders)
      .where(eq(callOffOrders.companyId, stranger.companyId));
    expect(rows).toHaveLength(0);
  });

  it("refuses to delete a framework anything was called off, and lists available ones", async () => {
    const res = await del(`/portfolio/frameworks/${frameworkId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/call-off\(s\) were placed/i);

    const available = await get(`/projects/${projectA}/portfolio/available-frameworks`);
    expect(available.statusCode).toBe(200);
    expect(available.json().frameworks[0].reference).toBe("FW-2026-CIVILS");
    expect(available.json().termContracts[0].reference).toBe("TC-2026-MAINT");
  });

  it("sweeps framework ceilings and expiry idempotently", async () => {
    // push the framework past its own maximum by expiring it and re-checking
    const first = await post("/portfolio/sweeps/run");
    expect(first.statusCode).toBe(200);
    const second = await post("/portfolio/sweeps/run");
    // nothing new the second time round
    expect(second.json().signalsRaised).toBe(0);

    const job = await app.scheduler.runNow("portfolio.frameworks");
    expect(job.state).toBe("succeeded");
  });

  it("expires a framework whose end date has passed and refuses further awards", async () => {
    const created = await post("/portfolio/frameworks", {
      reference: "FW-OLD",
      title: "Expired framework",
      currency: "GBP",
      maximumValue: 1_000_000,
      awardMode: "direct_or_mini",
      directAwardThreshold: 500_000,
      endDate: dateOffset(-2),
    });
    const oldId = created.json().id as string;
    await post(`/portfolio/frameworks/${oldId}/status`, { status: "live" });

    const sweep = await post("/portfolio/sweeps/run");
    expect(sweep.json().frameworksExpiring).toBeGreaterThanOrEqual(1);

    const after = await get(`/portfolio/frameworks/${oldId}`);
    expect(after.json().status).toBe("expired");

    const order = await post(`/projects/${projectA}/portfolio/call-offs`, {
      title: "Too late",
      route: "direct_award",
      frameworkId: oldId,
      supplierName: "Alpha Civils Ltd",
      currency: "GBP",
      orderValue: 1_000,
      justification: "Under the threshold",
    });
    expect(order.statusCode).toBe(409);
    expect(order.json().message).toMatch(/only a live framework/i);
  });
});
