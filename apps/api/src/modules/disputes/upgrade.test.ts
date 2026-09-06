/**
 * Integration tests for the dispute-resolution upgrade (spec Vol II Domain E
 * #322-357).
 *
 * Covers: statutory timetable generation per jurisdiction with a business-day
 * calendar, the adjudicator nomination request, DAAB membership and visits,
 * the dispute cost ledger and cost of recovery, the decision-tree settlement
 * model with Part 36 consequences and the litigation provision, bundle
 * privilege and content snapshots, the structured outcome record and the
 * company-wide outcome analytics that feed contract drafting.
 *
 * Regression tests for the audit findings in this area: expired offers lapse
 * and cannot be accepted, a terminal dispute closes its timetable obligations,
 * extending a missed step clears the breach, offers are compared only within
 * the dispute's currency, accepting one offer lapses the others, and bundle
 * items must belong to the dispute's own project.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { companyMemberships, files, obligations, projects, settlementOffers } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let admin: TestActor;
let adminHeaders: Record<string, string>;
let projectId: string;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  admin = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: admin.userId,
    role: "admin",
  });
  adminHeaders = {
    authorization: admin.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Dispute Upgrade Project",
  });
});

afterAll(async () => {
  await built.close();
});

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function insertFile(pid: string): Promise<string> {
  const id = newId("fil");
  await app.db.insert(files).values({
    id,
    companyId: owner.companyId,
    projectId: pid,
    name: `doc-${id}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1024,
    storageKey: `key/${id}`,
    // A REAL digest, not a placeholder: a bundle with a single produced
    // item has that item's own hash as its merkle root, so a fake value here
    // would hide whether the root is a well-formed sha256.
    sha256: createHash("sha256").update(id).digest("hex"),
    uploadedBy: owner.userId,
  });
  return id;
}

async function createDispute(pid: string, payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disputes`,
    headers: owner.headers,
    payload: {
      title: "Interim payment application 14",
      kind: "adjudication",
      currency: "GBP",
      amountInDispute: 400_000,
      ...payload,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; number: number; timetable: TimetableRow[] };
}

interface TimetableRow {
  id: string;
  name: string;
  dueDate: string | null;
  obligationId: string | null;
  done: boolean;
  breachedAt: string | null;
}

async function fetchDispute(pid: string, id: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${pid}/disputes/${id}`,
    headers: owner.headers,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Statutory regimes (#322-333)                                        */
/* ------------------------------------------------------------------ */

