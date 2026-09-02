/**
 * Integration tests for the contract-intelligence upgrade: Particular
 * Conditions driving the time-bar engine, calendar rules, chained deadlines,
 * persisted late service, the scheduled sweep with pre-expiry warnings,
 * per-contract obligation counts, the NEC compensation-event cycle with
 * quotations and deemed acceptance, the accepted-programme register,
 * insurance/bond compliance and health inputs — plus cross-tenant negatives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bonds,
  ceQuotations,
  companyMemberships,
  contractEvents,
  contractObligationLinks,
  contracts,
  insurancePolicies,
  obligations,
  projectMemberships,
  projects,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor;
let pm: TestActor; // second actor in the same company — the Project Manager side
let outsider: TestActor; // company member with no project membership
let stranger: TestActor; // a different company
let pmHeaders: Record<string, string>;
let outsiderHeaders: Record<string, string>;
let projectId: string;

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  pm = await registerActor(built.app);
  outsider = await registerActor(built.app);
  stranger = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: pm.userId,
    role: "member",
  });
  await built.app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: outsider.userId,
    role: "member",
  });
  pmHeaders = { authorization: pm.headers["authorization"]!, "x-company-id": owner.companyId };
  outsiderHeaders = {
    authorization: outsider.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await built.app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Contract upgrade project",
  });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: pm.userId,
    templateKey: "project_admin",
    overrides: {},
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

async function createContract(payload: Record<string, unknown>) {
  const res = await inject("POST", `/api/v1/projects/${projectId}/contracts`, owner.headers, payload);
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createEvent(contractId: string, payload: Record<string, unknown>) {
  return inject(
    "POST",
    `/api/v1/projects/${projectId}/contracts/${contractId}/events`,
    owner.headers,
    payload,
  );
}

/* ------------------------------------------------------------------ */
/* Particular Conditions drive the engine (production blocker)         */
/* ------------------------------------------------------------------ */

