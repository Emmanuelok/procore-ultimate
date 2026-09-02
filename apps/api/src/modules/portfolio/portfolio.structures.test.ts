import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  budgets,
  companyMemberships,
  gateReviews,
  jvTransactions,
  obligations,
  projectMemberships,
  projects,
  stageGates,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { portfolioModule } from "./index.js";

/**
 * WP-PORTFOLIO — joint ventures, target cost / pain-gain, open-book
 * verification, the disallowed cost register, audit rights and the command
 * view. Spec Vol II Domain Z #1057–#1066, Vol I §7 #776–#789.
 *
 * The segregation rules carry most of the weight here: a capital call is not
 * settled by whoever recorded it, and a claimed defined cost is not verified
 * by whoever claimed it.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let admin2Headers: Record<string, string>;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;

let projectA: string;
let projectB: string;

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

const today = new Date().toISOString().slice(0, 10);
function dateOffset(days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeProject(name: string, currency = "GBP") {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    currency,
    value: 25_000_000,
  } as typeof projects.$inferInsert);
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.hasRoute({ method: "GET", url: "/api/v1/portfolio/overview" })) {
    await app.register(portfolioModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Structures Test Co" });

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

  stranger = await registerActor(app, { companyName: "Rival Co" });

  projectA = await makeProject("Tunnel alliance");
  projectB = await makeProject("Second scheme");

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
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Joint ventures (#1057–#1060)                                        */
/* ================================================================== */

let jvId: string;
let partnerUs: string;
let partnerThem: string;

