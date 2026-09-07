/**
 * Household ↔ grievance coupling — engine unit tests and route integration
 * tests.
 *
 * The gap this closes: `grievance_open` was in the PAP status enum, in
 * PAP_TRANSITIONS, refused by the PAP status route with the words "the
 * grievance register sets it" — and nothing anywhere set it. A household
 * under a live complaint was indistinguishable from one that was not.
 *
 * The dangerous half of closing it is the overlay. `grievance_open` shares a
 * column with `resettled` and `livelihood_restored`, so a naive
 * implementation would let a dust complaint clear the PS5 "resettled before
 * compensation" finding against a household that was moved without being
 * paid, and manufacture a "livelihood not restored" finding against one whose
 * livelihood was restored. Both directions are tested here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { affectedPersons, evidence, ledgerEntries, projects, signals } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { todayISO } from "../field/dates.js";
import {
  effectivePapStatus,
  papGrievanceTransition,
  syncPapGrievanceStatus,
} from "./pap-grievance.js";

/* ================================================================== */
/* Engine (pure)                                                       */
/* ================================================================== */

describe("papGrievanceTransition", () => {
  it("stashes the current status and flags on the first open grievance", () => {
    const t = papGrievanceTransition({ status: "resettled", statusBeforeGrievance: null }, 1);
    expect(t.next).toEqual({ status: "grievance_open", statusBeforeGrievance: "resettled" });
    expect(t.reason).toContain("1 open grievance");
  });

  it("is idempotent — a second grievance must not overwrite the stash", () => {
    const t = papGrievanceTransition(
      { status: "grievance_open", statusBeforeGrievance: "resettled" },
      2,
    );
    expect(t.next).toBeNull();
  });

  it("restores the stashed status exactly when every grievance settles", () => {
    const t = papGrievanceTransition(
      { status: "grievance_open", statusBeforeGrievance: "livelihood_restored" },
      0,
    );
    expect(t.next).toEqual({ status: "livelihood_restored", statusBeforeGrievance: null });
  });

  it("falls back to registered for a flagged row with no stash", () => {
    const t = papGrievanceTransition({ status: "grievance_open", statusBeforeGrievance: null }, 0);
    expect(t.next).toEqual({ status: "registered", statusBeforeGrievance: null });
    expect(t.reason).toContain("no prior status");
  });

  it("does nothing when there is no grievance and no flag", () => {
    expect(
      papGrievanceTransition({ status: "compensated", statusBeforeGrievance: null }, 0).next,
    ).toBeNull();
  });
});

describe("effectivePapStatus", () => {
  it("sees through the overlay to the substantive status", () => {
    expect(
      effectivePapStatus({ status: "grievance_open", statusBeforeGrievance: "resettled" }),
    ).toBe("resettled");
  });

  it("passes an unflagged status through untouched", () => {
    expect(effectivePapStatus({ status: "surveyed", statusBeforeGrievance: null })).toBe(
      "surveyed",
    );
  });

  it("does not invent a status for a flagged row with no stash", () => {
    expect(effectivePapStatus({ status: "grievance_open", statusBeforeGrievance: null })).toBe(
      "grievance_open",
    );
  });
});

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let stranger: TestActor;
let pid: string;

async function insertEvidence(projectId: string): Promise<string> {
  const id = newId("evd");
  await app.db.insert(evidence).values({
    id,
    companyId: owner.companyId,
    projectId,
    kind: "bank_transaction",
    source: "compensation disbursement account",
    contentHash: `hash-${id}`,
    submittedBy: owner.userId,
  });
  return id;
}

async function makePap(reference: string, displacementType = "both"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/affected-persons`,
    headers: owner.headers,
    payload: { reference, householdHead: `Head of ${reference}`, displacementType },
  });
  if (res.statusCode !== 201) throw new Error(`pap create failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

async function papRow(id: string) {
  const [row] = await app.db.select().from(affectedPersons).where(eq(affectedPersons.id, id));
  return row!;
}

async function makeGrievance(papId: string | null, description: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/grievances`,
    headers: owner.headers,
    payload: {
      channel: "in_person",
      category: "dust",
      severity: "medium",
      description,
      receivedAt: todayISO(),
      ...(papId ? { papId } : {}),
    },
  });
  if (res.statusCode !== 201) throw new Error(`grievance create failed: ${res.body}`);
  return (res.json() as { id: string }).id;
}

async function settle(grievanceId: string): Promise<void> {
  const rejected = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${pid}/grievances/${grievanceId}/reject`,
    headers: owner.headers,
    payload: { reason: "Out of scope — no project activity at that location" },
  });
  if (rejected.statusCode !== 200) throw new Error(`reject failed: ${rejected.body}`);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  stranger = await registerActor(app);
  pid = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: pid, companyId: owner.companyId, name: "Kibaale road realignment" });
}, 120_000);

