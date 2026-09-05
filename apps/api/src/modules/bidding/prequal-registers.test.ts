import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  ledgerEntries,
  prequalificationLicences,
  prequalificationSubmissions,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

/**
 * THE TYPED PREQUALIFICATION REGISTERS, AUTOMATIC TIERING AND THE VENDOR
 * SELF-SERVICE PORTAL.
 *
 * What these tests are actually defending:
 *
 *  - A SAFETY RECORD IS A CEILING. A vendor who scores 95% and has a
 *    fatality on file is tier C. If that ever becomes tier A again, this
 *    suite fails.
 *  - A LICENCE EXPIRES ON ITS OWN. Nobody opens the page on the day it
 *    lapses, so a scheduled sweep does it, exactly once, with a signal.
 *  - THE VENDOR ANSWERS FOR THEMSELVES. A `pq_` token, hashed, expiring,
 *    scoped to one submission, resolving a vendor and nothing else — and the
 *    same answer validator the buyer's own route uses.
 *  - AND ANOTHER TENANT CAN REACH NONE OF IT.
 */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let stranger: TestActor;
let questionnaireId: string;
let questionId: string;

const dateIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const BASE = "/companies/current/prequalification";

const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const del = (url: string, headers = owner.headers) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
const portal = (url: string, token: string, payload?: unknown) =>
  app.inject({
    method: "POST",
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload ?? {},
  });

async function makeVendor(name: string): Promise<string> {
  const id = newId("ven");
  await app.db.insert(vendors).values({ id, companyId: owner.companyId, name });
  return id;
}

/** A vendor carried all the way to an approved, tiered prequalification. */
async function approveVendor(
  vendorId: string,
  score: { score: number; maxScore: number } = { score: 10, maxScore: 10 },
): Promise<Record<string, unknown>> {
  const created = await post(`${BASE}/submissions`, { questionnaireId, vendorId });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  await post(`${BASE}/submissions/${id}/responses`, {
    responses: [{ questionId, response: "yes" }],
  });
  await post(`${BASE}/submissions/${id}/submit`);
  const assessed = await post(`${BASE}/submissions/${id}/assess`, {
    scores: [{ questionId, ...score }],
  });
  expect(assessed.statusCode).toBe(200);
  const decided = await post(
    `${BASE}/submissions/${id}/decide`,
    { outcome: "approved", validFrom: dateIn(-1), expiresAt: dateIn(300) },
    approver.headers,
  );
  expect(decided.statusCode).toBe(200);
  return decided.json();
}