describe("joint ventures (#1057–#1060)", () => {
  it("creates a venture and reports an unbalanced share register rather than hiding it", async () => {
    const created = await post(`/projects/${projectA}/portfolio/ventures`, {
      name: "Tunnel JV",
      structure: "joint_venture",
      currency: "GBP",
      formationDate: dateOffset(-200),
      deedReference: "JV Deed dated 3 March 2025",
      quorumPercent: 75,
      reservedMatterThresholdPercent: 100,
    });
    expect(created.statusCode).toBe(201);
    jvId = created.json().id as string;

    const us = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/partners`, {
      name: "Structures Test Co",
      role: "lead",
      sharePercent: 60,
      committedCapital: 6_000_000,
      isSelf: true,
      boardSeats: 3,
    });
    expect(us.statusCode).toBe(201);
    partnerUs = us.json().partner.id as string;
    // one partner at 60%: the imbalance is reported, not normalised away
    expect(us.json().summary.sharesBalanced).toBe(false);
    expect(us.json().summary.warnings[0]).toMatch(/60%/);

    const secondSelf = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/partners`, {
      name: "Also us",
      sharePercent: 1,
      isSelf: true,
    });
    expect(secondSelf.statusCode).toBe(409);

    const them = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/partners`, {
      name: "Deepdig SpA",
      role: "partner",
      sharePercent: 40,
      committedCapital: 4_000_000,
      liabilityBasis: "joint_and_several",
    });
    expect(them.statusCode).toBe(201);
    partnerThem = them.json().partner.id as string;
    expect(them.json().summary.sharesBalanced).toBe(true);
    expect(them.json().summary.ourSharePercent).toBe(60);
  });

  it("calls a contribution, raising an obligation, and refuses self-settlement", async () => {
    const tx = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/transactions`, {
      partnerId: partnerThem,
      kind: "capital_call",
      amount: 1_000_000,
      dueDate: dateOffset(-3),
      description: "First capital call under clause 8",
    });
    expect(tx.statusCode).toBe(201);
    const txId = tx.json().id as string;

    const settleTooEarly = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/transactions/${txId}/settle`,
      {},
      admin2Headers,
    );
    expect(settleTooEarly.statusCode).toBe(200); // a planned transaction may be settled directly
    expect(settleTooEarly.json().status).toBe("paid");

    // now a second call that we will leave outstanding
    const tx2 = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/transactions`, {
      partnerId: partnerThem,
      kind: "capital_call",
      amount: 500_000,
      dueDate: dateOffset(-2),
    });
    const tx2Id = tx2.json().id as string;

    const called = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/transactions/${tx2Id}/call`,
      {},
    );
    expect(called.statusCode).toBe(200);
    expect(called.json().status).toBe("called");
    expect(called.json().obligationId).toBeTruthy();

    const obligationRows = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, owner.companyId),
          eq(obligations.id, called.json().obligationId as string),
        ),
      );
    expect(obligationRows).toHaveLength(1);
    expect(obligationRows[0]!.status).toBe("open");

    const twice = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/transactions/${tx2Id}/call`,
      {},
    );
    expect(twice.statusCode).toBe(409);

    // the person who recorded it cannot confirm it was paid
    const self = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/transactions/${tx2Id}/settle`,
      {},
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/second pair of eyes/i);
  });

  it("breaches the overdue call through the sweep, once, and notifies", async () => {
    const first = await post("/portfolio/sweeps/run");
    expect(first.statusCode).toBe(200);
    expect(first.json().jvContributionsOverdue).toBe(1);

    const second = await post("/portfolio/sweeps/run");
    expect(second.json().jvContributionsOverdue).toBe(0);

    const rows = await app.db
      .select()
      .from(jvTransactions)
      .where(and(eq(jvTransactions.companyId, owner.companyId), eq(jvTransactions.status, "overdue")));
    expect(rows).toHaveLength(1);
    const breached = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, rows[0]!.obligationId!));
    expect(breached[0]!.status).toBe("breached");

    const signals = await get("/portfolio/signals?detector=jv_contribution_overdue");
    expect(signals.json().items).toHaveLength(1);
  });

  it("settles the overdue call and discharges the breached obligation", async () => {
    const rows = await app.db
      .select()
      .from(jvTransactions)
      .where(and(eq(jvTransactions.companyId, owner.companyId), eq(jvTransactions.status, "overdue")));
    const txId = rows[0]!.id;
    const settled = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/transactions/${txId}/settle`,
      { settledDate: today },
      admin2Headers,
    );
    expect(settled.statusCode).toBe(200);
    expect(settled.json().status).toBe("paid");

    const discharged = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, rows[0]!.obligationId!));
    expect(discharged[0]!.status).toBe("satisfied");
  });

  it("computes the venture position with our share", async () => {
    const position = await get(`/projects/${projectA}/portfolio/ventures/${jvId}/position`);
    expect(position.statusCode).toBe(200);
    expect(position.json().totalContributed).toBe(1_500_000);
    expect(position.json().ourSharePercent).toBe(60);
    expect(position.json().ourShareOfContributions).toBe(900_000);
    expect(position.json().positions).toHaveLength(2);
  });

  it("decides a board vote against the deed's quorum and threshold", async () => {
    const preview = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/decisions/preview`,
      { decisionType: "reserved_matter", votes: [{ partnerId: partnerUs, vote: "for" }] },
    );
    expect(preview.statusCode).toBe(200);
    // 60% present against a 75% quorum
    expect(preview.json().quorumMet).toBe(false);
    expect(preview.json().outcome).toBe("not_quorate");

    const recorded = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/decisions`, {
      decisionType: "reserved_matter",
      meetingDate: today,
      subject: "Approve the revised target cost",
      deedClause: "Clause 12.3",
      votes: [{ partnerId: partnerUs, vote: "for" }],
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().decision.outcome).toBe("not_quorate");
    expect(recorded.json().computed.reasons.length).toBeGreaterThan(0);

    const quorate = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/decisions`, {
      decisionType: "reserved_matter",
      meetingDate: today,
      subject: "Approve the revised target cost (reconvened)",
      deedClause: "Clause 12.3",
      votes: [
        { partnerId: partnerUs, vote: "for" },
        { partnerId: partnerThem, vote: "for" },
      ],
      action: { description: "Execute the deed of variation", dueDate: dateOffset(30) },
    });
    expect(quorate.statusCode).toBe(201);
    expect(quorate.json().decision.outcome).toBe("approved");
    expect(quorate.json().decision.obligationId).toBeTruthy();

    const rejected = await post(`/projects/${projectA}/portfolio/ventures/${jvId}/decisions`, {
      decisionType: "reserved_matter",
      meetingDate: today,
      subject: "Sell the plant",
      votes: [
        { partnerId: partnerUs, vote: "for" },
        { partnerId: partnerThem, vote: "against" },
      ],
    });
    // 100% present, 60% for against a 100% reserved-matter threshold
    expect(rejected.json().decision.outcome).toBe("rejected");

    const list = await get(`/projects/${projectA}/portfolio/ventures/${jvId}/decisions`);
    expect(list.json().total).toBe(3);
    expect(list.json().items.some((d: { obligation: unknown }) => d.obligation !== null)).toBe(true);
  });

  it("refuses to delete a partner with money against them", async () => {
    const res = await del(
      `/projects/${projectA}/portfolio/ventures/${jvId}/partners/${partnerThem}`,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/orphan the money/i);
  });

  it("lists ventures at company level and shows another company none", async () => {
    const list = await get("/portfolio/ventures");
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].projectName).toBe("Tunnel alliance");

    expect((await get("/portfolio/ventures", stranger.headers)).json().items).toHaveLength(0);
    expect(
      (await get(`/projects/${projectA}/portfolio/ventures/${jvId}`, stranger.headers)).statusCode,
    ).toBe(403);
  });

  it("lets a read-only project member read the venture but not write to it", async () => {
    expect(
      (await get(`/projects/${projectA}/portfolio/ventures/${jvId}`, viewerHeaders)).statusCode,
    ).toBe(200);
    const write = await post(
      `/projects/${projectA}/portfolio/ventures/${jvId}/partners`,
      { name: "Sneaky", sharePercent: 1 },
      viewerHeaders,
    );
    expect(write.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Target cost and pain/gain (#1061–#1062)                             */
/* ================================================================== */

let targetCostId: string;

describe("target cost and pain/gain (#1061–#1062)", () => {
  it("refuses bands that leave a gap or overlap", async () => {
    const gap = await post(`/projects/${projectA}/portfolio/target-costs`, {
      name: "Gappy",
      currency: "GBP",
      baseTargetCost: 1_000_000,
      shareBands: [
        { fromPercent: 0, toPercent: 5, contractorSharePercent: 50 },
        { fromPercent: 10, toPercent: null, contractorSharePercent: 20 },
      ],
    });
    expect(gap.statusCode).toBe(400);
    expect(gap.json().message).toMatch(/gap/i);

    const overlap = await post(`/projects/${projectA}/portfolio/target-costs`, {
      name: "Overlapping",
      currency: "GBP",
      baseTargetCost: 1_000_000,
      shareBands: [
        { fromPercent: 0, toPercent: 10, contractorSharePercent: 50 },
        { fromPercent: 5, toPercent: 20, contractorSharePercent: 20 },
      ],
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json().message).toMatch(/overlap/i);
  });

  it("creates a banded target cost model and computes the position with its basis", async () => {
    const created = await post(`/projects/${projectA}/portfolio/target-costs`, {
      name: "Tunnel target cost",
      contractReference: "NEC4 Option C",
      isAlliance: true,
      currency: "GBP",
      baseTargetCost: 20_000_000,
      targetAdjustments: 500_000,
      actualDefinedCost: 15_000_000,
      forecastDefinedCost: 22_550_000,
      feePercent: 8,
      mechanism: "banded_share",
      shareBands: [
        { fromPercent: -100, toPercent: 0, contractorSharePercent: 50 },
        { fromPercent: 0, toPercent: 5, contractorSharePercent: 50 },
        { fromPercent: 5, toPercent: 10, contractorSharePercent: 30 },
        { fromPercent: 10, toPercent: null, contractorSharePercent: 0 },
      ],
      painCap: 1_000_000,
      participants: [
        { name: "Structures Test Co", sharePercent: 60 },
        { name: "Deepdig SpA", sharePercent: 40 },
      ],
    });
    expect(created.statusCode).toBe(201);
    targetCostId = created.json().id as string;
    const p = created.json().position;
    expect(p.computable).toBe(true);
    expect(p.adjustedTarget).toBe(20_500_000);
    expect(p.side).toBe("pain");
    expect(p.variance).toBe(2_050_000);
    expect(p.variancePercent).toBe(10);
    // 0–5%: 1,025,000 at 50% = 512,500; 5–10%: 1,025,000 at 30% = 307,500 → 820,000
    expect(p.contractorShare).toBe(820_000);
    expect(p.clientShare).toBe(1_230_000);
    expect(p.contractorAdjustment).toBe(-820_000);
    expect(p.participants).toHaveLength(2);
    expect(p.participants[0].amount).toBe(-492_000);
    expect(p.basis.length).toBeGreaterThan(2);
  });

  it("applies the pain cap and transfers the excess to the client", async () => {
    // 25m outturn against a 20.5m adjusted target is a 21.95% overrun; the
    // bands stop the contractor's share at 820k, and a 600k cap bites below it
    const patched = await patch(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}`,
      { forecastDefinedCost: 25_000_000, painCap: 600_000 },
    );
    expect(patched.statusCode).toBe(200);
    const p = patched.json().position;
    expect(p.variancePercent).toBeCloseTo(21.95, 2);
    expect(p.capApplied).toBe("pain");
    expect(p.cappedAt).toBe(600_000);
    expect(p.contractorShare).toBe(600_000);
    // the money does not disappear: the cap transfers it to the client
    expect(p.capTransfer).toBe(220_000);
    expect(p.clientShare).toBe(3_900_000);
    expect(p.basis.some((b: string) => /capped at 600000/.test(b))).toBe(true);
  });

  it("freezes a calculation and refuses to close without one", async () => {
    const noFreeze = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/calculate`,
      { basis: "forecast" },
    );
    expect(noFreeze.statusCode).toBe(200);
    expect(noFreeze.json().frozen).toBe(false);

    const active = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/status`,
      { status: "active" },
    );
    expect(active.statusCode).toBe(200);

    const closeTooEarly = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/status`,
      { status: "closed" },
      admin2Headers,
    );
    expect(closeTooEarly.statusCode).toBe(409);
    expect(closeTooEarly.json().message).toMatch(/frozen/i);

    const frozen = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/calculate`,
      { basis: "forecast", freeze: true, note: "Final account position" },
    );
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().frozen).toBe(true);
    expect(frozen.json().calculation.contractorShare).toBe(600_000);
    expect(frozen.json().calculation.detail.inputs.baseTargetCost).toBe(20_000_000);

    const calcs = await get(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/calculations`,
    );
    expect(calcs.json().total).toBe(1);

    const selfClose = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/status`,
      { status: "closed" },
    );
    expect(selfClose.statusCode).toBe(403);

    const closed = await post(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}/status`,
      { status: "closed" },
      admin2Headers,
    );
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");

    const edit = await patch(
      `/projects/${projectA}/portfolio/target-costs/${targetCostId}`,
      { baseTargetCost: 1 },
    );
    expect(edit.statusCode).toBe(409);
  });

  it("raises a target-cost overrun signal through the sweep, once", async () => {
    const created = await post(`/projects/${projectB}/portfolio/target-costs`, {
      name: "Second scheme target cost",
      currency: "GBP",
      baseTargetCost: 1_000_000,
      forecastDefinedCost: 1_200_000,
      mechanism: "flat_share",
      shareBands: [{ fromPercent: 0, toPercent: null, contractorSharePercent: 50 }],
    });
    expect(created.statusCode).toBe(201);
    await post(`/projects/${projectB}/portfolio/target-costs/${created.json().id}/status`, {
      status: "active",
    });

    const first = await post("/portfolio/sweeps/run");
    expect(first.json().targetCostOverruns).toBeGreaterThanOrEqual(1);
    const second = await post("/portfolio/sweeps/run");
    expect(second.json().targetCostOverruns).toBe(0);

    const signals = await get("/portfolio/signals?detector=target_cost_overrun");
    expect(signals.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it("gives another company nothing", async () => {
    expect(
      (await get(`/projects/${projectA}/portfolio/target-costs`, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

/* ================================================================== */
/* Open-book verification (#1063–#1066)                                */
/* ================================================================== */

let verificationId: string;

describe("open-book verification, disallowed cost and audit rights (#1063–#1066)", () => {
  it("creates a verification and refuses one in a currency the target cost is not in", async () => {
    const mismatch = await post(`/projects/${projectA}/portfolio/verifications`, {
      title: "Euro exercise",
      targetCostId,
      currency: "EUR",
    });
    expect(mismatch.statusCode).toBe(400);

    const created = await post(`/projects/${projectA}/portfolio/verifications`, {
      title: "Q1 defined cost verification",
      targetCostId,
      periodStart: dateOffset(-120),
      periodEnd: dateOffset(-30),
      currency: "GBP",
      claimedAmount: 4_000_000,
      auditRightsClause: "Clause 52.2",
      methodology: "Value-weighted sample of the labour and plant records",
      sampling: { basis: "value", populationCount: 900, populationValue: 4_000_000, sampleCount: 120, confidence: 90 },
      plannedAt: dateOffset(-5),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reference).toMatch(/^OB-\d{3}$/);
    verificationId = created.json().id as string;
  });

  it("adds defined cost items and materialises the header totals", async () => {
    const added = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items`,
      {
        items: [
          {
            component: "people",
            description: "Site staff, January",
            claimedAmount: 400_000,
            evidenceRef: "Payroll export PR-01",
          },
          {
            component: "equipment",
            description: "TBM standing time",
            claimedAmount: 250_000,
            evidenceRef: "Plant returns",
          },
          { component: "subcontractors", description: "Grouting subcontract", claimedAmount: 150_000 },
        ],
      },
    );
    expect(added.statusCode).toBe(201);
    expect(added.json().items).toHaveLength(3);
    expect(added.json().totals.claimed).toBe(800_000);
    expect(added.json().totals.pending).toBe(800_000);
    expect(added.json().totals.itemsWithoutEvidence).toBe(1);

    const detail = await get(
      `/projects/${projectA}/portfolio/verifications/${verificationId}`,
    );
    expect(detail.json().pendingAmount).toBe(800_000);
    expect(detail.json().untestedAmount).toBe(3_200_000);
    expect(detail.json().totals.reasons.some((r: string) => /no evidence reference/.test(r))).toBe(
      true,
    );
  });

  it("refuses a verdict from the person who recorded the claim", async () => {
    const detail = await get(
      `/projects/${projectA}/portfolio/verifications/${verificationId}`,
    );
    const item = detail.json().items[0];
    const self = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${item.id}/verdict`,
      { verdict: "verified" },
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/assertion, not a verification/i);
  });

  it("verifies, partially disallows and raises the register entry with its ground", async () => {
    const detail = await get(
      `/projects/${projectA}/portfolio/verifications/${verificationId}`,
    );
    const byComponent = (c: string) =>
      detail.json().items.find((i: { component: string }) => i.component === c);

    const people = byComponent("people");
    const verified = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${people.id}/verdict`,
      { verdict: "verified", verifierNote: "Traced to payroll and to the site register" },
      admin2Headers,
    );
    expect(verified.statusCode).toBe(200);
    expect(verified.json().totals.verified).toBe(400_000);

    const equipment = byComponent("equipment");
    const tooMuch = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${equipment.id}/verdict`,
      { verdict: "verified", verifiedAmount: 999_999 },
      admin2Headers,
    );
    expect(tooMuch.statusCode).toBe(400);

    const noAmount = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${equipment.id}/verdict`,
      { verdict: "partially_disallowed" },
      admin2Headers,
    );
    expect(noAmount.statusCode).toBe(400);

    const partial = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${equipment.id}/verdict`,
      {
        verdict: "partially_disallowed",
        verifiedAmount: 150_000,
        verifierNote: "Standing time beyond the accepted programme is not defined cost",
        disallowance: {
          category: "outside_accepted_programme",
          groundClause: "Clause 11.2(25)",
          responseDueAt: dateOffset(-1),
          description: "TBM standing time outside the accepted programme",
        },
      },
      admin2Headers,
    );
    expect(partial.statusCode).toBe(200);
    expect(partial.json().disallowedCostId).toBeTruthy();
    expect(partial.json().totals.verified).toBe(550_000);
    expect(partial.json().totals.disallowed).toBe(100_000);

    // a disallowing verdict with no ground is refused: it would put an amount
    // on the register citing nothing (#1066)
    const groundless = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${byComponent("subcontractors").id}/verdict`,
      { verdict: "disallowed" },
      admin2Headers,
    );
    expect(groundless.statusCode).toBe(400);
    expect(groundless.json().message).toMatch(/ground it rests on/i);

    const subs = byComponent("subcontractors");
    const queried = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items/${subs.id}/verdict`,
      { verdict: "queried", verifierNote: "Awaiting the subcontract and the application" },
      admin2Headers,
    );
    expect(queried.statusCode).toBe(200);
    expect(queried.json().totals.queried).toBe(150_000);
    expect(queried.json().totals.pending).toBe(0);
  });

  it("extrapolates the sample honestly, saying it is a projection", async () => {
    const detail = await get(
      `/projects/${projectA}/portfolio/verifications/${verificationId}`,
    );
    const ex = detail.json().extrapolation;
    expect(ex.extrapolable).toBe(true);
    expect(ex.observedRatePercent).toBe(12.5);
    expect(ex.untestedValue).toBe(3_200_000);
    expect(ex.projectedDisallowance).toBe(400_000);
    expect(ex.basis.some((b: string) => /projection from a sample, not a finding/.test(b))).toBe(
      true,
    );
  });

  it("refuses to report while a claim is still queried without findings, then reports", async () => {
    const noFindings = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/status`,
      { status: "reported" },
    );
    expect(noFindings.statusCode).toBe(400);

    const reported = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/status`,
      {
        status: "reported",
        findings:
          "£100k of TBM standing time disallowed; £150k of subcontract cost queried pending the subcontract.",
      },
    );
    expect(reported.statusCode).toBe(200);
    expect(reported.json().status).toBe("reported");

    const late = await post(
      `/projects/${projectA}/portfolio/verifications/${verificationId}/items`,
      { component: "design", description: "Late item", claimedAmount: 1 },
    );
    expect(late.statusCode).toBe(409);
  });

  it("sweeps overdue disallowance responses once, then records the contractor's answer", async () => {
    const first = await post("/portfolio/sweeps/run");
    expect(first.json().disallowedUnresolved).toBeGreaterThanOrEqual(1);
    const second = await post("/portfolio/sweeps/run");
    expect(second.json().disallowedUnresolved).toBe(0);

    const register = await get(`/projects/${projectA}/portfolio/disallowed-costs`);
    expect(register.statusCode).toBe(200);
    expect(register.json().summary.unresolved).toBe(1);
    expect(register.json().summary.overdueResponses).toBe(1);
    const dc = register.json().items[0];

    const responded = await post(
      `/projects/${projectA}/portfolio/disallowed-costs/${dc.id}/respond`,
      { response: "The standing time was instructed; see instruction 44.", disputed: true },
    );
    expect(responded.statusCode).toBe(200);
    expect(responded.json().status).toBe("disputed");

    // the second admin gave the verdict, so they are the one who raised this
    // disallowance and may not also execute the deduction
    const selfDeduct = await post(
      `/projects/${projectA}/portfolio/disallowed-costs/${dc.id}/resolve`,
      {
        outcome: "deducted",
        note: "Deducted from application 7",
        deductedAmount: 100_000,
        deductionRefType: "invoice",
        deductionRefId: "inv_123",
      },
      admin2Headers,
    );
    expect(selfDeduct.statusCode).toBe(403);
    expect(selfDeduct.json().message).toMatch(/different hands/i);

    const badDeduction = await post(
      `/projects/${projectA}/portfolio/disallowed-costs/${dc.id}/resolve`,
      { outcome: "deducted", note: "Deduct it", deductedAmount: 100_000 },
    );
    expect(badDeduction.statusCode).toBe(400);
    expect(badDeduction.json().message).toMatch(/where it landed/i);

    const tooMuch = await post(
      `/projects/${projectA}/portfolio/disallowed-costs/${dc.id}/resolve`,
      {
        outcome: "deducted",
        note: "Over-deduct",
        deductedAmount: 500_000,
        deductionRefType: "invoice",
        deductionRefId: "inv_123",
      },
    );
    expect(tooMuch.statusCode).toBe(400);

    const resolved = await post(
      `/projects/${projectA}/portfolio/disallowed-costs/${dc.id}/resolve`,
      {
        outcome: "deducted",
        note: "Deducted from application 7 after the instruction was found not to cover it",
        deductedAmount: 100_000,
        deductionRefType: "invoice",
        deductionRefId: "inv_123",
      },
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("deducted");
    expect(resolved.json().deductedAmount).toBe(100_000);
  });

  it("warns when a disallowance cites no clause", async () => {
    const res = await post(`/projects/${projectA}/portfolio/disallowed-costs`, {
      description: "Unsupported plant hire",
      category: "insufficient_records",
      currency: "GBP",
      amount: 25_000,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().warning).toMatch(/opinion/i);

    const register = await get(`/projects/${projectA}/portfolio/disallowed-costs`);
    expect(register.json().summary.withoutGround).toBe(1);
    expect(
      register.json().summary.reasons.some((r: string) => /cite no contract clause/.test(r)),
    ).toBe(true);
  });

  it("records an audit right, its obstruction, and sweeps it once", async () => {
    const created = await post(`/projects/${projectA}/portfolio/audit-rights`, {
      reference: "AR-001",
      subjectType: "commitment",
      subjectName: "Deepdig grouting subcontract",
      contractReference: "SC-014",
      clause: "Clause 52.2",
      scope: "Labour, plant and materials records for the period",
      auditorName: "Internal audit",
      noticeDate: dateOffset(-30),
      noticeDays: 14,
      scheduledDate: dateOffset(-3),
      verificationId,
      recordsRequested: [
        { description: "Daily allocation sheets" },
        { description: "Plant hire invoices" },
      ],
    });
    expect(created.statusCode).toBe(201);
    const auditId = created.json().id as string;
    expect(created.json().obligationId).toBeTruthy();

    const first = await post("/portfolio/sweeps/run");
    expect(first.json().auditRightsObstructed).toBe(1);
    const second = await post("/portfolio/sweeps/run");
    expect(second.json().auditRightsObstructed).toBe(0);

    const list = await get(`/projects/${projectA}/portfolio/audit-rights`);
    expect(list.json().items[0].status).toBe("obstructed");
    expect(list.json().items[0].recordsSummary.requested).toBe(2);
    expect(list.json().items[0].recordsSummary.outstanding).toBe(2);

    const noNote = await post(
      `/projects/${projectA}/portfolio/audit-rights/${auditId}/status`,
      { status: "obstructed" },
    );
    expect(noNote.statusCode).toBe(400);

    const granted = await post(
      `/projects/${projectA}/portfolio/audit-rights/${auditId}/status`,
      { status: "in_progress" },
    );
    expect(granted.statusCode).toBe(200);
    expect(granted.json().accessGrantedAt).toBeTruthy();

    const noOutcome = await post(
      `/projects/${projectA}/portfolio/audit-rights/${auditId}/status`,
      { status: "completed" },
    );
    expect(noOutcome.statusCode).toBe(400);

    const completed = await post(
      `/projects/${projectA}/portfolio/audit-rights/${auditId}/status`,
      { status: "completed", outcome: "Records produced in full; two allocation sheets missing." },
    );
    expect(completed.statusCode).toBe(200);
    const obligationRows = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, created.json().obligationId as string));
    expect(obligationRows[0]!.status).toBe("satisfied");

    const deletion = await del(`/projects/${projectA}/portfolio/audit-rights/${auditId}`);
    expect(deletion.statusCode).toBe(409);
  });

  it("gives another company nothing on any open-book route", async () => {
    expect(
      (await get(`/projects/${projectA}/portfolio/verifications`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/portfolio/disallowed-costs`, stranger.headers)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/projects/${projectA}/portfolio/audit-rights`, stranger.headers)).statusCode,
    ).toBe(403);
  });
});

/* ================================================================== */
/* Command view, project summary, health inputs                        */
/* ================================================================== */

describe("command view and health inputs", () => {
  beforeAll(async () => {
    // give the roll-up something real to read
    await app.db.insert(budgets).values({
      id: newId("bdg"),
      companyId: owner.companyId,
      projectId: projectA,
      number: 1,
      reference: "BUD-001",
      name: "Tunnel budget",
      isActive: 1,
      currency: "GBP",
      revisedBudgetTotal: 21_000_000,
      committedTotal: 18_000_000,
      jobToDateCostsTotal: 12_000_000,
      forecastFinalTotal: 23_000_000,
      createdBy: owner.userId,
    } as typeof budgets.$inferInsert);
    const gateId = newId("gat");
    await app.db.insert(stageGates).values({
      id: gateId,
      companyId: owner.companyId,
      projectId: projectA,
      gateNumber: 3,
      name: "Gate 3 — investment decision",
      status: "decided",
      plannedDate: dateOffset(-60),
    } as typeof stageGates.$inferInsert);
    await app.db.insert(stageGates).values({
      id: newId("gat"),
      companyId: owner.companyId,
      projectId: projectA,
      gateNumber: 4,
      name: "Gate 4 — readiness for service",
      status: "pending",
      plannedDate: dateOffset(-5),
    } as typeof stageGates.$inferInsert);
    await app.db.insert(gateReviews).values({
      id: newId("gre"),
      gateId,
      companyId: owner.companyId,
      projectId: projectA,
      reviewDate: dateOffset(-60),
      rag: "amber",
      decision: "approve_with_conditions",
      reviewedBy: owner.userId,
    } as typeof gateReviews.$inferInsert);
  });

  it("rolls up by currency and never combines across them", async () => {
    const res = await get("/portfolio/rollup");
    expect(res.statusCode).toBe(200);
    const gbp = res.json().byCurrency.find((b: { currency: string }) => b.currency === "GBP");
    expect(gbp.revisedBudget).toBe(21_000_000);
    expect(gbp.forecastFinal).toBe(23_000_000);
    expect(gbp.forecastVariance).toBe(2_000_000);
    // one currency in play, so the combined total is knowable
    expect(res.json().combinedForecastFinal.value).toBe(23_000_000);
    expect(res.json().projectsWithoutBudget).toBe(1);
    expect(res.json().reasons.some((r: string) => /no active budget/.test(r))).toBe(true);
  });

  it("returns an unknowable combined total once two currencies are in play", async () => {
    const euroProject = newId("prj");
    await app.db.insert(projects).values({
      id: euroProject,
      companyId: owner.companyId,
      name: "Euro scheme",
      currency: "EUR",
    } as typeof projects.$inferInsert);
    await app.db.insert(budgets).values({
      id: newId("bdg"),
      companyId: owner.companyId,
      projectId: euroProject,
      number: 1,
      reference: "BUD-002",
      name: "Euro budget",
      isActive: 1,
      currency: "EUR",
      revisedBudgetTotal: 5_000_000,
      forecastFinalTotal: 5_500_000,
      createdBy: owner.userId,
    } as typeof budgets.$inferInsert);

    const res = await get("/portfolio/rollup");
    expect(res.json().combinedForecastFinal.value).toBeNull();
    expect(res.json().combinedForecastFinal.reasons[0]).toMatch(/exchange rate/i);
  });

  it("builds the pipeline from the governance gates it reads", async () => {
    const res = await get("/portfolio/pipeline");
    expect(res.statusCode).toBe(200);
    const entry = res.json().entries.find((e: { projectId: string }) => e.projectId === projectA);
    expect(entry.gatesTotal).toBe(2);
    expect(entry.gatesDecided).toBe(1);
    expect(entry.nextGate.gateNumber).toBe(4);
    expect(entry.overdueGates).toBe(1);
    expect(entry.lastReview.rag).toBe("amber");
    expect(res.json().projectsWithoutGates).toBeGreaterThanOrEqual(1);
  });

  it("assembles the command view", async () => {
    const res = await get("/portfolio/overview");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects.total).toBeGreaterThanOrEqual(3);
    expect(body.rollup.byCurrency.length).toBeGreaterThanOrEqual(2);
    expect(body.pipeline.gatesOverdue).toBe(1);
    expect(body.ventures).toBe(1);
    expect(Array.isArray(body.signals)).toBe(true);
    expect(body.signals.length).toBeGreaterThan(0);
    expect(body.generatedAt).toBeTruthy();
  });

  it("summarises the project workspace and exposes health inputs that never fabricate", async () => {
    const summary = await get(`/projects/${projectA}/portfolio/summary`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().ventures.total).toBe(1);
    expect(summary.json().openBook.verifications).toBe(1);
    expect(summary.json().disallowed.total).toBe(2);
    expect(summary.json().disallowed.withoutGround).toBe(1);
    expect(summary.json().auditRights.total).toBe(1);

    const health = await get(`/projects/${projectA}/portfolio/health-inputs`);
    expect(health.statusCode).toBe(200);
    const m = health.json().metrics;
    expect(m.disallowedWithoutGround).toBe(1);
    expect(m.jvContributionsOverdue).toBe(0);
    expect(m.openBookDisallowanceRatePercent).toBe(12.5);
    // no funding allocated on this project: null with a reason, never 0
    expect(m.allocationDrawnPercent).toBeNull();
    expect(health.json().reasons.some((r: string) => /No funding has been allocated/.test(r))).toBe(
      true,
    );
  });

  it("lists portfolios with their project counts", async () => {
    const res = await get("/portfolio/portfolios");
    expect(res.statusCode).toBe(200);
    expect(res.json().ungroupedProjects).toBeGreaterThanOrEqual(3);
  });

  it("scopes the command view to the caller's projects when they are not an admin", async () => {
    const res = await get("/portfolio/overview", viewerHeaders);
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.total).toBe(1);
    expect(res.json().reasons.some((r: string) => /only the projects you are a member of/.test(r))).toBe(
      true,
    );
  });

  it("gives another company an empty command view, not someone else's", async () => {
    const res = await get("/portfolio/overview", stranger.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.total).toBe(0);
    expect(res.json().rollup.byCurrency).toHaveLength(0);
    expect(res.json().ventures).toBe(0);
    expect(res.json().signals).toHaveLength(0);
  });

  it("runs the commercial-structures scheduler job on demand", async () => {
    const job = await app.scheduler.runNow("portfolio.commercial-structures");
    expect(job.state).toBe("succeeded");
  });
});