describe("particular conditions", () => {
  it("uses the amended time bar, not the standard form's", async () => {
    const contractId = await createContract({
      name: "Amended FIDIC",
      form: "fidic_red_2017",
      contractSum: 5_000_000,
      particularConditions: [
        {
          clauseRef: "20.2",
          amendment: "The Notice of Claim period is extended to 56 days.",
          timeBarDays: 56,
        },
      ],
    });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Late instruction on the piling mat",
      eventDate: isoDaysFromToday(-2),
    });
    expect(res.statusCode).toBe(201);
    const ev = res.json() as {
      noticeDeadline: string;
      effectiveTimeBarDays: number;
      deadlineSource: string;
      deadlineExplanation: string;
      obligationId: string;
    };
    // 56 days from the event date, NOT the library's 28
    expect(ev.noticeDeadline).toBe(isoDaysFromToday(54));
    expect(ev.effectiveTimeBarDays).toBe(56);
    expect(ev.deadlineSource).toBe("particular_condition");
    expect(ev.deadlineExplanation).toContain("Particular Condition");
    expect(ev.deadlineExplanation).toContain("28"); // the standard-form period is shown too

    const [obl] = await built.app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, ev.obligationId));
    expect(obl!.deadline).toContain(isoDaysFromToday(54));
  });

  it("shortens a bar the same way and warns earlier", async () => {
    const contractId = await createContract({
      name: "Shortened bar",
      form: "fidic_red_2017",
      particularConditions: [
        { clauseRef: "20.2", amendment: "Reduced to 14 days.", timeBarDays: 14, warnDaysBefore: 5 },
      ],
    });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Access denied to zone C",
      eventDate: isoDaysFromToday(0),
    });
    const ev = res.json() as { noticeDeadline: string; warnDaysBefore: number };
    expect(ev.noticeDeadline).toBe(isoDaysFromToday(14));
    expect(ev.warnDaysBefore).toBe(5);
  });

  it("removes the deadline entirely when the Particular Conditions delete the clause", async () => {
    const contractId = await createContract({
      name: "Deleted clause",
      form: "fidic_red_2017",
      particularConditions: [
        { clauseRef: "20.2", amendment: "Sub-Clause 20.2 is deleted.", deleted: true },
      ],
    });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Claim under the deleted clause",
      eventDate: isoDaysFromToday(-1),
    });
    const ev = res.json() as { noticeDeadline: string | null; deadlineExplanation: string };
    expect(ev.noticeDeadline).toBeNull();
    expect(ev.deadlineExplanation).toContain("deleted by the Particular Conditions");
  });

  it("counts working days and skips the contract's holidays", async () => {
    const contractId = await createContract({
      name: "Working days",
      form: "fidic_red_2017",
      calendarBasis: "working",
      holidays: ["2026-12-25", "2026-12-28"],
      particularConditions: [
        { clauseRef: "20.2", amendment: "10 working days.", timeBarDays: 10 },
      ],
    });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Christmas-week event",
      eventDate: "2026-12-18", // a Friday
    });
    const ev = res.json() as { noticeDeadline: string; calendarBasis: string };
    expect(ev.calendarBasis).toBe("working");
    // 10 working days from Fri 18 Dec 2026, skipping weekends and the two
    // recorded holidays, lands on Tue 5 Jan 2027 — a calendar count would have
    // said 28 Dec, which is one of the holidays.
    expect(ev.noticeDeadline).toBe("2027-01-05");
  });

  it("lets a bespoke contract state its own bar", async () => {
    const contractId = await createContract({ name: "Gulf derivative", form: "bespoke" });
    const withoutBar = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "42.1",
      title: "Unforeseen conditions",
      eventDate: isoDaysFromToday(-1),
    });
    expect((withoutBar.json() as { noticeDeadline: string | null }).noticeDeadline).toBeNull();
    expect((withoutBar.json() as { deadlineExplanation: string }).deadlineExplanation).toContain(
      "not in the bespoke library",
    );

    const withBar = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "42.1",
      title: "Unforeseen conditions, notified",
      eventDate: isoDaysFromToday(-1),
      timeBarDays: 30,
    });
    const ev = withBar.json() as {
      noticeDeadline: string;
      deadlineSource: string;
      obligationId: string | null;
    };
    expect(ev.noticeDeadline).toBe(isoDaysFromToday(29));
    expect(ev.deadlineSource).toBe("manual");
    expect(ev.obligationId).toBeTruthy();
  });

  it("runs the bar from the awareness date when one is recorded", async () => {
    const contractId = await createContract({ name: "Awareness", form: "fidic_red_2017" });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Latent defect discovered",
      eventDate: isoDaysFromToday(-40),
      awarenessDate: isoDaysFromToday(-5),
    });
    const ev = res.json() as { noticeDeadline: string; awarenessDate: string };
    expect(ev.awarenessDate).toBe(isoDaysFromToday(-5));
    expect(ev.noticeDeadline).toBe(isoDaysFromToday(23)); // awareness + 28
  });

  it("refuses an awareness date before the event", async () => {
    const contractId = await createContract({ name: "Bad awareness", form: "fidic_red_2017" });
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Impossible awareness",
      eventDate: isoDaysFromToday(-1),
      awarenessDate: isoDaysFromToday(-10),
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Serving notices: lateness, backdating, chained deadlines            */
/* ------------------------------------------------------------------ */

describe("serving notices", () => {
  it("persists lateness and keeps a barred event visibly barred", async () => {
    const contractId = await createContract({ name: "Late service", form: "fidic_red_2017" });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Missed notice",
      eventDate: isoDaysFromToday(-60),
    });
    const ev = created.json() as { id: string; obligationId: string };
    const served = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${ev.id}/serve-notice`,
      owner.headers,
      { method: "letter", reference: "LTR-99" },
    );
    expect(served.statusCode).toBe(200);
    const body = served.json() as {
      status: string;
      noticeServedLate: boolean;
      deadlineAtService: string;
      noticeServedAt: string;
    };
    expect(body.status).toBe("time_barred");
    expect(body.noticeServedLate).toBe(true);
    expect(body.deadlineAtService).toBe(isoDaysFromToday(-32));
    expect(body.noticeServedAt).toBeTruthy();

    // serving late does not satisfy the deadline obligation
    const [obl] = await built.app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, ev.obligationId));
    expect(obl!.status).not.toBe("satisfied");
  });

  it("refuses backdated service without a reason and evidence, and refuses the future", async () => {
    const contractId = await createContract({ name: "Backdating", form: "fidic_red_2017" });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Notice with a suspicious date",
      eventDate: isoDaysFromToday(-40),
    });
    const eventId = (created.json() as { id: string }).id;
    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/serve-notice`;

    // the laundering move: claim it was served before the bar elapsed
    const bare = await inject("POST", url, owner.headers, {
      method: "email",
      servedAt: `${isoDaysFromToday(-30)}T09:00:00Z`,
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toContain("reason and an evidence reference");

    const future = await inject("POST", url, owner.headers, {
      method: "email",
      servedAt: `${isoDaysFromToday(5)}T09:00:00Z`,
    });
    expect(future.statusCode).toBe(400);

    const documented = await inject("POST", url, owner.headers, {
      method: "registered_post",
      servedAt: `${isoDaysFromToday(-30)}T09:00:00Z`,
      reason: "Recorded late from the site correspondence file",
      evidenceRef: "Royal Mail proof of posting RM-77213",
    });
    expect(documented.statusCode).toBe(200);
    const body = documented.json() as {
      status: string;
      noticeServedLate: boolean;
      lateReason: string;
      serviceEvidenceRef: string;
    };
    // served inside the bar (event −40, deadline −12), so this one is timely
    expect(body.noticeServedLate).toBe(false);
    expect(body.status).toBe("notice_served");
    expect(body.lateReason).toContain("site correspondence");
    expect(body.serviceEvidenceRef).toContain("RM-77213");
  });

  it("spawns the chained FIDIC 20.2.4 obligation when the 20.2 notice is served", async () => {
    const contractId = await createContract({ name: "Chain", form: "fidic_red_2017" });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Unforeseeable ground conditions",
      eventDate: isoDaysFromToday(-3),
    });
    const eventId = (created.json() as { id: string }).id;
    const served = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/serve-notice`,
      owner.headers,
      { method: "email", reference: "NOC-1" },
    );
    const body = served.json() as { chainedEvents: Array<{ clauseRef: string; deadline: string }> };
    expect(body.chainedEvents).toHaveLength(1);
    expect(body.chainedEvents[0]!.clauseRef).toBe("20.2.4");
    // 84 days from awareness (the event date), not from the date of service
    expect(body.chainedEvents[0]!.deadline).toBe(isoDaysFromToday(81));

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}`,
      owner.headers,
    );
    expect((detail.json() as { chainedEvents: unknown[] }).chainedEvents).toHaveLength(1);

    // serving again does not spawn a duplicate chain
    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/serve-notice`,
      owner.headers,
      { method: "email", reference: "NOC-1b" },
    );
    expect(again.statusCode).toBe(400); // already served
  });
});

/* ------------------------------------------------------------------ */
/* The scheduled sweep                                                 */
/* ------------------------------------------------------------------ */

describe("time-bar sweep", () => {
  it("is registered with the platform scheduler", () => {
    const names = built.app.scheduler.list().map((j) => j.name);
    expect(names).toContain("contracts.time-bars");
    expect(names).toContain("contracts.ce-clocks");
  });

  it("warns inside the window once, then breaches, attributing the change to the system", async () => {
    const contractId = await createContract({ name: "Sweeping", form: "fidic_red_2017" });
    // deadline 3 days away, warning window is 7 days for a 28-day bar
    const warnEvent = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Notice due shortly",
      eventDate: isoDaysFromToday(-25),
    });
    const warnId = (warnEvent.json() as { id: string }).id;

    const first = await built.app.scheduler.runNow("contracts.time-bars");
    expect(first.state).toBe("succeeded");
    const warnedRows = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "time_bar_warning")),
      );
    expect(warnedRows.length).toBeGreaterThanOrEqual(1);
    const forThisEvent = warnedRows.filter(
      (s) => (s.evidenceRefs as Record<string, unknown>)["eventId"] === warnId,
    );
    expect(forThisEvent).toHaveLength(1);

    // a second sweep does not warn again
    await built.app.scheduler.runNow("contracts.time-bars");
    const afterSecond = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "time_bar_warning")),
      );
    expect(
      afterSecond.filter((s) => (s.evidenceRefs as Record<string, unknown>)["eventId"] === warnId),
    ).toHaveLength(1);

    const [row] = await built.app.db
      .select()
      .from(contractEvents)
      .where(eq(contractEvents.id, warnId));
    expect(row!.status).toBe("open");
    expect(row!.warnedAt).toBeTruthy();
  });

  it("can be run on demand by an admin for one project", async () => {
    const contractId = await createContract({ name: "Manual sweep", form: "fidic_red_2017" });
    await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Long overdue",
      eventDate: isoDaysFromToday(-90),
    });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/sweep-time-bars`,
      owner.headers,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { breached: number }).breached).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Obligation ownership                                                */
/* ------------------------------------------------------------------ */

describe("obligation ownership", () => {
  it("counts obligations per contract, not per form", async () => {
    const a = await createContract({ name: "FIDIC A", form: "fidic_red_2017" });
    const b = await createContract({ name: "FIDIC B", form: "fidic_red_2017" });
    const detailA = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${a}`,
      owner.headers,
    );
    const detailB = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${b}`,
      owner.headers,
    );
    const countA = (detailA.json() as { obligationCount: number }).obligationCount;
    const countB = (detailB.json() as { obligationCount: number }).obligationCount;
    expect(countA).toBeGreaterThan(0);
    // two FIDIC contracts on one project do NOT report each other's obligations
    expect(countA).toBe(countB);

    const links = await built.app.db
      .select()
      .from(contractObligationLinks)
      .where(eq(contractObligationLinks.contractId, a));
    expect(links.length).toBe(countA);
    expect(links.every((l) => l.kind === "standing")).toBe(true);
  });

  it("does not create standing obligations for clauses the PCs delete", async () => {
    const plain = await createContract({ name: "Plain NEC", form: "nec4_ecc", necOption: "C" });
    const trimmed = await createContract({
      name: "Trimmed NEC",
      form: "nec4_ecc",
      necOption: "C",
      particularConditions: [
        { clauseRef: "10.1", amendment: "Clause 10.1 is deleted.", deleted: true },
      ],
    });
    const countOf = async (id: string) =>
      (
        await built.app.db
          .select()
          .from(contractObligationLinks)
          .where(eq(contractObligationLinks.contractId, id))
      ).length;
    expect(await countOf(trimmed)).toBeLessThan(await countOf(plain));
  });
});