/** Filed accounts good enough to derive a single-project limit from. */
async function fileAccounts(vendorId: string) {
  const res = await post(`${BASE}/financials`, {
    vendorId,
    financialYearEnd: dateIn(-120),
    source: "audited_accounts",
    currency: "GBP",
    turnover: 10_000_000,
    netAssets: 2_000_000,
    currentAssets: 4_000_000,
    currentLiabilities: 2_000_000,
    totalDebt: 500_000,
    profitBeforeTax: 400_000,
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
  stranger = await registerActor(app);

  const q = await post(`${BASE}/questionnaires`, {
    name: "Registers questionnaire",
    validityMonths: 12,
  });
  expect(q.statusCode).toBe(201);
  questionnaireId = q.json().id;
  await post(`${BASE}/questionnaires/${questionnaireId}/questions`, {
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
  const questions = await get(`${BASE}/questionnaires/${questionnaireId}/questions`);
  questionId = questions.json().items[0].id;
  const activated = await post(
    `${BASE}/questionnaires/${questionnaireId}/activate`,
    {},
    approver.headers,
  );
  expect(activated.statusCode).toBe(200);
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Safety records                                                      */
/* ================================================================== */

describe("safety records", () => {
  it("files a typed year, refuses a duplicate for the same provenance and ledgers it", async () => {
    const vendorId = await makeVendor("Safety Ltd");
    const year = new Date().getUTCFullYear() - 1;
    const created = await post(`${BASE}/safety-records`, {
      vendorId,
      year,
      emr: 0.82,
      trir: 1.4,
      fatalities: 0,
      hoursWorked: 210_000,
      source: "audited",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().emr).toBe(0.82);

    const again = await post(`${BASE}/safety-records`, { vendorId, year, source: "audited" });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/already exists/i);

    // A second row with a DIFFERENT provenance is a different fact.
    const selfDeclared = await post(`${BASE}/safety-records`, {
      vendorId,
      year,
      emr: 0.5,
      source: "self_declared",
    });
    expect(selfDeclared.statusCode).toBe(201);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "prequalification_safety_record"),
        ),
      );
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a year that has not happened", async () => {
    const vendorId = await makeVendor("Future Safety Ltd");
    const res = await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() + 1,
      emr: 0.5,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/has not happened yet/i);
  });

  it("refuses to bind a record to another vendor's assessment", async () => {
    const alpha = await makeVendor("Bind Alpha Ltd");
    const bravo = await makeVendor("Bind Bravo Ltd");
    const submission = await post(`${BASE}/submissions`, { questionnaireId, vendorId: alpha });
    const res = await post(`${BASE}/safety-records`, {
      vendorId: bravo,
      submissionId: submission.json().id,
      year: new Date().getUTCFullYear() - 1,
      emr: 0.9,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/different vendor/i);
  });

  it("refuses a verification that concludes the figure is self-declared", async () => {
    const vendorId = await makeVendor("Verify Ltd");
    const created = await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 1.1,
      source: "self_declared",
    });
    const id = created.json().id;
    const bad = await post(`${BASE}/safety-records/${id}/verify`, { source: "self_declared" });
    expect(bad.statusCode).toBe(400);
    const good = await post(`${BASE}/safety-records/${id}/verify`, {
      source: "audited",
      note: "Checked against the filed OSHA 300A summary for the year.",
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().source).toBe("audited");
    expect(good.json().verifiedBy).toBe(owner.userId);
  });
});

/* ================================================================== */
/* Licences                                                            */
/* ================================================================== */

describe("licences", () => {
  it("files a live licence as claimed and an already-lapsed one as expired", async () => {
    const vendorId = await makeVendor("Licence Ltd");
    const live = await post(`${BASE}/licences`, {
      vendorId,
      kind: "gas_safe",
      number: "GS-9912",
      expiresAt: dateIn(200),
    });
    expect(live.statusCode).toBe(201);
    expect(live.json().status).toBe("claimed");

    const lapsed = await post(`${BASE}/licences`, {
      vendorId,
      kind: "asbestos",
      expiresAt: dateIn(-2),
    });
    expect(lapsed.statusCode).toBe(201);
    expect(lapsed.json().status).toBe("expired");
  });

  it("refuses to verify a licence with no expiry, or one already expired", async () => {
    const vendorId = await makeVendor("Verify Licence Ltd");
    const noExpiry = await post(`${BASE}/licences`, { vendorId, kind: "electrical" });
    const res = await post(`${BASE}/licences/${noExpiry.json().id}/status`, {
      status: "verified",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/needs an expiry/i);

    const past = await post(`${BASE}/licences`, {
      vendorId,
      kind: "scaffolding",
      expiresAt: dateIn(-5),
    });
    const res2 = await post(`${BASE}/licences/${past.json().id}/status`, { status: "verified" });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().message).toMatch(/cannot be marked verified/i);
  });

  it("expires a lapsed licence on the scheduler exactly once, with a signal", async () => {
    const vendorId = await makeVendor("Sweep Licence Ltd");
    const licence = await post(`${BASE}/licences`, {
      vendorId,
      kind: "crane_operator",
      number: "CR-771",
      expiresAt: dateIn(60),
    });
    const licenceId = licence.json().id as string;
    // Backdate it directly: the sweep's job is to notice, not to be told.
    await app.db
      .update(prequalificationLicences)
      .set({ expiresAt: dateIn(-1) })
      .where(eq(prequalificationLicences.id, licenceId));

    const status = await app.scheduler.runNow("bidding.licence-expiry");
    expect(status.state).toBe("succeeded");

    const [row] = await app.db
      .select()
      .from(prequalificationLicences)
      .where(eq(prequalificationLicences.id, licenceId));
    expect(row!.status).toBe("expired");

    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "prequalification_licence_expired"),
        ),
      );
    const mine = raised.filter(
      (s) => (s.evidenceRefs as { key?: string } | null)?.key === licenceId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.severity).toBe("high");

    // Idempotent: a second run raises nothing new.
    await app.scheduler.runNow("bidding.licence-expiry");
    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "prequalification_licence_expired"),
        ),
      );
    expect(
      after.filter((s) => (s.evidenceRefs as { key?: string } | null)?.key === licenceId),
    ).toHaveLength(1);
  });

  it("lists the register and filters by expiry horizon", async () => {
    const vendorId = await makeVendor("Register Licence Ltd");
    await post(`${BASE}/licences`, { vendorId, kind: "soon", expiresAt: dateIn(10) });
    await post(`${BASE}/licences`, { vendorId, kind: "later", expiresAt: dateIn(900) });
    const res = await get(`${BASE}/licences?vendorId=${vendorId}&expiringWithinDays=30`);
    expect(res.statusCode).toBe(200);
    const kinds = res.json().items.map((l: { kind: string }) => l.kind);
    expect(kinds).toContain("soon");
    expect(kinds).not.toContain("later");
  });
});

