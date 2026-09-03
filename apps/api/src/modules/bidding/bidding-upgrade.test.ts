import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  bidBonds,
  bidInvitations,
  bidPackages,
  bidSubmissions,
  budgetLineItems,
  budgets,
  commitments,
  companyMemberships,
  ledgerEntries,
  obligations,
  prequalificationSubmissions,
  projectMemberships,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

/**
 * THE PLATFORM UPGRADE WAVE FOR BIDDING.
 *
 * Two halves:
 *
 *  REGRESSIONS — one test per audit finding, each named after the failure it
 *    prevents rather than after the code path it exercises. A bug fixed
 *    without a test is a bug waiting for the next refactor.
 *
 *  NEW CAPABILITY — the integrity detectors on real records, the opportunity
 *    pipeline and its bid/no-bid gate, tender queries, meetings, bonds, the
 *    bid board, the analytics, delegated authority and the scheduled sweeps.
 *
 * Every route also gets a cross-tenant negative: a second company must not be
 * able to read or mutate anything here.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let stranger: TestActor;
let viewerHeaders: Record<string, string>;

let projectA: string;
let projectB: string;
let alpha: string;
let bravo: string;
let charlie: string;
let delta: string;

const HOUR = 3_600_000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const dateIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const patch = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const put = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
const del = (url: string, headers = owner.headers) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

async function makeProject(name: string): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name });
  return id;
}

async function makeVendor(name: string): Promise<string> {
  const id = newId("ven");
  await app.db.insert(vendors).values({ id, companyId: owner.companyId, name });
  return id;
}

/**
 * No pre-tender estimate by default. An estimate turns every bid into a
 * measurable deviation, and a fixture that quietly makes every default bid
 * "abnormally low" tests the abnormality control instead of whatever the test
 * is actually about. Tests that need an estimate state one.
 */