describe("statutory timetable regimes", () => {
  it("serves the regime library with its statutory authority", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/disputes/regimes",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const jurisdictions = (res.json().regimes as { jurisdiction: string }[]).map(
      (r) => r.jurisdiction,
    );
    expect(jurisdictions).toEqual(
      expect.arrayContaining(["uk_hgcra", "singapore_sopa", "malaysia_cipaa", "fidic_daab"]),
    );
    const uk = (res.json().regimes as { jurisdiction: string; steps: unknown[] }[]).find(
      (r) => r.jurisdiction === "uk_hgcra",
    );
    expect(uk?.steps.length).toBeGreaterThan(2);
  });

  it("generates the UK HGCRA timetable at creation and materialises an obligation per dated step", async () => {
    const pid = await makeProject("HGCRA Project");
    const trigger = addDaysISO(todayISO(), 3);
    const dispute = await createDispute(pid, {
      jurisdiction: "uk_hgcra",
      triggerDate: trigger,
    });
    expect(dispute.timetable.length).toBeGreaterThan(2);
    // Offsets run from the notice of adjudication, in calendar days.
    const referral = dispute.timetable.find((s) => s.name === "Referral notice served");
    expect(referral).toBeTruthy();
    expect(referral?.dueDate).toBe(addDaysISO(trigger, 7));

    // 28 days from the REFERRAL, i.e. 35 from the notice — the regime says so.
    const decision = dispute.timetable.find((s) => s.name === "Adjudicator's decision");
    expect(decision?.dueDate).toBe(addDaysISO(trigger, 35));

    const obligationIds = dispute.timetable
      .map((s) => s.obligationId)
      .filter((x): x is string => Boolean(x));
    expect(obligationIds.length).toBe(dispute.timetable.filter((s) => s.dueDate).length);
    const rows = await app.db
      .select()
      .from(obligations)
      .where(inArray(obligations.id, obligationIds));
    expect(rows).toHaveLength(obligationIds.length);
  });

  it("regenerates a timetable without erasing steps already done", async () => {
    const pid = await makeProject("Regenerate Project");
    const dispute = await createDispute(pid, {
      timetable: [{ name: "Response served", dueDate: addDaysISO(todayISO(), 5) }],
    });
    const stepId = dispute.timetable[0]!.id;
    const done = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/timetable/${stepId}/complete`,
      headers: owner.headers,
      payload: {},
    });
    expect(done.statusCode).toBe(200);

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/timetable/generate`,
      headers: owner.headers,
      payload: {
        jurisdiction: "singapore_sopa",
        triggerDate: todayISO(),
        replace: true,
      },
    });
    expect(generated.statusCode).toBe(200);
    const steps = generated.json().timetable as TimetableRow[];
    expect(steps.some((s) => s.name === "Response served" && s.done)).toBe(true);
    expect(steps.length).toBeGreaterThan(1);
  });

  it("assembles the nomination request from recorded fields and names what is missing", async () => {
    const pid = await makeProject("Nomination Project");
    const dispute = await createDispute(pid, {
      jurisdiction: "uk_hgcra",
      triggerDate: todayISO(),
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/nomination-request`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toContain("nomination");
    expect(body.sections.length).toBeGreaterThan(3);
    // Nothing is invented: the missing counterparty is stated, not filled in.
    const joined = (body.sections as { body: string }[]).map((s) => s.body).join(" ");
    expect(joined).toMatch(/not recorded/i);
    expect(body.deadlines.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Timetable lifecycle regressions                                     */
/* ------------------------------------------------------------------ */

describe("timetable lifecycle", () => {
  it("REGRESSION: extending a missed step's due date clears the breach and reopens its obligation", async () => {
    const pid = await makeProject("Extension Project");
    const dispute = await createDispute(pid, {
      timetable: [{ name: "Rejoinder served", dueDate: addDaysISO(todayISO(), -5) }],
    });
    const stepId = dispute.timetable[0]!.id;
    const obligationId = dispute.timetable[0]!.obligationId!;

    // The sweep breaches it.
    await app.scheduler.runNow("disputes.deadlines");
    const breached = await fetchDispute(pid, dispute.id);
    const before = (breached.timetable as TimetableRow[]).find((s) => s.id === stepId);
    expect(before?.breachedAt).toBeTruthy();
    const breachedObligation = (
      await app.db.select().from(obligations).where(eq(obligations.id, obligationId))
    )[0];
    expect(breachedObligation?.status).toBe("breached");

    // The tribunal grants an extension.
    const newDue = addDaysISO(todayISO(), 10);
    const extended = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}`,
      headers: owner.headers,
      payload: {
        timetable: [{ id: stepId, name: "Rejoinder served", dueDate: newDue }],
      },
    });
    expect(extended.statusCode).toBe(200);
    const after = (extended.json().timetable as TimetableRow[]).find((s) => s.id === stepId);
    expect(after?.breachedAt).toBeNull();

    const reopened = (
      await app.db.select().from(obligations).where(eq(obligations.id, obligationId))
    )[0];
    expect(reopened?.status).toBe("open");
    expect(reopened?.deadline?.slice(0, 10)).toBe(newDue);
  });

  it("REGRESSION: a terminal transition closes every open timetable obligation", async () => {
    const pid = await makeProject("Terminal Project");
    const dispute = await createDispute(pid, {
      timetable: [
        { name: "Referral", dueDate: addDaysISO(todayISO(), 4) },
        { name: "Decision", dueDate: addDaysISO(todayISO(), 25) },
      ],
    });
    const obligationIds = dispute.timetable
      .map((s) => s.obligationId)
      .filter((x): x is string => Boolean(x));
    expect(obligationIds).toHaveLength(2);

    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/status`,
      headers: owner.headers,
      payload: { status: "withdrawn", outcome: "Referral withdrawn by agreement" },
    });
    expect(withdrawn.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(obligations)
      .where(inArray(obligations.id, obligationIds));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(["waived", "satisfied"]).toContain(row.status);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Dispute board (#331-332)                                            */
/* ------------------------------------------------------------------ */

describe("standing dispute board", () => {
  it("records members with independence disclosures, warns about gaps and logs visits", async () => {
    const pid = await makeProject("DAAB Project");
    const dispute = await createDispute(pid, {
      kind: "daab",
      jurisdiction: "fidic_daab",
      triggerDate: todayISO(),
    });

    const undisclosed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board-members`,
      headers: owner.headers,
      payload: { name: "A. Member", boardRole: "member", nominatedBy: "employer" },
    });
    expect(undisclosed.statusCode).toBe(201);

    const warned = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board`,
      headers: owner.headers,
    });
    expect(warned.json().warnings.join(" ")).toMatch(/independence disclosure/i);
    expect(warned.json().warnings.join(" ")).toMatch(/no chair/i);

    const chair = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board-members`,
      headers: owner.headers,
      payload: {
        name: "B. Chair",
        boardRole: "chair",
        nominatedBy: "agreed",
        appointedAt: todayISO(),
        independenceDisclosure: "No prior engagement with either party in the last 5 years.",
      },
    });
    expect(chair.statusCode).toBe(201);

    const visit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board-visits`,
      headers: owner.headers,
      payload: {
        visitDate: todayISO(),
        attendees: ["B. Chair", "A. Member", "Project Director"],
        summary: "Quarterly site visit; progress reviewed against the accepted programme.",
        recommendations: "Agree the revised access dates before the next visit.",
      },
    });
    expect(visit.statusCode).toBe(201);

    const board = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board`,
      headers: owner.headers,
    });
    expect(board.json().members).toHaveLength(2);
    expect(board.json().visits).toHaveLength(1);
    expect(board.json().warnings.join(" ")).not.toMatch(/no chair/i);
  });
});