/* ================================================================== */
/* References                                                          */
/* ================================================================== */

describe("references", () => {
  it("records a reference as unchecked and refuses an unknown outcome on the check", async () => {
    const vendorId = await makeVendor("Reference Ltd");
    const created = await post(`${BASE}/references`, {
      vendorId,
      clientName: "Northgate Estates",
      projectName: "Phase 2 groundworks",
      contractValue: 1_400_000,
      currency: "GBP",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().outcome).toBe("unknown");
    expect(created.json().checkedBy).toBeNull();

    const bad = await post(`${BASE}/references/${created.json().id}/check`, {
      outcome: "unknown",
      checkNote: "Could not reach the referee on the number supplied.",
    });
    expect(bad.statusCode).toBe(400);

    const good = await post(`${BASE}/references/${created.json().id}/check`, {
      outcome: "delivered",
      rating: 4.5,
      wouldUseAgain: true,
      checkNote: "Spoke to the client's project manager; delivered on time and to budget.",
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().checkedBy).toBe(owner.userId);
    expect(good.json().wouldUseAgain).toBe(1);
  });
});

/* ================================================================== */
/* Automatic tiering                                                   */
/* ================================================================== */

describe("automatic tiering", () => {
  it("grants tier A only on strong evidence, and states the basis", async () => {
    const vendorId = await makeVendor("Tier A Ltd");
    await fileAccounts(vendorId);
    await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 0.7,
      trir: 1.1,
      fatalities: 0,
      source: "audited",
    });
    const ref = await post(`${BASE}/references`, { vendorId, clientName: "Client A" });
    await post(`${BASE}/references/${ref.json().id}/check`, {
      outcome: "delivered",
      checkNote: "Reference taken up by telephone with the client's commercial manager.",
    });

    const decided = await approveVendor(vendorId);
    const tier = decided["tier"] as Record<string, unknown>;
    expect(tier["granted"]).toBe("a");
    expect(String(tier["grantedBasis"])).toMatch(/100%|tier A band/i);
    expect(tier["riskRating"]).toBe("low");
  });

  it("caps a 100% vendor at tier C for a fatality, and says so", async () => {
    const vendorId = await makeVendor("Fatality Ltd");
    await fileAccounts(vendorId);
    await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 0.9,
      fatalities: 1,
      source: "audited",
    });
    const decided = await approveVendor(vendorId);
    const tier = decided["tier"] as Record<string, unknown>;
    expect(tier["granted"]).toBe("c");
    expect(String(tier["grantedBasis"])).toMatch(/fatality/i);
    expect(tier["riskRating"]).toBe("high");
  });

  it("caps at tier C where no financial screening produced a limit", async () => {
    const vendorId = await makeVendor("No Accounts Ltd");
    await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 0.8,
      source: "audited",
    });
    const decided = await approveVendor(vendorId);
    const tier = decided["tier"] as Record<string, unknown>;
    expect(tier["granted"]).toBe("c");
    expect(String(tier["grantedBasis"])).toMatch(/capacity is unknown/i);
  });

  it("does not tier a rejection", async () => {
    const vendorId = await makeVendor("Rejected Ltd");
    const created = await post(`${BASE}/submissions`, { questionnaireId, vendorId });
    const id = created.json().id;
    await post(`${BASE}/submissions/${id}/responses`, {
      responses: [{ questionId, response: "no" }],
    });
    await post(`${BASE}/submissions/${id}/submit`);
    await post(`${BASE}/submissions/${id}/assess`, {
      scores: [{ questionId, score: 2, maxScore: 10 }],
    });
    const decided = await post(
      `${BASE}/submissions/${id}/decide`,
      {
        outcome: "rejected",
        rejectedReason: "Score well below the standard we require for this trade.",
      },
      approver.headers,
    );
    expect(decided.statusCode).toBe(200);
    const tier = decided.json()["tier"] as Record<string, unknown>;
    expect(tier["granted"]).toBeNull();
  });

  it("reports drift when the evidence changes after the approval", async () => {
    const vendorId = await makeVendor("Drift Ltd");
    await fileAccounts(vendorId);
    await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 0.7,
      source: "audited",
    });
    const ref = await post(`${BASE}/references`, { vendorId, clientName: "Client D" });
    await post(`${BASE}/references/${ref.json().id}/check`, {
      outcome: "delivered",
      checkNote: "Taken up with the client's quantity surveyor; no issues reported.",
    });
    const decided = await approveVendor(vendorId);
    expect((decided["tier"] as Record<string, unknown>)["granted"]).toBe("a");

    // A licence lapses AFTER the approval. The granted letter cannot know.
    await post(`${BASE}/licences`, { vendorId, kind: "gas_safe", expiresAt: dateIn(-1) });
    const standing = await get(`${BASE}/vendors/${vendorId}`);
    expect(standing.statusCode).toBe(200);
    const tier = standing.json().tier;
    expect(tier.granted).toBe("a");
    expect(tier.onCurrentEvidence.tier).toBe("c");
    expect(tier.drifted).toBe(true);
  });
});