/* ------------------------------------------------------------------ */
/* NEC compensation events                                             */
/* ------------------------------------------------------------------ */

describe("NEC compensation-event cycle", () => {
  let contractId: string;
  let eventId: string;

  beforeAll(async () => {
    contractId = await createContract({
      name: "NEC4 Option C works",
      form: "nec4_ecc",
      necOption: "C",
      currency: "GBP",
      contractSum: 8_000_000,
    });
    const created = await createEvent(contractId, {
      kind: "compensation_event",
      clauseRef: "61.3",
      title: "Instruction changing the Scope",
      eventDate: isoDaysFromToday(-5),
    });
    eventId = (created.json() as { id: string }).id;
  });

  it("starts a compensation event in `notified` and reports the option's valuation basis", async () => {
    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}`,
      owner.headers,
    );
    expect((detail.json() as { ceState: string }).ceState).toBe("notified");

    const basis = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/nec-basis`,
      owner.headers,
    );
    expect(basis.statusCode).toBe(200);
    const body = basis.json() as { basis: string; painGainShare: boolean; necOption: string };
    expect(body.necOption).toBe("C");
    expect(body.basis).toBe("target_cost");
    expect(body.painGainShare).toBe(true);
  });

  it("refuses an illegal jump and instructs a quotation with a 3-week clock", async () => {
    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/ce-state`;
    const jump = await inject("POST", url, owner.headers, { state: "implemented" });
    expect(jump.statusCode).toBe(400);

    const noRef = await inject("POST", url, owner.headers, { state: "quotation_requested" });
    expect(noRef.statusCode).toBe(400);

    const ok = await inject("POST", url, owner.headers, {
      state: "quotation_requested",
      instructionRef: "PMI-014",
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { ceState: string; quotationDueDate: string };
    expect(body.ceState).toBe("quotation_requested");
    expect(body.quotationDueDate).toBe(isoDaysFromToday(21));
  });

  it("prices a quotation as Defined Cost plus Fee and sets the PM reply clock", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/quotations`,
      pmHeaders,
      {
        components: [
          { component: "people", description: "Gang", unit: "hr", qty: 100, rate: 55 },
          { component: "equipment", description: "Excavator", unit: "hr", qty: 20, rate: 300 },
        ],
        feePercent: 10,
        riskAllowance: 500,
        timeImpactDays: 7,
        assumptions: "Assumes continuous access to the north compound.",
      },
    );
    expect(res.statusCode).toBe(201);
    const q = res.json() as {
      id: string;
      definedCost: number;
      fee: number;
      total: number;
      replyDueDate: string;
      byComponent: Record<string, number>;
    };
    expect(q.definedCost).toBe(11_500);
    expect(q.fee).toBe(1_150);
    expect(q.total).toBe(13_150);
    expect(q.byComponent["people"]).toBe(5_500);
    expect(q.replyDueDate).toBe(isoDaysFromToday(14));

    const dup = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/quotations`,
      pmHeaders,
      { components: [{ component: "people", description: "x", qty: 1, rate: 1 }], feePercent: 10 },
    );
    expect(dup.statusCode).toBe(409);

    const self = await inject("POST", `/api/v1/ce-quotations/${q.id}/reply`, pmHeaders, {
      decision: "accepted",
    });
    expect(self.statusCode).toBe(403);

    const accepted = await inject("POST", `/api/v1/ce-quotations/${q.id}/reply`, owner.headers, {
      decision: "accepted",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("accepted");

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}`,
      owner.headers,
    );
    expect((detail.json() as { ceState: string }).ceState).toBe("implemented");
  });

  it("deems a quotation accepted under NEC4 when the reply clock runs out", async () => {
    const created = await createEvent(contractId, {
      kind: "compensation_event",
      clauseRef: "61.3",
      title: "Second CE for the deemed-acceptance clock",
      eventDate: isoDaysFromToday(-5),
    });
    const evId = (created.json() as { id: string }).id;
    const quote = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${evId}/quotations`,
      pmHeaders,
      {
        components: [{ component: "people", description: "Gang", qty: 10, rate: 50 }],
        feePercent: 10,
      },
    );
    const quotationId = quote.json().id as string;
    // wind the reply clock back beyond the further period under 62.6
    await built.app.db
      .update(ceQuotations)
      .set({ replyDueDate: isoDaysFromToday(-30) })
      .where(eq(ceQuotations.id, quotationId));

    await built.app.scheduler.runNow("contracts.ce-clocks");
    const [row] = await built.app.db
      .select()
      .from(ceQuotations)
      .where(eq(ceQuotations.id, quotationId));
    expect(row!.status).toBe("deemed_accepted");
    expect(row!.deemedAcceptedAt).toBeTruthy();

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "ce_deemed_acceptance")),
      );
    expect(raised.length).toBeGreaterThanOrEqual(1);

    // idempotent
    await built.app.scheduler.runNow("contracts.ce-clocks");
    const again = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "ce_deemed_acceptance")),
      );
    expect(again.length).toBe(raised.length);
  });

  it("refuses the CE cycle on a non-NEC contract", async () => {
    const jct = await createContract({ name: "JCT works", form: "jct_sbc_2016" });
    const created = await createEvent(jct, {
      kind: "compensation_event",
      clauseRef: "3.14",
      title: "Not an NEC event",
      eventDate: isoDaysFromToday(-1),
    });
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${jct}/events/${(created.json() as { id: string }).id}/ce-state`,
      owner.headers,
      { state: "quotation_requested", instructionRef: "X" },
    );
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Accepted programme register                                         */
/* ------------------------------------------------------------------ */

describe("accepted programmes", () => {
  it("requires an NEC 31.3 reason to reject and supersedes the previous acceptance", async () => {
    const contractId = await createContract({
      name: "Programme register",
      form: "nec4_ecc",
      necOption: "A",
    });
    const base = `/api/v1/projects/${projectId}/contracts/${contractId}/programmes`;
    const p1 = await inject("POST", base, pmHeaders, {
      submittedAt: isoDaysFromToday(-20),
      plannedCompletion: isoDaysFromToday(300),
      terminalFloatDays: 10,
    });
    expect(p1.statusCode).toBe(201);
    expect(p1.json().decisionDueDate).toBe(isoDaysFromToday(-6));
    const p1Id = p1.json().id as string;

    const selfDecide = await inject(`POST`, `${base}/${p1Id}/decide`, pmHeaders, {
      decision: "accepted",
    });
    expect(selfDecide.statusCode).toBe(403);

    const noReason = await inject("POST", `${base}/${p1Id}/decide`, owner.headers, {
      decision: "rejected",
    });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toContain("31.3");

    const accepted = await inject("POST", `${base}/${p1Id}/decide`, owner.headers, {
      decision: "accepted",
      decisionAt: isoDaysFromToday(-10),
    });
    expect(accepted.statusCode).toBe(200);

    const p2 = await inject("POST", base, pmHeaders, {
      submittedAt: isoDaysFromToday(-2),
      revision: "B",
    });
    const p2Id = p2.json().id as string;
    await inject("POST", `${base}/${p2Id}/decide`, owner.headers, { decision: "accepted" });

    const list = await inject("GET", base, owner.headers);
    const body = list.json() as {
      items: Array<{ id: string; status: string }>;
      currentAcceptedProgrammeId: string;
    };
    expect(body.currentAcceptedProgrammeId).toBe(p2Id);
    expect(body.items.find((p) => p.id === p1Id)!.status).toBe("superseded");
  });
});

/* ------------------------------------------------------------------ */
/* Insurance and bond compliance                                       */
/* ------------------------------------------------------------------ */

describe("contract compliance", () => {
  let contractId: string;

  beforeAll(async () => {
    contractId = await createContract({
      name: "Compliance contract",
      form: "fidic_red_2017",
      currency: "GBP",
      contractSum: 10_000_000,
      completionDate: isoDaysFromToday(200),
      defectsPeriodMonths: 12,
    });
  });

  it("seeds the form's requirement set once, with amounts derived from the contract sum", async () => {
    const seeded = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/seed`,
      owner.headers,
      {},
    );
    expect(seeded.statusCode).toBe(201);
    expect(seeded.json().created).toBeGreaterThan(2);

    const again = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/seed`,
      owner.headers,
      {},
    );
    expect(again.json().created).toBe(0);

    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance`,
      owner.headers,
    );
    const items = list.json().items as Array<{
      clauseRef: string;
      requiredAmount: number | null;
      status: string;
      requiredUntil: string | null;
    }>;
    const security = items.find((i) => i.clauseRef === "4.2")!;
    expect(security.requiredAmount).toBe(1_000_000); // 10% of the contract sum
    expect(security.status).toBe("unknown"); // no evidence is not "compliant"
    expect(security.requiredUntil).toBeTruthy();
  });

  it("evaluates linked evidence and refuses to pass a bond that is too small", async () => {
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance`,
      owner.headers,
    );
    const check = (list.json().items as Array<{ id: string; clauseRef: string }>).find(
      (i) => i.clauseRef === "4.2",
    )!;

    const smallBondId = newId("bond");
    await built.app.db.insert(bonds).values({
      id: smallBondId,
      companyId: owner.companyId,
      projectId,
      contractId,
      number: "B-1",
      bondType: "performance",
      guarantor: "A Bank plc",
      bondNumber: "PB-0001",
      amount: 400_000,
      currency: "GBP",
      status: "active",
      expiryAt: isoDaysFromToday(900),
      createdBy: owner.userId,
    });
    const linked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/${check.id}/evidence`,
      owner.headers,
      { evidenceType: "bond", evidenceId: smallBondId },
    );
    expect(linked.statusCode).toBe(200);
    const body = linked.json() as { status: string; reason: string };
    expect(body.status).toBe("non_compliant");
    expect(body.reason).toContain("short by");

    const bigBondId = newId("bond");
    await built.app.db.insert(bonds).values({
      id: bigBondId,
      companyId: owner.companyId,
      projectId,
      contractId,
      number: "B-2",
      bondType: "performance",
      guarantor: "A Bank plc",
      bondNumber: "PB-0002",
      amount: 1_000_000,
      currency: "GBP",
      status: "active",
      expiryAt: isoDaysFromToday(900),
      createdBy: owner.userId,
    });
    const relinked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/${check.id}/evidence`,
      owner.headers,
      { evidenceType: "bond", evidenceId: bigBondId },
    );
    expect(relinked.json().status).toBe("compliant");
  });

  it("flags cover that is about to expire when the checks are re-evaluated", async () => {
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance`,
      owner.headers,
    );
    const insuranceCheck = (
      list.json().items as Array<{ id: string; kind: string; clauseRef: string }>
    ).find((i) => i.kind === "insurance" && i.clauseRef === "19.2(d)")!;
    const policyId = newId("pol");
    await built.app.db.insert(insurancePolicies).values({
      id: policyId,
      companyId: owner.companyId,
      projectId,
      number: "POL-1",
      policyType: "public_liability",
      insurer: "Underwriter Ltd",
      policyNumber: "PL-9",
      currency: "GBP",
      periodStart: isoDaysFromToday(-300),
      periodEnd: isoDaysFromToday(5),
      status: "active",
      createdBy: owner.userId,
    });
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/${insuranceCheck.id}/evidence`,
      owner.headers,
      { evidenceType: "insurance_policy", evidenceId: policyId },
    );
    const evaluated = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/compliance/evaluate`,
      owner.headers,
      {},
    );
    expect(evaluated.statusCode).toBe(200);
    const body = evaluated.json() as { byStatus: Record<string, number> };
    // required until the end of the defects period, which is beyond the policy
    expect((body.byStatus["non_compliant"] ?? 0) + (body.byStatus["expiring"] ?? 0)).toBeGreaterThan(
      0,
    );

    const project = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contract-compliance`,
      owner.headers,
    );
    expect(project.statusCode).toBe(200);
    expect((project.json() as { total: number }).total).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* LD exposure, health inputs, tenancy                                 */
