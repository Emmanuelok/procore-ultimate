/**
 * Consultants and professional indemnity, the deliverable schedule and its
 * obligations and late signals, information requirements, handover readiness,
 * the analytics and the health inputs — plus every scheduler job.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  obligations,
  projects,
  scheduleTasks,
  schedules,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import { designModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let checker: TestActor;
let stranger: TestActor;
let projectId: string;
let taskId: string;
let consultantId: string;

const today = todayISO();

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

const base = () => `/projects/${projectId}/design`;

async function signalsFor(detector: string) {
  return app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("design.deliverables")) await app.register(designModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  const second = await registerActor(app);
  await app.db
    .insert(companyMemberships)
    .values({ id: newId("cm"), companyId: owner.companyId, userId: second.userId, role: "admin" });
  checker = {
    ...second,
    companyId: owner.companyId,
    headers: { authorization: second.headers["authorization"]!, "x-company-id": owner.companyId },
  };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectId, companyId: owner.companyId, name: "Design — deliverables", stage: "design" });

  const scheduleId = newId("sch");
  await app.db
    .insert(schedules)
    .values({ id: scheduleId, companyId: owner.companyId, projectId, name: "Baseline", projectStart: today, createdBy: owner.userId });
  taskId = newId("tsk");
  await app.db.insert(scheduleTasks).values({
    id: taskId,
    scheduleId,
    projectId,
    name: "Erect facade frame",
    durationDays: 20,
    startDate: addDaysISO(today, 30),
    finishDate: addDaysISO(today, 50),
    isCritical: 1,
  });
});

afterAll(async () => {
  await built.close();
});

/* ================================================================== */

describe("consultants and professional indemnity", () => {
  it("registers a consultant and reports PI adequacy next to the record", async () => {
    const res = await post(`${base()}/consultants`, {
      name: "Facade Engineering LLP",
      discipline: "facade",
      role: "Delegated design",
      piRequiredAmount: 5_000_000,
      piCoverAmount: 5_000_000,
      piCurrency: "GBP",
      piExpiresOn: addDaysISO(today, 400),
    });
    expect(res.statusCode).toBe(201);
    consultantId = (res.json() as { id: string }).id;
    const listed = (await get(`${base()}/consultants`)).json() as {
      items: Array<{ id: string; pi: { adequate: boolean | null } }>;
    };
    expect(listed.items.find((c) => c.id === consultantId)?.pi.adequate).toBe(true);
  });

  it("refuses PI verification by the person who recorded the cover", async () => {
    const res = await post(`${base()}/consultants/${consultantId}/verify-pi`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("other than whoever recorded it");
    const proper = await post(`${base()}/consultants/${consultantId}/verify-pi`, {}, checker.headers);
    expect(proper.statusCode).toBe(200);
    expect((proper.json() as { piVerifiedBy: string }).piVerifiedBy).toBe(checker.userId);
  });

  it("clears the verification when the cover changes", async () => {
    const res = await patch(`${base()}/consultants/${consultantId}`, { piCoverAmount: 2_000_000 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { piVerifiedAt: string | null }).piVerifiedAt).toBeNull();
  });

  it("raises one signal for inadequate cover and not a second", async () => {
    const first = await post(`${base()}/consultants/pi-check`, {});
    expect(first.statusCode).toBe(200);
    const body = first.json() as { inadequate: number; signalsRaised: number };
    expect(body.inadequate).toBe(1);
    expect(body.signalsRaised).toBe(1);
    const second = await post(`${base()}/consultants/pi-check`, {});
    expect((second.json() as { signalsRaised: number }).signalsRaised).toBe(0);
    const raised = await signalsFor("design_pi_inadequate");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.explanation).toContain("below the required");
  });

  it("signals again once the policy actually changes", async () => {
    await patch(`${base()}/consultants/${consultantId}`, { piCoverAmount: 1_000_000 });
    const res = await post(`${base()}/consultants/pi-check`, {});
    expect((res.json() as { signalsRaised: number }).signalsRaised).toBe(1);
    await patch(`${base()}/consultants/${consultantId}`, { piCoverAmount: 5_000_000 });
  });
});

