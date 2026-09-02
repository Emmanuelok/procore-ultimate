import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq, ilike } from "drizzle-orm";
import { companyMemberships, obligations, projects, signals } from "@constructos/db";
import { CONTRACT_FORMS, CLAUSE_CATEGORIES } from "@constructos/shared";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { CLAUSE_LIBRARY, clausesForForm } from "./clause-library.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let assessor: TestActor; // second user in owner's company (admin) for determination independence
let assessorHeaders: Record<string, string>;
let projectId: string;

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  assessor = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: assessor.userId,
    role: "admin",
  });
  assessorHeaders = {
    authorization: assessor.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Contract Intelligence Test Project",
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

async function createContract(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/contracts`,
    headers: owner.headers,
    payload,
  });
}

async function createEvent(contractId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/contracts/${contractId}/events`,
    headers: owner.headers,
    payload,
  });
}

/* ------------------------------------------------------------------ */
/* Clause library integrity                                            */
/* ------------------------------------------------------------------ */

describe("clause library", () => {
  it("holds at least 70 clauses covering every standard form", () => {
    expect(CLAUSE_LIBRARY.length).toBeGreaterThanOrEqual(70);
    for (const form of CONTRACT_FORMS) {
      if (form === "bespoke") continue; // bespoke has no standard clauses by definition
      expect(clausesForForm(form).length, `form ${form}`).toBeGreaterThan(0);
    }
  });

  it("has unique clause refs per form, valid categories, and honest time bars", () => {
    const seen = new Set<string>();
    for (const c of CLAUSE_LIBRARY) {
      const key = `${c.form}::${c.clauseRef}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      expect(CLAUSE_CATEGORIES).toContain(c.category);
      expect(c.summary.length).toBeGreaterThan(20);
      if (c.timeBarDays !== undefined) {
        expect(c.timeBarDays).toBeGreaterThan(0);
        // a day-counted bar is meaningless without a notice requirement
        expect(c.noticeRequired, `${key} has timeBarDays but noticeRequired=false`).toBe(true);
      }
    }
  });

  it("serves forms + clause counts and filtered clause lists over HTTP", async () => {
    const formsRes = await app.inject({
      method: "GET",
      url: "/api/v1/contract-forms",
      headers: owner.headers,
    });
    expect(formsRes.statusCode).toBe(200);
    const forms = formsRes.json() as { items: { form: string; clauseCount: number }[] };
    expect(forms.items.length).toBe(CONTRACT_FORMS.length);
    const nec4 = forms.items.find((f) => f.form === "nec4_ecc");
    expect(nec4!.clauseCount).toBeGreaterThan(0);

    const clausesRes = await app.inject({
      method: "GET",
      url: "/api/v1/contract-forms/fidic_red_2017/clauses?category=notice&search=28",
      headers: owner.headers,
    });
    expect(clausesRes.statusCode).toBe(200);
    const body = clausesRes.json() as { items: { clauseRef: string; category: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const c of body.items) expect(c.category).toBe("notice");
    expect(body.items.some((c) => c.clauseRef === "20.2")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Contracts                                                           */
/* ------------------------------------------------------------------ */

describe("contracts", () => {
  it("creating a contract materializes the form's standing obligations", async () => {
    const res = await createContract({
      name: "Main Works Contract",
      form: "fidic_red_2017",
      contractSum: 25_000_000,
      completionDate: isoDaysFromToday(365),
      particularConditions: [{ clauseRef: "20.2", amendment: "Time bar extended to 56 days" }],
    });
    expect(res.statusCode).toBe(201);
    const contract = res.json() as { id: string; status: string };
    expect(contract.status).toBe("draft");

    const expected = clausesForForm("fidic_red_2017").filter((c) => c.standingObligation);
    const rows = await app.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.projectId, projectId),
          ilike(obligations.sourceClause, "fidic_red_2017 %"),
        ),
      );
    expect(rows.length).toBe(expected.length);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.status).toBe("open");
      expect(row.deadline).toBeNull();
      expect(row.trigger.length).toBeGreaterThan(10);
    }
  });

  it("requires necOption for NEC forms and rejects it elsewhere", async () => {
    const missing = await createContract({ name: "NEC no option", form: "nec4_ecc" });
    expect(missing.statusCode).toBe(400);

    const stray = await createContract({
      name: "JCT with option",
      form: "jct_sbc_2016",
      necOption: "C",
    });
    expect(stray.statusCode).toBe(400);

    const ok = await createContract({ name: "NEC target cost", form: "nec4_ecc", necOption: "C" });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { necOption: string }).necOption).toBe("C");
  });

  it("returns effective clauses with particular-condition amendment flags", async () => {
    const created = await createContract({
      name: "Amended FIDIC",
      form: "fidic_red_2017",
      particularConditions: [{ clauseRef: "14.7", amendment: "Payment period reduced to 30 days" }],
    });
    const contractId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      effectiveClauses: { clauseRef: string; amended: boolean; amendment: string | null }[];
      obligationCount: number;
      eventCounts: Record<string, number>;
    };
    expect(body.effectiveClauses.length).toBe(clausesForForm("fidic_red_2017").length);
    const amended = body.effectiveClauses.find((c) => c.clauseRef === "14.7");
    expect(amended!.amended).toBe(true);
    expect(amended!.amendment).toBe("Payment period reduced to 30 days");
    const untouched = body.effectiveClauses.find((c) => c.clauseRef === "20.2");
    expect(untouched!.amended).toBe(false);
    expect(body.obligationCount).toBeGreaterThan(0);
    expect(body.eventCounts).toEqual({});
  });

  it("enforces a forward-only status lifecycle", async () => {
    const created = await createContract({ name: "Lifecycle", form: "jct_sbc_2016" });
    const contractId = (created.json() as { id: string }).id;
    const url = `/api/v1/projects/${projectId}/contracts/${contractId}/status`;

    const skip = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { status: "completed" },
    });
    expect(skip.statusCode).toBe(400); // draft cannot jump to completed

    const execute = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { status: "executed" },
    });
    expect(execute.statusCode).toBe(200);

    // form is frozen once executed
    const reform = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: owner.headers,
      payload: { form: "jct_db_2016" },
    });
    expect(reform.statusCode).toBe(400);

    const complete = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { status: "completed" },
    });
    expect(complete.statusCode).toBe(200);

    const reopen = await app.inject({
      method: "POST",
      url,
      headers: owner.headers,
      payload: { status: "terminated" },
    });
    expect(reopen.statusCode).toBe(400); // completed is terminal
  });
});

/* ------------------------------------------------------------------ */
/* Events, notices and the time-bar engine                             */
/* ------------------------------------------------------------------ */

describe("contract events + time-bar engine", () => {
  let contractId: string;

  beforeAll(async () => {
    const res = await createContract({ name: "Time-bar contract", form: "fidic_red_2017" });
    contractId = (res.json() as { id: string }).id;
  });

  it("computes the notice deadline from the clause time bar and links an obligation", async () => {
    const eventDate = isoDaysFromToday(-2);
    const expectedDeadline = isoDaysFromToday(26); // eventDate + 28 days (FIDIC 20.2)
    const res = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Differing ground conditions at pier 3",
      eventDate,
    });
    expect(res.statusCode).toBe(201);
    const ev = res.json() as {
      noticeDeadline: string;
      obligationId: string;
      status: string;
      daysToDeadline: number;
    };
    expect(ev.status).toBe("open");
    expect(ev.noticeDeadline).toBe(expectedDeadline);
    expect(ev.daysToDeadline).toBe(26);
    expect(ev.obligationId).toBeTruthy();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, ev.obligationId));
    expect(obl!.sourceClause).toBe("fidic_red_2017 20.2");
    expect(obl!.trigger).toContain("Notice required");
    expect(obl!.deadline).toContain(expectedDeadline);
    expect(obl!.warnDaysBefore).toBe(7); // min(14, ceil(28/4))
    expect(obl!.evidenceRequirement).toBe("Served notice with proof of service");
    expect(obl!.status).toBe("open");
  });

  it("leaves the deadline empty for clauses without a time bar", async () => {
    const res = await createEvent(contractId, {
      kind: "delay_event",
      clauseRef: "8.5",
      title: "Exceptionally adverse weather",
      eventDate: isoDaysFromToday(-3),
    });
    expect(res.statusCode).toBe(201);
    const ev = res.json() as { noticeDeadline: string | null; obligationId: string | null };
    expect(ev.noticeDeadline).toBeNull();
    expect(ev.obligationId).toBeNull();
  });

  it("serving notice in time satisfies the linked obligation", async () => {
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Late access to zone B",
      eventDate: isoDaysFromToday(-2), // deadline is 26 days away
    });
    const ev = created.json() as { id: string; obligationId: string };
    const served = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/events/${ev.id}/serve-notice`,
      headers: owner.headers,
      payload: { method: "email", reference: "LTR-0042" },
    });
    expect(served.statusCode).toBe(200);
    const body = served.json() as { status: string; late: boolean; noticeMethod: string };
    expect(body.status).toBe("notice_served");
    expect(body.late).toBe(false);
    expect(body.noticeMethod).toBe("email");
    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, ev.obligationId));
    expect(obl!.status).toBe("satisfied");
  });

  it("recording a late notice keeps the event barred and persists the breach", async () => {
    const created = await createEvent(contractId, {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Utility diversion delay",
      eventDate: isoDaysFromToday(-60), // deadline passed ~32 days ago
    });
    const ev = created.json() as { id: string; number: number };
    const served = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/events/${ev.id}/serve-notice`,
      headers: owner.headers,
      payload: { method: "registered_post" },
    });
    expect(served.statusCode).toBe(200);
    const body = served.json() as {
      status: string;
      late: boolean;
      noticeServedLate: boolean;
      deadlineAtService: string | null;
    };
    // a late notice does not launder a missed bar into a clean "notice served"
    expect(body.status).toBe("time_barred");
    expect(body.late).toBe(true);
    expect(body.noticeServedLate).toBe(true);
    expect(body.deadlineAtService).toBeTruthy();
    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "time_bar_breach_risk")),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.severity).toBe("high");
    expect(rows[0]!.explanation).toContain("after the notice deadline");
  });

  it("the scheduled sweep breaches past-deadline events exactly once", async () => {
    const created = await createEvent(contractId, {
      kind: "compensation_event",
      clauseRef: "20.2",
      title: "Unnotified variation work",
      eventDate: isoDaysFromToday(-40), // deadline passed ~12 days ago
    });
    const ev = created.json() as { id: string; obligationId: string; status: string };
    // Reading the register no longer performs the transition: the sweep is a
    // scheduled job, so an unread contract is still policed.
    expect(ev.status).toBe("open");
    const listUrl = `/api/v1/projects/${projectId}/contracts/${contractId}/events`;
    const beforeSweep = await app.inject({ method: "GET", url: listUrl, headers: owner.headers });
    expect(
      (beforeSweep.json() as { items: { id: string; status: string }[] }).items.find(
        (i) => i.id === ev.id,
      )!.status,
    ).toBe("open");

    await app.scheduler.runNow("contracts.time-bars");

    const after = await app.inject({ method: "GET", url: listUrl, headers: owner.headers });
    expect(after.statusCode).toBe(200);
    const swept = (after.json() as { items: { id: string; status: string }[] }).items.find(
      (i) => i.id === ev.id,
    );
    expect(swept!.status).toBe("time_barred");

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, ev.obligationId));
    expect(obl!.status).toBe("breached");

    const signalCount = async () =>
      (
        await app.db
          .select()
          .from(signals)
          .where(
            and(eq(signals.companyId, owner.companyId), eq(signals.detector, "time_bar_missed")),
          )
      ).length;
    const afterFirst = await signalCount();
    expect(afterFirst).toBe(1);

    // a second sweep must not duplicate the signal or re-transition
    await app.scheduler.runNow("contracts.time-bars");
    expect(await signalCount()).toBe(afterFirst);
  });

  it("time-bar radar orders open deadlines ascending with negative days for overdue", async () => {
    // fresh contract so earlier tests' events (already swept/served) don't interfere
    const res = await createContract({ name: "Radar contract", form: "nec4_ecc", necOption: "A" });
    const radarContract = (res.json() as { id: string }).id;
    // NEC4 61.3: 56-day bar. eventDate -60 → deadline 4 days ago (negative).
    const overdue = await createEvent(radarContract, {
      kind: "compensation_event",
      clauseRef: "61.3",
      title: "Overdue CE notification",
      eventDate: isoDaysFromToday(-60),
    });
    // eventDate -40 → deadline in 16 days (within 30-day window).
    const upcoming = await createEvent(radarContract, {
      kind: "compensation_event",
      clauseRef: "61.3",
      title: "Upcoming CE notification",
      eventDate: isoDaysFromToday(-40),
    });
    const overdueId = (overdue.json() as { id: string }).id;
    const upcomingId = (upcoming.json() as { id: string }).id;

    const radar = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/deadlines?days=30`,
      headers: owner.headers,
    });
    expect(radar.statusCode).toBe(200);
    const items = (
      radar.json() as {
        items: { id: string; daysRemaining: number; clauseTitle: string | null }[];
      }
    ).items;
    const ids = items.map((i) => i.id);
    expect(ids).toContain(overdueId);
    expect(ids).toContain(upcomingId);
    expect(ids.indexOf(overdueId)).toBeLessThan(ids.indexOf(upcomingId)); // ascending deadlines
    const overdueItem = items.find((i) => i.id === overdueId)!;
    const upcomingItem = items.find((i) => i.id === upcomingId)!;
    expect(overdueItem.daysRemaining).toBeLessThan(0);
    expect(upcomingItem.daysRemaining).toBeGreaterThan(0);
    expect(overdueItem.clauseTitle).toContain("Compensation Events");
  });
});