async function createPackage(projectId: string, over: Record<string, unknown> = {}) {
  const res = await post(`/projects/${projectId}/bid-packages`, {
    title: "Groundworks",
    currency: "GBP",
    bidDueAt: isoIn(HOUR),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function issuePackage(projectId: string, packageId: string) {
  const approved = await post(
    `/projects/${projectId}/bid-packages/${packageId}/approve`,
    {},
    approver.headers,
  );
  expect(approved.statusCode).toBe(200);
  const issued = await post(`/projects/${projectId}/bid-packages/${packageId}/issue`);
  expect(issued.statusCode).toBe(200);
  return issued.json();
}

/**
 * Bids arrive when they arrive. The default receipt time is staggered by
 * hours across calls, because bids from different companies landing at the
 * same instant is itself a finding — one the clustering detector is supposed
 * to raise, and one a test fixture should not manufacture by accident.
 */
let receiptOffset = 0;

async function submitBid(
  projectId: string,
  packageId: string,
  vendorId: string,
  over: Record<string, unknown> = {},
) {
  receiptOffset += 1;
  const res = await post(`/projects/${projectId}/bid-packages/${packageId}/submissions`, {
    vendorId,
    baseBidAmount: 190_000,
    currency: "GBP",
    receivedAt: isoIn(-(2 + (receiptOffset % 24)) * HOUR),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

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

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: viewer.userId,
    role: "member",
  });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  projectA = await makeProject("Upgrade — tenders");
  projectB = await makeProject("Upgrade — integrity");
  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  alpha = await makeVendor("Alpha Groundworks Ltd");
  bravo = await makeVendor("Bravo Civils Ltd");
  charlie = await makeVendor("Charlie Piling Ltd");
  delta = await makeVendor("Delta Excavation Ltd");
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* REGRESSIONS — the sealed-bid control                                */
/* ================================================================== */

describe("regression: a sealed price never leaves the building", () => {
  it("does not leak the base bid through detail.totalsNotes", async () => {
    const pkg = await createPackage(projectA, {
      title: "Sealed leak",
      isSealed: true,
      bidDueAt: isoIn(6 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    // Priced lines with NO headline figure: the old code derived the base bid
    // and wrote it into a note, which redaction could not see.
    const bid = await submitBid(projectA, pkg.id, alpha, {
      baseBidAmount: null,
      lines: [
        { description: "Excavate", quantity: 100, unitRate: 800, amount: 80_000 },
        { description: "Concrete", quantity: 200, unitRate: 442, amount: 88_400 },
      ],
    });
    const secret = 168_400;
    // The row really does hold the amount…
    const [row] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, bid.id));
    expect(row!.baseBidAmount).toBe(secret);

    // …and no read path returns it while the seal is on.
    for (const url of [
      `/projects/${projectA}/bid-packages/${pkg.id}`,
      `/projects/${projectA}/bid-packages/${pkg.id}/submissions`,
      `/bid-submissions/${bid.id}`,
      `/bid-submissions/${bid.id}/lines`,
      `/projects/${projectA}/bid-packages/${pkg.id}/tabulation`,
    ]) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(String(secret));
      expect(res.body).not.toContain("168400");
      expect(res.body).not.toContain("80000");
    }
  });

  it("withholds the whole detail bag by allowlist, not by blacklist", async () => {
    const pkg = await createPackage(projectA, {
      title: "Sealed detail bag",
      isSealed: true,
      bidDueAt: isoIn(6 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    const bid = await submitBid(projectA, pkg.id, bravo, {
      baseBidAmount: 123_456,
      detail: { ourSecretMargin: 123_456, salesNote: "we are at 123456" },
    });
    const res = await get(`/bid-submissions/${bid.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("123456");
    const body = res.json();
    expect(body.detail.sealed).toBe(true);
    // The KEYS come back so a client can say what is withheld…
    expect(body.detail.withheldDetailKeys).toContain("ourSecretMargin");
    // …and the values do not.
    expect(JSON.stringify(body.detail)).not.toContain("123456");
    expect(body.withheldFields).toContain("detail");
  });

  it("summarises the bidder's own free text rather than showing it", async () => {
    const pkg = await createPackage(projectA, {
      title: "Sealed qualifications",
      isSealed: true,
      bidDueAt: isoIn(6 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    const bid = await submitBid(projectA, pkg.id, charlie, {
      baseBidAmount: 654_321,
      qualifications: "Our figure of 654321 excludes all temporary works.",
    });
    const res = await get(`/bid-submissions/${bid.id}`);
    expect(res.body).not.toContain("654321");
    expect(res.json().qualifications).toMatch(/withheld while sealed/);
  });
});

/* ================================================================== */
/* REGRESSIONS — tenancy, submissions, packages                        */
/* ================================================================== */

describe("regression: a submission cannot reach across the tenancy", () => {
  it("refuses an invitationId that belongs to another company", async () => {
    // The stranger's own project, package and invitation.
    const otherProject = newId("prj");
    await app.db.insert(projects).values({
      id: otherProject,
      companyId: stranger.companyId,
      name: "Stranger project",
    });
    const otherVendor = newId("ven");
    await app.db.insert(vendors).values({
      id: otherVendor,
      companyId: stranger.companyId,
      name: "Stranger Vendor",
    });
    const otherPkg = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProject}/bid-packages`,
      headers: stranger.headers,
      payload: { title: "Stranger package", bidDueAt: isoIn(HOUR) },
    });
    expect(otherPkg.statusCode).toBe(201);
    const otherApprover = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: stranger.companyId,
      userId: otherApprover.userId,
      role: "admin",
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProject}/bid-packages/${otherPkg.json().id}/approve`,
      headers: {
        authorization: otherApprover.headers["authorization"]!,
        "x-company-id": stranger.companyId,
      },
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProject}/bid-packages/${otherPkg.json().id}/issue`,
      headers: stranger.headers,
      payload: {},
    });
    const otherInvite = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProject}/bid-packages/${otherPkg.json().id}/invitations`,
      headers: stranger.headers,
      payload: { vendorId: otherVendor },
    });
    expect(otherInvite.statusCode).toBe(201);
    const victimInvitationId = otherInvite.json().items[0].id;

    const pkg = await createPackage(projectA, { title: "Cross tenant invitation" });
    await issuePackage(projectA, pkg.id);
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100,
      invitationId: victimInvitationId,
    });
    expect(res.statusCode).toBe(404);
    const [victim] = await app.db
      .select()
      .from(bidInvitations)
      .where(eq(bidInvitations.id, victimInvitationId));
    expect(victim!.status).toBe("draft");
    expect(victim!.submissionId).toBeNull();
  });

  it("refuses an invitation that belongs to another package or another vendor", async () => {
    const one = await createPackage(projectA, { title: "Invitation scope A" });
    await issuePackage(projectA, one.id);
    const two = await createPackage(projectA, { title: "Invitation scope B" });
    await issuePackage(projectA, two.id);
    const invite = await post(`/projects/${projectA}/bid-packages/${one.id}/invitations`, {
      vendorId: alpha,
    });
    const invitationId = invite.json().items[0].id;

    const wrongPackage = await post(
      `/projects/${projectA}/bid-packages/${two.id}/submissions`,
      { vendorId: alpha, baseBidAmount: 100, invitationId },
    );
    expect(wrongPackage.statusCode).toBe(400);
    expect(wrongPackage.json().message).toMatch(/different bid package/i);

    const wrongVendor = await post(
      `/projects/${projectA}/bid-packages/${one.id}/submissions`,
      { vendorId: bravo, baseBidAmount: 100, invitationId },
    );
    expect(wrongVendor.statusCode).toBe(400);
    expect(wrongVendor.json().message).toMatch(/different vendor/i);
  });
});

describe("regression: the seal cannot be switched off after the bids are in", () => {
  it("refuses a bid on a package that was never issued", async () => {
    const pkg = await createPackage(projectA, {
      title: "Draft takes no bids",
      isSealed: true,
      bidDueAt: isoIn(6 * HOUR),
    });
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/has not been issued to bidders/i);
  });

  it("freezes the evaluation basis as soon as a bid exists", async () => {
    const pkg = await createPackage(projectA, {
      title: "Basis frozen by bids",
      isSealed: true,
      bidDueAt: isoIn(6 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 111_111 });
    const res = await patch(`/projects/${projectA}/bid-packages/${pkg.id}`, { isSealed: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/frozen/i);
    const detail = await get(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(detail.body).not.toContain("111111");
  });

  it("refuses to shorten or clear the bid deadline after issue", async () => {
    const pkg = await createPackage(projectA, { title: "Deadline immovable" });
    await issuePackage(projectA, pkg.id);
    const earlier = await patch(`/projects/${projectA}/bid-packages/${pkg.id}`, {
      bidDueAt: isoIn(-HOUR),
    });
    expect(earlier.statusCode).toBe(400);
    expect(earlier.json().message).toMatch(/extended but never shortened/i);

    const cleared = await patch(`/projects/${projectA}/bid-packages/${pkg.id}`, {
      bidDueAt: null,
    });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().message).toMatch(/cannot be cleared/i);

    const later = await patch(`/projects/${projectA}/bid-packages/${pkg.id}`, {
      bidDueAt: isoIn(72 * HOUR),
    });
    expect(later.statusCode).toBe(200);
  });
});

describe("regression: package deletion cannot orphan its children", () => {
  it("refuses to delete a draft package that carries scope rows", async () => {
    const pkg = await createPackage(projectA, { title: "Deletion guard" });
    const items = await post(
      `/projects/${projectA}/bid-packages/${pkg.id}/levelling/items`,
      { description: "Reduced dig", itemCode: "A1" },
    );
    expect(items.statusCode).toBe(201);
    const res = await del(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/levelling scope row/i);
  });

  it("deletes a genuinely empty draft package", async () => {
    const pkg = await createPackage(projectA, { title: "Empty draft" });
    const res = await del(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(res.statusCode).toBe(204);
  });
});

describe("regression: a bid's receipt time is bounded", () => {
  it("refuses a receipt in the future", async () => {
    const pkg = await createPackage(projectA, { title: "Future receipt" });
    await issuePackage(projectA, pkg.id);
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100,
      receivedAt: isoIn(48 * HOUR),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/in the future/i);
  });

  it("requires a reason to backdate a receipt by more than a week", async () => {
    const pkg = await createPackage(projectA, {
      title: "Backdated receipt",
      bidDueAt: isoIn(HOUR),
    });
    await issuePackage(projectA, pkg.id);
    const refused = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100,
      receivedAt: isoIn(-30 * 24 * HOUR),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.control).toBe("backdated_receipt");

    const accepted = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100,
      receivedAt: isoIn(-30 * 24 * HOUR),
      backdateReason: "Envelope logged at reception on the day and entered on our return.",
    });
    expect(accepted.statusCode).toBe(201);
    // The server's own clock is on the record next to the stated one.
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, accepted.json().id),
        ),
      );
    const payload = entries[0]!.payload as Record<string, unknown>;
    expect(payload["serverReceiptAt"]).toBeTruthy();
    expect(payload["backdateReason"]).toMatch(/reception/);
  });
});

describe("regression: a revision supersedes its predecessor", () => {
  it("withdraws the earlier revision and keeps it on the record", async () => {
    const pkg = await createPackage(projectA, { title: "Revisions" });
    await issuePackage(projectA, pkg.id);
    const r0 = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 210_000 });
    const r1 = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 195_000 });
    expect(r1.superseded).toEqual([r0.id]);

    const [prior] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, r0.id));
    expect(prior!.status).toBe("withdrawn");
    expect(prior!.supersededById).toBe(r1.id);
    expect(prior!.baseBidAmount).toBe(210_000); // kept, not deleted

    // Only the live revision drives the market tiles.
    const detail = await get(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(detail.json().market.lowest.value).toBe(195_000);
  });
});

describe("regression: a clarification cannot resurrect a dead bid", () => {
  it("refuses to clarify a withdrawn bid", async () => {
    const pkg = await createPackage(projectA, { title: "Clarify the dead" });
    await issuePackage(projectA, pkg.id);
    const bid = await submitBid(projectA, pkg.id, bravo, { baseBidAmount: 150_000 });
    const withdrawn = await post(`/bid-submissions/${bid.id}/withdraw`, {
      reason: "Bidder withdrew before the deadline",
    });
    expect(withdrawn.statusCode).toBe(200);
    const res = await post(`/bid-submissions/${bid.id}/clarification`, {
      response: "We confirm our price",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/cannot be clarified/i);
    const [row] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, bid.id));
    expect(row!.status).toBe("withdrawn");
  });
});

describe("regression: an unaccepted late bid is not in the market", () => {
  it("keeps a late, unaccepted bid out of the lowest and the estimate comparison", async () => {
    const pkg = await createPackage(projectA, {
      title: "Late excluded from tiles",
      bidDueAt: isoIn(-4 * HOUR),
      engineersEstimate: 200_000,
    });
    await issuePackage(projectA, pkg.id);
    await submitBid(projectA, pkg.id, alpha, {
      baseBidAmount: 200_000,
      receivedAt: isoIn(-5 * HOUR),
    });
    const late = await submitBid(projectA, pkg.id, bravo, {
      baseBidAmount: 90_000,
      receivedAt: isoIn(-HOUR),
    });
    expect(late.isLate).toBe(1);
    const detail = await get(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(detail.json().market.lowest.value).toBe(200_000);

    const accepted = await post(`/bid-submissions/${late.id}/accept-late`, {
      reason: "Courier held at the site gate for eleven minutes; CCTV timestamp confirms.",
    });
    expect(accepted.statusCode).toBe(200);
    const after = await get(`/projects/${projectA}/bid-packages/${pkg.id}`);
    expect(after.json().market.lowest.value).toBe(90_000);
  });
});

/* ================================================================== */
/* REGRESSIONS — scoring, levelling, close                             */
/* ================================================================== */

describe("regression: a score cannot exceed its own maximum", () => {
  it("refuses a score above the default maximum when none was supplied", async () => {
    const pkg = await createPackage(projectA, {
      title: "Score bounds",
      priceWeight: 60,
      qualityWeight: 40,
      evaluationCriteria: [{ key: "method", label: "Method", weight: 100, kind: "quality" }],
    });
    await issuePackage(projectA, pkg.id);
    const bid = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 100_000 });
    const res = await post(`/bid-submissions/${bid.id}/scores`, {
      scores: [{ key: "method", score: 150 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/exceeds its maximum of 100/i);

    const ok = await post(`/bid-submissions/${bid.id}/scores`, {
      scores: [{ key: "method", score: 80 }],
    });
    expect(ok.statusCode).toBe(200);
    const scoring = await get(`/projects/${projectA}/bid-packages/${pkg.id}/scoring`);
    const row = scoring.json().rows.find((r: { submissionId: string }) => r.submissionId === bid.id);
    expect(row.technicalScore.value).toBe(80);
  });
});

describe("regression: levelling is frozen by an award and close does not regress", () => {
  let pkgId: string;
  let awardId: string;

  it("refuses to re-complete the levelling once an award is live", async () => {
    const pkg = await createPackage(projectA, { title: "Levelling frozen", engineersEstimate: 100_000 });
    pkgId = pkg.id;
    await issuePackage(projectA, pkgId);
    const a = await submitBid(projectA, pkgId, alpha, { baseBidAmount: 100_000 });
    const b = await submitBid(projectA, pkgId, bravo, { baseBidAmount: 120_000 });
    const items = await post(`/projects/${projectA}/bid-packages/${pkgId}/levelling/items`, {
      items: [{ description: "All works", itemCode: "A", isMandatory: true }],
    });
    const itemId = items.json().items[0].id;
    await post(`/projects/${projectA}/bid-packages/${pkgId}/levelling/entries`, {
      entries: [
        { levellingItemId: itemId, submissionId: a.id, includedStatus: "included", asBidAmount: 100_000, adjustmentAmount: 0 },
        { levellingItemId: itemId, submissionId: b.id, includedStatus: "included", asBidAmount: 120_000, adjustmentAmount: 0 },
      ],
    });
    const complete = await post(
      `/projects/${projectA}/bid-packages/${pkgId}/levelling/complete`,
    );
    expect(complete.statusCode).toBe(200);

    const rec = await post(`/projects/${projectA}/bid-packages/${pkgId}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis:
        "Lowest levelled amount with a compliant programme and no qualifications of substance.",
    });
    expect(rec.statusCode).toBe(201);
    awardId = rec.json().id;

    const again = await post(`/projects/${projectA}/bid-packages/${pkgId}/levelling/complete`);
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/levelled amounts are what that award was measured against/i);
  });

  it("keeps levelledAt after the package moves to under_evaluation", async () => {
    const grid = await get(`/projects/${projectA}/bid-packages/${pkgId}/levelling/grid`);
    expect(grid.json().package.levelledAt).toBeTruthy();
  });

  it("refuses to close a package that is already under evaluation", async () => {
    const res = await post(`/projects/${projectA}/bid-packages/${pkgId}/close`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/cannot be closed to bids/i);
    expect(awardId).toBeTruthy();
  });
});