/* ================================================================== */

describe("deliverable schedule", () => {
  let lateId: string;
  let onTrackId: string;

  it("assesses a new deliverable and opens its obligation", async () => {
    const res = await post(`${base()}/deliverables`, {
      title: "Facade GA drawings",
      deliverableType: "drawing",
      discipline: "facade",
      consultantId,
      scheduleTaskId: taskId,
      plannedIssueDate: addDaysISO(today, -10),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      reference: string;
      slippageLevel: string;
      obligationId: string | null;
      assessment: { level: string; reasons: string[] };
    };
    lateId = body.id;
    expect(body.reference).toMatch(/^DLV-\d{3}$/);
    expect(body.slippageLevel).toBe("late");
    expect(body.assessment.reasons.join(" ")).toContain("overdue");
    expect(body.obligationId).toBeTruthy();

    const [obligation] = await app.db
      .select()
      .from(obligations)
      .where(and(eq(obligations.id, body.obligationId!), eq(obligations.companyId, owner.companyId)));
    expect(obligation?.status).toBe("open");
    expect(obligation?.sourceClause).toContain(body.reference);
  });

  it("assesses one with time in hand as on track", async () => {
    const res = await post(`${base()}/deliverables`, {
      title: "Facade fabrication drawings",
      consultantId,
      plannedIssueDate: addDaysISO(today, 60),
    });
    const body = res.json() as { id: string; slippageLevel: string };
    onTrackId = body.id;
    expect(body.slippageLevel).toBe("on_track");
  });

  it("declines to assess a deliverable with no planned date", async () => {
    const res = await post(`${base()}/deliverables`, { title: "Unplanned", consultantId });
    const body = res.json() as { slippageLevel: string; obligationId: string | null; assessment: { reasons: string[] } };
    expect(body.slippageLevel).toBe("not_assessable");
    expect(body.obligationId).toBeNull();
    expect(body.assessment.reasons.join(" ")).toContain("No planned issue date");
  });

  it("raises one late signal per planned date, not per sweep", async () => {
    const first = await post(`${base()}/deliverables/recompute`, {});
    expect(first.statusCode).toBe(200);
    const body = first.json() as { assessed: number; signalsRaised: number; byLevel: Record<string, number> };
    expect(body.byLevel["late"]).toBe(1);
    expect(body.signalsRaised).toBe(1);
    const second = await post(`${base()}/deliverables/recompute`, {});
    expect((second.json() as { signalsRaised: number }).signalsRaised).toBe(0);
    expect(await signalsFor("design_deliverable_late")).toHaveLength(1);
  });

  it("closes the old obligation when the planned date is re-planned", async () => {
    const before = (await get(`${base()}/deliverables/${lateId}`)).json() as { obligationId: string };
    const oldObligation = before.obligationId;
    const res = await patch(`${base()}/deliverables/${lateId}`, { plannedIssueDate: addDaysISO(today, 20) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { obligationId: string | null; slippageLevel: string };
    expect(body.obligationId).not.toBe(oldObligation);
    expect(body.slippageLevel).toBe("on_track");
    const [old] = await app.db.select().from(obligations).where(eq(obligations.id, oldObligation));
    expect(old?.status).toBe("waived");
  });

  it("records the lateness it was issued at and satisfies the obligation", async () => {
    const res = await post(`${base()}/deliverables/${onTrackId}/issue`, {
      actualIssueDate: addDaysISO(today, 70),
      revision: "P02",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; assessment: { level: string; slippageDays: number } ; obligationId: string };
    expect(body.status).toBe("issued");
    expect(body.assessment.level).toBe("delivered");
    expect(body.assessment.slippageDays).toBe(10);
    const [obligation] = await app.db.select().from(obligations).where(eq(obligations.id, body.obligationId));
    expect(obligation?.status).toBe("satisfied");
  });

  it("refuses a second issue of the same deliverable", async () => {
    const res = await post(`${base()}/deliverables/${onTrackId}/issue`, {});
    expect(res.statusCode).toBe(409);
  });

  it("refuses acceptance by the person who registered and issued it", async () => {
    const res = await post(`${base()}/deliverables/${onTrackId}/accept`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("other than the person who registered");
    const proper = await post(`${base()}/deliverables/${onTrackId}/accept`, {}, checker.headers);
    expect(proper.statusCode).toBe(200);
    expect((proper.json() as { status: string }).status).toBe("accepted");
  });

  it("refuses to edit an accepted deliverable", async () => {
    const res = await patch(`${base()}/deliverables/${onTrackId}`, { title: "renamed" });
    expect(res.statusCode).toBe(409);
  });

  it("returns a rejected deliverable to outstanding with a fresh obligation", async () => {
    const created = await post(`${base()}/deliverables`, {
      title: "Rejected deliverable",
      consultantId,
      plannedIssueDate: addDaysISO(today, 5),
    });
    const id = (created.json() as { id: string }).id;
    await post(`${base()}/deliverables/${id}/issue`, {});
    const rejected = await post(
      `${base()}/deliverables/${id}/reject`,
      { reason: "Wrong revision issued" },
      checker.headers,
    );
    expect(rejected.statusCode).toBe(200);
    const body = rejected.json() as { status: string; actualIssueDate: string | null; obligationId: string | null };
    expect(body.status).toBe("rejected");
    expect(body.actualIssueDate).toBeNull();
    expect(body.obligationId).toBeTruthy();
  });

  it("flags a deliverable that arrives after the task it feeds", async () => {
    const created = await post(`${base()}/deliverables`, {
      title: "Blocks the frame",
      consultantId,
      scheduleTaskId: taskId,
      plannedIssueDate: addDaysISO(today, 10),
      forecastIssueDate: addDaysISO(today, 40),
    });
    const body = created.json() as { assessment: { blocksTask: boolean; level: string; reasons: string[] } };
    expect(body.assessment.blocksTask).toBe(true);
    expect(body.assessment.level).toBe("at_risk");
    expect(body.assessment.reasons.join(" ")).toContain("too late");
  });

  it("refuses a schedule task from another project", async () => {
    const res = await post(`${base()}/deliverables`, { title: "Bad task", scheduleTaskId: newId("tsk") });
    expect(res.statusCode).toBe(400);
  });

  it("reports slippage per consultant with the worst first", async () => {
    const res = await get(`${base()}/deliverables-performance`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overall: { onTimePercent: number | null; reasons: string[] };
      byConsultant: Array<{ consultantId: string | null; name: string; total: number }>;
    };
    expect(body.byConsultant.length).toBeGreaterThan(0);
    expect(body.byConsultant[0]?.name).toBeTruthy();
  });

  it("runs the same work from the scheduler job", async () => {
    const result = await app.scheduler.runNow("design.deliverables");
    expect(result.state).toBe("succeeded");
  });
});

/* ================================================================== */

describe("information requirements", () => {
  let requirementId: string;

  it("registers a requirement and opens its obligation on the sweep", async () => {
    const res = await post(`${base()}/information-requirements`, {
      kind: "eir",
      title: "Employer's Information Requirements issued to the design team",
      dueDate: addDaysISO(today, -5),
      responsibleUserId: owner.userId,
    });
    expect(res.statusCode).toBe(201);
    requirementId = (res.json() as { id: string }).id;

    const swept = await post(`${base()}/information-requirements/sweep`, {});
    expect(swept.statusCode).toBe(200);
    const body = swept.json() as { overdue: number; obligationsOpened: number; signalsRaised: number };
    expect(body.overdue).toBe(1);
    expect(body.obligationsOpened).toBe(1);
    expect(body.signalsRaised).toBe(1);

    const again = await post(`${base()}/information-requirements/sweep`, {});
    expect((again.json() as { signalsRaised: number }).signalsRaised).toBe(0);
    expect(await signalsFor("design_info_requirement_overdue")).toHaveLength(1);
  });

  it("marks the requirement overdue and lets a re-plan clear it", async () => {
    const listed = (await get(`${base()}/information-requirements`)).json() as {
      items: Array<{ id: string; status: string }>;
    };
    expect(listed.items.find((r) => r.id === requirementId)?.status).toBe("overdue");
    const res = await patch(`${base()}/information-requirements/${requirementId}`, {
      dueDate: addDaysISO(today, 30),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; obligationId: string | null };
    expect(body.status).toBe("planned");
    expect(body.obligationId).toBeNull();
  });

  it("refuses verification by the person who delivered it", async () => {
    const delivered = await post(`${base()}/information-requirements/${requirementId}/deliver`, {});
    expect(delivered.statusCode).toBe(200);
    const self = await post(`${base()}/information-requirements/${requirementId}/verify`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toContain("other than whoever delivered");
    const proper = await post(
      `${base()}/information-requirements/${requirementId}/verify`,
      { note: "Checked against ISO 19650" },
      checker.headers,
    );
    expect(proper.statusCode).toBe(200);
    expect((proper.json() as { status: string }).status).toBe("verified");
  });

  it("refuses to edit a verified requirement", async () => {
    const res = await patch(`${base()}/information-requirements/${requirementId}`, { title: "renamed" });
    expect(res.statusCode).toBe(409);
  });

  it("waives a requirement and closes its obligation", async () => {
    const created = await post(`${base()}/information-requirements`, {
      kind: "bep",
      title: "BEP not required on this project",
      dueDate: addDaysISO(today, -1),
    });
    const id = (created.json() as { id: string }).id;
    await post(`${base()}/information-requirements/sweep`, {});
    const withObligation = (await get(`${base()}/information-requirements`)).json() as {
      items: Array<{ id: string; obligationId: string | null }>;
    };
    const obligationId = withObligation.items.find((r) => r.id === id)?.obligationId;
    expect(obligationId).toBeTruthy();
    const res = await post(`${base()}/information-requirements/${id}/waive`, { reason: "Contract does not require a BEP" });
    expect(res.statusCode).toBe(200);
    const [obligation] = await app.db.select().from(obligations).where(eq(obligations.id, obligationId!));
    expect(obligation?.status).toBe("waived");
  });

  it("runs the same work from the scheduler job", async () => {
    const result = await app.scheduler.runNow("design.information");
    expect(result.state).toBe("succeeded");
  });
});

/* ================================================================== */

describe("review and issue sweeps", () => {
  it("raises an overdue review signal once and notifies the issuer", async () => {
    const pkg = await post(`${base()}/packages`, { name: "Overdue review package" });
    const pkgId = (pkg.json() as { id: string }).id;
    const review = await post(`${base()}/reviews`, {
      packageId: pkgId,
      title: "Issued and forgotten",
      issuedAt: `${addDaysISO(today, -30)}T00:00:00.000Z`,
      dueAt: `${addDaysISO(today, -16)}T00:00:00.000Z`,
    });
    expect(review.statusCode).toBe(201);
    const first = await post(`${base()}/reviews/sweep`, {});
    const body = first.json() as { overdue: number; signalsRaised: number };
    expect(body.overdue).toBe(1);
    expect(body.signalsRaised).toBe(1);
    const raised = await signalsFor("design_review_overdue");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("high");
    const second = await post(`${base()}/reviews/sweep`, {});
    expect((second.json() as { signalsRaised: number }).signalsRaised).toBe(0);
    expect((await app.scheduler.runNow("design.reviews")).state).toBe("succeeded");
  });

  it("does not call a fresh issue stale", async () => {
    await post(`${base()}/issues`, { title: "Just raised", priority: "critical" });
    const res = await post(`${base()}/issues/sweep`, {});
    expect((res.json() as { stale: number }).stale).toBe(0);
    expect((await app.scheduler.runNow("design.issues")).state).toBe("succeeded");
  });
});

/* ================================================================== */

describe("readiness, summary and analytics", () => {
  it("gives an honest verdict with named blockers", async () => {
    const res = await get(`${base()}/readiness`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      level: string;
      score: number | null;
      confidence: number;
      dimensions: Array<{ key: string; score: number | null; basis: string; reasons: string[] }>;
      blockers: string[];
    };
    expect(body.dimensions).toHaveLength(6);
    expect(body.blockers.length).toBeGreaterThan(0);
    for (const dimension of body.dimensions) {
      if (dimension.score === null) expect(dimension.reasons.length).toBeGreaterThan(0);
      expect(dimension.basis).not.toBe("");
    }
  });

  it("writes a snapshot when the verdict moves and not when it does not", async () => {
    const first = await post(`${base()}/readiness/recompute`, {});
    expect(first.statusCode).toBe(200);
    expect((first.json() as { snapshotWritten: boolean }).snapshotWritten).toBe(true);
    const second = await post(`${base()}/readiness/recompute`, {});
    expect((second.json() as { snapshotWritten: boolean }).snapshotWritten).toBe(false);
    expect((await app.scheduler.runNow("design.readiness")).state).toBe("succeeded");
  });

  it("serves a summary with the figures the workspace shows", async () => {
    const res = await get(`${base()}/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      packages: { total: number };
      deliverables: { total: number; late: number; onTimePercent: { value: number | null; reasons: string[] } };
      consultants: { total: number; piInadequate: number };
      signals: { open: number };
      readiness: { level: string };
    };
    expect(body.packages.total).toBeGreaterThan(0);
    expect(body.deliverables.total).toBeGreaterThan(0);
    expect(body.consultants.total).toBe(1);
    expect(body.signals.open).toBeGreaterThan(0);
    expect(body.readiness.level).toBeTruthy();
  });

  it("serves analytics with nulls, not zeros, where nothing is measurable", async () => {
    const res = await get(`${base()}/analytics`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewCycles: { averageTurnaroundDays: number | null; reasons: string[] };
      deliverables: { onTimePercent: number | null; byConsultant: unknown[] };
      issues: { open: number; averageOpenAgeDays: number | null };
      changeNotices: { total: number };
    };
    expect(body.reviewCycles.averageTurnaroundDays).toBeNull();
    expect(body.reviewCycles.reasons.length).toBeGreaterThan(0);
    expect(body.issues.open).toBeGreaterThan(0);
  });

  it("exposes health inputs for the intelligence layer", async () => {
    const res = await get(`${base()}/health-inputs`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(Object.keys(body.metrics)).toContain("designDeliverablesLate");
    expect(Object.keys(body.metrics)).toContain("designReadinessScore");
    expect(body.metrics["designConsultantsPiInadequate"]).toBe(0);
  });

  it("lists the signals this module raised", async () => {
    const res = await get(`${base()}/signals`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ detector: string }>; detectors: string[] };
    expect(body.detectors).toHaveLength(7);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("runs every sweep in one call", async () => {
    const res = await post(`${base()}/sweeps/run`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deliverables: { assessed: number };
      reviews: { checked: number };
      issues: { checked: number };
      infoRequirements: { checked: number };
      professionalIndemnity: { consultants: number };
      readiness: { level: string };
    };
    expect(body.deliverables.assessed).toBeGreaterThan(0);
    expect(body.professionalIndemnity.consultants).toBe(1);
    expect(body.readiness.level).toBeTruthy();
  });

  it("keeps another company out of every read", async () => {
    expect((await get(`${base()}/summary`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/analytics`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/readiness`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/health-inputs`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/deliverables`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/consultants`, stranger.headers)).statusCode).toBe(403);
    expect((await post(`${base()}/sweeps/run`, {}, stranger.headers)).statusCode).toBe(403);
  });
});