/* ------------------------------------------------------------------ */
/* EOT claims                                                          */
/* ------------------------------------------------------------------ */

describe("EOT claims", () => {
  let contractId: string;
  let eventId: string;

  beforeAll(async () => {
    const res = await createContract({
      name: "EOT contract",
      form: "fidic_red_2017",
      completionDate: "2027-06-30",
    });
    contractId = (res.json() as { id: string }).id;
    const ev = await createEvent(contractId, {
      kind: "delay_event",
      clauseRef: "8.5",
      title: "Storm damage",
      eventDate: isoDaysFromToday(-5),
    });
    eventId = (ev.json() as { id: string }).id;
  });

  it("rejects eventIds from another contract", async () => {
    const other = await createContract({ name: "Other contract", form: "fidic_red_2017" });
    const otherId = (other.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${otherId}/eot-claims`,
      headers: owner.headers,
      payload: { title: "Cross-contract claim", daysClaimed: 5, eventIds: [eventId] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("enforces determination independence and extends completion on agreement", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/eot-claims`,
      headers: owner.headers,
      payload: {
        title: "EOT for storm damage",
        clauseRef: "8.5",
        eventIds: [eventId],
        daysClaimed: 14,
        narrative: "Critical path impact on pier works.",
      },
    });
    expect(created.statusCode).toBe(201);
    const claim = created.json() as { id: string; status: string; number: number };
    expect(claim.status).toBe("notified");

    const statusUrl = `/api/v1/projects/${projectId}/contracts/${contractId}/eot-claims/${claim.id}/status`;

    const submit = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: owner.headers,
      payload: { status: "submitted" },
    });
    expect(submit.statusCode).toBe(200);

    // the raiser cannot assess their own claim (#232 determination independence)
    const selfAssess = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: owner.headers,
      payload: { status: "assessed", daysAwarded: 10 },
    });
    expect(selfAssess.statusCode).toBe(403);

    // assessing without daysAwarded fails
    const noDays = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: assessorHeaders,
      payload: { status: "assessed" },
    });
    expect(noDays.statusCode).toBe(400);

    // an assessment must name the delay-analysis method it used
    const noMethod = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: assessorHeaders,
      payload: { status: "assessed", daysAwarded: 10 },
    });
    expect(noMethod.statusCode).toBe(400);

    const assess = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: assessorHeaders,
      payload: {
        status: "assessed",
        daysAwarded: 10,
        assessment: {
          method: "time_impact_analysis",
          concurrency: "none",
          floatOwnership: "project",
          reasons: "Storm damage delayed the pier works on the critical path.",
        },
      },
    });
    expect(assess.statusCode).toBe(200);
    const assessed = assess.json() as { daysAwarded: number; assessedBy: string };
    expect(assessed.daysAwarded).toBe(10);
    expect(assessed.assessedBy).toBe(assessor.userId);

    const agree = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: assessorHeaders,
      payload: { status: "agreed" },
    });
    expect(agree.statusCode).toBe(200);

    const contract = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}`,
      headers: owner.headers,
    });
    expect((contract.json() as { completionDate: string }).completionDate).toBe("2027-07-10"); // +10 days

    // agreed is terminal
    const reAgree = await app.inject({
      method: "POST",
      url: statusUrl,
      headers: assessorHeaders,
      payload: { status: "rejected" },
    });
    expect(reAgree.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* LD exposure                                                         */
/* ------------------------------------------------------------------ */

describe("LD exposure", () => {
  it("computes accrued delay damages with the cap applied", async () => {
    const created = await createContract({
      name: "LD contract",
      form: "fidic_red_2017",
      completionDate: isoDaysFromToday(-10),
      ldRatePerDay: 500,
      ldCap: 3000,
    });
    const contractId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/ld-exposure`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      applicable: boolean;
      daysLate: number;
      accrued: number;
      capReached: boolean;
    };
    expect(body.applicable).toBe(true);
    expect(body.daysLate).toBe(10);
    expect(body.accrued).toBe(3000); // 10 × 500 = 5000, capped at 3000
    expect(body.capReached).toBe(true);
  });

  it("reports not-applicable without LD rate or completion date", async () => {
    const created = await createContract({ name: "No LD contract", form: "jct_db_2016" });
    const contractId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/contracts/${contractId}/ld-exposure`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { applicable: boolean }).applicable).toBe(false);
  });
});