/* ================================================================== */
/* REGRESSIONS — the award                                             */
/* ================================================================== */

let budgetCounter = 0;

describe("regression: award approval is atomic and validated", () => {
  async function budgetLineOn(projectId: string): Promise<string> {
    const budgetId = newId("bdg");
    budgetCounter += 1;
    await app.db.insert(budgets).values({
      id: budgetId,
      companyId: owner.companyId,
      projectId,
      number: budgetCounter,
      reference: `BUD-${String(budgetCounter).padStart(4, "0")}`,
      name: "Primary",
      status: "active",
      createdBy: owner.userId,
    });
    const lineId = newId("bli");
    await app.db.insert(budgetLineItems).values({
      id: lineId,
      budgetId,
      companyId: owner.companyId,
      projectId,
      costCode: "03-300",
      description: "Groundworks",
      originalBudget: 500_000,
      createdBy: owner.userId,
    });
    return lineId;
  }

  it("refuses a budget line that is not on the project, at entry", async () => {
    const res = await post(`/projects/${projectA}/bid-packages`, {
      title: "Bad budget line",
      bidDueAt: isoIn(HOUR),
      budgetLineItemIds: ["bli_does_not_exist"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not budget lines on this project/i);
  });

  it("creates exactly one commitment, and a concurrent second approval is refused", async () => {
    const lineId = await budgetLineOn(projectA);
    const pkg = await createPackage(projectA, {
      title: "Atomic approval",
      budgetLineItemIds: [lineId],
    });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 150_000 });
    await submitBid(projectA, pkg.id, bravo, { baseBidAmount: 175_000 });
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis: "Lowest compliant bid on an unlevelled package with no exclusions.",
    });
    expect(rec.statusCode).toBe(201);
    const awardId = rec.json().id;

    const [first, second] = await Promise.all([
      post(`/bid-awards/${awardId}/approve`, {}, approver.headers),
      post(`/bid-awards/${awardId}/approve`, {}, approver.headers),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(409);

    const rows = await app.db
      .select()
      .from(commitments)
      .where(
        and(eq(commitments.companyId, owner.companyId), eq(commitments.projectId, projectA)),
      );
    const fromThisAward = rows.filter(
      (c) => (c.detail as Record<string, unknown>)["sourceBidAwardId"] === awardId,
    );
    expect(fromThisAward).toHaveLength(1);
  });

  it("leaves no commitment behind when the approval cannot complete", async () => {
    const pkg = await createPackage(projectA, { title: "Rollback on failure" });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, charlie, { baseBidAmount: 90_000 });
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis: "Only bid received; the market was tested and did not respond.",
    });
    const awardId = rec.json().id;
    const before = await app.db.select().from(commitments);
    // A budget line that belongs to a different project is refused BEFORE
    // anything is written, which is the whole point.
    const otherLine = await budgetLineOn(projectB);
    const res = await post(
      `/bid-awards/${awardId}/approve`,
      { budgetLineItemId: otherLine },
      approver.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().details.control).toBe("budget_line_not_on_project");
    const after = await app.db.select().from(commitments);
    expect(after.length).toBe(before.length);
  });

  it("records the comparable amount and the as-bid sum as different numbers", async () => {
    const pkg = await createPackage(projectA, { title: "Audit block", engineersEstimate: 205_000 });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 200_000 });
    const b = await submitBid(projectA, pkg.id, bravo, { baseBidAmount: 190_000 });
    const items = await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/items`, {
      items: [{ description: "All works", itemCode: "A", isMandatory: true }],
    });
    const itemId = items.json().items[0].id;
    await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/entries`, {
      entries: [
        {
          levellingItemId: itemId,
          submissionId: a.id,
          includedStatus: "included",
          asBidAmount: 200_000,
          adjustmentAmount: 0,
        },
        {
          // The cheaper bidder excluded the temporary works; levelling adds
          // them back and the "lowest" bid changes.
          levellingItemId: itemId,
          submissionId: b.id,
          includedStatus: "excluded",
          asBidAmount: 190_000,
          adjustmentAmount: 40_000,
          adjustmentReason: "excluded_scope_priced_elsewhere",
          adjustmentNote: "Temporary works excluded; priced from the next bidder's rate.",
        },
      ],
    });
    await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/complete`);
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis:
        "Lowest LEVELLED amount once the excluded temporary works are priced back in.",
    });
    expect(rec.statusCode).toBe(201);
    const audit = rec.json().audit;
    expect(audit.asBidContractSum).toBe(200_000);
    expect(audit.recommendedComparableAmount).toBe(200_000);
    expect(audit.lowestBidAmount).toBe(200_000);
    expect(audit.comparisonBasis).toBe("levelled");
    expect(audit.comparableAmountsNote).toMatch(/LEVELLED figures/);
  });
});

describe("delegated award authority", () => {
  it("refuses an approval above the approver's own limit and permits it below", async () => {
    const created = await post("/companies/current/award-delegations", {
      subjectKind: "user",
      subjectId: approver.userId,
      label: "Commercial Manager",
      maxAwardAmount: 50_000,
      currency: "GBP",
      basis: "Scheme of delegation, board minute 2026-01.",
    });
    expect(created.statusCode).toBe(201);

    const pkg = await createPackage(projectA, { title: "Over the limit" });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, delta, { baseBidAmount: 120_000 });
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis: "Only compliant bid; the others declined for capacity reasons.",
    });
    const awardId = rec.json().id;
    const refused = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().details.control).toBe("delegated_authority");

    const raised = await patch(
      `/companies/current/award-delegations/${created.json().id}`,
      { maxAwardAmount: 500_000, basis: "Raised by board minute 2026-04." },
    );
    expect(raised.statusCode).toBe(200);
    const ok = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().approvalAuthority).toMatch(/Commercial Manager/);
  });

  it("keeps another company out of the delegation register", async () => {
    const res = await get("/companies/current/award-delegations", stranger.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
  });
});

describe("award withdrawal", () => {
  it("voids the commitment, restores the losing bids and lets the package be re-recommended", async () => {
    const pkg = await createPackage(projectA, { title: "Unwind an award" });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 80_000 });
    const b = await submitBid(projectA, pkg.id, bravo, { baseBidAmount: 95_000 });
    const rec = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis: "Lowest compliant bid with an acceptable programme.",
    });
    const awardId = rec.json().id;
    const approved = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(approved.statusCode).toBe(200);
    const commitmentId = approved.json().commitmentCreated.id;

    const withdrawn = await post(
      `/bid-awards/${awardId}/withdraw`,
      {
        reason:
          "The winning bidder entered administration before the contract was issued; the award " +
          "is unwound and the package returns to evaluation.",
      },
      approver.headers,
    );
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().restored).toBeGreaterThan(0);

    const [commitment] = await app.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, commitmentId));
    expect(commitment!.status).toBe("void");
    const [loser] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, b.id));
    expect(loser!.status).toBe("under_review");

    const again = await post(`/projects/${projectA}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: b.id,
      recommendationBasis:
        "The lowest bidder is in administration; this is the next compliant bid on the record.",
      notLowestJustification:
        "The lowest bidder entered administration and cannot contract; their price is not " +
        "available to be taken.",
    });
    expect(again.statusCode).toBe(201);
  });
});

/* ================================================================== */
/* REGRESSIONS — the bidder portal                                     */
/* ================================================================== */