afterAll(async () => {
  await built.close();
});

describe("household grievance flag", () => {
  it("flags the household when a grievance naming it is opened, and stashes where it was", async () => {
    const papId = await makePap("PAP-100");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    expect((await papRow(papId)).status).toBe("surveyed");

    const grievanceId = await makeGrievance(papId, "Dust from the haul road on the compound");
    const after = await papRow(papId);
    expect(after.status).toBe("grievance_open");
    expect(after.statusBeforeGrievance).toBe("surveyed");

    const led = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "affected_person"),
          eq(ledgerEntries.objectId, papId),
        ),
      );
    const sync = led.find(
      (l) => (l.payload as Record<string, unknown> | null)?.["event"] === "grievance_status_sync",
    );
    expect(sync).toBeDefined();
    expect((sync!.payload as Record<string, unknown>)["from"]).toBe("surveyed");
    expect((sync!.payload as Record<string, unknown>)["to"]).toBe("grievance_open");
    expect((sync!.payload as Record<string, unknown>)["grievanceId"]).toBe(grievanceId);
  });

  it("keeps the stash intact when a second grievance names the same household", async () => {
    const papId = await makePap("PAP-101");
    await makeGrievance(papId, "Noise at night from the batching plant");
    expect((await papRow(papId)).statusBeforeGrievance).toBe("registered");
    await makeGrievance(papId, "Access track blocked by parked plant");
    const row = await papRow(papId);
    expect(row.status).toBe("grievance_open");
    // NOT "grievance_open" — that would have lost the real prior status
    expect(row.statusBeforeGrievance).toBe("registered");
  });

  it("clears the flag only when the LAST grievance settles, restoring the exact status", async () => {
    const papId = await makePap("PAP-102");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    const a = await makeGrievance(papId, "Crops damaged by the diversion road");
    const b = await makeGrievance(papId, "Water source silted by the works");
    expect((await papRow(papId)).status).toBe("grievance_open");

    await settle(a);
    expect((await papRow(papId)).status).toBe("grievance_open");

    await settle(b);
    const row = await papRow(papId);
    expect(row.status).toBe("surveyed");
    expect(row.statusBeforeGrievance).toBeNull();
  });

  it("reflags when an unsatisfied complainant reopens a resolved grievance", async () => {
    const papId = await makePap("PAP-103");
    const gid = await makeGrievance(papId, "Fence removed without notice");
    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${gid}/resolve`,
      headers: owner.headers,
      payload: { resolution: "Fence reinstated on 12th" },
    });
    expect(resolved.statusCode).toBe(200);
    expect((await papRow(papId)).status).toBe("registered");

    const reopened = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/grievances/${gid}/verify-closure`,
      headers: owner.headers,
      payload: { complainantSatisfied: false, note: "Fence is not on the original line" },
    });
    expect(reopened.statusCode).toBe(200);
    expect((await papRow(papId)).status).toBe("grievance_open");
  });

  it("still refuses grievance_open as something a person can type in", async () => {
    const papId = await makePap("PAP-104");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/status`,
      headers: owner.headers,
      payload: { status: "grievance_open" },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().message)).toMatch(/set by the grievance register/i);
  });

  it("lets the lifecycle advance under an open grievance without clearing the flag", async () => {
    const papId = await makePap("PAP-105");
    await makeGrievance(papId, "Boundary marker moved onto our land");
    expect((await papRow(papId)).status).toBe("grievance_open");

    // registered → surveyed is the legal next step from the SUBSTANTIVE status
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/status`,
      headers: owner.headers,
      payload: { status: "surveyed" },
    });
    expect(res.statusCode).toBe(200);
    const row = await papRow(papId);
    expect(row.status).toBe("grievance_open"); // the complaint is not cleared
    expect(row.statusBeforeGrievance).toBe("surveyed"); // but the lifecycle moved

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}`,
      headers: owner.headers,
    });
    const body = detail.json() as {
      effectiveStatus: string;
      underOpenGrievance: boolean;
      allowedTransitions: string[];
    };
    expect(body.effectiveStatus).toBe("surveyed");
    expect(body.underOpenGrievance).toBe(true);
    expect(body.allowedTransitions).toEqual(["entitlement_agreed"]);
  });

  it("does not let a complaint hide a household resettled without payment (PS5 para 20)", async () => {
    const papId = await makePap("PAP-106", "physical");
    // force the household to `resettled` with no payment, the way a bad
    // migration or a direct correction would
    await app.db
      .update(affectedPersons)
      .set({ status: "resettled" })
      .where(eq(affectedPersons.id, papId));

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const before = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "displacement_before_compensation"),
          eq(signals.subjectId, papId),
        ),
      );
    expect(before).toHaveLength(1);

    // now a complaint arrives; the finding must survive it
    await makeGrievance(papId, "Relocation site has no water supply");
    expect((await papRow(papId)).status).toBe("grievance_open");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/land/detectors/run`,
      headers: owner.headers,
    });
    const after = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "displacement_before_compensation"),
          eq(signals.subjectId, papId),
        ),
      );
    expect(after).toHaveLength(1);
    expect(after[0]!.disposition).toBe("new"); // NOT auto-closed by the complaint
  });

  it("counts a restored household as restored while it is under complaint", async () => {
    const papId = await makePap("PAP-107", "economic");
    const entitled = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/entitlements`,
      headers: owner.headers,
      payload: {
        entitlements: [
          { item: "Transitional allowance", basis: "6 months of median household income", amount: 1_200 },
        ],
      },
    });
    expect(entitled.statusCode).toBe(200);
    const evidenceId = await insertEvidence(pid);
    const paid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/compensate`,
      headers: owner.headers,
      payload: { paidAt: todayISO(), evidenceIds: [evidenceId] },
    });
    expect(paid.statusCode).toBe(200);
    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${pid}/affected-persons/${papId}/status`,
      headers: owner.headers,
      payload: { status: "livelihood_restored" },
    });
    expect(restored.statusCode).toBe(200);

    const indicatorsBefore = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-indicators`,
      headers: owner.headers,
    });
    const restoredBefore = (
      indicatorsBefore.json() as { households: { livelihoodRestored: number } }
    ).households.livelihoodRestored;

    await makeGrievance(papId, "Training promised under the livelihood programme never happened");
    expect((await papRow(papId)).status).toBe("grievance_open");

    const indicatorsAfter = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pid}/land/rap-indicators`,
      headers: owner.headers,
    });
    const body = indicatorsAfter.json() as {
      households: { livelihoodRestored: number; underOpenGrievance: number };
    };
    expect(body.households.livelihoodRestored).toBe(restoredBefore);
    expect(body.households.underOpenGrievance).toBeGreaterThan(0);
  });

  it("heals drift in the scheduled sweep as the system actor", async () => {
    const papId = await makePap("PAP-108");
    // a grievance that never reached the sync (a partial write, a direct
    // insert, a row created before the coupling existed)
    await makeGrievance(papId, "Livestock route cut by the embankment");
    await app.db
      .update(affectedPersons)
      .set({ status: "registered", statusBeforeGrievance: null })
      .where(eq(affectedPersons.id, papId));

    await app.scheduler.runNow("land.detectors");
    const row = await papRow(papId);
    expect(row.status).toBe("grievance_open");
    expect(row.statusBeforeGrievance).toBe("registered");

    const led = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "affected_person"),
          eq(ledgerEntries.objectId, papId),
        ),
      );
    const syncs = led
      .filter(
        (l) => (l.payload as Record<string, unknown> | null)?.["event"] === "grievance_status_sync",
      )
      .sort((a, b) => a.seq - b.seq);
    // the intake wrote the first one; the sweep's repair is the LAST
    expect(syncs.length).toBeGreaterThanOrEqual(2);
    // the SYSTEM healed this, not whoever happened to be looking at a page
    expect(syncs[syncs.length - 1]!.actorId).toBeNull();
  });

  it("is a no-op for a grievance naming no household", async () => {
    const before = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "affected_person"),
        ),
      );
    await makeGrievance(null, "General complaint about site lighting at night");
    const after = await app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "affected_person"),
        ),
      );
    expect(after.length).toBe(before.length);
  });

  it("never touches another tenant's household", async () => {
    const theirProject = newId("prj");
    await app.db
      .insert(projects)
      .values({ id: theirProject, companyId: stranger.companyId, name: "Their scheme" });
    const theirPapId = newId("pap");
    await app.db.insert(affectedPersons).values({
      id: theirPapId,
      companyId: stranger.companyId,
      projectId: theirProject,
      reference: "PAP-X1",
      householdHead: "Their household",
      displacementType: "both",
      status: "resettled",
      createdBy: stranger.userId,
    });
    // the owner's company id with the stranger's household must resolve to nothing
    const res = await syncPapGrievanceStatus(app.db, {
      companyId: owner.companyId,
      projectId: pid,
      papId: theirPapId,
      actorId: owner.userId,
    });
    expect(res).toBeNull();
    const [row] = await app.db
      .select()
      .from(affectedPersons)
      .where(eq(affectedPersons.id, theirPapId));
    expect(row!.status).toBe("resettled");
  });
});