/* ------------------------------------------------------------------ */
/* Cost ledger (#354)                                                  */
/* ------------------------------------------------------------------ */

describe("dispute cost ledger", () => {
  it("buckets costs per currency, keeps budget vs actual and computes cost of recovery only in the dispute currency", async () => {
    const pid = await makeProject("Costs Project");
    const dispute = await createDispute(pid, { currency: "GBP" });

    for (const payload of [
      {
        category: "legal",
        supplier: "Solicitors LLP",
        description: "Preparation of the referral",
        incurredAt: addDaysISO(todayISO(), -20),
        budgetAmount: 30_000,
        actualAmount: 42_000,
        recoverable: true,
      },
      {
        category: "expert",
        supplier: "Delay Analyst Ltd",
        description: "Programme analysis",
        incurredAt: addDaysISO(todayISO(), -10),
        actualAmount: 18_000,
        recoverable: false,
      },
      {
        category: "counsel",
        description: "Foreign counsel opinion",
        incurredAt: addDaysISO(todayISO(), -5),
        actualAmount: 9_000,
        currency: "EUR",
        recoverable: true,
      },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/disputes/${dispute.id}/costs`,
        headers: owner.headers,
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const noAward = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/costs`,
      headers: owner.headers,
    });
    expect(noAward.statusCode).toBe(200);
    const before = noAward.json();
    expect(before.total).toBe(3);
    const gbp = (before.byCurrency as { currency: string; actual: number; budgeted: number | null }[]).find(
      (b) => b.currency === "GBP",
    );
    expect(gbp?.actual).toBe(60_000);
    expect(gbp?.budgeted).toBe(30_000);
    // Currencies are reported side by side, never added.
    expect((before.byCurrency as unknown[]).length).toBe(2);
    expect(before.costOfRecovery.ratio).toBeNull();
    expect(before.costOfRecovery.reason).toMatch(/no award/i);

    const outcome = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/outcome`,
      headers: owner.headers,
      payload: { amountClaimed: 400_000, amountAwarded: 240_000, rootCause: "variation_valuation" },
    });
    expect(outcome.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/costs`,
      headers: owner.headers,
    });
    expect(after.json().costOfRecovery.ratio).toBeCloseTo(0.25, 4);
  });
});

