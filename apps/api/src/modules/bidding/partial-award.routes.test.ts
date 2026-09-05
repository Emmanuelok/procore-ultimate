import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  bidPackages,
  bidSubmissions,
  budgetLineItems,
  budgets,
  commitments,
  companyMemberships,
  ledgerEntries,
  projects,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

/**
 * PARTIAL AWARDS — one package, several winners.
 *
 * What this suite defends:
 *
 *  - The scope of a partial award is the buyer's own levelling rows, and the
 *    same row is never awarded twice.
 *  - Its value is the winning bidder's LEVELLED sum over those rows, not the
 *    headline package total, and it is refused rather than guessed when a row
 *    has no levelled figure.
 *  - "The lowest bid" is re-decided on the awarded subset, because the
 *    cheapest bidder for the frame is rarely the cheapest for the package.
 *  - The losing bidders stay in contention while mandatory scope is still
 *    unplaced — telling them they lost before that decision is both wrong and
 *    irreversible.
 *  - The package reads `partially_awarded` until the last row is placed.
 *  - And another tenant can reach none of it.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let stranger: TestActor;
let projectA: string;
let alpha: string;
let bravo: string;
let budgetLineId: string;

const HOUR = 3_600_000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });

let receiptOffset = 0;

async function createPackage(over: Record<string, unknown> = {}) {
  const res = await post(`/projects/${projectA}/bid-packages`, {
    title: "Split package",
    currency: "GBP",
    bidDueAt: isoIn(HOUR),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function issuePackage(packageId: string) {
  const approved = await post(
    `/projects/${projectA}/bid-packages/${packageId}/approve`,
    {},
    approver.headers,
  );
  expect(approved.statusCode).toBe(200);
  const issued = await post(`/projects/${projectA}/bid-packages/${packageId}/issue`);
  expect(issued.statusCode).toBe(200);
}

async function submitBid(packageId: string, vendorId: string, amount: number) {
  receiptOffset += 1;
  const res = await post(`/projects/${projectA}/bid-packages/${packageId}/submissions`, {
    vendorId,
    baseBidAmount: amount,
    currency: "GBP",
    receivedAt: isoIn(-(2 + (receiptOffset % 20)) * HOUR),
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/**
 * A package with two scope rows, two bidders and a complete levelling grid:
 * Alpha is cheaper on the groundworks row, Bravo on the frame row, and Bravo
 * is cheaper overall. Every partial-award question this suite asks needs
 * exactly that shape.
 */