describe("regression: the bidder portal", () => {
  let token: string;
  let invitationId: string;
  let pkgId: string;

  beforeAll(async () => {
    const pkg = await createPackage(projectA, { title: "Portal controls", bidDueAt: isoIn(6 * HOUR) });
    pkgId = pkg.id;
    await issuePackage(projectA, pkgId);
    const invite = await post(`/projects/${projectA}/bid-packages/${pkgId}/invitations`, {
      vendorId: charlie,
    });
    invitationId = invite.json().items[0].id;
    await post(`/bid-invitations/${invitationId}/send`);
    const minted = await post(`/bid-invitations/${invitationId}/portal-token`);
    expect(minted.statusCode).toBe(201);
    expect(minted.json().expiresAt).toBeTruthy();
    token = minted.json().token;
  });

  const portal = (url: string, payload?: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload ?? {},
    });

  it("ledgers a bidder's stated intention", async () => {
    const res = await portal("/bid-portal/intent", { intentToBid: true });
    expect(res.statusCode).toBe(200);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, invitationId),
        ),
      );
    const intent = entries.find(
      (e) => ((e.payload as Record<string, unknown> | null) ?? {})["event"] === "portal_intent_to_bid",
    );
    expect(intent).toBeDefined();
    expect((intent!.payload as Record<string, unknown>)["via"]).toBe("portal_token");
    expect(intent!.actorId).toBeNull();
  });

  it("refuses a decline once the bid has been submitted", async () => {
    await submitBid(projectA, pkgId, charlie, { baseBidAmount: 100_000, invitationId });
    const res = await portal("/bid-portal/intent", {
      intentToBid: false,
      declineReason: "capacity",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/withdrawn through the buyer/i);
  });

  it("logs document access per bidder and reports who never opened what", async () => {
    const pkg = await createPackage(projectA, { title: "Access log", bidDueAt: isoIn(6 * HOUR) });
    await issuePackage(projectA, pkg.id);
    await patch(`/projects/${projectA}/bid-packages/${pkg.id}`, {
      documentFileIds: ["fil_drawings", "fil_spec"],
    });
    const invite = await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
      invitations: [{ vendorId: alpha }, { vendorId: bravo }],
    });
    const first = invite.json().items[0].id;
    await post(`/bid-invitations/${first}/send`);
    const minted = await post(`/bid-invitations/${first}/portal-token`);
    const theirToken = minted.json().token;
    const logged = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/document-access",
      headers: { authorization: `Bearer ${theirToken}` },
      payload: { fileId: "fil_drawings", accessKind: "download" },
    });
    expect(logged.statusCode).toBe(201);

    const unknownFile = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/document-access",
      headers: { authorization: `Bearer ${theirToken}` },
      payload: { fileId: "fil_not_issued" },
    });
    expect(unknownFile.statusCode).toBe(400);

    const report = await get(
      `/projects/${projectA}/bid-packages/${pkg.id}/document-access`,
    );
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.total).toBe(1);
    const opener = body.byVendor.find((v: { vendorId: string }) => v.vendorId === alpha);
    expect(opener.filesOpened).toBe(1);
    expect(opener.neverAccessed).toEqual(["fil_spec"]);
    const silent = body.byVendor.find((v: { vendorId: string }) => v.vendorId === bravo);
    expect(silent.filesOpened).toBe(0);
  });

  it("refuses an expired portal token", async () => {
    const pkg = await createPackage(projectA, { title: "Expired token", bidDueAt: isoIn(HOUR) });
    await issuePackage(projectA, pkg.id);
    const invite = await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
      vendorId: delta,
    });
    const id = invite.json().items[0].id;
    await post(`/bid-invitations/${id}/send`);
    const minted = await post(`/bid-invitations/${id}/portal-token`);
    await app.db
      .update(bidInvitations)
      .set({ portalTokenExpiresAt: isoIn(-HOUR) })
      .where(eq(bidInvitations.id, id));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/session",
      headers: { authorization: `Bearer ${minted.json().token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/expired/i);
  });
});

/* ================================================================== */
/* REGRESSIONS — prequalification                                      */
/* ================================================================== */

describe("regression: prequalification", () => {
  let questionnaireId: string;

  async function activeQuestionnaire(name: string): Promise<string> {
    const created = await post("/companies/current/prequalification/questionnaires", {
      name,
      validityMonths: 12,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await post(`/companies/current/prequalification/questionnaires/${id}/questions`, {
      questions: [
        {
          text: "Do you hold current employers liability insurance?",
          itemType: "yes_no",
          category: "insurance",
          required: true,
          weight: 1,
          maxScore: 10,
        },
      ],
    });
    const activated = await post(
      `/companies/current/prequalification/questionnaires/${id}/activate`,
      {},
      approver.headers,
    );
    expect(activated.statusCode).toBe(200);
    return id;
  }

  beforeAll(async () => {
    questionnaireId = await activeQuestionnaire("Upgrade wave questionnaire");
  });

  it("numbers questionnaires and submissions atomically under concurrency", async () => {
    const results = await Promise.all([
      post("/companies/current/prequalification/questionnaires", { name: "Race A", validityMonths: 12 }),
      post("/companies/current/prequalification/questionnaires", { name: "Race B", validityMonths: 12 }),
      post("/companies/current/prequalification/questionnaires", { name: "Race C", validityMonths: 12 }),
    ]);
    for (const res of results) expect(res.statusCode).toBe(201);
    const numbers = results.map((r) => r.json().number);
    expect(new Set(numbers).size).toBe(3);

    const submissions = await Promise.all([
      post("/companies/current/prequalification/submissions", { questionnaireId, vendorId: alpha }),
      post("/companies/current/prequalification/submissions", { questionnaireId, vendorId: bravo }),
      post("/companies/current/prequalification/submissions", { questionnaireId, vendorId: charlie }),
    ]);
    for (const res of submissions) expect(res.statusCode).toBe(201);
    expect(new Set(submissions.map((r) => r.json().number)).size).toBe(3);
  });

  it("refuses a re-assessment of a decided prequalification", async () => {
    const created = await post("/companies/current/prequalification/submissions", {
      questionnaireId,
      vendorId: delta,
    });
    const id = created.json().id;
    const questions = await get(
      `/companies/current/prequalification/questionnaires/${questionnaireId}/questions`,
    );
    const questionId = questions.json().items[0].id;
    await post(`/companies/current/prequalification/submissions/${id}/responses`, {
      responses: [{ questionId, response: "yes" }],
    });
    await post(`/companies/current/prequalification/submissions/${id}/submit`);
    const assessed = await post(
      `/companies/current/prequalification/submissions/${id}/assess`,
      { scores: [{ questionId, score: 9, maxScore: 10 }] },
    );
    expect(assessed.statusCode).toBe(200);
    const decided = await post(
      `/companies/current/prequalification/submissions/${id}/decide`,
      { outcome: "approved", validFrom: dateIn(-1), expiresAt: dateIn(200) },
      approver.headers,
    );
    expect(decided.statusCode).toBe(200);

    const again = await post(
      `/companies/current/prequalification/submissions/${id}/assess`,
      { scores: [{ questionId, score: 1, maxScore: 10 }] },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/cannot be re-assessed/i);
  });

  it("does not lapse an approval that a renewal has superseded", async () => {
    const vendorId = await makeVendor("Renewal Ltd");
    const first = await post("/companies/current/prequalification/submissions", {
      questionnaireId,
      vendorId,
    });
    const firstId = first.json().id;
    const questions = await get(
      `/companies/current/prequalification/questionnaires/${questionnaireId}/questions`,
    );
    const questionId = questions.json().items[0].id;
    const complete = async (submissionId: string, expiresAt: string) => {
      await post(`/companies/current/prequalification/submissions/${submissionId}/responses`, {
        responses: [{ questionId, response: "yes" }],
      });
      await post(`/companies/current/prequalification/submissions/${submissionId}/submit`);
      await post(`/companies/current/prequalification/submissions/${submissionId}/assess`, {
        scores: [{ questionId, score: 9, maxScore: 10 }],
      });
      const decided = await post(
        `/companies/current/prequalification/submissions/${submissionId}/decide`,
        { outcome: "approved", validFrom: dateIn(-400), expiresAt },
        approver.headers,
      );
      expect(decided.statusCode).toBe(200);
    };
    // The first approval has ALREADY expired.
    await complete(firstId, dateIn(-2));
    const renewed = await post(
      `/companies/current/prequalification/submissions/${firstId}/renew`,
    );
    expect(renewed.statusCode).toBe(200);
    await complete(renewed.json().id, dateIn(300));

    await app.scheduler.runNow("bidding.prequalification-expiry");

    const lapseSignals = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "prequalification_lapsed"),
        ),
      );
    const forThisVendor = lapseSignals.filter(
      (s) => (s.evidenceRefs as Record<string, unknown>)["vendorId"] === vendorId,
    );
    expect(forThisVendor).toHaveLength(0);

    const standing = await get(`/companies/current/prequalification/vendors/${vendorId}`);
    expect(standing.json().state).toBe("approved");
  });

  it("clamps a derived expiry to the end of the month rather than overflowing it", async () => {
    const vendorId = await makeVendor("Month End Ltd");
    const monthly = await post("/companies/current/prequalification/questionnaires", {
      name: "One month validity",
      validityMonths: 1,
    });
    const qid = monthly.json().id;
    await post(`/companies/current/prequalification/questionnaires/${qid}/questions`, {
      questions: [{ text: "Ready?", itemType: "yes_no", required: true, weight: 1, maxScore: 10 }],
    });
    await post(
      `/companies/current/prequalification/questionnaires/${qid}/activate`,
      {},
      approver.headers,
    );
    const created = await post("/companies/current/prequalification/submissions", {
      questionnaireId: qid,
      vendorId,
    });
    const id = created.json().id;
    const questions = await get(
      `/companies/current/prequalification/questionnaires/${qid}/questions`,
    );
    const questionId = questions.json().items[0].id;
    await post(`/companies/current/prequalification/submissions/${id}/responses`, {
      responses: [{ questionId, response: "yes" }],
    });
    await post(`/companies/current/prequalification/submissions/${id}/submit`);
    await post(`/companies/current/prequalification/submissions/${id}/assess`, {
      scores: [{ questionId, score: 9, maxScore: 10 }],
    });
    const decided = await post(
      `/companies/current/prequalification/submissions/${id}/decide`,
      { outcome: "approved", validFrom: "2026-01-31" },
      approver.headers,
    );
    expect(decided.statusCode).toBe(200);
    // 31 January + 1 month is 28 February, not 3 March.
    expect(decided.json().expiresAt).toBe("2026-02-28");
  });

  it("refuses a read-only member answering on a vendor's behalf", async () => {
    const created = await post("/companies/current/prequalification/submissions", {
      questionnaireId,
      vendorId: alpha,
    });
    const id = created.json().id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/companies/current/prequalification/submissions/${id}/responses`,
      headers: viewerHeaders,
      payload: { responses: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("treats a vendor inside the renewal window as prequalified on the invitation row", async () => {
    const vendorId = await makeVendor("Expiring Soon Ltd");
    const created = await post("/companies/current/prequalification/submissions", {
      questionnaireId,
      vendorId,
    });
    const id = created.json().id;
    const questions = await get(
      `/companies/current/prequalification/questionnaires/${questionnaireId}/questions`,
    );
    const questionId = questions.json().items[0].id;
    await post(`/companies/current/prequalification/submissions/${id}/responses`, {
      responses: [{ questionId, response: "yes" }],
    });
    await post(`/companies/current/prequalification/submissions/${id}/submit`);
    await post(`/companies/current/prequalification/submissions/${id}/assess`, {
      scores: [{ questionId, score: 9, maxScore: 10 }],
    });
    await post(
      `/companies/current/prequalification/submissions/${id}/decide`,
      { outcome: "approved", validFrom: dateIn(-300), expiresAt: dateIn(20) },
      approver.headers,
    );
    const pkg = await createPackage(projectA, { title: "Expiring vendor invite" });
    await issuePackage(projectA, pkg.id);
    const invite = await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
      vendorId,
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().items[0].prequalification.state).toBe("expiring");
    const [row] = await app.db
      .select()
      .from(bidInvitations)
      .where(eq(bidInvitations.id, invite.json().items[0].id));
    expect(row!.isPrequalified).toBe(1);
  });
});

