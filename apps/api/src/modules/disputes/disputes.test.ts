import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  contracts,
  disputes as disputesTable,
  entities,
  files,
  forensicClaims,
  obligations,
  projects,
  rfis,
  signals,
} from "@constructos/db";
import { hashPayload, merkleRoot, sha256Hex } from "@constructos/ledger";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { analyseSettlement } from "./settlement.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let projectId: string;
let contractId: string;
let entityId: string;
let claimId: string;
let rfiId: string;
let fileA: string;
let fileB: string;

interface Step {
  id: string;
  name: string;
  dueDate: string | null;
  obligationId: string | null;
  done: boolean;
  breachedAt: string | null;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Dispute Support Test Project",
  });
  contractId = newId("con");
  await app.db.insert(contracts).values({
    id: contractId,
    companyId: owner.companyId,
    projectId,
    name: "Main Works Contract",
    form: "nec4_ecc",
    createdBy: owner.userId,
  });
  entityId = newId("ent");
  await app.db.insert(entities).values({
    id: entityId,
    companyId: owner.companyId,
    kind: "company",
    name: "Counterparty Constructors Ltd",
  });
  claimId = newId("fcl");
  await app.db.insert(forensicClaims).values({
    id: claimId,
    companyId: owner.companyId,
    projectId,
    number: 1,
    title: "Prolongation claim — groundworks",
    kind: "prolongation",
    createdBy: owner.userId,
  });
  rfiId = newId("rfi");
  await app.db.insert(rfis).values({
    id: rfiId,
    companyId: owner.companyId,
    projectId,
    number: 7,
    subject: "Rebar spacing at pile cap",
    question: "Confirm spacing",
    createdBy: owner.userId,
  });
  fileA = newId("fil");
  await app.db.insert(files).values({
    id: fileA,
    companyId: owner.companyId,
    projectId,
    name: "witness-statement.pdf",
    contentType: "application/pdf",
    sizeBytes: 11,
    sha256: sha256Hex("content-a"),
    storageKey: "test/a",
    uploadedBy: owner.userId,
  });
  fileB = newId("fil");
  await app.db.insert(files).values({
    id: fileB,
    companyId: owner.companyId,
    projectId,
    name: "expert-report.pdf",
    contentType: "application/pdf",
    sizeBytes: 12,
    sha256: sha256Hex("content-b"),
    storageKey: "test/b",
    uploadedBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function createDispute(payload: Record<string, unknown>, pid = projectId) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/disputes`,
    headers: owner.headers,
    payload: { title: "Test dispute", kind: "adjudication", ...payload },
  });
}

async function post(url: string, payload?: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers: owner.headers, payload });
}

async function get(url: string) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers: owner.headers });
}

/* ------------------------------------------------------------------ */
/* Register + timetable engine                                         */
/* ------------------------------------------------------------------ */

describe("dispute register (#321, #329-338)", () => {
  it("registers a dispute with sequential numbering and materializes timetable obligations", async () => {
    const due = addDaysISO(todayISO(), 14);
    const res = await createDispute({
      forum: "RICS adjudicator nomination",
      rules: "Scheme for Construction Contracts",
      contractId,
      claimIds: [claimId],
      counterpartyEntityId: entityId,
      amountInDispute: 250000,
      currency: "GBP",
      timetable: [
        { name: "Referral notice", dueDate: due },
        { name: "Site visit" }, // undated — no obligation
      ],
    });
    expect(res.statusCode).toBe(201);
    const d = res.json() as { id: string; number: number; timetable: Step[]; status: string };
    expect(d.status).toBe("notified");
    expect(d.timetable).toHaveLength(2);
    expect(d.timetable[0]!.obligationId).toBeTruthy();
    expect(d.timetable[1]!.obligationId).toBeNull();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, d.timetable[0]!.obligationId!));
    expect(obl!.status).toBe("open");
    expect(obl!.warnDaysBefore).toBe(3);
    expect(obl!.sourceClause).toBe("adjudication — Referral notice");
    expect(obl!.deadline).toContain(due);

    const res2 = await createDispute({});
    expect(res2.statusCode).toBe(201);
    expect((res2.json() as { number: number }).number).toBe(d.number + 1);
  });

  it("validates contractId, claimIds and counterpartyEntityId", async () => {
    const badContract = await createDispute({ contractId: "con_nope" });
    expect(badContract.statusCode).toBe(400);
    const badClaim = await createDispute({ claimIds: [claimId, "fcl_nope"] });
    expect(badClaim.statusCode).toBe(400);
    const badEntity = await createDispute({ counterpartyEntityId: "ent_nope" });
    expect(badEntity.statusCode).toBe(400);
  });

  it("lists with kind/status filters, nextDeadline and daysToNext", async () => {
    const due = addDaysISO(todayISO(), 5);
    const res = await createDispute({
      kind: "mediation",
      timetable: [{ name: "Position papers", dueDate: due }],
    });
    const created = res.json() as { id: string };
    const list = await get(`/projects/${projectId}/disputes?kind=mediation`);
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      items: { id: string; kind: string; nextDeadline: string | null; daysToNext: number | null }[];
    };
    expect(body.items.every((i) => i.kind === "mediation")).toBe(true);
    const mine = body.items.find((i) => i.id === created.id)!;
    expect(mine.nextDeadline).toBe(due);
    expect(mine.daysToNext).toBe(5);
  });

  it("completing a timetable step marks it done and satisfies its obligation", async () => {
    const res = await createDispute({
      timetable: [{ name: "Response due", dueDate: addDaysISO(todayISO(), 10) }],
    });
    const d = res.json() as { id: string; timetable: Step[] };
    const step = d.timetable[0]!;
    const done = await post(
      `/projects/${projectId}/disputes/${d.id}/timetable/${step.id}/complete`,
    );
    expect(done.statusCode).toBe(200);
    const updated = done.json() as { timetable: Step[] };
    expect(updated.timetable[0]!.done).toBe(true);
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, step.obligationId!));
    expect(obl!.status).toBe("satisfied");

    const again = await post(
      `/projects/${projectId}/disputes/${d.id}/timetable/${step.id}/complete`,
    );
    expect(again.statusCode).toBe(400);
  });

  it("lazy sweep breaches missed deadlines once, with a high signal (idempotent)", async () => {
    const past = addDaysISO(todayISO(), -3);
    const res = await createDispute({
      timetable: [{ name: "Rejoinder", dueDate: past }],
    });
    const d = res.json() as { id: string; timetable: Step[] };
    const obligationId = d.timetable[0]!.obligationId!;

    // two reads → sweep runs twice; breach and signal must appear exactly once
    await get(`/projects/${projectId}/disputes`);
    await get(`/projects/${projectId}/disputes/${d.id}`);

    const [obl] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId));
    expect(obl!.status).toBe("breached");

    const sigs = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "dispute_deadline_missed")),
      );
    const mine = sigs.filter((s) => s.title.includes("Rejoinder"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.severity).toBe("high");

    const detail = await get(`/projects/${projectId}/disputes/${d.id}`);
    const steps = (detail.json() as { timetable: Step[] }).timetable;
    expect(steps[0]!.breachedAt).toBeTruthy();
  });

  it("PATCH re-materializes obligations for new timetable steps and waives removed ones", async () => {
    const res = await createDispute({
      timetable: [{ name: "Old step", dueDate: addDaysISO(todayISO(), 20) }],
    });
    const d = res.json() as { id: string; timetable: Step[] };
    const oldObligation = d.timetable[0]!.obligationId!;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/disputes/${d.id}`,
      headers: owner.headers,
      payload: {
        forum: "TCC",
        timetable: [{ name: "New hearing step", dueDate: addDaysISO(todayISO(), 30) }],
      },
    });
    expect(patch.statusCode).toBe(200);
    const updated = patch.json() as { forum: string; timetable: Step[] };
    expect(updated.forum).toBe("TCC");
    expect(updated.timetable).toHaveLength(1);
    expect(updated.timetable[0]!.name).toBe("New hearing step");
    const newObligation = updated.timetable[0]!.obligationId!;
    expect(newObligation).not.toBe(oldObligation);

    const [oldRow] = await app.db.select().from(obligations).where(eq(obligations.id, oldObligation));
    expect(oldRow!.status).toBe("waived");
    const [newRow] = await app.db.select().from(obligations).where(eq(obligations.id, newObligation));
    expect(newRow!.status).toBe("open");
  });
});

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