/* ------------------------------------------------------------------ */

describe("LD exposure and health inputs", () => {
  it("stops LD accrual at taking-over and freezes a completed contract", async () => {
    const contractId = await createContract({
      name: "LD stop",
      form: "fidic_red_2017",
      completionDate: isoDaysFromToday(-100),
      ldRatePerDay: 1_000,
      ldCap: 500_000,
    });
    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/ld-exposure`;
    const running = await inject("GET", url, owner.headers);
    expect((running.json() as { daysLate: number }).daysLate).toBe(100);

    await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/contracts/${contractId}`,
      owner.headers,
      { takingOverDate: isoDaysFromToday(-90) },
    );
    const stopped = await inject("GET", url, owner.headers);
    const body = stopped.json() as {
      daysLate: number;
      accrued: number;
      frozen: boolean;
      accrualEndBasis: string;
    };
    expect(body.daysLate).toBe(10);
    expect(body.accrued).toBe(10_000);
    expect(body.frozen).toBe(true);
    expect(body.accrualEndBasis).toContain("taking-over");
  });

  it("reports contract health inputs with reasons where a figure is unknowable", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/health-inputs`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["contracts"]).toBeGreaterThan(5);
    expect(body.metrics["timeBarsMissed"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics["noticesServedLate"]).toBeGreaterThanOrEqual(1);
    expect(body.metrics["contractsWithParticularConditions"]).toBeGreaterThanOrEqual(3);
    expect(Object.keys(body.metrics)).toContain("worstDaysLate");
  });

  /* ---------------------------------------------------------------- */
  /* Notice pack and the AI drafting hook (#228, #1006-1007)           */
  /* ---------------------------------------------------------------- */

  it("builds a deterministic notice pack that names its basis and its gaps", async () => {
    const contractId = await createContract({
      name: "Notice pack contract",
      form: "fidic_red_2017",
      contractSum: 3_000_000,
      currency: "GBP",
      parties: { employer: "Metro Authority", contractor: "Buildco", administrator: "Consult Eng" },
      particularConditions: [
        { clauseRef: "20.2", amendment: "Notice period extended to 56 days", timeBarDays: 56 },
      ],
    });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Unforeseeable ground conditions in Zone 4",
      description: "Rock encountered at 2.4 m below the level shown on the geotechnical baseline.",
      eventDate: isoDaysFromToday(-3),
      awarenessDate: isoDaysFromToday(-2),
    });
    expect(created.statusCode).toBe(201);
    const eventId = created.json().id as string;

    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/notice-pack`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const pack = res.json() as {
      clauseRef: string;
      basis: string;
      addressee: string;
      addresseeRole: string;
      urgency: string;
      serviceRules: string[];
      requirements: Array<{ key: string; satisfied: boolean }>;
      missing: string[];
      draft: string;
      aiAvailable: boolean;
      note: string;
    };
    expect(pack.clauseRef).toBe("20.2");
    // The pack must quote the AMENDED bar, not the standard form's 28 days.
    expect(pack.basis).toContain("56 calendar days");
    expect(pack.basis).toContain("Particular Conditions");
    expect(pack.addressee).toBe("Consult Eng");
    expect(pack.addresseeRole).toBe("administrator");
    expect(pack.serviceRules.join(" ")).toContain("1.3");
    expect(pack.draft).toContain("Consult Eng");
    expect(pack.draft).toContain("Rock encountered");
    expect(pack.requirements.find((r) => r.key === "clause_ref")?.satisfied).toBe(true);
    // No key configured in tests: the pack still exists, and says why.
    expect(pack.aiAvailable).toBe(false);
    expect(pack.note).toContain("deterministically");
  });

  it("brackets every fact the record does not hold instead of inventing it", async () => {
    const contractId = await createContract({
      name: "Sparse contract",
      form: "fidic_red_2017",
      parties: { employer: "Metro Authority" },
    });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Access",
      eventDate: isoDaysFromToday(-1),
    });
    const eventId = created.json().id as string;
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/notice-pack`,
      owner.headers,
    );
    const pack = res.json() as { missing: string[]; draft: string; addressee: string | null };
    expect(pack.addressee).toBeNull();
    expect(pack.missing.length).toBeGreaterThanOrEqual(3);
    expect(pack.draft).toContain("NOT ON RECORD");
  });

  it("returns 503 AiDisabled from the drafting hook while the pack keeps working", async () => {
    const contractId = await createContract({ name: "AI hook contract", form: "nec4_ecc", necOption: "C" });
    const created = await createEvent(contractId, {
      kind: "compensation_event",
      clauseRef: "61.3",
      title: "Late access to the working areas",
      eventDate: isoDaysFromToday(-2),
    });
    const eventId = created.json().id as string;
    const draft = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/draft-notice`,
      owner.headers,
      {},
    );
    expect(draft.statusCode).toBe(503);
    expect(draft.json().error).toBe("AiDisabled");

    const pack = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/notice-pack`,
      owner.headers,
    );
    expect(pack.statusCode).toBe(200);
    // NEC notifications are governed by clause 13, not FIDIC 1.3.
    expect((pack.json() as { serviceRules: string[] }).serviceRules.join(" ")).toContain("13.1");
  });

  it("refuses the notice pack to a company member who is not on the project", async () => {
    const contractId = await createContract({ name: "Notice tenancy", form: "fidic_red_2017" });
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Tenancy check",
      eventDate: isoDaysFromToday(-1),
    });
    const eventId = created.json().id as string;
    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/events/${eventId}/notice-pack`;
    expect((await inject("GET", url, outsiderHeaders)).statusCode).toBe(403);
    expect([403, 404]).toContain((await inject("GET", url, stranger.headers)).statusCode);
  });

  it("keeps every contract route inside its tenant and its project", async () => {
    const contractId = await createContract({ name: "Tenancy", form: "fidic_red_2017" });
    const otherCompany = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}`,
      stranger.headers,
    );
    expect([403, 404]).toContain(otherCompany.statusCode);

    const nonMember = await inject(
      "GET",
      `/api/v1/projects/${projectId}/contracts/${contractId}`,
      outsiderHeaders,
    );
    expect(nonMember.statusCode).toBe(403);

    const write = await inject(
      "POST",
      `/api/v1/projects/${projectId}/contracts/${contractId}/events`,
      outsiderHeaders,
      { kind: "claim_notice", title: "Should not land", eventDate: isoDaysFromToday(0) },
    );
    expect(write.statusCode).toBe(403);

    const stillEmpty = await built.app.db
      .select()
      .from(contracts)
      .where(and(eq(contracts.companyId, stranger.companyId)));
    expect(stillEmpty).toHaveLength(0);
  });
});
