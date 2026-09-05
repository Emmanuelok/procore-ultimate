import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  bidSubmissions,
  commitments,
  ledgerEntries,
  commitmentSovLines,
  companyMemberships,
  obligations,
  prequalificationSubmissions,
  projectMemberships,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
/** creates the records — never approves them */
let owner: TestActor;
/** the independent second pair of eyes (ADR 0004) */
let approver: TestActor;
/** read-only project member — the permission counterparty */
let viewerHeaders: Record<string, string>;
/** a different company entirely — the tenant-isolation counterparty */
let stranger: TestActor;

let sealProject: string;
let openProject: string;
let awardProject: string;
let prequalProject: string;
let permProject: string;

let alpha: string;
let bravo: string;
let charlie: string;
let lapsed: string;
let delta: string;

const HOUR = 3_600_000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const dateIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

  sealProject = await makeProject("Bidding — sealed control");
  openProject = await makeProject("Bidding — levelling");
  awardProject = await makeProject("Bidding — award");
  prequalProject = await makeProject("Bidding — prequalification");
  permProject = await makeProject("Bidding — permissions");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: permProject,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  alpha = await makeVendor("Alpha Groundworks Ltd");
  bravo = await makeVendor("Bravo Civils Ltd");
  charlie = await makeVendor("Charlie Piling Ltd");
  lapsed = await makeVendor("Lapsed Approvals Ltd");
  delta = await makeVendor("Delta Renewals Ltd");
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const patch = (url: string, payload: unknown, headers = owner.headers) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const del = (url: string, headers = owner.headers) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });

interface PackageOptions {
  [key: string]: unknown;
}