/* ================================================================== */
/* Evidence repository                                                 */
/* ================================================================== */

describe("evidence repository", () => {
  it("assembles every file this company holds on one vendor, with counts", async () => {
    const vendorId = await makeVendor("Evidence Ltd");
    await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 1,
      source: "audited",
      fileIds: ["file_safety_1"],
    });
    await post(`${BASE}/licences`, {
      vendorId,
      kind: "gas_safe",
      expiresAt: dateIn(300),
      fileIds: ["file_licence_1"],
    });
    await post(`${BASE}/references`, { vendorId, clientName: "Evidence Client" });
    const res = await get(`${BASE}/vendors/${vendorId}/evidence`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fileCount).toBe(2);
    expect(body.files.map((f: { fileId: string }) => f.fileId)).toEqual(
      expect.arrayContaining(["file_safety_1", "file_licence_1"]),
    );
    expect(body.counts.references).toBe(1);
    expect(body.counts.referencesChecked).toBe(0);
    // No submission for this vendor, so there is nothing to tier — and the
    // answer says so rather than inventing "unrated".
    expect(body.tier).toBeNull();
    expect(body.tierNote).toMatch(/nothing to tier/i);
  });
});

/* ================================================================== */
/* The vendor self-service portal                                      */
/* ================================================================== */