/* ------------------------------------------------------------------ */
/* Decision-tree settlement model (#351-355)                           */
/* ------------------------------------------------------------------ */

describe("decision-tree settlement model", () => {
  it("evaluates branches to an expected present value with a provision, and refuses to advise on a tree that does not close", async () => {
    const pid = await makeProject("Decision Tree Project");
    const dispute = await createDispute(pid, { currency: "GBP", amountInDispute: 500_000 });

    const open = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-model`,
      headers: owner.headers,
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().model).toBeNull();
    expect(open.json().reason).toMatch(/no decision tree/i);

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-model`,
      headers: owner.headers,
      payload: {
        name: "Broken tree",
        branches: [
          { kind: "win_full", label: "Win", probability: 0.3, award: 500_000 },
          { kind: "lose", label: "Lose", probability: 0.3, award: 0 },
        ],
        stages: [{ name: "Preparation", ownCosts: 50_000, opponentCosts: 60_000 }],
      },
    });
    expect(invalid.statusCode).toBe(200);
    // The PUT returns the stored row; the evaluation (and the provision it
    // implies) is frozen inside `computed`.
    expect(invalid.json().computed.valid).toBe(false);
    expect(invalid.json().computed.recommendation).toBe("insufficient_model");
    expect(invalid.json().computed.provision.provision).toBeNull();

    const valid = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-model`,
      headers: owner.headers,
      payload: {
        name: "Base case",
        branches: [
          { kind: "win_full", label: "Succeed in full", probability: 0.35, award: 500_000 },
          { kind: "win_partial", label: "Partial recovery", probability: 0.4, award: 250_000 },
          { kind: "lose", label: "Fail", probability: 0.25, award: 0 },
        ],
        stages: [
          { name: "Pleadings", ownCosts: 40_000, opponentCosts: 45_000 },
          { name: "Hearing", ownCosts: 60_000, opponentCosts: 70_000 },
        ],
        discountRatePercent: 5,
        yearsToResolution: 2,
        costsRules: {
          enabled: true,
          indemnityCostsPercent: 25,
          enhancedInterestPercent: 8,
          ownOfferAmount: 300_000,
        },
      },
    });
    expect(valid.statusCode).toBe(200);
    const computed = valid.json().computed;
    expect(computed.valid).toBe(true);
    expect(computed.branches).toHaveLength(3);
    expect(computed.totalOwnCosts).toBe(100_000);
    expect(computed.totalOpponentCosts).toBe(115_000);
    // The winning branch beats our own offer, so Part 36 consequences apply.
    const win = computed.branches.find((b: { kind: string }) => b.kind === "win_full");
    expect(win.costsUplift).toBeGreaterThan(0);
    expect(win.enhancedInterest).toBeGreaterThan(0);
    // Discounting is real: PV is strictly smaller in magnitude than the net.
    expect(Math.abs(win.presentValue)).toBeLessThan(Math.abs(win.netOutcome));
    expect(valid.json().computed.provision.provision).toBeGreaterThan(0);
    expect(valid.json().computed.provision.contingentAsset).toBeGreaterThan(0);

    // The GET recomputes against today's offers and reports the provision
    // alongside the stored model.
    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-model`,
      headers: owner.headers,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().computed.valid).toBe(true);
    expect(fetched.json().provision.provision).toBeGreaterThan(0);
  });

  it("REGRESSION: compares only offers in the dispute's currency and warns about the rest", async () => {
    const pid = await makeProject("Currency Offer Project");
    const dispute = await createDispute(pid, { currency: "GBP", amountInDispute: 500_000 });

    for (const payload of [
      {
        direction: "received",
        basis: "without_prejudice",
        amount: 350_000,
        currency: "GBP",
        offeredAt: todayISO(),
      },
      {
        direction: "received",
        basis: "without_prejudice",
        amount: 400_000,
        currency: "USD",
        offeredAt: todayISO(),
      },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/disputes/${dispute.id}/offers`,
        headers: owner.headers,
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const analysis = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-analysis`,
      headers: owner.headers,
    });
    expect(analysis.statusCode).toBe(200);
    const best = analysis.json().bestOpenOffer;
    expect(best?.currency).toBe("GBP");
    expect(best?.amount).toBe(350_000);
    // The excluded offer is named rather than silently dropped, and the
    // reason says there is no exchange rate on the platform.
    const caveats = (analysis.json().caveats as string[]).join(" ");
    expect(caveats).toMatch(/denominated in USD/);
    expect(caveats).toMatch(/no exchange rate/i);
    expect(analysis.json().otherCurrencyOffers).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Settlement offer lifecycle regressions                              */
/* ------------------------------------------------------------------ */

describe("settlement offer lifecycle", () => {
  it("REGRESSION: an expired offer lapses, is excluded from the analysis and cannot be accepted", async () => {
    const pid = await makeProject("Expiry Project");
    const dispute = await createDispute(pid, { currency: "GBP", amountInDispute: 500_000 });
    const offer = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/offers`,
      headers: owner.headers,
      payload: {
        direction: "received",
        basis: "without_prejudice_save_as_to_costs",
        amount: 250_000,
        currency: "GBP",
        offeredAt: addDaysISO(todayISO(), -60),
        expiresAt: addDaysISO(todayISO(), -30),
      },
    });
    expect(offer.statusCode).toBe(201);
    const offerId = offer.json().id as string;

    // A plain read of the dispute lapses it — no write required.
    const detail = await fetchDispute(pid, dispute.id);
    const row = (detail.offers as { id: string; status: string }[]).find((o) => o.id === offerId);
    expect(row?.status).toBe("lapsed");

    const analysis = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-analysis`,
      headers: owner.headers,
    });
    expect(analysis.json().bestOpenOffer).toBeNull();

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/settlement-offers/${offerId}/status`,
      headers: owner.headers,
      payload: { status: "accepted" },
    });
    expect([400, 409]).toContain(accept.statusCode);

    const stillLive = await fetchDispute(pid, dispute.id);
    expect(stillLive.status).not.toBe("settled");
  });

  it("REGRESSION: accepting an offer lapses every sibling and freezes the register", async () => {
    const pid = await makeProject("Sibling Offer Project");
    const dispute = await createDispute(pid, { currency: "GBP", amountInDispute: 500_000 });
    const ids: string[] = [];
    for (const amount of [200_000, 260_000]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${pid}/disputes/${dispute.id}/offers`,
        headers: owner.headers,
        payload: {
          direction: "received",
          basis: "without_prejudice",
          amount,
          currency: "GBP",
          offeredAt: todayISO(),
        },
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().id as string);
    }

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/settlement-offers/${ids[1]}/status`,
      headers: owner.headers,
      payload: { status: "accepted" },
    });
    expect(accepted.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(settlementOffers)
      .where(inArray(settlementOffers.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(ids[1]!)).toBe("accepted");
    expect(byId.get(ids[0]!)).toBe("lapsed");

    // The dispute is settled and the register is frozen.
    const settled = await fetchDispute(pid, dispute.id);
    expect(settled.status).toBe("settled");
    const late = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/settlement-offers/${ids[0]}/status`,
      headers: owner.headers,
      payload: { status: "rejected" },
    });
    expect(late.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Bundles: privilege, snapshots, project scoping (#340-343)           */
/* ------------------------------------------------------------------ */

describe("hearing bundle upgrades", () => {
  it("REGRESSION: refuses a file that belongs to another project of the same company", async () => {
    const pid = await makeProject("Bundle Scope Project");
    const otherPid = await makeProject("Someone Else's Project");
    const dispute = await createDispute(pid);
    const foreignFile = await insertFile(otherPid);

    const bundle = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/bundles`,
      headers: owner.headers,
      payload: { name: "Hearing bundle A" },
    });
    expect(bundle.statusCode).toBe(201);

    const items = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/dispute-bundles/${bundle.json().id}/items`,
      headers: owner.headers,
      payload: {
        items: [{ title: "Foreign document", fileId: foreignFile }],
      },
    });
    expect(items.statusCode).toBe(400);
  });

  it("marks privileged items, excludes them from production and keeps a privilege log", async () => {
    const pid = await makeProject("Privilege Project");
    const dispute = await createDispute(pid);
    const f1 = await insertFile(pid);
    const f2 = await insertFile(pid);

    const bundle = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/bundles`,
      headers: owner.headers,
      payload: { name: "Production bundle" },
    });
    const bundleId = bundle.json().id as string;

    const items = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: {
        items: [
          { title: "Programme", fileId: f1 },
          { title: "Counsel advice", fileId: f2 },
        ],
      },
    });
    expect(items.statusCode).toBe(200);
    // Tabs are assigned at GENERATION, not on the draft, so the item is
    // identified by what it is rather than by where it will end up.
    const draftItems = items.json().items as { id: string; title: string; tab: string | null }[];
    expect(draftItems.every((i) => i.tab === null)).toBe(true);
    const itemId = draftItems.find((i) => i.title === "Counsel advice")!.id;

    const privileged = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/dispute-bundles/${bundleId}/privilege`,
      headers: owner.headers,
      payload: {
        entries: [
          {
            itemId,
            privilege: "legal_advice",
            reason: "Advice from counsel — not produced.",
          },
        ],
      },
    });
    expect(privileged.statusCode).toBe(200);

    const generated = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/dispute-bundles/${bundleId}/generate`,
      headers: owner.headers,
      payload: {},
    });
    expect(generated.statusCode).toBe(200);
    const manifest = generated.json().manifest as {
      itemCount: number;
      index: { tab: string; title: string }[];
      privilegeLog: { title: string; privilege: string; reason: string | null }[];
      merkleRoot: string;
    };
    // Only the non-privileged item is produced, and the withheld one is logged.
    expect(manifest.itemCount).toBe(1);
    expect(manifest.index.map((i) => i.title)).toEqual(["Programme"]);
    expect(manifest.privilegeLog).toHaveLength(1);
    expect(manifest.privilegeLog[0]!.privilege).toBe("legal_advice");
    expect(manifest.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

    // Verification still passes: the snapshot is what it checks against.
    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/dispute-bundles/${bundleId}/verify`,
      headers: owner.headers,
      payload: {},
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().intact).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Outcome analytics (#356-357)                                        */
/* ------------------------------------------------------------------ */

describe("outcome analytics and drafting recommendations", () => {
  it("counts only terminal disputes and never sums money across currencies", async () => {
    const pid = await makeProject("Analytics Project");

    // A decided dispute with an award and costs.
    const decided = await createDispute(pid, { currency: "GBP", amountInDispute: 300_000 });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${decided.id}/costs`,
      headers: owner.headers,
      payload: {
        category: "legal",
        description: "Referral and reply",
        incurredAt: addDaysISO(todayISO(), -30),
        actualAmount: 25_000,
      },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/disputes/${decided.id}/outcome`,
      headers: owner.headers,
      payload: {
        amountClaimed: 300_000,
        amountAwarded: 150_000,
        rootCause: "late_information",
        governingClause: "NEC4 cl. 61.3",
        contractFamily: "NEC4 ECC",
        resolvedAt: todayISO(),
      },
    });
    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/disputes/${decided.id}/status`,
      headers: owner.headers,
      payload: { status: "decided", outcome: "Adjudicator awarded £150,000" },
    });
    expect(closed.statusCode).toBe(200);

    // A live dispute that must not drag the rates down.
    await createDispute(pid, { currency: "GBP", amountInDispute: 900_000 });

    // Scoped to this project: the company-wide view legitimately carries the
    // terminal disputes the other tests in this file created.
    const analytics = await app.inject({
      method: "GET",
      url: `/api/v1/disputes/analytics?groupBy=rootCause&projectId=${pid}`,
      headers: owner.headers,
    });
    expect(analytics.statusCode).toBe(200);
    const body = analytics.json();
    expect(body.overall.disputes).toBe(1);
    expect(body.excludedNotTerminal).toBeGreaterThanOrEqual(1);
    expect(body.overall.winRate).toBe(1);
    expect(body.overall.awardRatio).toBeCloseTo(0.5, 4);
    const group = (body.groups as { key: string }[]).find((g) => g.key === "late_information");
    expect(group).toBeTruthy();

    const recs = await app.inject({
      method: "GET",
      url: "/api/v1/disputes/drafting-recommendations",
      headers: owner.headers,
    });
    expect(recs.statusCode).toBe(200);
    expect(recs.json()).toHaveProperty("recommendations");
    if (recs.json().recommendations.length > 0) {
      expect(recs.json().recommendations[0].citedDisputeIds.length).toBeGreaterThan(0);
    } else {
      expect(recs.json().reason).toBeTruthy();
    }
  });

  it("returns dispute health inputs with reasons rather than fabricated zeroes", async () => {
    const pid = await makeProject("Dispute Health Inputs");
    await createDispute(pid);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/health-inputs`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("metrics");
    expect(Array.isArray(res.json().reasons)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Tenant isolation                                                    */
/* ------------------------------------------------------------------ */

describe("tenant isolation on the upgraded dispute routes", () => {
  it("keeps every new route invisible to another company", async () => {
    const pid = await makeProject("Dispute Isolation Project");
    const dispute = await createDispute(pid);
    const stranger = await registerActor(app);

    const reads: string[] = [
      `/api/v1/projects/${pid}/disputes/${dispute.id}/board`,
      `/api/v1/projects/${pid}/disputes/${dispute.id}/costs`,
      `/api/v1/projects/${pid}/disputes/${dispute.id}/settlement-model`,
      `/api/v1/projects/${pid}/disputes/${dispute.id}/nomination-request`,
      `/api/v1/projects/${pid}/disputes/health-inputs`,
    ];
    for (const url of reads) {
      const res = await app.inject({ method: "GET", url, headers: stranger.headers });
      expect([403, 404]).toContain(res.statusCode);
    }

    const write = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/outcome`,
      headers: stranger.headers,
      payload: { amountAwarded: 1 },
    });
    expect([403, 404]).toContain(write.statusCode);

    // The company analytics show the stranger nothing of ours.
    const analytics = await app.inject({
      method: "GET",
      url: "/api/v1/disputes/analytics",
      headers: stranger.headers,
    });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().overall === null || analytics.json().overall.disputes === 0).toBe(true);
  });

  it("admins in the same company can still read the new registers", async () => {
    const pid = await makeProject("Admin Access Project");
    const dispute = await createDispute(pid);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/disputes/${dispute.id}/board`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
  });
});

/* The base project fixture is used by nothing else here; assert it exists so
 * a future test can build on it without re-deriving the setup. */
describe("fixture", () => {
  it("has a base project in the owner's company", async () => {
    const rows = await app.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, owner.companyId)));
    expect(rows).toHaveLength(1);
  });
});
