import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  ledgerEntries,
  portfolioAllocations,
  portfolios,
  projects,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { portfolioModule } from "./index.js";

/**
 * WP-PORTFOLIO — money authority and prioritisation, route integration tests.
 * Spec Vol II Domain G #424–#434, Vol I §7 #779–#784.
 *
 * Covers every route in routes/funding.ts and routes/prioritisation.ts,
 * including the refusals that matter: headroom, currency, segregation of
 * duties, and the cross-tenant negative.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** a second admin in the owner's company — the "other person" every SoD rule needs */
let admin2Headers: Record<string, string>;
let admin2Id: string;
/** an ordinary member: company gate yes, company-admin gate no */
let memberHeaders: Record<string, string>;
/** a different company entirely */
let stranger: TestActor;

let portfolioA: string;
let projectA: string;
let projectB: string;
let projectC: string;

function get(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function post(url: string, payload?: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
}
function put(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function del(url: string, headers: Record<string, string> = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

async function makeProject(name: string, currency = "GBP", extra: Record<string, unknown> = {}) {
  const id = newId("prj");
  await app.db.insert(projects).values({
    id,
    companyId: owner.companyId,
    name,
    currency,
    ...extra,
  } as typeof projects.$inferInsert);
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  // Until the orchestrator adds the portfolio line to app.ts, mount it here so
  // the suite exercises the real plugin either way.
  if (!app.hasRoute({ method: "GET", url: "/api/v1/portfolio/overview" })) {
    await app.register(portfolioModule, { prefix: "/api/v1" });
  }
  owner = await registerActor(app, { companyName: "Portfolio Test Co" });

  const admin2 = await registerActor(app);
  admin2Id = admin2.userId;
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

  portfolioA = newId("pfl");
  await app.db.insert(portfolios).values({
    id: portfolioA,
    companyId: owner.companyId,
    name: "Schools programme",
  });

  projectA = await makeProject("Riverside School", "GBP", { portfolioId: portfolioA, value: 12_000_000 });
  projectB = await makeProject("Hilltop Academy", "GBP", { portfolioId: portfolioA, value: 8_000_000 });
  projectC = await makeProject("Overseas Depot", "EUR", { value: 3_000_000 });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Funding sources (#427)                                              */
/* ================================================================== */

describe("funding sources (#427, #432)", () => {
  let sourceId: string;

  it("creates a facility, ledgers it and reports its position", async () => {
    const created = await post("/portfolio/funding-sources", {
      name: "DfE capital grant 2026",
      kind: "government_grant",
      provider: "Department for Education",
      portfolioId: portfolioA,
      currency: "gbp",
      amount: 10_000_000,
      availableFrom: "2026-04-01",
      availableTo: "2027-03-31",
      expenditureClass: "capital",
      conditions: [{ text: "Quarterly monitoring return", dueDate: "2026-07-31", met: false }],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.currency).toBe("GBP");
    expect(body.status).toBe("proposed");
    expect(body.conditions).toHaveLength(1);
    sourceId = body.id as string;

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "portfolio_funding_source"),
          eq(ledgerEntries.objectId, sourceId),
        ),
      );
    expect(entries.length).toBeGreaterThan(0);

    const detail = await get(`/portfolio/funding-sources/${sourceId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().position.facility).toBe(10_000_000);
    expect(detail.json().position.headroom).toBe(10_000_000);
  });

  it("rejects an inverted availability window and an unknown portfolio", async () => {
    const inverted = await post("/portfolio/funding-sources", {
      name: "Bad window",
      kind: "loan",
      currency: "GBP",
      amount: 1,
      availableFrom: "2026-06-01",
      availableTo: "2026-01-01",
    });
    expect(inverted.statusCode).toBe(400);

    const unknown = await post("/portfolio/funding-sources", {
      name: "Bad portfolio",
      kind: "loan",
      currency: "GBP",
      amount: 1,
      portfolioId: "pfl_nope",
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("moves the facility to available and lists it", async () => {
    const status = await post(`/portfolio/funding-sources/${sourceId}/status`, {
      status: "available",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("available");

    const list = await get("/portfolio/funding-sources?status=available");
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((s: { id: string }) => s.id)).toContain(sourceId);
    expect(list.json().items[0].position.currency).toBe("GBP");
  });

  it("refuses a company-admin write from an ordinary member but allows the read", async () => {
    const write = await post(
      "/portfolio/funding-sources",
      { name: "Member facility", kind: "loan", currency: "GBP", amount: 1 },
      memberHeaders,
    );
    expect(write.statusCode).toBe(403);

    const read = await get("/portfolio/funding-sources", memberHeaders);
    expect(read.statusCode).toBe(200);
  });

  it("hides the facility from another company entirely", async () => {
    const list = await get("/portfolio/funding-sources", stranger.headers);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(0);

    const direct = await get(`/portfolio/funding-sources/${sourceId}`, stranger.headers);
    expect(direct.statusCode).toBe(404);

    const write = await patch(
      `/portfolio/funding-sources/${sourceId}`,
      { name: "Hijacked" },
      stranger.headers,
    );
    expect(write.statusCode).toBe(404);
  });

  it("keeps the facility id available for the appropriation tests", () => {
    expect(sourceId).toBeTruthy();
    fundingSourceId = sourceId;
  });
});

let fundingSourceId: string;

/* ================================================================== */
/* Appropriations, virements, carry-forward (#428–#429, #433)          */
/* ================================================================== */

describe("appropriations and carry-forward (#428–#429, #433)", () => {
  let year1: string;
  let year2: string;
  let lapsing: string;

  it("creates an appropriation against the facility and refuses a currency mismatch", async () => {
    const mismatch = await post("/portfolio/appropriations", {
      name: "Euro year",
      fiscalYear: "2026/27",
      fundingSourceId,
      currency: "EUR",
      appropriatedAmount: 100,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().message).toMatch(/across currencies/i);

    const created = await post("/portfolio/appropriations", {
      name: "Schools 2026/27",
      fiscalYear: "2026/27",
      portfolioId: portfolioA,
      fundingSourceId,
      currency: "GBP",
      appropriatedAmount: 6_000_000,
      carryForwardPolicy: "carry_forward",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("draft");
    year1 = created.json().id as string;

    const next = await post("/portfolio/appropriations", {
      name: "Schools 2027/28",
      fiscalYear: "2027/28",
      portfolioId: portfolioA,
      fundingSourceId,
      currency: "GBP",
      appropriatedAmount: 3_000_000,
      carryForwardPolicy: "carry_forward",
    });
    expect(next.statusCode).toBe(201);
    year2 = next.json().id as string;

    const lapse = await post("/portfolio/appropriations", {
      name: "Revenue 2026/27",
      fiscalYear: "2026/27",
      currency: "GBP",
      appropriatedAmount: 500_000,
      expenditureClass: "revenue",
      carryForwardPolicy: "lapse",
    });
    expect(lapse.statusCode).toBe(201);
    lapsing = lapse.json().id as string;
  });

  it("refuses self-approval and accepts a second admin's", async () => {
    const self = await post(`/portfolio/appropriations/${year1}/approve`);
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/cannot approve it/i);

    const byOther = await post(`/portfolio/appropriations/${year1}/approve`, {}, admin2Headers);
    expect(byOther.statusCode).toBe(200);
    expect(byOther.json().status).toBe("approved");
    expect(byOther.json().approvedBy).toBe(admin2Id);

    // and again is a conflict, not a silent second approval
    const again = await post(`/portfolio/appropriations/${year1}/approve`, {}, admin2Headers);
    expect(again.statusCode).toBe(409);

    for (const id of [year2, lapsing]) {
      const ok = await post(`/portfolio/appropriations/${id}/approve`, {}, admin2Headers);
      expect(ok.statusCode).toBe(200);
    }
  });

  it("shows the appropriation position with its authority arithmetic", async () => {
    const detail = await get(`/portfolio/appropriations/${year1}`);
    expect(detail.statusCode).toBe(200);
    const p = detail.json().position;
    expect(p.authorised).toBe(6_000_000);
    expect(p.allocated).toBe(0);
    expect(p.uncommitted).toBe(6_000_000);
    expect(p.carryForwardPolicy).toBe("carry_forward");
  });

  it("moves authority by virement, refusing a self-decided one", async () => {
    const same = await post("/portfolio/virements", {
      fromAppropriationId: year1,
      toAppropriationId: year1,
      amount: 10,
      reason: "nonsense",
    });
    expect(same.statusCode).toBe(400);

    const created = await post("/portfolio/virements", {
      fromAppropriationId: year1,
      toAppropriationId: year2,
      amount: 1_000_000,
      reason: "Programme reprofiled after planning delay",
    });
    expect(created.statusCode).toBe(201);
    const virementId = created.json().id as string;

    const self = await post(`/portfolio/virements/${virementId}/decide`, { outcome: "approved" });
    expect(self.statusCode).toBe(403);

    const decided = await post(
      `/portfolio/virements/${virementId}/decide`,
      { outcome: "approved", decisionNote: "Approved by finance committee" },
      admin2Headers,
    );
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("approved");

    const from = await get(`/portfolio/appropriations/${year1}`);
    expect(from.json().virementNet).toBe(-1_000_000);
    expect(from.json().position.authorised).toBe(5_000_000);
    const to = await get(`/portfolio/appropriations/${year2}`);
    expect(to.json().virementNet).toBe(1_000_000);
    expect(to.json().position.authorised).toBe(4_000_000);

    const twice = await post(
      `/portfolio/virements/${virementId}/decide`,
      { outcome: "rejected" },
      admin2Headers,
    );
    expect(twice.statusCode).toBe(409);
  });

  it("carries a balance forward into a named successor and records the chain", async () => {
    const close = await post(
      `/portfolio/appropriations/${year1}/close`,
      { successorAppropriationId: year2, note: "Year end 2026/27" },
      admin2Headers,
    );
    expect(close.statusCode).toBe(200);
    expect(close.json().carriedForward).toBe(5_000_000);
    expect(close.json().appropriation.status).toBe("carried_forward");

    const successor = await get(`/portfolio/appropriations/${year2}`);
    expect(successor.json().carriedForwardIn).toBe(5_000_000);
    expect(successor.json().carriedForwardFromId).toBe(year1);
    expect(successor.json().carriedForwardFrom.id).toBe(year1);
    expect(successor.json().position.authorised).toBe(9_000_000);

    const again = await post(
      `/portfolio/appropriations/${year1}/close`,
      { successorAppropriationId: year2 },
      admin2Headers,
    );
    expect(again.statusCode).toBe(409);
  });

  it("lapses an unspent balance where the policy says so", async () => {
    const close = await post(`/portfolio/appropriations/${lapsing}/close`, {}, admin2Headers);
    expect(close.statusCode).toBe(200);
    expect(close.json().carriedForward).toBe(0);
    expect(close.json().lapsed).toBe(500_000);
    expect(close.json().appropriation.status).toBe("lapsed");
  });

  it("keeps the live appropriation id for the allocation tests", () => {
    liveAppropriationId = year2;
  });
});

let liveAppropriationId: string;

/* ================================================================== */
/* Allocations (#427, #430, #434)                                      */
/* ================================================================== */

describe("allocations (#427, #430, #434)", () => {
  let allocationId: string;

  it("refuses an allocation with no stated source", async () => {
    const res = await post("/portfolio/allocations", {
      projectId: projectA,
      currency: "GBP",
      amount: 100,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no stated source/i);
  });

  it("refuses an allocation in a currency the appropriation is not in", async () => {
    const res = await post("/portfolio/allocations", {
      projectId: projectC,
      appropriationId: liveAppropriationId,
      currency: "EUR",
      amount: 100,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot consume that authority/i);
  });

  it("creates an allocation inside the headroom and reports the remaining", async () => {
    const res = await post("/portfolio/allocations", {
      projectId: projectA,
      appropriationId: liveAppropriationId,
      fundingSourceId,
      fiscalYear: "2027/28",
      currency: "GBP",
      amount: 4_000_000,
      expenditureClass: "capital",
      wholeLifeCost: 18_000_000,
    });
    expect(res.statusCode).toBe(201);
    allocationId = res.json().id as string;
    expect(res.json().status).toBe("planned");

    const list = await get(`/portfolio/allocations?projectId=${projectA}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0].projectName).toBe("Riverside School");
    expect(list.json().items[0].remaining).toBe(4_000_000);
  });

  it("refuses an allocation that would overcommit the appropriation", async () => {
    const res = await post("/portfolio/allocations", {
      projectId: projectB,
      appropriationId: liveAppropriationId,
      currency: "GBP",
      amount: 6_000_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/beyond the .* authorised/i);
  });

  it("refuses an allocation that would overdraw the facility", async () => {
    const res = await post("/portfolio/allocations", {
      projectId: projectB,
      fundingSourceId,
      currency: "GBP",
      amount: 9_000_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/beyond its .* facility/i);
  });

  it("requires a second person to approve, then permits a draw within the amount", async () => {
    const self = await post(`/portfolio/allocations/${allocationId}/approve`);
    expect(self.statusCode).toBe(403);

    const approved = await post(
      `/portfolio/allocations/${allocationId}/approve`,
      {},
      admin2Headers,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");

    const over = await post(`/portfolio/allocations/${allocationId}/draw`, { amount: 5_000_000 });
    expect(over.statusCode).toBe(409);

    const drawn = await post(`/portfolio/allocations/${allocationId}/draw`, {
      amount: 1_500_000,
      note: "First drawdown",
    });
    expect(drawn.statusCode).toBe(200);
    expect(drawn.json().drawnAmount).toBe(1_500_000);
    expect(drawn.json().status).toBe("approved");

    const rest = await post(`/portfolio/allocations/${allocationId}/draw`, { amount: 2_500_000 });
    expect(rest.statusCode).toBe(200);
    expect(rest.json().drawnAmount).toBe(4_000_000);
    expect(rest.json().status).toBe("drawn");
  });

  it("refuses to change the money on an allocation already drawn against", async () => {
    const res = await patch(`/portfolio/allocations/${allocationId}`, { amount: 5_000_000 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already been drawn/i);

    const cancel = await post(`/portfolio/allocations/${allocationId}/cancel`, { reason: "no" });
    expect(cancel.statusCode).toBe(409);
  });

  it("reverts the approval when an undrawn allocation's amount changes", async () => {
    const created = await post("/portfolio/allocations", {
      projectId: projectB,
      appropriationId: liveAppropriationId,
      currency: "GBP",
      amount: 1_000_000,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const approved = await post(`/portfolio/allocations/${id}/approve`, {}, admin2Headers);
    expect(approved.statusCode).toBe(200);

    const edited = await patch(`/portfolio/allocations/${id}`, { amount: 2_000_000 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().status).toBe("planned");
    expect(edited.json().approvedBy).toBeNull();
    expect(edited.json().amount).toBe(2_000_000);

    const cancelled = await post(`/portfolio/allocations/${id}/cancel`, {
      reason: "Scheme deferred to the next spending round",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
  });

  it("refuses to shrink a facility below what is allocated against it", async () => {
    const res = await patch(`/portfolio/funding-sources/${fundingSourceId}`, { amount: 100 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Release allocations first/i);
  });

  it("refuses to delete a facility with allocations on it", async () => {
    const res = await del(`/portfolio/funding-sources/${fundingSourceId}`);
    expect(res.statusCode).toBe(409);
  });

  it("shows nothing to another company", async () => {
    const list = await get("/portfolio/allocations", stranger.headers);
    expect(list.json().items).toHaveLength(0);
    const direct = await get(`/portfolio/allocations/${allocationId}`, stranger.headers);
    expect(direct.statusCode).toBe(404);
    const draw = await post(
      `/portfolio/allocations/${allocationId}/draw`,
      { amount: 1 },
      stranger.headers,
    );
    expect(draw.statusCode).toBe(404);
  });
});

/* ================================================================== */
/* Affordability envelope (#426, #430)                                 */
/* ================================================================== */

describe("affordability envelope (#426, #430)", () => {
  let envelopeId: string;
  let supersedingId: string;

  it("activates one envelope per year/currency/class and supersedes the old one", async () => {
    const first = await post("/portfolio/envelopes", {
      name: "Capital envelope 2027/28",
      fiscalYear: "2027/28",
      portfolioId: portfolioA,
      currency: "GBP",
      envelopeAmount: 3_000_000,
      basis: "Medium-term financial plan, Cabinet 12 Feb 2026",
    });
    expect(first.statusCode).toBe(201);
    envelopeId = first.json().id as string;
    expect(first.json().status).toBe("draft");

    const activated = await post(`/portfolio/envelopes/${envelopeId}/activate`);
    expect(activated.statusCode).toBe(200);
    expect(activated.json().status).toBe("active");

    // an active envelope is a decision record, not editable
    const edit = await patch(`/portfolio/envelopes/${envelopeId}`, { envelopeAmount: 9 });
    expect(edit.statusCode).toBe(409);

    const second = await post("/portfolio/envelopes", {
      name: "Capital envelope 2027/28 (revised)",
      fiscalYear: "2027/28",
      portfolioId: portfolioA,
      currency: "GBP",
      envelopeAmount: 5_000_000,
      basis: "Revised after the Autumn settlement",
    });
    supersedingId = second.json().id as string;
    const activate2 = await post(`/portfolio/envelopes/${supersedingId}/activate`);
    expect(activate2.statusCode).toBe(200);

    const old = await get(`/portfolio/envelopes?status=superseded`);
    expect(old.json().items.map((e: { id: string }) => e.id)).toContain(envelopeId);
  });

  it("measures demand against the active envelope and reports the breach honestly", async () => {
    const res = await get(`/portfolio/affordability?portfolioId=${portfolioA}&fiscalYear=2027/28`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const line = body.lines.find((l: { envelopeId: string }) => l.envelopeId === supersedingId);
    expect(line).toBeTruthy();
    expect(line.envelope).toBe(5_000_000);
    // the 4m allocation on project A in 2027/28, capital, GBP
    expect(line.demand).toBe(4_000_000);
    expect(line.headroom).toBe(1_000_000);
    expect(line.breached).toBe(false);
    expect(body.classificationSplit[0].currency).toBe("GBP");
    expect(body.classificationSplit[0].capitalPercent).toBe(100);
  });

  it("raises an envelope breach signal through the sweep once, not twice", async () => {
    // push demand past the envelope
    const extra = await post("/portfolio/allocations", {
      projectId: projectB,
      fiscalYear: "2027/28",
      appropriationId: liveAppropriationId,
      currency: "GBP",
      amount: 2_000_000,
    });
    expect(extra.statusCode).toBe(201);

    const first = await post("/portfolio/sweeps/run");
    expect(first.statusCode).toBe(200);
    expect(first.json().envelopeBreaches).toBe(1);

    const second = await post("/portfolio/sweeps/run");
    expect(second.json().envelopeBreaches).toBe(0);

    const signals = await get("/portfolio/signals?detector=portfolio_envelope_breach");
    expect(signals.statusCode).toBe(200);
    expect(signals.json().items).toHaveLength(1);
    expect(signals.json().items[0].explanation).toMatch(/exceed/i);
  });

  it("runs the scheduler job on demand and finds nothing new", async () => {
    const result = await app.scheduler.runNow("portfolio.funding-control");
    expect(result.state).toBe("succeeded");
  });

  it("refuses the sweep and the envelope write to an ordinary member", async () => {
    expect((await post("/portfolio/sweeps/run", {}, memberHeaders)).statusCode).toBe(403);
    expect(
      (
        await post(
          "/portfolio/envelopes",
          { name: "x", fiscalYear: "2027/28", currency: "GBP", envelopeAmount: 1 },
          memberHeaders,
        )
      ).statusCode,
    ).toBe(403);
  });

  it("shows another company no envelopes and no signals", async () => {
    expect((await get("/portfolio/envelopes", stranger.headers)).json().items).toHaveLength(0);
    expect((await get("/portfolio/signals", stranger.headers)).json().items).toHaveLength(0);
    expect((await get("/portfolio/affordability", stranger.headers)).json().lines).toHaveLength(0);
  });
});

/* ================================================================== */
/* MCDA prioritisation (#424–#425)                                     */
/* ================================================================== */

describe("MCDA prioritisation (#424–#425)", () => {
  let modelId: string;

  it("refuses a model with no criterion carrying weight", async () => {
    const res = await post("/portfolio/scoring-models", {
      name: "Weightless",
      criteria: [{ key: "a", label: "A", weight: 0, min: 0, max: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/positive weight/i);
  });

  it("creates a model and activates it", async () => {
    const res = await post("/portfolio/scoring-models", {
      name: "Capital prioritisation 2027",
      description: "Strategic fit, deliverability and whole-life cost",
      criteria: [
        { key: "strategic_fit", label: "Strategic fit", weight: 50, direction: "benefit", min: 0, max: 10 },
        { key: "deliverability", label: "Deliverability", weight: 30, direction: "benefit", min: 0, max: 10 },
        { key: "whole_life_cost", label: "Whole-life cost", weight: 20, direction: "cost", min: 0, max: 100 },
      ],
    });
    expect(res.statusCode).toBe(201);
    modelId = res.json().id as string;
    expect(res.json().version).toBe(1);

    const activated = await post(`/portfolio/scoring-models/${modelId}/status`, { status: "active" });
    expect(activated.statusCode).toBe(200);
  });

  it("refuses a score against a criterion the model does not carry", async () => {
    const res = await put(`/portfolio/scoring-models/${modelId}/scores/${projectA}`, {
      scores: { strategic_fit: 8, invented: 3 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no criterion named invented/i);
  });

  it("scores two projects and ranks them, leaving the unscored one null", async () => {
    const a = await put(`/portfolio/scoring-models/${modelId}/scores/${projectA}`, {
      scores: { strategic_fit: 9, deliverability: 7, whole_life_cost: 40 },
      rationale: { strategic_fit: "Named in the estate strategy" },
    });
    expect(a.statusCode).toBe(200);
    const b = await put(`/portfolio/scoring-models/${modelId}/scores/${projectB}`, {
      scores: { strategic_fit: 5, deliverability: 9, whole_life_cost: 20 },
    });
    expect(b.statusCode).toBe(200);

    const ranking = await get(`/portfolio/scoring-models/${modelId}/ranking`);
    expect(ranking.statusCode).toBe(200);
    const run = ranking.json().run;
    const rows: Array<{ projectId: string; rank: number | null; score: number | null; coverage: number }> =
      run.ranked;
    const rowA = rows.find((r) => r.projectId === projectA)!;
    const rowB = rows.find((r) => r.projectId === projectB)!;
    const rowC = rows.find((r) => r.projectId === projectC)!;
    expect(rowA.rank).toBe(1);
    expect(rowB.rank).toBe(2);
    // never scored: null, never zero — a fabricated zero reads as "scored badly"
    expect(rowC.rank).toBeNull();
    expect(rowC.score).toBeNull();
    expect(rowA.coverage).toBe(1);
    expect(run.influence.length).toBe(3);
    expect(ranking.json().reasons.some((r: string) => /carry no score/.test(r))).toBe(true);
  });

  it("bumps the version when the criteria change and names the orphaned entries", async () => {
    const res = await patch(`/portfolio/scoring-models/${modelId}`, {
      criteria: [
        { key: "strategic_fit", label: "Strategic fit", weight: 60, direction: "benefit", min: 0, max: 10 },
        { key: "deliverability", label: "Deliverability", weight: 40, direction: "benefit", min: 0, max: 10 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(2);

    const ranking = await get(`/portfolio/scoring-models/${modelId}/ranking`);
    expect(ranking.json().orphanedEntries.length).toBe(2);
    expect(ranking.json().reasons.some((r: string) => /no longer carries/.test(r))).toBe(true);

    const detail = await get(`/portfolio/scoring-models/${modelId}`);
    expect(detail.json().scores[0].orphanedKeys).toContain("whole_life_cost");
  });

  it("deletes a score and archives the model", async () => {
    const removed = await del(`/portfolio/scoring-models/${modelId}/scores/${projectB}`);
    expect(removed.statusCode).toBe(204);
    const again = await del(`/portfolio/scoring-models/${modelId}/scores/${projectB}`);
    expect(again.statusCode).toBe(404);

    const archived = await post(`/portfolio/scoring-models/${modelId}/status`, {
      status: "archived",
    });
    expect(archived.statusCode).toBe(200);
    const edit = await patch(`/portfolio/scoring-models/${modelId}`, { name: "nope" });
    expect(edit.statusCode).toBe(409);
    const score = await put(`/portfolio/scoring-models/${modelId}/scores/${projectA}`, {
      scores: { strategic_fit: 1 },
    });
    expect(score.statusCode).toBe(409);
  });

  it("gives another company nothing", async () => {
    expect((await get("/portfolio/scoring-models", stranger.headers)).json().items).toHaveLength(0);
    expect((await get(`/portfolio/scoring-models/${modelId}`, stranger.headers)).statusCode).toBe(404);
    expect(
      (
        await put(
          `/portfolio/scoring-models/${modelId}/scores/${projectA}`,
          { scores: {} },
          stranger.headers,
        )
      ).statusCode,
    ).toBe(404);
  });
});

/* ================================================================== */
/* Tenant isolation on the data itself                                 */
/* ================================================================== */

describe("tenant isolation", () => {
  it("wrote every allocation under the owning company only", async () => {
    const rows = await app.db
      .select()
      .from(portfolioAllocations)
      .where(eq(portfolioAllocations.companyId, stranger.companyId));
    expect(rows).toHaveLength(0);
  });

  it("rejects an unauthenticated call outright", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/portfolio/overview" });
    expect(res.statusCode).toBe(401);
  });
});