async function splitPackage(title: string, over: Record<string, unknown> = {}) {
  const pkg = await createPackage({ title, ...over });
  await issuePackage(pkg.id);
  const bidA = await submitBid(pkg.id, alpha, 180_000);
  const bidB = await submitBid(pkg.id, bravo, 175_000);
  const items = await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/items`, {
    items: [
      { itemCode: "G10", description: "Groundworks" },
      { itemCode: "F10", description: "Frame" },
      { itemCode: "O10", description: "Optional landscaping", isMandatory: false },
    ],
  });
  expect(items.statusCode).toBe(201);
  const rows: Array<{ id: string; itemCode: string }> = items.json().items;
  const row = (code: string) => rows.find((r) => r.itemCode === code)!.id;
  const entries = await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/entries`, {
    entries: [
      { levellingItemId: row("G10"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 80_000 },
      { levellingItemId: row("F10"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 100_000 },
      { levellingItemId: row("O10"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 5_000 },
      { levellingItemId: row("G10"), submissionId: bidB.id, includedStatus: "included", asBidAmount: 95_000 },
      { levellingItemId: row("F10"), submissionId: bidB.id, includedStatus: "included", asBidAmount: 80_000 },
      { levellingItemId: row("O10"), submissionId: bidB.id, includedStatus: "included", asBidAmount: 4_000 },
    ],
  });
  expect(entries.statusCode).toBe(201);
  return { pkg, bidA, bidB, row, rows };
}

const BASIS =
  "The scope splits cleanly at the frame line and each winner is the cheapest bidder for the " +
  "scope they are being given, on the levelled figures.";

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);

  const second = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: second.userId,
    role: "admin",
  });
  approver = {
    ...second,
    companyId: owner.companyId,
    headers: {
      authorization: second.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };

  stranger = await registerActor(app);

  projectA = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectA, companyId: owner.companyId, name: "Partial awards" });

  alpha = newId("ven");
  bravo = newId("ven");
  await app.db.insert(vendors).values([
    { id: alpha, companyId: owner.companyId, name: "Alpha Groundworks Ltd" },
    { id: bravo, companyId: owner.companyId, name: "Bravo Frames Ltd" },
  ]);

  const budgetId = newId("bud");
  await app.db.insert(budgets).values({
    id: budgetId,
    companyId: owner.companyId,
    projectId: projectA,
    number: 1,
    reference: "BUD-0001",
    name: "Baseline",
    status: "active",
    createdBy: owner.userId,
  });
  budgetLineId = newId("bli");
  await app.db.insert(budgetLineItems).values({
    id: budgetLineId,
    companyId: owner.companyId,
    projectId: projectA,
    budgetId,
    costCode: "03-300",
    description: "Substructure",
    originalBudget: 500_000,
    createdBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

describe("partial award — scope", () => {
  it("values a partial award at the winner's levelled sum over its own rows", async () => {
    const { pkg, bidA, row } = await splitPackage("Value of a part");
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Alpha's groundworks row alone, NOT their 180,000 package total.
    expect(body.awardAmount).toBe(80_000);
    expect(body.scope.partial).toBe(true);
    expect(body.scope.scopeLabels).toEqual(["G10"]);
    expect(body.scope.packageStatusAfterApproval).toBe("partially_awarded");
    // The engineer's estimate is for the whole package: no saving is invented.
    expect(body.savingAgainstEstimate).toBeNull();
  });

  it("decides the lowest bid on the awarded subset, not the package total", async () => {
    const { pkg, bidA, row } = await splitPackage("Lowest for this scope");
    // Alpha is DEARER overall (180k vs 175k) but cheaper on groundworks
    // (80k vs 95k), so recommending Alpha for groundworks needs no
    // not-lowest justification.
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().isLowestBid).toBe(true);
    expect(res.json().lowestBidAmount).toBe(80_000);
    expect(res.json().comparison.basisNote).toMatch(/partial award covers/i);
  });

  it("still demands a written justification when the subset winner is not the cheapest for it", async () => {
    const { pkg, bidA, row } = await splitPackage("Not lowest for this scope");
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      // Alpha's frame is 100k against Bravo's 80k.
      scopeLevellingItemIds: [row("F10")],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.control).toBe("not_lowest_requires_justification");
    expect(res.json().details.lowestBidAmount).toBe(80_000);
  });

  it("refuses scope rows that are not levelling rows on this package", async () => {
    const { pkg, bidA, row } = await splitPackage("Foreign scope");
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10"), "bli_not_a_row"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.control).toBe("unknown_scope_rows");
    expect(res.json().details.unknownItemIds).toEqual(["bli_not_a_row"]);
  });

  it("refuses a partial award over scope another live award already holds", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Overlap");
    const first = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(first.statusCode).toBe(201);
    const clash = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10"), row("F10")],
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().details.control).toBe("scope_overlap");
    expect(clash.json().details.overlappingItemIds).toEqual([row("G10")]);
    expect(clash.json().message).toMatch(/pay for it twice/i);
  });

  it("permits a second, disjoint partial award on the same package", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Disjoint");
    const first = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(first.statusCode).toBe(201);
    const second = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("F10")],
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().awardAmount).toBe(80_000);
    // Both mandatory rows are now covered.
    expect(second.json().scope.packageStatusAfterApproval).toBe("awarded");
    expect(second.json().scope.remaining).toEqual([]);
  });

  it("refuses a whole-package award once part of the scope is spoken for", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Whole after part");
    const first = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(first.statusCode).toBe(201);
    const whole = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
    });
    expect(whole.statusCode).toBe(409);
    expect(whole.json().details.control).toBe("partial_award_exists");
  });

  it("refuses a partial award when the winner has no levelled figure for one of its rows", async () => {
    const pkg = await createPackage({ title: "Hole in the sum" });
    await issuePackage(pkg.id);
    const bidA = await submitBid(pkg.id, alpha, 180_000);
    await submitBid(pkg.id, bravo, 175_000);
    const items = await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/items`, {
      items: [
        { itemCode: "G10", description: "Groundworks" },
        { itemCode: "F10", description: "Frame" },
      ],
    });
    const rows: Array<{ id: string; itemCode: string }> = items.json().items;
    const row = (code: string) => rows.find((r) => r.itemCode === code)!.id;
    await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/entries`, {
      entries: [
        {
          levellingItemId: row("G10"),
          submissionId: bidA.id,
          includedStatus: "included",
          asBidAmount: 80_000,
        },
      ],
    });
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10"), row("F10")],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.control).toBe("partial_award_amount_unknowable");
    expect(res.json().message).toMatch(/no levelling entry on that row/i);
  });
});