describe("vendor prequalification portal", () => {
  let submissionId: string;
  let token: string;
  let vendorId: string;

  beforeAll(async () => {
    vendorId = await makeVendor("Portal Ltd");
    const created = await post(`${BASE}/submissions`, { questionnaireId, vendorId });
    submissionId = created.json().id;
    const minted = await post(`${BASE}/submissions/${submissionId}/portal-token`, {});
    expect(minted.statusCode).toBe(201);
    token = minted.json().token;
    expect(token.startsWith("pq_")).toBe(true);
  });

  it("never returns the token or its hash on a read path", async () => {
    const detail = await get(`${BASE}/submissions/${submissionId}`);
    expect(detail.json().portalTokenHash).toBeUndefined();
    expect(detail.json().vendorPortal.issued).toBe(true);
    const list = await get(`${BASE}/submissions?vendorId=${vendorId}`);
    for (const row of list.json().items) expect(row.portalTokenHash).toBeUndefined();
  });

  it("refuses a missing, malformed or unknown token", async () => {
    const none = await app.inject({ method: "POST", url: "/api/v1/prequal-portal/session" });
    expect(none.statusCode).toBe(401);
    const wrongPrefix = await portal("/prequal-portal/session", "bpt_deadbeef");
    expect(wrongPrefix.statusCode).toBe(401);
    const unknown = await portal("/prequal-portal/session", `pq_${"0".repeat(40)}`);
    expect(unknown.statusCode).toBe(401);
  });

  it("shows the vendor their own questionnaire and never the pass threshold", async () => {
    const res = await portal("/prequal-portal/session", token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference).toMatch(/^PQ-/);
    expect(body.questions).toHaveLength(1);
    expect(body.outstanding).toHaveLength(1);
    expect(body.questionnaire.passThreshold).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("scorePercent");
  });

  it("validates the vendor's answers with the same rules the buyer's route uses", async () => {
    const bad = await portal("/prequal-portal/responses", token, {
      responses: [{ questionId, response: "perhaps" }],
    });
    expect(bad.statusCode).toBe(400);
    const good = await portal("/prequal-portal/responses", token, {
      responses: [{ questionId, response: "yes" }],
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().status).toBe("in_progress");
  });

  it("refuses an answer to a question on a different questionnaire", async () => {
    const other = await post(`${BASE}/questionnaires`, { name: "Other", validityMonths: 12 });
    await post(`${BASE}/questionnaires/${other.json().id}/questions`, {
      questions: [{ text: "Unrelated?", itemType: "yes_no", required: false }],
    });
    const otherQuestions = await get(`${BASE}/questionnaires/${other.json().id}/questions`);
    const res = await portal("/prequal-portal/responses", token, {
      responses: [{ questionId: otherQuestions.json().items[0].id, response: "yes" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not on this questionnaire/i);
  });

  it("files vendor declarations as self-declared, claimed and unchecked", async () => {
    const res = await portal("/prequal-portal/declarations", token, {
      safety: [
        {
          year: new Date().getUTCFullYear() - 1,
          emr: 0.6,
          trir: 0.9,
          fatalities: 0,
        },
      ],
      licences: [{ kind: "gas_safe", number: "GS-1", expiresAt: dateIn(400) }],
      references: [{ clientName: "Vendor-supplied client" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ safety: 1, licences: 1, references: 1 });

    const evidence = await get(`${BASE}/vendors/${vendorId}/evidence`);
    const body = evidence.json();
    expect(body.safety[0].source).toBe("self_declared");
    expect(body.licences[0].status).toBe("claimed");
    expect(body.references[0].outcome).toBe("unknown");
    expect(body.references[0].checked).toBe(false);
  });

  it("submits, then refuses further edits, and ledgers the declaration with no actor", async () => {
    const submitted = await portal("/prequal-portal/submit", token, {
      declaration: "I confirm the information given is true and complete to the best of my knowledge.",
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("submitted");

    const again = await portal("/prequal-portal/responses", token, {
      responses: [{ questionId, response: "no" }],
    });
    expect(again.statusCode).toBe(409);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectId, submissionId),
        ),
      );
    const vendorEntries = entries.filter(
      (e) => (e.payload as Record<string, unknown> | null)?.["via"] === "prequal_token",
    );
    expect(vendorEntries.length).toBeGreaterThan(0);
    for (const entry of vendorEntries) expect(entry.actorId).toBeNull();
    expect(
      vendorEntries.some(
        (e) => (e.payload as Record<string, unknown>)["event"] === "vendor_submitted",
      ),
    ).toBe(true);
  });

  it("refuses a required question left blank on submit", async () => {
    const blankVendor = await makeVendor("Blank Ltd");
    const created = await post(`${BASE}/submissions`, {
      questionnaireId,
      vendorId: blankVendor,
    });
    const minted = await post(`${BASE}/submissions/${created.json().id}/portal-token`, {});
    const res = await portal("/prequal-portal/submit", minted.json().token, {
      declaration: "I confirm the information given is true and complete.",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/unanswered/i);
  });

  it("refuses an expired token and a revoked one", async () => {
    const expiredVendor = await makeVendor("Expired Token Ltd");
    const created = await post(`${BASE}/submissions`, {
      questionnaireId,
      vendorId: expiredVendor,
    });
    const id = created.json().id as string;
    const minted = await post(`${BASE}/submissions/${id}/portal-token`, {});
    const raw = minted.json().token as string;
    await app.db
      .update(prequalificationSubmissions)
      .set({ portalTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(prequalificationSubmissions.id, id));
    const expired = await portal("/prequal-portal/session", raw);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().message).toMatch(/expired/i);

    const revokedVendor = await makeVendor("Revoked Token Ltd");
    const second = await post(`${BASE}/submissions`, {
      questionnaireId,
      vendorId: revokedVendor,
    });
    const secondToken = (
      await post(`${BASE}/submissions/${second.json().id}/portal-token`, {})
    ).json().token;
    expect((await portal("/prequal-portal/session", secondToken)).statusCode).toBe(200);
    const revoked = await del(`${BASE}/submissions/${second.json().id}/portal-token`);
    expect(revoked.statusCode).toBe(204);
    expect((await portal("/prequal-portal/session", secondToken)).statusCode).toBe(401);
  });
});

/* ================================================================== */
/* Tenancy and permissions                                             */
/* ================================================================== */

describe("tenancy and permissions", () => {
  it("keeps another company out of every register route", async () => {
    const vendorId = await makeVendor("Isolation Ltd");
    const licence = await post(`${BASE}/licences`, { vendorId, kind: "gas_safe" });
    const safety = await post(`${BASE}/safety-records`, {
      vendorId,
      year: new Date().getUTCFullYear() - 1,
      emr: 1,
    });
    const reference = await post(`${BASE}/references`, { vendorId, clientName: "Isolation" });

    // Reads: the stranger's own company has no such vendor.
    const read = await get(`${BASE}/vendors/${vendorId}/evidence`, stranger.headers);
    expect([400, 403, 404]).toContain(read.statusCode);

    // Writes against ids that belong to us.
    for (const [url, payload] of [
      [`${BASE}/licences/${licence.json().id}/status`, { status: "revoked" }],
      [`${BASE}/safety-records/${safety.json().id}/verify`, { source: "audited" }],
      [
        `${BASE}/references/${reference.json().id}/check`,
        { outcome: "delivered", checkNote: "Not our reference to check at all." },
      ],
    ] as const) {
      const res = await post(url, payload, stranger.headers);
      expect([400, 403, 404]).toContain(res.statusCode);
    }

    // And nothing was changed by any of it.
    const [row] = await app.db
      .select()
      .from(prequalificationLicences)
      .where(eq(prequalificationLicences.id, licence.json().id));
    expect(row!.status).toBe("claimed");
  });

  it("refuses a plain company member the register writes", async () => {
    const member = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: member.userId,
      role: "member",
    });
    const headers = {
      authorization: member.headers["authorization"]!,
      "x-company-id": owner.companyId,
    };
    const vendorId = await makeVendor("Member Write Ltd");
    const res = await post(`${BASE}/licences`, { vendorId, kind: "gas_safe" }, headers);
    expect(res.statusCode).toBe(403);
    // …but reading the register is a member's job.
    const read = await get(`${BASE}/licences`, headers);
    expect(read.statusCode).toBe(200);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1${BASE}/licences` });
    expect(res.statusCode).toBe(401);
  });
});