describe("regression: a balance-sheet-insolvent contractor gets no limit", () => {
  it("hard stops on negative net assets instead of granting a turnover limit", async () => {
    const vendorId = await makeVendor("Insolvent Ltd");
    const res = await post("/companies/current/prequalification/financials", {
      vendorId,
      financialYearEnd: dateIn(-100),
      source: "audited_accounts",
      currency: "GBP",
      turnover: 10_000_000,
      netAssets: -500_000,
      currentAssets: 1_000_000,
      currentLiabilities: 2_000_000,
    });
    expect(res.statusCode).toBe(201);
    const standing = await get(`/companies/current/prequalification/vendors/${vendorId}`);
    expect(standing.statusCode).toBe(200);
    const body = JSON.stringify(standing.json());
    expect(body).toMatch(/hard_stop/);
    expect(body).toMatch(/net assets/i);
    // The turnover test would otherwise have allowed 25% of 10m.
    expect(body).not.toMatch(/2500000/);
    expect(standing.json().recommendedLimit.value).toBe(0);
  });
});

/* ================================================================== */
/* NEW — bid integrity                                                 */
/* ================================================================== */

describe("bid integrity detectors on real records", () => {
  let pkgId: string;
  let submissions: { id: string; vendorId: string }[] = [];

  beforeAll(async () => {
    const pkg = await createPackage(projectB, {
      title: "Collusive tender",
      tradeCode: "GROUNDWORKS",
      engineersEstimate: 200_000,
      bidDueAt: isoIn(HOUR),
    });
    pkgId = pkg.id;
    await issuePackage(projectB, pkgId);
    const shared = [98, 51, 210, 33, 77, 142, 19, 64, 88];
    const line = (rate: number, i: number) => ({
      description: `Item ${i}`,
      itemCode: `L${i}`,
      quantity: 10,
      unitRate: rate,
      amount: rate * 10,
    });
    const a = await submitBid(projectB, pkgId, alpha, {
      baseBidAmount: null,
      receivedAt: isoIn(-40 * 60_000),
      lines: shared.map((r, i) => line(r, i)),
    });
    const b = await submitBid(projectB, pkgId, bravo, {
      baseBidAmount: null,
      receivedAt: isoIn(-38 * 60_000),
      lines: shared.map((r, i) => line(r, i)),
    });
    const c = await submitBid(projectB, pkgId, charlie, {
      baseBidAmount: null,
      receivedAt: isoIn(-37 * 60_000),
      lines: shared.map((r, i) => line(Number((r * 1.03).toFixed(2)), i)),
    });
    submissions = [
      { id: a.id, vendorId: alpha },
      { id: b.id, vendorId: bravo },
      { id: c.id, vendorId: charlie },
    ];
  });

  it("reads the findings without writing any", async () => {
    const res = await get(`/projects/${projectB}/bid-packages/${pkgId}/integrity`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const detectors = body.findings.map((f: { detector: string }) => f.detector);
    expect(detectors).toContain("bid_integrity_price_clustering");
    expect(detectors).toContain("bid_integrity_identical_rates");
    expect(detectors).toContain("bid_integrity_submission_clustering");
    expect(body.signals).toHaveLength(0);
    expect(body.contenders).toHaveLength(3);
    expect(submissions).toHaveLength(3);
  });

  it("raises each finding once and never twice", async () => {
    const first = await post(`/projects/${projectB}/bid-packages/${pkgId}/integrity/run`);
    expect(first.statusCode).toBe(200);
    expect(first.json().raised.length).toBeGreaterThan(0);
    const second = await post(`/projects/${projectB}/bid-packages/${pkgId}/integrity/run`);
    expect(second.json().raised).toHaveLength(0);
    expect(second.json().alreadyOpen.length).toBeGreaterThan(0);
    expect(second.json().note).toMatch(/false-positive fatigue/i);
  });

  it("refuses a recommendation until the findings are acknowledged", async () => {
    const refused = await post(
      `/projects/${projectB}/bid-packages/${pkgId}/award/recommend`,
      {
        submissionId: submissions[0]!.id,
        recommendationBasis: "Cheapest of three bids received, all compliant.",
      },
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.control).toBe("integrity_findings_require_acknowledgement");

    const accepted = await post(
      `/projects/${projectB}/bid-packages/${pkgId}/award/recommend`,
      {
        submissionId: submissions[0]!.id,
        recommendationBasis: "Cheapest of three bids received, all compliant.",
        integrityAcknowledgement:
          "Findings reviewed with the commercial director. All three bidders buy from the same " +
          "two suppliers and priced from the issued schedule of rates, which explains the " +
          "shared rates; the timing is a portal receipt artefact confirmed with the host.",
      },
    );
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().audit.integrityAcknowledgement).toMatch(/commercial director/);
  });

  it("lists the findings company-wide and records a dismissal with its reason", async () => {
    const list = await get("/companies/current/bid-integrity");
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBeGreaterThan(0);
    const first = list.json().items[0];
    const dismissed = await post(
      `/companies/current/bid-integrity/${first.id}/dismiss`,
      { reason: "Explained by the shared schedule of rates; no further action." },
    );
    expect(dismissed.statusCode).toBe(200);
    const openOnly = await get("/companies/current/bid-integrity?openOnly=true");
    expect(
      openOnly.json().items.some((i: { id: string }) => i.id === first.id),
    ).toBe(false);
  });

  it("keeps another company out of the integrity register", async () => {
    const res = await get("/companies/current/bid-integrity", stranger.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    const pkgRead = await get(
      `/projects/${projectB}/bid-packages/${pkgId}/integrity`,
      stranger.headers,
    );
    expect([403, 404]).toContain(pkgRead.statusCode);
  });

  it("moves thresholds only with a stated reason, and ledgers the change", async () => {
    const res = await put(
      `/projects/${projectB}/bid-packages/${pkgId}/integrity/thresholds`,
      { thresholds: { clusteringCvPercent: 0.5 }, reason: "Schedule of rates package." },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().thresholds.clusteringCvPercent).toBe(0.5);
    const noReason = await put(
      `/projects/${projectB}/bid-packages/${pkgId}/integrity/thresholds`,
      { thresholds: null },
    );
    expect(noReason.statusCode).toBe(400);
  });

  it("flags an approval signed minutes after the recommendation", async () => {
    const pkg = await createPackage(projectB, { title: "Velocity", tradeCode: "PILING" });
    await issuePackage(projectB, pkg.id);
    const a = await submitBid(projectB, pkg.id, delta, { baseBidAmount: 45_000 });
    const rec = await post(`/projects/${projectB}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: a.id,
      recommendationBasis: "Single compliant bid from the only prequalified specialist.",
    });
    const approved = await post(`/bid-awards/${rec.json().id}/approve`, {}, approver.headers);
    expect(approved.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "bid_integrity_approval_velocity"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.subjectId === rec.json().id)).toBe(true);
  });

  it("runs the cross-package detectors from the scheduler", async () => {
    const status = await app.scheduler.runNow("bidding.integrity");
    expect(status.state).toBe("succeeded");
  });
});

/* ================================================================== */
/* NEW — scope gaps, bid board, health inputs                          */
/* ================================================================== */

describe("scope gaps across bids", () => {
  it("names the scope nobody priced", async () => {
    const pkg = await createPackage(projectA, { title: "Scope gaps" });
    await issuePackage(projectA, pkg.id);
    const a = await submitBid(projectA, pkg.id, alpha, { baseBidAmount: 100_000 });
    const b = await submitBid(projectA, pkg.id, bravo, { baseBidAmount: 110_000 });
    const items = await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/items`, {
      items: [
        { description: "Main works", itemCode: "M1", isMandatory: true },
        {
          description: "Temporary works design",
          itemCode: "T1",
          isMandatory: true,
          engineersEstimate: 25_000,
        },
      ],
    });
    const [main, temp] = items.json().items;
    await post(`/projects/${projectA}/bid-packages/${pkg.id}/levelling/entries`, {
      entries: [
        { levellingItemId: main.id, submissionId: a.id, includedStatus: "included", asBidAmount: 100_000, adjustmentAmount: 0 },
        { levellingItemId: main.id, submissionId: b.id, includedStatus: "included", asBidAmount: 110_000, adjustmentAmount: 0 },
        { levellingItemId: temp.id, submissionId: a.id, includedStatus: "excluded", adjustmentAmount: 0 },
        { levellingItemId: temp.id, submissionId: b.id, includedStatus: "excluded", adjustmentAmount: 0 },
      ],
    });
    const res = await get(`/projects/${projectA}/bid-packages/${pkg.id}/scope-gaps`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.universalGaps).toBe(1);
    expect(body.gaps[0].description).toMatch(/Temporary works/);
    expect(body.gaps[0].note).toMatch(/no competition/i);
    expect(body.summary.exposure).toBe(25_000);
  });
});

describe("the bid board", () => {
  it("publishes a package without publishing the estimate", async () => {
    const pkg = await createPackage(projectA, {
      title: "Board entry",
      tradeCode: "ROOFING",
      engineersEstimate: 987_654,
    });
    const early = await post(`/projects/${projectA}/bid-packages/${pkg.id}/publish`, {
      publish: true,
    });
    expect(early.statusCode).toBe(409);
    await issuePackage(projectA, pkg.id);
    const published = await post(`/projects/${projectA}/bid-packages/${pkg.id}/publish`, {
      publish: true,
      publicSummary: "Roof coverings, edge protection and rainwater goods to a four-storey block.",
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().publication.isPublished).toBe(true);

    const board = await get("/companies/current/bid-board", viewerHeaders);
    expect(board.statusCode).toBe(200);
    expect(board.body).not.toContain("987654");
    const entry = board.json().items.find((i: { id: string }) => i.id === pkg.id);
    expect(entry.summary).toMatch(/Roof coverings/);
    expect(entry).not.toHaveProperty("engineersEstimate");
  });

  it("shows another company nothing", async () => {
    const res = await get("/companies/current/bid-board", stranger.headers);
    expect(res.json().items).toHaveLength(0);
  });
});

describe("health inputs", () => {
  it("reports what procurement contributes, with reasons", async () => {
    const res = await get(`/projects/${projectA}/bidding/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.metrics.packages).toBe("number");
    expect(Array.isArray(body.reasons)).toBe(true);
  });

  it("returns nulls rather than zeros on a project with no packages", async () => {
    const empty = await makeProject("No procurement");
    const res = await get(`/projects/${empty}/bidding/health-inputs`);
    expect(res.json().metrics.packages).toBe(0);
    expect(res.json().metrics.liveTenders).toBeNull();
    expect(res.json().reasons[0]).toMatch(/No bid packages/);
  });
});

/* ================================================================== */
/* NEW — tender queries, meetings, bonds                               */
/* ================================================================== */

describe("tender queries", () => {
  let pkgId: string;

  beforeAll(async () => {
    const pkg = await createPackage(projectA, {
      title: "Q and A",
      bidDueAt: isoIn(72 * HOUR),
      questionsDueAt: isoIn(24 * HOUR),
    });
    pkgId = pkg.id;
    await issuePackage(projectA, pkgId);
  });

  it("records a query, answers it, and publishes it to every bidder as an addendum", async () => {
    const invite = await post(`/projects/${projectA}/bid-packages/${pkgId}/invitations`, {
      invitations: [{ vendorId: alpha }, { vendorId: bravo }],
    });
    const invitationId = invite.json().items[0].id;
    const asked = await post(`/projects/${projectA}/bid-packages/${pkgId}/questions`, {
      question: "Is the existing slab to be broken out or left in place?",
      category: "scope",
      invitationId,
    });
    expect(asked.statusCode).toBe(201);
    const questionId = asked.json().id;
    expect(asked.json().reference).toBe("TQ-0001");

    const publishedTooEarly = await post(
      `/projects/${projectA}/bid-packages/${pkgId}/questions/publish`,
      { addendumReference: "ADD-Q1", questionIds: [questionId] },
    );
    expect(publishedTooEarly.statusCode).toBe(400);
    expect(publishedTooEarly.json().message).toMatch(/no answer yet/i);

    const answered = await post(
      `/projects/${projectA}/bid-packages/${pkgId}/questions/${questionId}/answer`,
      {
        answer: "The slab is to be broken out in full and removed from site.",
        anonymisedQuestion: "Is the existing slab to be broken out or left in place?",
      },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json().note).toMatch(/not yet with the other bidders/i);

    const published = await post(
      `/projects/${projectA}/bid-packages/${pkgId}/questions/publish`,
      { addendumReference: "ADD-Q1", questionIds: [questionId] },
    );
    expect(published.statusCode).toBe(201);
    expect(published.json().published).toBe(1);

    const addenda = await get(`/projects/${projectA}/bid-packages/${pkgId}/addenda`);
    const addendum = addenda.json().items.find((a: { reference: string }) => a.reference === "ADD-Q1");
    expect(addendum.description).toMatch(/broken out in full/);
    expect(addendum.outstandingFrom).toHaveLength(2);
  });

  it("requires a stated reason before an answer may be withheld from the others", async () => {
    const asked = await post(`/projects/${projectA}/bid-packages/${pkgId}/questions`, {
      question: "Can we substitute our own proprietary system?",
      category: "specification",
    });
    const res = await post(
      `/projects/${projectA}/bid-packages/${pkgId}/questions/${asked.json().id}/answer`,
      { answer: "No — the specified system is a client standard.", isPrivate: true },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/priced a different job/i);
  });

  it("flags a query that arrived after the questions deadline", async () => {
    const asked = await post(`/projects/${projectA}/bid-packages/${pkgId}/questions`, {
      question: "Late question about the programme.",
      askedAt: isoIn(48 * HOUR - 1000),
    });
    expect(asked.statusCode).toBe(201);
    expect(asked.json().lateWarning).toMatch(/after the questions deadline/i);
  });

  it("keeps another company out of the query register", async () => {
    const res = await get(
      `/projects/${projectA}/bid-packages/${pkgId}/questions`,
      stranger.headers,
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe("pre-bid meetings", () => {
  it("records attendance and names the bidders who missed a mandatory site visit", async () => {
    const pkg = await createPackage(projectA, {
      title: "Site visit",
      bidDueAt: isoIn(96 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
      invitations: [{ vendorId: alpha }, { vendorId: bravo }, { vendorId: charlie }],
    });
    const meeting = await post(`/projects/${projectA}/bid-packages/${pkg.id}/meetings`, {
      kind: "site_visit",
      title: "Mandatory site visit",
      scheduledAt: isoIn(24 * HOUR),
      isMandatory: true,
      location: "Site gate, north entrance",
    });
    expect(meeting.statusCode).toBe(201);
    const meetingId = meeting.json().id;

    const attendance = await post(
      `/projects/${projectA}/bid-packages/${pkg.id}/meetings/${meetingId}/attendance`,
      {
        attendees: [
          { vendorId: alpha, attendeeName: "A. Smith", attendance: "attended" },
          { vendorId: bravo, attendeeName: "B. Jones", attendance: "apologies" },
        ],
      },
    );
    expect(attendance.statusCode).toBe(200);

    const minutes = await post(
      `/projects/${projectA}/bid-packages/${pkg.id}/meetings/${meetingId}/minutes`,
      {
        minutes: "Ground conditions inspected; the client confirmed the existing services survey.",
        publishAsAddendum: "ADD-SV1",
      },
    );
    expect(minutes.statusCode).toBe(200);
    expect(minutes.json().note).toMatch(/published as addendum/i);

    const list = await get(`/projects/${projectA}/bid-packages/${pkg.id}/meetings`);
    const held = list.json().items[0];
    expect(held.attendedCount).toBe(1);
    expect(held.missingMandatory.map((m: { vendorId: string }) => m.vendorId).sort()).toEqual(
      [bravo, charlie].sort(),
    );
    expect(held.compliance).toMatch(/priced on the drawings alone/i);

    const [invitation] = await app.db
      .select()
      .from(bidInvitations)
      .where(
        and(eq(bidInvitations.packageId, pkg.id), eq(bidInvitations.vendorId, alpha)),
      );
    expect(invitation!.attendedSiteVisit).toBe(1);
  });

  it("refuses a pre-bid meeting scheduled after the bids are in", async () => {
    const pkg = await createPackage(projectA, { title: "Too late", bidDueAt: isoIn(HOUR) });
    await issuePackage(projectA, pkg.id);
    const res = await post(`/projects/${projectA}/bid-packages/${pkg.id}/meetings`, {
      kind: "pre_bid",
      title: "Pointless meeting",
      scheduledAt: isoIn(48 * HOUR),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/informs nobody's price/i);
  });
});

describe("bid bonds", () => {
  let bondId: string;
  let pkgId: string;

  it("records a bond, refuses self-verification and reports the shortfall", async () => {
    const pkg = await createPackage(projectA, { title: "Bond tracking", currency: "GBP" });
    pkgId = pkg.id;
    await issuePackage(projectA, pkgId);
    await submitBid(projectA, pkgId, alpha, { baseBidAmount: 200_000 });
    const created = await post(`/projects/${projectA}/bid-packages/${pkgId}/bonds`, {
      vendorId: alpha,
      bondType: "bid",
      requiredPercent: 5,
      providedAmount: 6_000,
      provider: "Surety Co",
      expiresAt: dateIn(60),
    });
    expect(created.statusCode).toBe(201);
    bondId = created.json().id;

    const selfVerify = await post(`/bid-bonds/${bondId}/status`, { status: "verified" });
    expect(selfVerify.statusCode).toBe(400);
    expect(selfVerify.json().message).toMatch(/may not be the person who verifies/i);

    const verified = await post(
      `/bid-bonds/${bondId}/status`,
      { status: "verified", note: "Confirmed with the surety by telephone." },
      approver.headers,
    );
    expect(verified.statusCode).toBe(200);

    const list = await get(`/projects/${projectA}/bid-packages/${pkgId}/bonds`);
    const row = list.json().items[0];
    // 5% of the £200,000 bid is £10,000; £6,000 was lodged.
    expect(row.derivedRequiredAmount).toBe(10_000);
    expect(row.shortfall).toBe(4_000);
    expect(row.note).toMatch(/short of/i);
  });

  it("raises an obligation for a bond inside its expiry window and expires a lapsed one", async () => {
    await app.db
      .update(bidBonds)
      .set({ expiresAt: dateIn(10) })
      .where(eq(bidBonds.id, bondId));
    const first = await app.scheduler.runNow("bidding.bid-bonds");
    expect(first.state).toBe("succeeded");
    const [withObligation] = await app.db
      .select()
      .from(bidBonds)
      .where(eq(bidBonds.id, bondId));
    expect(withObligation!.obligationId).toBeTruthy();
    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, withObligation!.obligationId!));
    expect(obligation!.status).toBe("open");

    await app.db
      .update(bidBonds)
      .set({ expiresAt: dateIn(-1) })
      .where(eq(bidBonds.id, bondId));
    await app.scheduler.runNow("bidding.bid-bonds");
    const [expired] = await app.db.select().from(bidBonds).where(eq(bidBonds.id, bondId));
    expect(expired!.status).toBe("expired");
    const [breached] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, withObligation!.obligationId!));
    expect(breached!.status).toBe("breached");
  });

  it("refuses a second bond of the same type for the same bidder", async () => {
    const res = await post(`/projects/${projectA}/bid-packages/${pkgId}/bonds`, {
      vendorId: alpha,
      bondType: "bid",
      requiredPercent: 5,
    });
    expect(res.statusCode).toBe(409);
  });
});

/* ================================================================== */
/* NEW — opportunities, win probability, costs, analytics              */
/* ================================================================== */

describe("the opportunity pipeline", () => {
  let opportunityId: string;

  it("creates a pursuit and refuses to move it to bidding before the gate", async () => {
    const created = await post("/companies/current/opportunities", {
      title: "New leisure centre",
      clientName: "Borough Council",
      workType: "leisure",
      sector: "public",
      estimatedValue: 8_000_000,
      currency: "GBP",
      submissionDueAt: isoIn(20 * 24 * HOUR),
      peakResourceUnits: 4,
      resourceUnitLabel: "crews",
      competitors: [{ name: "Rival Construction" }, { name: "Second Rival" }],
    });
    expect(created.statusCode).toBe(201);
    opportunityId = created.json().id;
    expect(created.json().reference).toBe("OPP-0001");

    const early = await post(`/companies/current/opportunities/${opportunityId}/stage`, {
      stage: "bidding",
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/bid\/no-bid gate/i);
  });

  it("refuses a win probability where the history is too thin, and says why", async () => {
    const res = await post(
      `/companies/current/opportunities/${opportunityId}/win-probability`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().probability.value).toBeNull();
    expect(res.json().probability.reasons[0]).toMatch(/decided bid/i);
    expect(res.json().basis).toMatch(/we do not know/i);
  });

  it("records the decision with its scored basis, and flags when it went against the score", async () => {
    const res = await post(`/companies/current/opportunities/${opportunityId}/decide`, {
      decision: "bid",
      factors: [
        { factor: "client_relationship", score: 2, weight: 40 },
        { factor: "capacity", score: 2, weight: 40 },
        { factor: "margin_potential", score: 3, weight: 20 },
      ],
      basis:
        "We are bidding despite a low score because the client is opening a framework next year " +
        "and being on the list matters more than this job.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assessment.suggested).toBe("no_bid");
    expect(res.json().note).toMatch(/against the score|not a problem/i);
    expect(res.json().stage).toBe("bidding");

    const again = await post(`/companies/current/opportunities/${opportunityId}/decide`, {
      decision: "no_bid",
      basis: "Changed our minds after the pre-qualification pack arrived and it was enormous.",
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses to record a win on a pursuit that was a no-bid", async () => {
    const created = await post("/companies/current/opportunities", {
      title: "Declined pursuit",
      estimatedValue: 100_000,
      currency: "GBP",
    });
    const id = created.json().id;
    await post(`/companies/current/opportunities/${id}/decide`, {
      decision: "no_bid",
      basis: "No capacity in the window and the terms are unacceptable on liability.",
    });
    // Deciding "no bid" closes the pursuit there and then: it is a decided
    // outcome, not a stage somebody has to remember to close afterwards.
    const detail = await get(`/companies/current/opportunities/${id}`);
    expect(detail.json().outcome).toBe("no_bid");
    const res = await post(`/companies/current/opportunities/${id}/outcome`, {
      outcome: "won",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already closed as "no_bid"/i);
  });

  it("produces a fitted probability once enough outcomes are on the record", async () => {
    // Twelve decided pursuits: repeat clients win, cold approaches lose.
    for (let i = 0; i < 6; i += 1) {
      const won = await post("/companies/current/opportunities", {
        title: `Repeat client job ${i}`,
        clientName: "Borough Council",
        workType: "leisure",
        estimatedValue: 5_000_000,
        currency: "GBP",
      });
      await post(`/companies/current/opportunities/${won.json().id}/decide`, {
        decision: "bid",
        factors: [{ factor: "client_relationship", score: 9, weight: 100 }],
        basis: "Strong incumbent position with this client and a compliant delivery team.",
      });
      await post(`/companies/current/opportunities/${won.json().id}/outcome`, {
        outcome: "won",
        submittedAmount: 5_000_000,
      });

      const lost = await post("/companies/current/opportunities", {
        title: `Cold approach ${i}`,
        clientName: "Unknown Developer",
        workType: "residential",
        estimatedValue: 5_000_000,
        currency: "GBP",
      });
      await post(`/companies/current/opportunities/${lost.json().id}/decide`, {
        decision: "bid",
        factors: [{ factor: "client_relationship", score: 2, weight: 100 }],
        basis: "Unknown client but the work suits our team and the programme is comfortable.",
      });
      await post(`/companies/current/opportunities/${lost.json().id}/outcome`, {
        outcome: "lost",
        submittedAmount: 5_200_000,
        winningCompetitor: "Rival Construction",
      });
    }

    const candidate = await post("/companies/current/opportunities", {
      title: "Another Borough Council job",
      clientName: "Borough Council",
      workType: "leisure",
      estimatedValue: 5_000_000,
      currency: "GBP",
    });
    const res = await post(
      `/companies/current/opportunities/${candidate.json().id}/win-probability`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().probability.value).not.toBeNull();
    expect(res.json().model.sampleSize).toBeGreaterThanOrEqual(12);
    expect(res.json().contributions.length).toBeGreaterThan(0);
    expect(res.json().basis).toMatch(/In-sample accuracy is always flattering/);
  });

  it("buckets the pipeline by currency and reports what it could not weight", async () => {
    const res = await get("/companies/current/opportunities?pageSize=5");
    expect(res.statusCode).toBe(200);
    const gbp = res.json().pipeline.find((p: { currency: string }) => p.currency === "GBP");
    expect(gbp).toBeDefined();
    expect(gbp.liveCount).toBeGreaterThan(0);
    expect(gbp.unweighted).toBeGreaterThanOrEqual(0);
    expect(res.json().capacity.note).toBeTruthy();
  });

  it("reports win rate by client, refusing rates over too few outcomes", async () => {
    const res = await get("/companies/current/win-rate?by=client");
    expect(res.statusCode).toBe(200);
    const council = res.json().groups.find((g: { label: string }) => g.label === "Borough Council");
    expect(council.wins).toBe(6);
    expect(council.winRatePercent.value).toBe(100);
    const thin = res.json().groups.find((g: { key: string }) => g.key === "__none__");
    if (thin) expect(thin.winRatePercent.value === null || thin.bids >= 3).toBe(true);
  });

  it("keeps another company out of the pipeline", async () => {
    const res = await get("/companies/current/opportunities", stranger.headers);
    expect(res.json().items).toHaveLength(0);
    const detail = await get(
      `/companies/current/opportunities/${opportunityId}`,
      stranger.headers,
    );
    expect(detail.statusCode).toBe(404);
  });

  it("flags a pursuit whose submission date passed with nothing recorded", async () => {
    const created = await post("/companies/current/opportunities", {
      title: "Forgotten pursuit",
      estimatedValue: 250_000,
      currency: "GBP",
      submissionDueAt: isoIn(-48 * HOUR),
    });
    const status = await app.scheduler.runNow("bidding.opportunities");
    expect(status.state).toBe("succeeded");
    const detail = await get(`/companies/current/opportunities/${created.json().id}`);
    expect(detail.json().detail.overdueNotifiedAt).toBeTruthy();
  });
});

describe("tender cost of sale", () => {
  it("derives an amount from hours and rate, and refuses a third disagreeing figure", async () => {
    const created = await post("/companies/current/opportunities", {
      title: "Costed pursuit",
      estimatedValue: 1_000_000,
      currency: "GBP",
    });
    const opportunityId = created.json().id;
    const ok = await post("/companies/current/tender-costs", {
      opportunityId,
      kind: "estimating_labour",
      description: "Estimator, three weeks",
      incurredOn: dateIn(-10),
      hours: 100,
      hourlyRate: 45,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().amount).toBe(4_500);

    const disagree = await post("/companies/current/tender-costs", {
      opportunityId,
      kind: "printing",
      description: "Document printing",
      incurredOn: dateIn(-5),
      hours: 2,
      hourlyRate: 50,
      amount: 500,
    });
    expect(disagree.statusCode).toBe(400);
    expect(disagree.json().message).toMatch(/third figure that disagrees/i);

    const orphan = await post("/companies/current/tender-costs", {
      kind: "travel",
      description: "Site visit travel",
      incurredOn: dateIn(-3),
      amount: 120,
      currency: "GBP",
    });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().message).toMatch(/belongs to a pursuit or to a package/i);

    await post(`/companies/current/opportunities/${opportunityId}/decide`, {
      decision: "bid",
      factors: [{ factor: "capacity", score: 8, weight: 100 }],
      basis: "Good fit for the delivery team with the right programme window available.",
    });
    await post(`/companies/current/opportunities/${opportunityId}/outcome`, {
      outcome: "lost",
      submittedAmount: 990_000,
    });

    const summary = await get("/companies/current/cost-of-sale");
    expect(summary.statusCode).toBe(200);
    const gbp = summary.json().currencies.find((c: { currency: string }) => c.currency === "GBP");
    expect(gbp.lostCost).toBeGreaterThanOrEqual(4_500);
    expect(gbp.note).toMatch(/price of the ones that were won/i);
  });
});

describe("coverage, pricing and vendor history", () => {
  it("flags a live tender with fewer than three intending bidders", async () => {
    const pkg = await createPackage(projectA, {
      title: "Thin field",
      tradeCode: "CLADDING",
      bidDueAt: isoIn(2 * 24 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    const invite = await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
      invitations: [{ vendorId: alpha }, { vendorId: bravo }],
    });
    for (const item of invite.json().items) {
      await post(`/bid-invitations/${item.id}/send`);
    }
    const res = await get("/companies/current/bid-coverage");
    expect(res.statusCode).toBe(200);
    const row = res.json().packages.find((p: { packageId: string }) => p.packageId === pkg.id);
    expect(row.invited).toBe(2);
    expect(row.intending).toBe(0);
    expect(row.coverageFlag).toBe("critical");
    expect(row.note).toMatch(/quotation rather than a competition/i);
  });

  it("places each bidder against the field", async () => {
    const res = await get("/companies/current/bid-pricing");
    expect(res.statusCode).toBe(200);
    expect(res.json().observations).toBeGreaterThan(0);
    const alphaProfile = res.json().vendors.find((v: { vendorId: string }) => v.vendorId === alpha);
    expect(alphaProfile).toBeDefined();
    expect(alphaProfile.note).toBeTruthy();
  });

  it("returns one vendor's whole bidding history with rates refused where thin", async () => {
    const res = await get(`/companies/current/vendors/${alpha}/bid-history`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vendor.id).toBe(alpha);
    expect(body.summary.invitations).toBeGreaterThan(0);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.summary.responseRatePercent.value).not.toBeNull();
  });

  it("refuses a vendor from another company", async () => {
    const res = await get(`/companies/current/vendors/${alpha}/bid-history`, stranger.headers);
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Scheduled sweeps                                                    */
/* ================================================================== */

describe("scheduled sweeps", () => {
  it("closes a tender whose published deadline has passed", async () => {
    const pkg = await createPackage(projectA, {
      title: "Deadline sweep",
      bidDueAt: isoIn(2 * HOUR),
    });
    await issuePackage(projectA, pkg.id);
    await app.db
      .update(bidPackages)
      .set({ bidDueAt: isoIn(-HOUR), status: "open" })
      .where(eq(bidPackages.id, pkg.id));
    const status = await app.scheduler.runNow("bidding.tender-deadlines");
    expect(status.state).toBe("succeeded");
    const [row] = await app.db.select().from(bidPackages).where(eq(bidPackages.id, pkg.id));
    expect(row!.status).toBe("closed");
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.companyId, owner.companyId), eq(ledgerEntries.objectId, pkg.id)),
      );
    expect(
      entries.some((e) => (e.payload as Record<string, unknown>)["derived"] === true),
    ).toBe(true);
  });

  it("warns where a bid's validity expires before the anticipated award", async () => {
    const pkg = await createPackage(projectA, {
      title: "Validity sweep",
      bidDueAt: isoIn(HOUR),
      anticipatedAwardDate: dateIn(90),
    });
    await issuePackage(projectA, pkg.id);
    const bid = await submitBid(projectA, pkg.id, bravo, {
      baseBidAmount: 100_000,
      validUntil: dateIn(30),
    });
    await app.db
      .update(bidPackages)
      .set({ status: "closed" })
      .where(eq(bidPackages.id, pkg.id));
    await app.scheduler.runNow("bidding.tender-deadlines");
    const [row] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, bid.id));
    expect((row!.detail as Record<string, unknown>)["validityWarnedAt"]).toBeTruthy();
  });

  it("runs the prequalification sweep from the scheduler", async () => {
    const status = await app.scheduler.runNow("bidding.prequalification-expiry");
    expect(status.state).toBe("succeeded");
  });
});

/* ================================================================== */
/* Permissions                                                         */
/* ================================================================== */

describe("permissions", () => {
  it("gives a read-only project member read but not write on the new routes", async () => {
    const pkg = await createPackage(projectA, { title: "Permission surface" });
    await issuePackage(projectA, pkg.id);
    const read = await get(
      `/projects/${projectA}/bid-packages/${pkg.id}/integrity`,
      viewerHeaders,
    );
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/bid-packages/${pkg.id}/integrity/run`,
      headers: viewerHeaders,
      payload: {},
    });
    expect(write.statusCode).toBe(403);
    const question = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/bid-packages/${pkg.id}/questions`,
      headers: viewerHeaders,
      payload: { question: "Can I write?" },
    });
    expect(question.statusCode).toBe(403);
  });

  it("keeps every new project-scoped route out of another company's reach", async () => {
    const pkg = await createPackage(projectA, { title: "Tenant isolation upgrade" });
    for (const path of [
      `/projects/${projectA}/bid-packages/${pkg.id}/integrity`,
      `/projects/${projectA}/bid-packages/${pkg.id}/scope-gaps`,
      `/projects/${projectA}/bid-packages/${pkg.id}/questions`,
      `/projects/${projectA}/bid-packages/${pkg.id}/meetings`,
      `/projects/${projectA}/bid-packages/${pkg.id}/bonds`,
      `/projects/${projectA}/bid-packages/${pkg.id}/document-access`,
      `/projects/${projectA}/bidding/health-inputs`,
    ]) {
      const res = await get(path, stranger.headers);
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it("refuses an unauthenticated caller everywhere", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/companies/current/opportunities",
    });
    expect(res.statusCode).toBe(401);
  });
});