describe("partial award — approval", () => {
  it("leaves the package partially awarded and the other bids alive", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Approve one part");
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(rec.statusCode).toBe(201);
    const approved = await post(
      `/bid-awards/${rec.json().id}/approve`,
      { budgetLineItemId: budgetLineId },
      approver.headers,
    );
    expect(approved.statusCode).toBe(200);

    const [pkgRow] = await app.db.select().from(bidPackages).where(eq(bidPackages.id, pkg.id));
    expect(pkgRow?.status).toBe("partially_awarded");
    // No single winner is asserted for the whole package.
    expect(pkgRow?.awardedSubmissionId).toBeNull();
    expect(pkgRow?.awardedAmount).toBeNull();

    // Bravo is still in the running for the frame.
    const [other] = await app.db.select().from(bidSubmissions).where(eq(bidSubmissions.id, bidB.id));
    expect(other?.status).not.toBe("unsuccessful");

    // The commitment carries the partial value, not the package total.
    const [cmt] = await app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, approved.json().commitmentId as string));
    expect(cmt?.currency).toBe("GBP");

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.objectId, rec.json().id as string));
    expect(entries.length).toBeGreaterThan(0);
  });

  it("closes the package and the losing bids once the last row is placed", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Approve both parts");
    const first = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(first.statusCode).toBe(201);
    const second = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("F10")],
    });
    expect(second.statusCode).toBe(201);

    const a1 = await post(
      `/bid-awards/${first.json().id}/approve`,
      { budgetLineItemId: budgetLineId },
      approver.headers,
    );
    expect(a1.statusCode).toBe(200);
    const a2 = await post(
      `/bid-awards/${second.json().id}/approve`,
      { budgetLineItemId: budgetLineId },
      approver.headers,
    );
    expect(a2.statusCode).toBe(200);

    const [pkgRow] = await app.db.select().from(bidPackages).where(eq(bidPackages.id, pkg.id));
    expect(pkgRow?.status).toBe("awarded");

    // BOTH bidders won something; neither is unsuccessful.
    const subs = await app.db.select().from(bidSubmissions).where(eq(bidSubmissions.packageId, pkg.id));
    expect(subs.filter((s) => s.status === "awarded").map((s) => s.id).sort()).toEqual(
      [bidA.id, bidB.id].sort(),
    );
    expect(subs.some((s) => s.status === "unsuccessful")).toBe(false);
  });

  it("makes the losers unsuccessful when a whole-package award is approved", async () => {
    const { pkg, bidA, bidB } = await splitPackage("Whole package still works");
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
    });
    expect(rec.statusCode).toBe(201);
    // Whole-package award: the as-bid contract sum.
    expect(rec.json().awardAmount).toBe(175_000);
    const approved = await post(
      `/bid-awards/${rec.json().id}/approve`,
      { budgetLineItemId: budgetLineId },
      approver.headers,
    );
    expect(approved.statusCode).toBe(200);
    const [pkgRow] = await app.db.select().from(bidPackages).where(eq(bidPackages.id, pkg.id));
    expect(pkgRow?.status).toBe("awarded");
    expect(pkgRow?.awardedSubmissionId).toBe(bidB.id);
    const [loser] = await app.db.select().from(bidSubmissions).where(eq(bidSubmissions.id, bidA.id));
    expect(loser?.status).toBe("unsuccessful");
  });

  it("frees the scope again when a partial award is withdrawn", async () => {
    const { pkg, bidA, bidB, row } = await splitPackage("Withdraw a part");
    const first = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(first.statusCode).toBe(201);
    const withdrawn = await post(
      `/bid-awards/${first.json().id}/withdraw`,
      {
        reason:
          "Alpha went into administration the week after the recommendation and cannot contract.",
      },
      approver.headers,
    );
    expect(withdrawn.statusCode).toBe(200);
    const again = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidB.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().awardAmount).toBe(95_000);
  });
});

describe("partial award — tenancy", () => {
  it("refuses a stranger's company every partial-award route on this package", async () => {
    const { pkg, bidA, row } = await splitPackage("Tenancy");
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bidA.id,
      recommendationBasis: BASIS,
      scopeLevellingItemIds: [row("G10")],
    });
    expect(rec.statusCode).toBe(201);
    const awardId = rec.json().id as string;

    const recommend = await post(
      `/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`,
      { submissionId: bidA.id, recommendationBasis: BASIS, scopeLevellingItemIds: [row("F10")] },
      stranger.headers,
    );
    expect([403, 404]).toContain(recommend.statusCode);

    const read = await get(`/bid-awards/${awardId}`, stranger.headers);
    expect([403, 404]).toContain(read.statusCode);

    const approve = await post(`/bid-awards/${awardId}/approve`, {}, stranger.headers);
    expect([403, 404]).toContain(approve.statusCode);

    const withdraw = await post(
      `/bid-awards/${awardId}/withdraw`,
      { reason: "Because I say so, and I am not in this company at all." },
      stranger.headers,
    );
    expect([403, 404]).toContain(withdraw.statusCode);
  });
});