describe("status transitions (#325-333)", () => {
  it("moves forward only along the procedural ladder", async () => {
    const d = (await createDispute({})).json() as { id: string };
    const fwd = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "referred",
    });
    expect(fwd.statusCode).toBe(200);
    expect((fwd.json() as { status: string }).status).toBe("referred");

    const back = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "notified",
    });
    expect(back.statusCode).toBe(400);
  });

  it("decided requires an outcome and stamps decidedAt; terminal states are frozen", async () => {
    const d = (await createDispute({})).json() as { id: string };
    await post(`/projects/${projectId}/disputes/${d.id}/status`, { status: "hearing" });

    const noOutcome = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "decided",
    });
    expect(noOutcome.statusCode).toBe(400);

    const decided = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "decided",
      outcome: "Adjudicator awarded GBP 180,000",
    });
    expect(decided.statusCode).toBe(200);
    const body = decided.json() as { status: string; outcome: string; decidedAt: string | null };
    expect(body.status).toBe("decided");
    expect(body.outcome).toContain("180,000");
    expect(body.decidedAt).toBeTruthy();

    const afterDecided = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "settled",
    });
    expect(afterDecided.statusCode).toBe(400);
  });

  it("settled/withdrawn are reachable from any pre-decided status", async () => {
    const d = (await createDispute({})).json() as { id: string };
    const settled = await post(`/projects/${projectId}/disputes/${d.id}/status`, {
      status: "withdrawn",
    });
    expect(settled.statusCode).toBe(200);
    expect((settled.json() as { status: string }).status).toBe("withdrawn");
  });
});