async function createPackage(projectId: string, over: PackageOptions = {}) {
  const res = await post(`/projects/${projectId}/bid-packages`, {
    title: "Substructure and groundworks",
    scopeDescription: "Reduced dig, piling mat, drainage and ground beams.",
    currency: "GBP",
    engineersEstimate: 165_000,
    bidDueAt: isoIn(HOUR),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Approve (by the independent actor) and issue a package. */
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

async function submitBid(
  projectId: string,
  packageId: string,
  vendorId: string,
  over: Record<string, unknown> = {},
) {
  const res = await post(`/projects/${projectId}/bid-packages/${packageId}/submissions`, {
    vendorId,
    baseBidAmount: 170_000,
    currency: "GBP",
    receivedAt: isoIn(-2 * HOUR),
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/* ================================================================== */
/* 1. Packages and the tender timetable                                */
/* ================================================================== */

describe("bid packages", () => {
  it("auto-numbers a package and starts it in draft", async () => {
    const pkg = await createPackage(openProject, { title: "Package numbering" });
    expect(pkg.reference).toBe("BP-0001");
    expect(pkg.status).toBe("draft");
    expect(pkg.seal.isSealed).toBe(false);
    expect(pkg.timetable.bidsClosed).toBe(false);
  });

  it("refuses to seal a package with no moment for the seal to lift", async () => {
    const res = await post(`/projects/${sealProject}/bid-packages`, {
      title: "Sealed with no deadline",
      isSealed: true,
      bidDueAt: null,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/moment at which the seal lifts/i);
  });

  it("refuses issue before someone other than the author has approved it", async () => {
    const pkg = await createPackage(openProject, { title: "Unapproved" });
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/issue`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/has not been approved for issue/i);
  });

  it("refuses self-approval of a package", async () => {
    const pkg = await createPackage(openProject, { title: "Self approval" });
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("freezes the evaluation basis once the package is issued", async () => {
    const pkg = await createPackage(openProject, {
      title: "Frozen basis",
      priceWeight: 60,
      qualityWeight: 40,
      evaluationCriteria: [{ key: "method", label: "Method", weight: 100, kind: "quality" }],
    });
    await issuePackage(openProject, pkg.id);
    const res = await patch(`/projects/${openProject}/bid-packages/${pkg.id}`, {
      priceWeight: 90,
      qualityWeight: 10,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/cannot be changed once the package has been issued/i);
    // a non-basis field is still editable
    const ok = await patch(`/projects/${openProject}/bid-packages/${pkg.id}`, {
      scopeDescription: "Revised scope narrative",
    });
    expect(ok.statusCode).toBe(200);
  });

  it("issues an addendum, extends the deadline and tracks acknowledgement", async () => {
    const pkg = await createPackage(openProject, { title: "Addenda" });
    await issuePackage(openProject, pkg.id);
    const invite = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/invitations`,
      { vendorId: alpha },
    );
    const invitationId = invite.json().items[0].id;

    const shortened = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/addenda`,
      { reference: "ADD-01", description: "Revised drainage layout", newBidDueAt: isoIn(-HOUR) },
    );
    expect(shortened.statusCode).toBe(400);
    expect(shortened.json().message).toMatch(/never shorten/i);

    const added = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/addenda`,
      { reference: "ADD-01", description: "Revised drainage layout", newBidDueAt: isoIn(48 * HOUR) },
    );
    expect(added.statusCode).toBe(201);
    expect(added.json().addendaCount).toBe(1);

    const before = await get(`/projects/${openProject}/bid-packages/${pkg.id}/addenda`);
    expect(before.json().items[0].outstandingFrom).toEqual([alpha]);

    const ack = await post(`/bid-invitations/${invitationId}/acknowledge-addendum`, {
      addendumRef: "ADD-01",
    });
    expect(ack.statusCode).toBe(200);
    const after = await get(`/projects/${openProject}/bid-packages/${pkg.id}/addenda`);
    expect(after.json().items[0].acknowledgedBy).toEqual([alpha]);
    expect(after.json().items[0].outstandingFrom).toEqual([]);
  });

  it("keeps another company's packages invisible", async () => {
    const pkg = await createPackage(openProject, { title: "Tenant isolation" });
    const res = await get(`/projects/${openProject}/bid-packages/${pkg.id}`, stranger.headers);
    expect(res.statusCode).toBe(403);
  });

  it("gives a read-only project member read but not write", async () => {
    const pkg = await createPackage(permProject, { title: "Permissions" });
    expect((await get(`/projects/${permProject}/bid-packages/${pkg.id}`, viewerHeaders)).statusCode).toBe(200);
    const res = await post(
      `/projects/${permProject}/bid-packages`,
      { title: "Nope", bidDueAt: isoIn(HOUR) },
      viewerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* 2. THE SEALED-BID CONTROL                                           */
/* ================================================================== */

describe("sealed bidding is a control, not a flag", () => {
  let pkg: { id: string };
  let alphaBid: { id: string };
  let bravoBid: { id: string };

  beforeAll(async () => {
    pkg = await createPackage(sealProject, {
      title: "Sealed piling package",
      isSealed: true,
      // the deadline has passed, so the ONLY thing standing between the
      // amounts and a reader is the recorded opening
      bidDueAt: isoIn(-HOUR),
      priceWeight: 60,
      qualityWeight: 40,
      evaluationCriteria: [{ key: "method", label: "Method", weight: 100, kind: "quality" }],
    });
    await issuePackage(sealProject, pkg.id);
    alphaBid = await submitBid(sealProject, pkg.id, alpha, {
      baseBidAmount: 412_500,
      receivedAt: isoIn(-3 * HOUR),
      sealedFileId: "file_alpha",
      sealedSha256: "a".repeat(64),
      lines: [{ description: "Piling", amount: 412_500, unitRate: 55, quantity: 7500 }],
    });
    bravoBid = await submitBid(sealProject, pkg.id, bravo, {
      baseBidAmount: 398_000,
      receivedAt: isoIn(-3 * HOUR),
    });
  });

  it("stores the amount but withholds it from the package detail", async () => {
    const [row] = await app.db
      .select()
      .from(bidSubmissions)
      .where(eq(bidSubmissions.id, alphaBid.id));
    expect(row!.totalAmount).toBe(412_500); // it IS on the record

    const res = await get(`/projects/${sealProject}/bid-packages/${pkg.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.seal.amountsWithheld).toBe(true);
    for (const s of body.submissions) {
      expect(s.sealed).toBe(true);
      expect(s.totalAmount).toBeNull();
      expect(s.baseBidAmount).toBeNull();
      expect(s.withheldFields).toContain("totalAmount");
    }
    expect(JSON.stringify(body)).not.toContain("412500");
  });

  it("withholds the amount from the submission list", async () => {
    const res = await get(`/projects/${sealProject}/bid-packages/${pkg.id}/submissions`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((s: { totalAmount: null }) => s.totalAmount === null)).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain("398000");
  });

  it("withholds the amount from the submission detail", async () => {
    const res = await get(`/bid-submissions/${alphaBid.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().totalAmount).toBeNull();
    expect(res.json().sealNote).toMatch(/withheld|Sealed until|unread bid/i);
  });

  it("withholds the priced lines — a unit rate is a price", async () => {
    const res = await get(`/bid-submissions/${alphaBid.id}/lines`);
    expect(res.statusCode).toBe(200);
    expect(res.json().sealed).toBe(true);
    expect(res.json().items).toEqual([]);
    expect(res.json().total).toBe(1); // the line EXISTS; it is withheld, not absent
    expect(JSON.stringify(res.json())).not.toContain("unitRate");
    expect(JSON.stringify(res.json())).not.toContain("412500");
  });

  it("withholds the levelling grid, the scoring and the tabulation", async () => {
    const grid = await get(`/projects/${sealProject}/bid-packages/${pkg.id}/levelling/grid`);
    expect(grid.json().sealed).toBe(true);
    expect(grid.json().comparison).toBeNull();

    const scoring = await get(`/projects/${sealProject}/bid-packages/${pkg.id}/scoring`);
    expect(scoring.json().sealed).toBe(true);
    expect(scoring.json().rows).toEqual([]);

    const tab = await get(`/projects/${sealProject}/bid-packages/${pkg.id}/tabulation`);
    expect(tab.json().seal.amountsWithheld).toBe(true);
    expect(tab.json().market.lowest.value).toBeNull();
    expect(JSON.stringify(tab.json())).not.toContain("412500");
  });

  it("refuses every analysis that would read a sealed price", async () => {
    for (const [url, payload] of [
      [`/projects/${sealProject}/bid-packages/${pkg.id}/levelling/entries`, {
        levellingItemId: "x",
        submissionId: alphaBid.id,
        includedStatus: "included",
      }],
      [`/projects/${sealProject}/bid-packages/${pkg.id}/scoring/compute`, {}],
      [`/projects/${sealProject}/bid-packages/${pkg.id}/award/recommend`, {
        submissionId: alphaBid.id,
        recommendationBasis: "They are the cheapest bidder on this package by some way.",
      }],
    ] as const) {
      const res = await post(url, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/sealed/i);
    }
  });

  it("refuses an opening with no witness where the package requires one", async () => {
    const res = await post(`/projects/${sealProject}/bid-packages/${pkg.id}/open`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/requires a witness and none was named/i);
  });

  it("refuses an opening witnessed by the opener", async () => {
    const res = await post(`/projects/${sealProject}/bid-packages/${pkg.id}/open`, {
      witnessUserId: owner.userId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/witness who is the opener witnesses nothing/i);
  });

  it("records the opening, ledgers it, and only then releases the amounts", async () => {
    const res = await post(`/projects/${sealProject}/bid-packages/${pkg.id}/open`, {
      witnessUserId: approver.userId,
      witnessName: "R. Patel, Commercial Manager",
      note: "Opened in the project office.",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.opening.openedBy).toBe(owner.userId);
    expect(body.opening.witnessedBy).toBe(approver.userId);
    expect(body.opening.bidsOpened).toBe(2);
    expect(body.seal.amountsWithheld).toBe(false);

    // the opening is a LEDGERED event carrying both people and the envelopes
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "bid_package"),
          eq(ledgerEntries.objectId, pkg.id),
        ),
      );
    const opening = entries.find(
      (e) => (e.payload as { event?: string } | null)?.event === "sealed_bid_opening",
    );
    expect(opening).toBeTruthy();
    const payload = opening!.payload as Record<string, unknown>;
    expect(payload["openedBy"]).toBe(owner.userId);
    expect(payload["witnessedBy"]).toBe(approver.userId);
    expect(payload["witnessRequired"]).toBe(true);
    expect(payload["bidsInTheRoom"]).toBe(2);
    expect(payload["sealedHashes"]).toEqual(
      expect.arrayContaining([{ id: alphaBid.id, sha256: "a".repeat(64) }]),
    );
    expect(opening!.entryHash).toBeTruthy();

    const detail = await get(`/bid-submissions/${alphaBid.id}`);
    expect(detail.json().totalAmount).toBe(412_500);
    expect(detail.json().sealed).toBe(false);

    const lines = await get(`/bid-submissions/${alphaBid.id}/lines`);
    expect(lines.json().items).toHaveLength(1);
    expect(lines.json().items[0].amount).toBe(412_500);

    const tab = await get(`/projects/${sealProject}/bid-packages/${pkg.id}/tabulation`);
    expect(tab.json().market.lowest.value).toBe(398_000);
  });

  it("refuses a second opening", async () => {
    const res = await post(`/projects/${sealProject}/bid-packages/${pkg.id}/open`, {
      witnessUserId: approver.userId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already opened/i);
  });

  it("refuses an opening before the seal is due to lift", async () => {
    const early = await createPackage(sealProject, {
      title: "Not yet due",
      isSealed: true,
      bidDueAt: isoIn(4 * HOUR),
      sealedUntil: isoIn(6 * HOUR),
    });
    const res = await post(`/projects/${sealProject}/bid-packages/${early.id}/open`, {
      witnessUserId: approver.userId,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/does not lift until/i);
  });

  it("permits a lone opener only where the witness was deliberately waived", async () => {
    const waived = await createPackage(sealProject, {
      title: "Witness waived",
      isSealed: true,
      bidDueAt: isoIn(-HOUR),
      requiresOpeningWitness: false,
    });
    const res = await post(`/projects/${sealProject}/bid-packages/${waived.id}/open`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().seal.requiresWitness).toBe(false);
    expect(res.json().opening.witnessedBy).toBeNull();
  });

  it("refuses to record an opening on a package that was never sealed", async () => {
    const plain = await createPackage(sealProject, { title: "Never sealed", bidDueAt: isoIn(-HOUR) });
    const res = await post(`/projects/${sealProject}/bid-packages/${plain.id}/open`, {
      witnessUserId: approver.userId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not sealed/i);
  });
});

/* ================================================================== */
/* 3. Submissions, lateness and the totals rules                       */
/* ================================================================== */

describe("submissions", () => {
  it("reconciles the headline figure against the priced lines", async () => {
    const pkg = await createPackage(openProject, { title: "Line reconciliation" });
    await issuePackage(openProject, pkg.id);
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 100_000,
      currency: "GBP",
      lines: [
        { description: "Dig", amount: 60_000 },
        { description: "Beams", amount: 30_000 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/does not equal the sum of the priced lines/i);
  });

  it("excludes unaccepted alternates and never re-adds provisional sums", async () => {
    const pkg = await createPackage(openProject, { title: "Totals" });
    await issuePackage(openProject, pkg.id);
    const bid = await submitBid(openProject, pkg.id, alpha, {
      baseBidAmount: 200_000,
      provisionalSumsTotal: 25_000,
      allowancesTotal: 10_000,
      alternates: [
        { label: "Alt 1 — deeper piles", amount: 18_000, accepted: true },
        { label: "Alt 2 — imported fill", amount: 9_000, accepted: false },
      ],
    });
    expect(bid.alternatesTotal).toBe(18_000);
    // 200,000 + 18,000 accepted alternate; PS and allowances are INSIDE the base
    expect(bid.totalAmount).toBe(218_000);
    expect(bid.totalsNotes.join(" ")).toMatch(/components of the base bid/i);
  });

  it("refuses a measured line whose amount disagrees with quantity x rate", async () => {
    const pkg = await createPackage(openProject, { title: "Measured line" });
    await issuePackage(openProject, pkg.id);
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      currency: "GBP",
      lines: [{ description: "Piling", quantity: 100, unitRate: 55, amount: 6_000 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/quantity x rate/i);
  });

  it("flags a late bid with the lateness in minutes", async () => {
    const pkg = await createPackage(openProject, { title: "Late bids", bidDueAt: isoIn(-2 * HOUR) });
    await issuePackage(openProject, pkg.id);
    const bid = await submitBid(openProject, pkg.id, alpha, {
      receivedAt: isoIn(-HOUR),
      baseBidAmount: 150_000,
    });
    expect(bid.lateness.isLate).toBe(true);
    expect(bid.lateness.lateByMinutes).toBeGreaterThanOrEqual(59);
    expect(bid.lateness.accepted).toBe(false);
  });

  it("refuses to level, score or award a late bid nobody has accepted", async () => {
    const pkg = await createPackage(openProject, { title: "Late gate", bidDueAt: isoIn(-2 * HOUR) });
    await issuePackage(openProject, pkg.id);
    const late = await submitBid(openProject, pkg.id, alpha, { receivedAt: isoIn(-HOUR) });
    const items = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/items`, {
      description: "Everything",
      itemCode: "A10",
    });
    const itemId = items.json().items[0].id;
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`, {
      levellingItemId: itemId,
      submissionId: late.id,
      includedStatus: "included",
      asBidAmount: 170_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/no one has accepted it late/i);
  });

  it("requires a recorded reason to accept a late bid, and refuses a bare one", async () => {
    const pkg = await createPackage(openProject, { title: "Late accept", bidDueAt: isoIn(-2 * HOUR) });
    await issuePackage(openProject, pkg.id);
    const late = await submitBid(openProject, pkg.id, bravo, { receivedAt: isoIn(-HOUR) });

    const noReason = await post(`/bid-submissions/${late.id}/accept-late`, {});
    expect(noReason.statusCode).toBe(400);
    const thin = await post(`/bid-submissions/${late.id}/accept-late`, { reason: "ok" });
    expect(thin.statusCode).toBe(400);

    const accepted = await post(`/bid-submissions/${late.id}/accept-late`, {
      reason:
        "The courier was held at the site gate for eleven minutes by a delivery; the envelope " +
        "was time-stamped at the gatehouse before the deadline.",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().lateness.accepted).toBe(true);
    expect(accepted.json().lateness.acceptedBy).toBe(owner.userId);
    expect(accepted.json().lateness.acceptanceReason).toMatch(/gatehouse/);
  });

  it("refuses a late acceptance on a bid that was not late", async () => {
    const pkg = await createPackage(openProject, { title: "Not late" });
    await issuePackage(openProject, pkg.id);
    const onTime = await submitBid(openProject, pkg.id, alpha);
    const res = await post(`/bid-submissions/${onTime.id}/accept-late`, {
      reason: "This bid was perfectly punctual but we would like to say otherwise.",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/was not late/i);
  });

  it("reports insurance and bond compliance by READING the insurance register", async () => {
    const pkg = await createPackage(openProject, {
      title: "Compliance",
      requiredBonds: [{ bondType: "performance", percent: 10, required: true }],
      insuranceRequirements: [
        { policyType: "third_party_liability", limit: 5_000_000, currency: "GBP", required: true },
      ],
    });
    await issuePackage(openProject, pkg.id);
    const bid = await submitBid(openProject, pkg.id, charlie);
    expect(bid.compliance.satisfied).toBe(false);
    const findings = bid.compliance.findings as { requirement: string; satisfied: boolean; detail: string }[];
    expect(findings.find((f) => f.requirement.includes("performance"))!.satisfied).toBe(false);
    expect(findings.find((f) => f.requirement.includes("third_party_liability"))!.detail).toMatch(
      /no certificate of this cover is held/i,
    );
  });
});

/* ================================================================== */
/* 4. Invitations and the bidder portal                                */
/* ================================================================== */

describe("invitations and the bidder portal", () => {
  it("tracks delivery, engagement, decline reasons and reminders", async () => {
    const pkg = await createPackage(openProject, { title: "Engagement" });
    await issuePackage(openProject, pkg.id);
    const created = await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, {
      invitations: [{ vendorId: alpha, contactEmail: "estimating@alpha.test" }, { vendorId: bravo }],
    });
    expect(created.statusCode).toBe(201);
    const [a, b] = created.json().items as { id: string }[];

    expect((await post(`/bid-invitations/${a!.id}/send`)).json().status).toBe("sent");
    expect((await post(`/bid-invitations/${a!.id}/delivery`, { delivered: true })).json().status).toBe("delivered");
    expect((await post(`/bid-invitations/${a!.id}/download`)).json().downloadCount).toBe(1);
    expect((await post(`/bid-invitations/${a!.id}/remind`)).json().remindersSent).toBe(1);

    await post(`/bid-invitations/${b!.id}/send`);
    const declined = await post(`/bid-invitations/${b!.id}/decline`, {
      reason: "insufficient_time",
      note: "Four working days is not enough to price piling.",
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().declineReason).toBe("insufficient_time");

    const list = await get(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`);
    expect(list.json().summary.declined).toBe(1);
    const detail = await get(`/projects/${openProject}/bid-packages/${pkg.id}`);
    expect(detail.json().declineCount).toBe(1);
  });

  it("refuses a duplicate invitation to the same vendor", async () => {
    const pkg = await createPackage(openProject, { title: "Duplicate invite" });
    await issuePackage(openProject, pkg.id);
    await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, { vendorId: alpha });
    const again = await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, {
      vendorId: alpha,
    });
    expect(again.statusCode).toBe(409);
  });

  it("mints a portal token once, stores only its hash, and never shows it again", async () => {
    const pkg = await createPackage(openProject, { title: "Portal" });
    await issuePackage(openProject, pkg.id);
    const invite = await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, {
      vendorId: charlie,
    });
    const invitationId = invite.json().items[0].id as string;
    await post(`/bid-invitations/${invitationId}/send`);

    const minted = await post(`/bid-invitations/${invitationId}/portal-token`);
    expect(minted.statusCode).toBe(201);
    const token = minted.json().token as string;
    expect(token).toMatch(/^bpt_[0-9a-f]{40}$/);

    const detail = await get(`/bid-invitations/${invitationId}`);
    expect(detail.json().portalAccessIssued).toBe(true);
    expect(detail.json().portalTokenHash).toBeUndefined();
    expect(JSON.stringify(detail.json())).not.toContain(token);

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/session",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(session.statusCode).toBe(200);
    const view = session.json();
    expect(view.package.reference).toBe(pkg.reference);
    // the bidder never sees the pre-tender estimate or any other bidder
    expect(view.package.engineersEstimate).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("165000");
  });

  it("refuses a bad portal token and a revoked one", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/session",
      headers: { authorization: "Bearer bpt_deadbeef" },
      payload: {},
    });
    expect(bad.statusCode).toBe(401);

    const pkg = await createPackage(openProject, { title: "Revoked portal" });
    await issuePackage(openProject, pkg.id);
    const invite = await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, {
      vendorId: alpha,
    });
    const invitationId = invite.json().items[0].id as string;
    const token = (await post(`/bid-invitations/${invitationId}/portal-token`)).json().token;
    expect((await del(`/bid-invitations/${invitationId}/portal-token`)).statusCode).toBe(204);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/session",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(after.statusCode).toBe(401);
  });

  it("lets a bidder decline through the portal, but only with a reason", async () => {
    const pkg = await createPackage(openProject, { title: "Portal decline" });
    await issuePackage(openProject, pkg.id);
    const invite = await post(`/projects/${openProject}/bid-packages/${pkg.id}/invitations`, {
      vendorId: bravo,
    });
    const invitationId = invite.json().items[0].id as string;
    const token = (await post(`/bid-invitations/${invitationId}/portal-token`)).json().token;
    const headers = { authorization: `Bearer ${token}` };

    const noReason = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/intent",
      headers,
      payload: { intentToBid: false },
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toMatch(/Declining requires a reason/i);

    const declined = await app.inject({
      method: "POST",
      url: "/api/v1/bid-portal/intent",
      headers,
      payload: { intentToBid: false, declineReason: "capacity" },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().invitation.status).toBe("declined");
  });
});

/* ================================================================== */
/* 5. Levelling through the routes                                     */
/* ================================================================== */

describe("levelling", () => {
  let pkg: { id: string; reference: string };
  let bidA: { id: string };
  let bidB: { id: string };
  let items: { id: string; itemCode: string }[];

  beforeAll(async () => {
    pkg = await createPackage(openProject, {
      title: "Levelled piling package",
      engineersEstimate: 165_000,
      priceWeight: 60,
      qualityWeight: 40,
      evaluationCriteria: [
        { key: "method", label: "Method statement", weight: 60, kind: "quality" },
        { key: "programme", label: "Programme", weight: 40, kind: "quality" },
      ],
    });
    await issuePackage(openProject, pkg.id);
    bidA = await submitBid(openProject, pkg.id, alpha, { baseBidAmount: 170_000 });
    bidB = await submitBid(openProject, pkg.id, bravo, { baseBidAmount: 116_000 });
    const created = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/items`, {
      items: [
        { itemCode: "A10", description: "Groundworks", engineersEstimate: 100_000 },
        { itemCode: "A20", description: "Scaffold", engineersEstimate: 55_000 },
        { itemCode: "A30", description: "Drainage PS", category: "provisional_sum" },
        { itemCode: "X10", description: "Temporary works design", category: "exclusion_check" },
      ],
    });
    items = created.json().items;
  });

  const item = (code: string) => items.find((i) => i.itemCode === code)!.id;

  it("refuses an adjustment with no stated reason", async () => {
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`, {
      levellingItemId: item("A10"),
      submissionId: bidA.id,
      includedStatus: "included",
      asBidAmount: 100_000,
      adjustmentAmount: -5_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/carries no reason/i);
  });

  it("refuses completeness while a contender has an unpriced mandatory row", async () => {
    await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`, {
      entries: [
        { levellingItemId: item("A10"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 100_000 },
        { levellingItemId: item("A20"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 50_000 },
        { levellingItemId: item("A30"), submissionId: bidA.id, includedStatus: "included", asBidAmount: 20_000 },
        { levellingItemId: item("X10"), submissionId: bidA.id, includedStatus: "included" },
      ],
    });
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/complete`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/not complete and cannot be declared so/i);
    expect(res.json().message).toContain("A10");
  });

  it("shows coverage — which bidders priced which rows", async () => {
    const grid = await get(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/grid`);
    const coverage = grid.json().coverage as { itemCode: string; coveredBy: string[]; missingFrom: string[] }[];
    expect(coverage.find((c) => c.itemCode === "A10")!.coveredBy).toEqual([bidA.id]);
    expect(coverage.find((c) => c.itemCode === "A10")!.missingFrom).toEqual([bidB.id]);
    expect(grid.json().complete).toBe(false);
  });

  it("refuses to treat an exclusion with no adjustment as free scope", async () => {
    await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`, {
      entries: [
        { levellingItemId: item("A10"), submissionId: bidB.id, includedStatus: "included", asBidAmount: 95_000 },
        { levellingItemId: item("A20"), submissionId: bidB.id, includedStatus: "excluded" },
        { levellingItemId: item("A30"), submissionId: bidB.id, includedStatus: "included", asBidAmount: 21_000 },
        { levellingItemId: item("X10"), submissionId: bidB.id, includedStatus: "excluded" },
      ],
    });
    const res = await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/complete`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/treat the missing scope as free|excluded the most/i);
  });

  it("levels the exclusion, completes, and freezes the comparable amounts", async () => {
    const adjusted = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`,
      {
        levellingItemId: item("A20"),
        submissionId: bidB.id,
        includedStatus: "excluded",
        adjustmentAmount: 62_000,
        adjustmentReason: "scope_gap",
        adjustmentNote: "Scaffold excluded; priced from the framework scaffolder's schedule.",
      },
    );
    expect(adjusted.json().items[0].levelledAmount).toBe(62_000);

    const grid = await get(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/grid`);
    expect(grid.json().complete).toBe(true);
    expect(grid.json().ranking).toEqual([
      { submissionId: bidA.id, levelledAmount: 170_000, rank: 1 },
      { submissionId: bidB.id, levelledAmount: 178_000, rank: 2 },
    ]);

    const completed = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/levelling/complete`,
      {},
    );
    expect(completed.statusCode).toBe(200);
    const [rowB] = await app.db.select().from(bidSubmissions).where(eq(bidSubmissions.id, bidB.id));
    // as bid, B looked GBP 54,000 cheaper; levelled, it is GBP 8,000 dearer
    expect(rowB!.totalAmount).toBe(116_000);
    expect(rowB!.normalisedAmount).toBe(178_000);
  });

  it("refuses a levelling review by the person who made the adjustment", async () => {
    const grid = await get(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/grid`);
    const entryId = (
      await post(`/projects/${openProject}/bid-packages/${pkg.id}/levelling/entries`, {
        levellingItemId: item("A30"),
        submissionId: bidB.id,
        includedStatus: "included",
        asBidAmount: 21_000,
      })
    ).json().items[0].id as string;
    expect(grid.statusCode).toBe(200);

    const self = await post(`/bid-levelling-entries/${entryId}/review`);
    expect(self.statusCode).toBe(403);
    expect(self.json().details.role).toBe("adjustedBy");

    const other = await post(`/bid-levelling-entries/${entryId}/review`, {}, approver.headers);
    expect(other.statusCode).toBe(200);
    expect(other.json().reviewedBy).toBe(approver.userId);
  });

  it("refuses to delete a scope row that already carries bidder answers", async () => {
    const res = await del(`/bid-levelling-items/${item("A10")}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/erase what those bidders said/i);
  });

  /* ---------------- scoring ---------------- */

  it("produces a NULL total with the criterion named where a bidder is unscored", async () => {
    await post(`/bid-submissions/${bidA.id}/scores`, {
      scores: [
        { key: "method", score: 8, maxScore: 10 },
        { key: "programme", score: 6, maxScore: 10 },
      ],
    });
    await post(`/bid-submissions/${bidB.id}/scores`, {
      scores: [{ key: "method", score: 9, maxScore: 10 }],
    });
    const computed = await post(
      `/projects/${openProject}/bid-packages/${pkg.id}/scoring/compute`,
      {},
    );
    expect(computed.statusCode).toBe(200);
    const rows = computed.json().rows as {
      submissionId: string;
      totalScore: { value: number | null; reasons: string[] };
      technicalScore: { value: number | null };
    }[];
    const a = rows.find((r) => r.submissionId === bidA.id)!;
    const b = rows.find((r) => r.submissionId === bidB.id)!;
    expect(a.technicalScore.value).toBe(72);
    expect(a.totalScore.value).toBe(88.8);
    expect(b.totalScore.value).toBeNull();
    expect(b.totalScore.reasons.join(" ")).toContain("Programme");
    expect(computed.json().unscored).toHaveLength(1);

    // and the NULL is what is stored — never a zero
    const [rowB] = await app.db.select().from(bidSubmissions).where(eq(bidSubmissions.id, bidB.id));
    expect(rowB!.totalScore).toBeNull();
    expect(rowB!.rank).toBeNull();
  });

  it("refuses a score against a criterion the tender never declared", async () => {
    const res = await post(`/bid-submissions/${bidA.id}/scores`, {
      scores: [{ key: "we_like_them", score: 10, maxScore: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not a declared evaluation criterion/i);
  });
});

/* ================================================================== */
/* 6. Award                                                            */
/* ================================================================== */

describe("award", () => {
  /**
   * THE CROSS-PACKAGE DETECTORS FIRE ON THIS FIXTURE, AND THAT IS CORRECT.
   *
   * Two vendors bidding against each other on a dozen packages inside one
   * company, with one of them winning repeatedly, is exactly the pattern the
   * cover-bidding and winner-rotation detectors exist to raise. The control
   * is not "no findings"; it is "an open high or critical finding must be
   * ACKNOWLEDGED IN WRITING before a bidder is recommended". So the tests
   * acknowledge, in the words a buyer would use — and the one test that
   * checks the refusal itself lives in bidding-upgrade.test.ts.
   */
  const ACK =
    "The bidder overlap across these packages was checked against the company's tender log: " +
    "this is a small trade with four capable firms in the region, the prices differ by more " +
    "than the field's spread, and no relationship between the bidders is on the record.";

  /**
   * NO PRE-TENDER ESTIMATE UNLESS THE TEST IS ABOUT ONE.
   *
   * An estimate turns every bid into a measurable deviation from it, and a
   * fixture that quietly makes every bid 20% "abnormally low" tests the
   * abnormally-low control instead of whatever the test was written for —
   * the control has its own tests in bidding-upgrade.test.ts. Tests that
   * need an estimate state one, and then their bids sit inside its band.
   */
  async function levelledPackage(
    title: string,
    amounts: { vendorId: string; amount: number }[],
    estimate: number | null = null,
  ) {
    const pkg = await createPackage(awardProject, { title, engineersEstimate: estimate });
    await issuePackage(awardProject, pkg.id);
    const bids = [];
    for (const a of amounts) {
      bids.push(await submitBid(awardProject, pkg.id, a.vendorId, { baseBidAmount: a.amount }));
    }
    return { pkg, bids };
  }

  it("refuses a not-lowest recommendation without a written justification", async () => {
    const { pkg, bids } = await levelledPackage(
      "Not lowest",
      [
        { vendorId: alpha, amount: 190_000 },
        { vendorId: bravo, amount: 175_000 },
      ],
      200_000,
    );
    const res = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis:
        "Alpha's method statement is materially better and their team is already on site.",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.control).toBe("not_lowest_requires_justification");
    expect(res.json().details.lowestBidAmount).toBe(175_000);
    expect(res.json().message).toMatch(/REQUIRES a written justification/i);
  });

  it("records the justification AND the lowest bid amount when the lowest is not taken", async () => {
    const { pkg, bids } = await levelledPackage(
      "Justified",
      [
        { vendorId: alpha, amount: 190_000 },
        { vendorId: bravo, amount: 175_000 },
      ],
      200_000,
    );
    const res = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis:
        "Alpha's method statement is materially better and their team is already on site.",
      notLowestJustification:
        "Bravo's price excludes the temporary works design and their programme is six weeks " +
        "longer, which costs more in preliminaries than the GBP 15,000 headline difference.",
      integrityAcknowledgement: ACK,
      standstillDays: 10,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.isLowestBid).toBe(false);
    expect(body.lowestBidAmount).toBe(175_000);
    expect(body.awardAmount).toBe(190_000);
    expect(body.audit.notLowestJustification).toMatch(/temporary works design/);
    expect(body.audit.comparisonBasis).toBe("as_bid");
    expect(body.savingAgainstEstimate).toBe(10_000);
  });

  it("marks a lowest-bid recommendation as such and still records the lowest amount", async () => {
    const { pkg, bids } = await levelledPackage("Lowest", [
      { vendorId: alpha, amount: 210_000 },
      { vendorId: bravo, amount: 180_000 },
    ]);
    const res = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[1]!.id,
      recommendationBasis: "Bravo is the lowest compliant bid and their programme fits the works.",
      integrityAcknowledgement: ACK,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().isLowestBid).toBe(true);
    expect(res.json().lowestBidAmount).toBe(180_000);
  });

  it("refuses to compare bids priced in different currencies", async () => {
    const pkg = await createPackage(awardProject, { title: "Two currencies" });
    await issuePackage(awardProject, pkg.id);
    const gbp = await submitBid(awardProject, pkg.id, alpha, { baseBidAmount: 100_000, currency: "GBP" });
    await submitBid(awardProject, pkg.id, bravo, { baseBidAmount: 100_000, currency: "USD" });
    const res = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: gbp.id,
      recommendationBasis: "They are the only bidder we can actually compare on this package.",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/never ranks figures in different currencies/i);
  });

  it("refuses approval by the recommender, and accepts it from anyone else", async () => {
    const { pkg, bids } = await levelledPackage("Segregation", [
      { vendorId: alpha, amount: 160_000 },
      { vendorId: bravo, amount: 180_000 },
    ]);
    const award = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis: "Alpha is the lowest bid and is compliant on every requirement.",
      integrityAcknowledgement: ACK,
    });
    expect(award.statusCode).toBe(201);
    const awardId = award.json().id as string;

    const self = await post(`/bid-awards/${awardId}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().details.control).toBe("no_self_approval");

    const other = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(other.statusCode).toBe(200);
    expect(other.json().audit.segregated).toBe(true);
  });

  it("creates a real commitment on approval and hangs it off commitmentId", async () => {
    const { pkg, bids } = await levelledPackage("Handoff", [
      { vendorId: charlie, amount: 143_250 },
      { vendorId: bravo, amount: 199_000 },
    ]);
    const award = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis: "Charlie is the lowest compliant bid with the best programme fit.",
      scopeSummary: "Piling, ground beams and drainage as tendered.",
      integrityAcknowledgement: ACK,
    });
    const awardId = award.json().id as string;
    const approved = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(approved.statusCode).toBe(200);

    const commitmentId = approved.json().commitmentId as string;
    expect(commitmentId).toBeTruthy();
    expect(approved.json().commitmentCreated.reference).toMatch(/^SC-\d{4}$/);

    const [row] = await app.db.select().from(commitments).where(eq(commitments.id, commitmentId));
    expect(row!.vendorId).toBe(charlie);
    expect(row!.currency).toBe("GBP");
    // the sum is the SOV, derived by the commitments module — not typed here
    expect(row!.originalCommitmentSum).toBe(143_250);
    expect(row!.revisedCommitmentSum).toBe(143_250);
    expect((row!.detail as Record<string, unknown>)["sourceBidAwardId"]).toBe(awardId);

    const sov = await app.db
      .select()
      .from(commitmentSovLines)
      .where(eq(commitmentSovLines.commitmentId, commitmentId));
    expect(sov).toHaveLength(1);
    expect(sov[0]!.scheduledValue).toBe(143_250);

    // and it is a real commitment as far as the commitments module is concerned
    const viaCommitments = await get(`/commitments/${commitmentId}`);
    expect(viaCommitments.statusCode).toBe(200);
    expect(viaCommitments.json().commitment.reference).toBe(
      approved.json().commitmentCreated.reference,
    );
    expect(viaCommitments.json().sovLines).toHaveLength(1);

    // the losers are marked unsuccessful and the package is awarded
    const pkgAfter = await get(`/projects/${awardProject}/bid-packages/${pkg.id}`);
    expect(pkgAfter.json().status).toBe("awarded");
    expect(pkgAfter.json().awardedVendorId).toBe(charlie);
    expect(
      pkgAfter.json().submissions.find((s: { id: string }) => s.id === bids[1]!.id).status,
    ).toBe("unsuccessful");
  });

  it("notifies the unsuccessful bidders and blocks contract issue during standstill", async () => {
    const { pkg, bids } = await levelledPackage("Standstill", [
      { vendorId: alpha, amount: 120_000 },
      { vendorId: bravo, amount: 150_000 },
    ]);
    const award = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis: "Alpha is the lowest compliant bid on a like-for-like basis.",
      integrityAcknowledgement: ACK,
      standstillDays: 10,
    });
    const awardId = award.json().id as string;

    const early = await post(`/bid-awards/${awardId}/notify-unsuccessful`, {});
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toMatch(/after the award is approved/i);

    await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    const notified = await post(`/bid-awards/${awardId}/notify-unsuccessful`, {});
    expect(notified.statusCode).toBe(200);
    expect(notified.json().notified).toBe(1);
    expect(notified.json().standstill.active).toBe(true);

    const issued = await post(`/bid-awards/${awardId}/contract-issued`, {});
    expect(issued.statusCode).toBe(409);
    expect(issued.json().message).toMatch(/standstill period/i);
  });

  it("refuses an uncapped letter of intent", async () => {
    const { pkg, bids } = await levelledPackage("LOI", [{ vendorId: alpha, amount: 90_000 }]);
    const award = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis: "Sole compliant bidder on a negotiated package with an agreed price.",
      integrityAcknowledgement: ACK,
    });
    const awardId = award.json().id as string;
    await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    const uncapped = await post(`/bid-awards/${awardId}/letter-of-intent`, {});
    expect(uncapped.statusCode).toBe(400);
    expect(uncapped.json().message).toMatch(/needs a financial cap/i);
    const over = await post(`/bid-awards/${awardId}/letter-of-intent`, { cap: 100_000 });
    expect(over.statusCode).toBe(400);
    const ok = await post(`/bid-awards/${awardId}/letter-of-intent`, { cap: 20_000 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().letterOfIntentCap).toBe(20_000);
  });

  it("refuses a second live award on the same package", async () => {
    const { pkg, bids } = await levelledPackage("One award", [
      { vendorId: alpha, amount: 111_000 },
      { vendorId: bravo, amount: 122_000 },
    ]);
    await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[0]!.id,
      recommendationBasis: "Alpha is the lowest compliant bid on this package.",
      integrityAcknowledgement: ACK,
    });
    const second = await post(`/projects/${awardProject}/bid-packages/${pkg.id}/award/recommend`, {
      submissionId: bids[1]!.id,
      recommendationBasis: "We changed our minds after seeing the prices, which is the problem.",
      notLowestJustification:
        "This justification exists purely to get past the not-lowest gate in this test case.",
      integrityAcknowledgement: ACK,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/already carries award/i);
  });
});

/* ================================================================== */
/* 7. Prequalification                                                 */
/* ================================================================== */

describe("prequalification", () => {
  const BASE = "/companies/current/prequalification";
  let questionnaireId: string;
  let knockoutQuestionId: string;
  let scoredQuestionId: string;

  beforeAll(async () => {
    const created = await post(`${BASE}/questionnaires`, {
      name: "Standard supply-chain PQQ 2026",
      validityMonths: 12,
      passThreshold: 60,
      categories: ["financial", "health_safety"],
    });
    expect(created.statusCode).toBe(201);
    questionnaireId = created.json().id;

    const questions = await post(`${BASE}/questionnaires/${questionnaireId}/questions`, {
      questions: [
        {
          questionCode: "Q1",
          text: "Has the company entered administration, receivership or a CVA in the last three years?",
          category: "financial",
          itemType: "yes_no",
          isKnockout: true,
          knockoutValue: "yes",
          weight: 1,
          maxScore: 10,
        },
        {
          questionCode: "Q2",
          text: "Describe your health and safety management system.",
          category: "health_safety",
          itemType: "long_text",
          weight: 2,
          maxScore: 10,
        },
      ],
    });
    expect(questions.statusCode).toBe(201);
    knockoutQuestionId = questions.json().items[0].id;
    scoredQuestionId = questions.json().items[1].id;
  });

  it("refuses to activate a questionnaire written by the activator", async () => {
    const res = await post(`${BASE}/questionnaires/${questionnaireId}/activate`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().details.control).toBe("no_self_approval");
  });

  it("activates a questionnaire when someone else approves it", async () => {
    const res = await post(
      `${BASE}/questionnaires/${questionnaireId}/activate`,
      {},
      approver.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("active");
    expect(res.json().approvedBy).toBe(approver.userId);
  });

  it("refuses to edit an active questionnaire", async () => {
    const res = await patch(`${BASE}/questionnaires/${questionnaireId}`, { passThreshold: 10 });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/would silently change what those assessments mean/i);
  });

  it("validates answers against the shared typed-item vocabulary", async () => {
    const invited = await post(`${BASE}/submissions`, { questionnaireId, vendorId: charlie });
    const submissionId = invited.json().id as string;
    const res = await post(`${BASE}/submissions/${submissionId}/responses`, {
      responses: [{ questionId: knockoutQuestionId, response: "maybe" }],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toMatch(/expects one of yes \/ no/i);
  });

  it("fails a knockout outright and names the question", async () => {
    const invited = await post(`${BASE}/submissions`, { questionnaireId, vendorId: bravo });
    const submissionId = invited.json().id as string;
    await post(`${BASE}/submissions/${submissionId}/responses`, {
      responses: [
        { questionId: knockoutQuestionId, response: "yes" },
        { questionId: scoredQuestionId, response: "ISO 45001 certified, full-time SHEQ manager." },
      ],
    });
    await post(`${BASE}/submissions/${submissionId}/submit`, {});
    const assessed = await post(`${BASE}/submissions/${submissionId}/assess`, {
      scores: [
        { questionId: knockoutQuestionId, score: 0, maxScore: 10 },
        { questionId: scoredQuestionId, score: 9, maxScore: 10 },
      ],
    });
    expect(assessed.statusCode).toBe(200);
    expect(assessed.json().knockout.failed).toBe(true);
    expect(assessed.json().knockout.reason).toContain("Q1");
    expect(assessed.json().knockout.reason).toContain("administration");
    expect(assessed.json().knockoutFailed).toBe(true);
    // it can still score well — and still fail
    expect(assessed.json().assessment.scorePercent.value).toBeGreaterThan(50);

    const approvedAnyway = await post(
      `${BASE}/submissions/${submissionId}/decide`,
      { outcome: "approved" },
      approver.headers,
    );
    expect(approvedAnyway.statusCode).toBe(409);
    expect(approvedAnyway.json().message).toContain("Q1");
    expect(approvedAnyway.json().message).toMatch(/not a low score to be weighed against the rest/i);
  });

  it("returns a NULL score with the question named where a required answer was not assessed", async () => {
    const invited = await post(`${BASE}/submissions`, { questionnaireId, vendorId: charlie });
    const submissionId = invited.json().id as string;
    await post(`${BASE}/submissions/${submissionId}/responses`, {
      responses: [
        { questionId: knockoutQuestionId, response: "no" },
        { questionId: scoredQuestionId, response: "Documented system, externally audited." },
      ],
    });
    await post(`${BASE}/submissions/${submissionId}/submit`, {});
    const assessed = await post(`${BASE}/submissions/${submissionId}/assess`, {
      scores: [{ questionId: knockoutQuestionId, score: 10, maxScore: 10 }],
    });
    expect(assessed.json().assessment.scorePercent.value).toBeNull();
    expect(assessed.json().assessment.unscored[0].label).toContain("Q2");

    const decided = await post(
      `${BASE}/submissions/${submissionId}/decide`,
      { outcome: "approved" },
      approver.headers,
    );
    expect(decided.statusCode).toBe(409);
    expect(decided.json().message).toMatch(/approving against an unknown score approves against nothing/i);
  });

  it("refuses a decision by the person who assessed it", async () => {
    const invited = await post(`${BASE}/submissions`, { questionnaireId, vendorId: alpha });
    const submissionId = invited.json().id as string;
    await post(`${BASE}/submissions/${submissionId}/responses`, {
      responses: [
        { questionId: knockoutQuestionId, response: "no" },
        { questionId: scoredQuestionId, response: "ISO 45001, zero RIDDORs in three years." },
      ],
    });
    await post(`${BASE}/submissions/${submissionId}/submit`, {});
    await post(`${BASE}/submissions/${submissionId}/assess`, {
      scores: [
        { questionId: knockoutQuestionId, score: 10, maxScore: 10 },
        { questionId: scoredQuestionId, score: 8, maxScore: 10 },
      ],
    });
    const self = await post(`${BASE}/submissions/${submissionId}/decide`, { outcome: "approved" });
    expect(self.statusCode).toBe(403);
    expect(self.json().details.control).toBe("no_self_approval");

    const other = await post(
      `${BASE}/submissions/${submissionId}/decide`,
      { outcome: "approved" },
      approver.headers,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().outcome).toBe("approved");
    expect(other.json().expiresAt).toBe(
      new Date(new Date(`${other.json().validFrom}T00:00:00Z`).setUTCMonth(
        new Date(`${other.json().validFrom}T00:00:00Z`).getUTCMonth() + 12,
      )).toISOString().slice(0, 10),
    );
  });

  /* ---------------- financial screening ---------------- */

  it("derives the ratios and the recommended limit with its basis, never a bare number", async () => {
    const res = await post(`${BASE}/financials`, {
      vendorId: alpha,
      financialYearEnd: "2025-12-31",
      source: "audited_accounts",
      currency: "GBP",
      turnover: 10_000_000,
      netAssets: 800_000,
      currentAssets: 3_000_000,
      currentLiabilities: 2_000_000,
      totalDebt: 400_000,
      profitBeforeTax: 350_000,
      largestContractValue: 1_500_000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.workingCapital).toBe(1_000_000);
    expect(body.currentRatio).toBe(1.5);
    expect(body.gearingPercent).toBe(50);
    expect(body.recommendedSingleProjectLimit).toBe(2_500_000);
    expect(body.recommendedLimit.bindingTest).toBe("turnover");
    expect(body.recommendedLimit.basis).toMatch(/Bound by: Turnover x 25%/);
  });

  it("refuses a limit where turnover is unknown", async () => {
    const res = await post(`${BASE}/financials`, {
      vendorId: bravo,
      financialYearEnd: "2025-12-31",
      source: "self_declared",
      currency: "GBP",
      netAssets: 500_000,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recommendedSingleProjectLimit).toBeNull();
    expect(res.json().recommendedLimit.reasons[0]).toMatch(/Turnover was not supplied/i);
  });

  it("refuses verification of figures by the person who entered them", async () => {
    const created = await post(`${BASE}/financials`, {
      vendorId: charlie,
      financialYearEnd: "2025-12-31",
      source: "management_accounts",
      currency: "GBP",
      turnover: 4_000_000,
    });
    const id = created.json().id as string;
    const self = await post(`${BASE}/financials/${id}/verify`, {});
    expect(self.statusCode).toBe(403);
    const other = await post(`${BASE}/financials/${id}/verify`, {}, approver.headers);
    expect(other.statusCode).toBe(200);
    expect(other.json().verifiedBy).toBe(approver.userId);
  });

  it("flags a contract value beyond the vendor's recommended limit", async () => {
    const res = await get(
      `${BASE}/vendors/${alpha}/capacity?contractValue=4000000&currency=GBP`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().capacity.exceeds).toBe(true);
    expect(res.json().capacity.severity).toBe("critical");
    expect(res.json().contractToTurnover.value).toBe(0.4);
  });

  it("refuses duplicate figures for the same period from the same source", async () => {
    const res = await post(`${BASE}/financials`, {
      vendorId: alpha,
      financialYearEnd: "2025-12-31",
      source: "audited_accounts",
      currency: "GBP",
      turnover: 11_000_000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/stops being reproducible/i);
  });
});

/* ================================================================== */
/* 8. Expiry, the sweep, and the lapsed-prequalification gate          */
/* ================================================================== */

describe("prequalification expiry and the gate", () => {
  const BASE = "/companies/current/prequalification";
  let questionnaireId: string;
  let lapsedSubmissionId: string;
  let gatedPackage: { id: string; reference: string };

  async function approvedPrequalFor(vendorId: string, expiresAt: string) {
    const invited = await post(`${BASE}/submissions`, { questionnaireId, vendorId });
    const submissionId = invited.json().id as string;
    const questions = await get(`${BASE}/questionnaires/${questionnaireId}/questions`);
    const q = questions.json().items[0];
    await post(`${BASE}/submissions/${submissionId}/responses`, {
      responses: [{ questionId: q.id, response: "no" }],
    });
    await post(`${BASE}/submissions/${submissionId}/submit`, {});
    await post(`${BASE}/submissions/${submissionId}/assess`, {
      scores: [{ questionId: q.id, score: 10, maxScore: 10 }],
    });
    const decided = await post(
      `${BASE}/submissions/${submissionId}/decide`,
      { outcome: "approved_with_limit", singleProjectLimit: 500_000, currency: "GBP", expiresAt },
      approver.headers,
    );
    expect(decided.statusCode).toBe(200);
    return submissionId;
  }

  beforeAll(async () => {
    const created = await post(`${BASE}/questionnaires`, {
      name: "Expiry questionnaire",
      validityMonths: 12,
    });
    questionnaireId = created.json().id;
    await post(`${BASE}/questionnaires/${questionnaireId}/questions`, {
      questionCode: "K1",
      text: "Has the company entered administration in the last three years?",
      itemType: "yes_no",
      isKnockout: true,
      knockoutValue: "yes",
      maxScore: 10,
    });
    await post(`${BASE}/questionnaires/${questionnaireId}/activate`, {}, approver.headers);

    gatedPackage = await createPackage(prequalProject, {
      title: "Prequalified bidders only",
      prequalificationRequired: true,
      engineersEstimate: 300_000,
    });
    await issuePackage(prequalProject, gatedPackage.id);
  });

  it("raises a renewal obligation for an approval inside its renewal window", async () => {
    // a live invitation is what gives a COMPANY-WIDE approval a project to
    // bind its renewal to, so it has to exist before the approval is decided
    await post(`/projects/${prequalProject}/bid-packages/${gatedPackage.id}/invitations`, {
      vendorId: delta,
    });
    const submissionId = await approvedPrequalFor(delta, dateIn(30));
    await get(`${BASE}/submissions`);
    const [row] = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.id, submissionId));
    expect(row!.obligationId).toBeTruthy();
    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, row!.obligationId!));
    expect(obligation!.status).toBe("open");
    expect(obligation!.sourceClause).toMatch(/^prequalification PQ-\d{4} — renewal$/);
    expect(obligation!.projectId).toBe(prequalProject);
  });

  it("expires a lapsed approval on a list read and raises a signal, once", async () => {
    lapsedSubmissionId = await approvedPrequalFor(lapsed, dateIn(30));
    // wind the clock back on the record itself
    await app.db
      .update(prequalificationSubmissions)
      .set({ expiresAt: dateIn(-3) })
      .where(eq(prequalificationSubmissions.id, lapsedSubmissionId));

    const first = await get(`${BASE}/submissions`);
    expect(first.json().sweep.lapsed).toContain(lapsedSubmissionId);

    const [row] = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.id, lapsedSubmissionId));
    expect(row!.status).toBe("expired");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "prequalification_lapsed"),
        ),
      );
    const mine = raised.filter(
      (s) => (s.evidenceRefs as { key?: string } | null)?.key === lapsedSubmissionId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.explanation).toMatch(/Nothing has been checked about this company since then/i);

    // idempotent: a second read raises nothing further
    const second = await get(`${BASE}/submissions`);
    expect(second.json().sweep.signalsRaised).toEqual([]);
    const again = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "prequalification_lapsed")),
      );
    expect(again.filter((s) => (s.evidenceRefs as { key?: string } | null)?.key === lapsedSubmissionId)).toHaveLength(1);
  });

  it("FLAGS an invitation to a lapsed vendor rather than refusing it", async () => {
    const res = await post(
      `/projects/${prequalProject}/bid-packages/${gatedPackage.id}/invitations`,
      { vendorId: lapsed },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toHaveLength(1);
    expect(res.json().warnings[0].message).toMatch(/expired on/i);
    expect(res.json().items[0].prequalification.state).toBe("lapsed");
    expect(res.json().items[0].isPrequalified).toBe(false);

    const list = await get(
      `/projects/${prequalProject}/bid-packages/${gatedPackage.id}/invitations`,
    );
    expect(list.json().summary.flagged).toBeGreaterThanOrEqual(1);
  });

  it("REFUSES an award to a lapsed vendor, naming the lapse", async () => {
    const bid = await submitBid(prequalProject, gatedPackage.id, lapsed, {
      baseBidAmount: 280_000,
    });
    const res = await post(
      `/projects/${prequalProject}/bid-packages/${gatedPackage.id}/award/recommend`,
      {
        submissionId: bid.id,
        recommendationBasis: "The only bid received on this package, and it is under the estimate.",
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/expired on/i);
    expect(res.json().message).toMatch(/Lapsed Approvals Ltd/);
    expect(res.json().message).toMatch(/prequalificationStrictness/);
  });

  it("WARNS instead of refusing once the package's strictness is relaxed", async () => {
    await patch(`/projects/${prequalProject}/bid-packages/${gatedPackage.id}`, {
      prequalificationStrictness: "warn",
    });
    const submissions = await get(
      `/projects/${prequalProject}/bid-packages/${gatedPackage.id}/submissions`,
    );
    const bidId = submissions.json().items[0].id as string;
    const res = await post(
      `/projects/${prequalProject}/bid-packages/${gatedPackage.id}/award/recommend`,
      {
        submissionId: bidId,
        recommendationBasis: "The only bid received on this package, and it is under the estimate.",
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings.join(" ")).toMatch(/expired on/i);
    expect(res.json().prequalification.state).toBe("lapsed");
  });

  it("re-tests the standing at approval, so a lapse between the two is caught", async () => {
    // restore strictness and lapse the vendor's approval again
    await patch(`/projects/${prequalProject}/bid-packages/${gatedPackage.id}`, {
      prequalificationStrictness: "refuse",
    });
    const awards = await get(`/projects/${prequalProject}/bid-packages/${gatedPackage.id}/awards`);
    const awardId = awards.json().items[0].id as string;
    const res = await post(`/bid-awards/${awardId}/approve`, {}, approver.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/Award approval/i);
    expect(res.json().message).toMatch(/expired on/i);
  });

  it("renews as a new submission that supersedes the old one", async () => {
    const renewed = await post(`${BASE}/submissions/${lapsedSubmissionId}/renew`, {});
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().supersedesId).toBe(lapsedSubmissionId);
    expect(renewed.json().status).toBe("invited");
    // the expired record is untouched — "what did we know about them then" survives
    const [old] = await app.db
      .select()
      .from(prequalificationSubmissions)
      .where(eq(prequalificationSubmissions.id, lapsedSubmissionId));
    expect(old!.status).toBe("expired");
  });

  it("summarises a vendor's whole standing in one place", async () => {
    const res = await get(`${BASE}/vendors/${alpha}`);
    expect(res.statusCode).toBe(200);
    expect(["approved", "expiring"]).toContain(res.json().state);
    expect(res.json().recommendedLimit.value).toBe(2_500_000);
    expect(res.json().history.length).toBeGreaterThanOrEqual(1);
    expect(res.json().rule.turnoverShare).toBe(0.25);
    expect(res.json().note).toMatch(/Alpha Groundworks Ltd/);
  });
});