/* ------------------------------------------------------------------ */
/* Submissions                                                         */
/* ------------------------------------------------------------------ */

describe("pleadings register (#339)", () => {
  it("records submissions, validates fileId and lists in servedAt order", async () => {
    const d = (await createDispute({})).json() as { id: string };
    const badFile = await post(`/projects/${projectId}/disputes/${d.id}/submissions`, {
      kind: "referral",
      title: "Referral",
      party: "claimant",
      servedAt: todayISO(),
      fileId: "fil_nope",
    });
    expect(badFile.statusCode).toBe(400);

    const later = await post(`/projects/${projectId}/disputes/${d.id}/submissions`, {
      kind: "response",
      title: "Response to referral",
      party: "respondent",
      servedAt: addDaysISO(todayISO(), -1),
    });
    expect(later.statusCode).toBe(201);
    const earlier = await post(`/projects/${projectId}/disputes/${d.id}/submissions`, {
      kind: "referral",
      title: "Referral notice",
      party: "claimant",
      servedAt: addDaysISO(todayISO(), -10),
      fileId: fileA,
    });
    expect(earlier.statusCode).toBe(201);

    const list = await get(`/projects/${projectId}/disputes/${d.id}/submissions`);
    const items = (list.json() as { items: { title: string }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Referral notice", "Response to referral"]);
  });
});

/* ------------------------------------------------------------------ */
/* Bundles                                                             */
/* ------------------------------------------------------------------ */

describe("hearing bundles (#343-344)", () => {
  async function makeBundle(): Promise<{ disputeId: string; bundleId: string }> {
    const d = (await createDispute({})).json() as { id: string };
    const b = await post(`/projects/${projectId}/disputes/${d.id}/bundles`, { name: "Bundle A" });
    expect(b.statusCode).toBe(201);
    return { disputeId: d.id, bundleId: (b.json() as { id: string }).id };
  }

  it("validates bundle items: bad fileId and bad record references are 400", async () => {
    const { bundleId } = await makeBundle();
    const badFile = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: { items: [{ title: "X", fileId: "fil_nope" }] },
    });
    expect(badFile.statusCode).toBe(400);

    const badRecord = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: { items: [{ recordType: "rfi", recordId: "rfi_nope" }] },
    });
    expect(badRecord.statusCode).toBe(400);

    const neither = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: { items: [{ title: "Just a title" }] },
    });
    expect(neither.statusCode).toBe(400);
  });

  it("resolves record titles server-side and reorders chronologically", async () => {
    const { bundleId } = await makeBundle();
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: {
        items: [
          { fileId: fileA, date: "2026-03-01" },
          { recordType: "rfi", recordId: rfiId, date: "2026-01-15" },
          { recordType: "claim", recordId: claimId, date: "2026-02-01" },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const items = (put.json() as { items: { title: string }[] }).items;
    expect(items[0]!.title).toBe("witness-statement.pdf");
    expect(items[1]!.title).toBe("RFI-7: Rebar spacing at pile cap");
    expect(items[2]!.title).toBe("Prolongation claim — groundworks");

    const chron = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/chronological`);
    expect(chron.statusCode).toBe(200);
    const sorted = (chron.json() as { items: { date: string }[] }).items;
    expect(sorted.map((i) => i.date)).toEqual(["2026-01-15", "2026-02-01", "2026-03-01"]);
  });

  it("generate freezes tabs + manifest with a recomputable merkle root; frozen bundles reject edits", async () => {
    const { bundleId } = await makeBundle();
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: {
        items: [
          { fileId: fileA, date: "2026-01-01" },
          { fileId: fileB, date: "2026-01-02" },
          { recordType: "rfi", recordId: rfiId },
        ],
      },
    });
    const gen = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/generate`);
    expect(gen.statusCode).toBe(200);
    const bundle = gen.json() as {
      status: string;
      manifest: {
        itemCount: number;
        merkleRoot: string;
        index: { tab: string; sha256: string; source: string }[];
      };
    };
    expect(bundle.status).toBe("generated");
    expect(bundle.manifest.itemCount).toBe(3);
    expect(bundle.manifest.index.map((e) => e.tab)).toEqual(["A1", "A2", "A3"]);
    expect(bundle.manifest.index[0]!.sha256).toBe(sha256Hex("content-a"));
    expect(bundle.manifest.index[1]!.sha256).toBe(sha256Hex("content-b"));

    // the record-backed leaf is the hash of the record's canonical JSON
    const [rfiRow] = await app.db.select().from(rfis).where(eq(rfis.id, rfiId));
    expect(bundle.manifest.index[2]!.sha256).toBe(hashPayload(rfiRow));

    // recompute the root independently
    expect(merkleRoot(bundle.manifest.index.map((e) => e.sha256))).toBe(bundle.manifest.merkleRoot);

    const editFrozen = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: { items: [{ fileId: fileA }] },
    });
    expect(editFrozen.statusCode).toBe(400);

    const regen = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/generate`);
    expect(regen.statusCode).toBe(400);

    // manifest.csv export
    const csv = await get(`/projects/${projectId}/dispute-bundles/${bundleId}/manifest.csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toBe("tab,title,date,source,sha256");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("A1");
    expect(lines[1]).toContain(sha256Hex("content-a"));

    // issue
    const issued = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/issue`);
    expect(issued.statusCode).toBe(200);
    expect((issued.json() as { status: string }).status).toBe("issued");
  });

  it("verify reports intact, then names the tampered tab (#862-style tamper evidence)", async () => {
    // dedicated file so tampering does not poison other tests
    const tamperFile = newId("fil");
    await app.db.insert(files).values({
      id: tamperFile,
      companyId: owner.companyId,
      projectId,
      name: "site-diary.pdf",
      contentType: "application/pdf",
      sizeBytes: 9,
      sha256: sha256Hex("diary-v1"),
      storageKey: "test/diary",
      uploadedBy: owner.userId,
    });
    const { bundleId } = await makeBundle();
    await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/dispute-bundles/${bundleId}/items`,
      headers: owner.headers,
      payload: { items: [{ fileId: fileA }, { fileId: tamperFile }] },
    });
    await post(`/projects/${projectId}/dispute-bundles/${bundleId}/generate`);

    const clean = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/verify`);
    expect(clean.statusCode).toBe(200);
    expect((clean.json() as { intact: boolean }).intact).toBe(true);

    // tamper: the file's content hash changes after the bundle was frozen
    await app.db
      .update(files)
      .set({ sha256: sha256Hex("diary-v2-tampered") })
      .where(eq(files.id, tamperFile));

    const dirty = await post(`/projects/${projectId}/dispute-bundles/${bundleId}/verify`);
    const body = dirty.json() as {
      intact: boolean;
      mismatches: { tab: string; expected: string; actual: string | null }[];
    };
    expect(body.intact).toBe(false);
    expect(body.mismatches).toHaveLength(1);
    expect(body.mismatches[0]!.tab).toBe("A2");
    expect(body.mismatches[0]!.expected).toBe(sha256Hex("diary-v1"));
    expect(body.mismatches[0]!.actual).toBe(sha256Hex("diary-v2-tampered"));
  });
});

/* ------------------------------------------------------------------ */
/* Settlement offers + expected value                                  */
/* ------------------------------------------------------------------ */

describe("settlement offers (#350-352)", () => {
  it("accepting an offer settles the dispute and records the outcome", async () => {
    const d = (await createDispute({ currency: "GBP" })).json() as { id: string };
    const offer = await post(`/projects/${projectId}/disputes/${d.id}/offers`, {
      direction: "received",
      basis: "without_prejudice_save_as_to_costs",
      amount: 120000,
      offeredAt: todayISO(),
    });
    expect(offer.statusCode).toBe(201);
    const offerId = (offer.json() as { id: string }).id;

    const accepted = await post(`/projects/${projectId}/settlement-offers/${offerId}/status`, {
      status: "accepted",
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { status: string }).status).toBe("accepted");

    const [row] = await app.db.select().from(disputesTable).where(eq(disputesTable.id, d.id));
    expect(row!.status).toBe("settled");
    expect(row!.outcome).toBe("Settled at GBP 120000");

    // offer status transitions only run from open
    const again = await post(`/projects/${projectId}/settlement-offers/${offerId}/status`, {
      status: "rejected",
    });
    expect(again.statusCode).toBe(400);
  });

  it("settlement-analysis recommends both ways depending on EV vs best open offer", async () => {
    const d = (await createDispute({ amountInDispute: 200000 })).json() as { id: string };
    await post(`/projects/${projectId}/disputes/${d.id}/offers`, {
      direction: "received",
      basis: "without_prejudice",
      amount: 90000,
      offeredAt: todayISO(),
    });
    // a made offer must never count as the best RECEIVED offer
    await post(`/projects/${projectId}/disputes/${d.id}/offers`, {
      direction: "made",
      basis: "open",
      amount: 500000,
      offeredAt: todayISO(),
    });

    // EV = 0.6 × 200000 − 10000 = 110000 > 90000 → proceed
    const proceed = await get(
      `/projects/${projectId}/disputes/${d.id}/settlement-analysis?winProbability=0.6&expectedAward=200000&legalCosts=10000`,
    );
    expect(proceed.statusCode).toBe(200);
    const p = proceed.json() as {
      expectedValueOfProceeding: number;
      bestOpenOffer: { amount: number } | null;
      recommendation: string;
    };
    expect(p.expectedValueOfProceeding).toBe(110000);
    expect(p.bestOpenOffer!.amount).toBe(90000);
    expect(p.recommendation).toBe("proceed");

    // EV = 0.3 × 200000 − 25000 = 35000 ≤ 90000 → settle
    const settle = await get(
      `/projects/${projectId}/disputes/${d.id}/settlement-analysis?winProbability=0.3&expectedAward=200000&legalCosts=25000`,
    );
    const s = settle.json() as { expectedValueOfProceeding: number; recommendation: string };
    expect(s.expectedValueOfProceeding).toBe(35000);
    expect(s.recommendation).toBe("settle");
  });

  it("analyseSettlement is a pure function with exact arithmetic", () => {
    const offers = [
      {
        id: "o1",
        direction: "received",
        status: "open",
        amount: 50000,
        currency: "GBP",
        basis: "open",
        offeredAt: "2026-01-01",
      },
      {
        id: "o2",
        direction: "received",
        status: "rejected",
        amount: 999999,
        currency: "GBP",
        basis: "open",
        offeredAt: "2026-01-02",
      },
    ];
    const a = analyseSettlement(
      { winProbability: 0.55, expectedAward: 100000, legalCosts: 12345.5 },
      offers,
    );
    expect(a.expectedValueOfProceeding).toBe(42654.5);
    expect(a.bestOpenOffer!.id).toBe("o1"); // rejected offers never count
    expect(a.recommendation).toBe("settle");

    const b = analyseSettlement({ winProbability: 0.9, expectedAward: 100000, legalCosts: 0 }, []);
    expect(b.expectedValueOfProceeding).toBe(90000);
    expect(b.bestOpenOffer).toBeNull();
    expect(b.recommendation).toBe("proceed");
  });
});

/* ------------------------------------------------------------------ */
/* Isolation                                                           */
/* ------------------------------------------------------------------ */

describe("tenant and project isolation", () => {
  it("keeps disputes invisible across companies and projects", async () => {
    const d = (await createDispute({})).json() as { id: string };

    const stranger = await registerActor(app);
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/disputes/${d.id}`,
      headers: stranger.headers,
    });
    expect([403, 404]).toContain(cross.statusCode);

    // same company, different project → 404
    const otherProject = newId("prj");
    await app.db.insert(projects).values({
      id: otherProject,
      companyId: owner.companyId,
      name: "Other Project",
    });
    const wrongProject = await get(`/projects/${otherProject}/disputes/${d.id}`);
    expect(wrongProject.statusCode).toBe(404);
    const list = await get(`/projects/${otherProject}/disputes`);
    expect((list.json() as { total: number }).total).toBe(0);
  });
});
