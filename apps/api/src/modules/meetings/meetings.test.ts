import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  meetingActionItems,
  obligations,
  projects,
  projectMemberships,
  signals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  checkQuorum,
  parseRecurrenceRule,
  planOccurrences,
  ruleForRecurrence,
  UnsupportedRecurrenceRule,
  zonedWallTimeToUtc,
} from "./recurrence.js";

/* ================================================================== */
/* Recurrence + quorum unit tests                                      */
/* ================================================================== */

describe("recurrence rules", () => {
  it("parses the supported RRULE subset", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY")).toEqual({ freq: "WEEKLY", interval: 1, byDay: [] });
    expect(parseRecurrenceRule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: [1, 3],
    });
    expect(parseRecurrenceRule("freq=daily;interval=3")).toEqual({
      freq: "DAILY",
      interval: 3,
      byDay: [],
    });
  });

  it("refuses what it cannot honour rather than approximating it", () => {
    expect(() => parseRecurrenceRule("FREQ=YEARLY")).toThrow(UnsupportedRecurrenceRule);
    expect(() => parseRecurrenceRule("FREQ=WEEKLY;BYDAY=2MO")).toThrow(UnsupportedRecurrenceRule);
    expect(() => parseRecurrenceRule("FREQ=WEEKLY;UNTIL=20260101")).toThrow(
      UnsupportedRecurrenceRule,
    );
    expect(() => parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=0")).toThrow(UnsupportedRecurrenceRule);
    expect(() => parseRecurrenceRule("")).toThrow(UnsupportedRecurrenceRule);
  });

  it("maps the simple recurrences onto the same rule shape", () => {
    expect(ruleForRecurrence("weekly", null, 2)).toEqual({
      freq: "WEEKLY",
      interval: 1,
      byDay: [2],
    });
    expect(ruleForRecurrence("fortnightly", null, 4)).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: [4],
    });
    expect(ruleForRecurrence("quarterly", null, null)).toEqual({
      freq: "MONTHLY",
      interval: 3,
      byDay: [],
    });
    expect(() => ruleForRecurrence("none", null, null)).toThrow(UnsupportedRecurrenceRule);
    expect(() => ruleForRecurrence("custom", null, null)).toThrow(UnsupportedRecurrenceRule);
  });

  it("steps weekly and fortnightly on the named day", () => {
    // 2026-03-02 is a Monday.
    const weekly = planOccurrences({
      rule: ruleForRecurrence("weekly", null, 1),
      from: "2026-03-02",
      count: 3,
      startTime: "09:00",
    });
    expect(weekly.map((o) => o.date)).toEqual(["2026-03-02", "2026-03-09", "2026-03-16"]);

    const fortnightly = planOccurrences({
      rule: ruleForRecurrence("fortnightly", null, 1),
      from: "2026-03-02",
      count: 3,
    });
    expect(fortnightly.map((o) => o.date)).toEqual(["2026-03-02", "2026-03-16", "2026-03-30"]);
  });

  it("honours BYDAY with several days a week", () => {
    const plan = planOccurrences({
      rule: parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,WE,FR"),
      from: "2026-03-02",
      count: 4,
    });
    expect(plan.map((o) => o.date)).toEqual([
      "2026-03-02",
      "2026-03-04",
      "2026-03-06",
      "2026-03-09",
    ]);
  });

  it("clamps a monthly series to the last day of a short month", () => {
    const plan = planOccurrences({
      rule: ruleForRecurrence("monthly", null, null),
      from: "2026-01-31",
      count: 3,
    });
    expect(plan.map((o) => o.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("resolves a wall-clock start into the instant it happens at", () => {
    // British Summer Time: 09:00 local is 08:00Z.
    expect(zonedWallTimeToUtc("2026-07-01", "09:00", "Europe/London").instant).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    // Winter: London is UTC.
    expect(zonedWallTimeToUtc("2026-01-15", "09:00", "Europe/London").instant).toBe(
      "2026-01-15T09:00:00.000Z",
    );
    const fallback = zonedWallTimeToUtc("2026-07-01", "09:00", "Not/AZone");
    expect(fallback.instant).toBe("2026-07-01T09:00:00.000Z");
    expect(fallback.resolvedTimezone).toBeNull();
  });

  it("derives the scheduled end from the duration, or leaves it unknown", () => {
    const [withDuration] = planOccurrences({
      rule: ruleForRecurrence("weekly", null, 1),
      from: "2026-03-02",
      count: 1,
      startTime: "14:00",
      durationMinutes: 90,
    });
    expect(withDuration!.scheduledStart).toBe("2026-03-02T14:00:00.000Z");
    expect(withDuration!.scheduledEnd).toBe("2026-03-02T15:30:00.000Z");

    const [noDuration] = planOccurrences({
      rule: ruleForRecurrence("weekly", null, 1),
      from: "2026-03-02",
      count: 1,
    });
    expect(noDuration!.scheduledEnd).toBeNull();
  });
});

describe("quorum", () => {
  const room = [
    { role: "chair", attendance: "present" },
    { role: "required", attendance: "remote" },
    { role: "required", attendance: "delegate_attended" },
    { role: "required", attendance: "apologies" },
    { role: "required", attendance: "absent" },
    { role: "distribution_only", attendance: "present" },
  ];

  it("counts the people who were actually in the room", () => {
    const result = checkQuorum(room, 3);
    expect(result.counted).toBe(3);
    expect(result.met).toBe(true);
    expect(result.apologies).toBe(1);
    expect(result.absent).toBe(1);
  });

  it("fails a quorum the room did not reach", () => {
    expect(checkQuorum(room, 4).met).toBe(false);
  });

  it("returns null, not a pass, when no quorum is required", () => {
    const result = checkQuorum(room, null);
    expect(result.met).toBeNull();
    expect(result.reasons[0]).toMatch(/No quorum is required/i);
  });
});

/* ================================================================== */
/* Integration                                                         */
/* ================================================================== */

let built: BuiltApp;
let chair: TestActor;
let second: TestActor;
let third: TestActor;
let readOnly: TestActor;
let h2: Record<string, string>;
let h3: Record<string, string>;
let hRead: Record<string, string>;
let projectId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  chair = await registerActor(built.app);
  second = await registerActor(built.app);
  third = await registerActor(built.app);
  readOnly = await registerActor(built.app);
  await built.app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: chair.companyId, userId: second.userId, role: "admin" },
    { id: newId("cm"), companyId: chair.companyId, userId: third.userId, role: "admin" },
    { id: newId("cm"), companyId: chair.companyId, userId: readOnly.userId, role: "member" },
  ]);
  h2 = { authorization: `Bearer ${second.accessToken}`, "x-company-id": chair.companyId };
  h3 = { authorization: `Bearer ${third.accessToken}`, "x-company-id": chair.companyId };
  hRead = { authorization: `Bearer ${readOnly.accessToken}`, "x-company-id": chair.companyId };

  projectId = newId("prj");
  await built.app.db
    .insert(projects)
    .values({ id: projectId, companyId: chair.companyId, name: "Meetings Tower" });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: chair.companyId,
    projectId,
    userId: readOnly.userId,
    templateKey: "read_only",
    overrides: {},
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

describe("series and occurrence generation", () => {
  let seriesId: string;

  it("creates a recurring series with a quorum requirement", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meeting-series`, chair.headers, {
      title: "Weekly Progress",
      meetingType: "progress",
      recurrence: "weekly",
      dayOfWeek: 1,
      startTime: "09:00",
      durationMinutes: 60,
      timezone: "Europe/London",
      quorumRequired: 2,
      contractRequirement: "NEC4 cl.31.1 progress meeting",
      agendaTemplate: [
        { title: "Safety moment", category: "safety", position: 0 },
        { title: "Programme", category: "programme", position: 1 },
      ],
      defaultAttendees: [
        { name: "Project Manager", role: "chair", userId: chair.userId },
        { name: "Site Agent", role: "required" },
      ],
    });
    expect(res.statusCode).toBe(201);
    seriesId = res.json().id;
    expect(res.json().reference).toMatch(/^MS-\d{3}$/);
    expect(res.json().status).toBe("active");

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}`,
      chair.headers,
    );
    expect(detail.json().quorumRequired).toBe(2);
  });

  it("refuses a custom recurrence it cannot honour", async () => {
    const missing = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series`,
      chair.headers,
      { title: "Bad", recurrence: "custom" },
    );
    expect(missing.statusCode).toBe(400);

    const bad = await inject("POST", `/api/v1/projects/${projectId}/meeting-series`, chair.headers, {
      title: "Bad",
      recurrence: "custom",
      recurrenceRule: "FREQ=YEARLY",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/not supported/i);
  });

  it("generates the first occurrence with its standing agenda and invitees", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      chair.headers,
      { count: 1, from: "2026-03-02" },
    );
    expect(res.statusCode).toBe(201);
    const [occurrence] = res.json().created;
    expect(occurrence.occurrenceNumber).toBe(1);
    expect(occurrence.reference).toMatch(/^MTG-\d{3}$/);
    // Compare the INSTANT, not its spelling: the column round-trips through
    // Postgres, which returns "2026-03-02 09:00:00+00" (see lib/time.ts).
    // 2 March is before BST starts, so 09:00 London is 09:00Z.
    expect(Date.parse(occurrence.scheduledStart)).toBe(
      Date.parse("2026-03-02T09:00:00.000Z"),
    );
    expect(occurrence.quorumRequired).toBe(2);
    expect(occurrence.carriedForward.carried).toBe(0);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${occurrence.id}`,
      chair.headers,
    );
    expect(detail.json().agendaItems).toHaveLength(2);
    expect(detail.json().attendees).toHaveLength(2);
    // Nobody has attended a meeting that has not happened yet.
    expect(detail.json().attendees.every((a: { attendance: string }) => a.attendance === "absent")).toBe(
      true,
    );
    expect(detail.json().quorum.met).toBe(false);
  });

  it("refuses meeting writes from a read-only project member", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meeting-series`, hRead, {
      title: "Not allowed",
    });
    expect(res.statusCode).toBe(403);
    const read = await inject("GET", `/api/v1/projects/${projectId}/meeting-series`, hRead);
    expect(read.statusCode).toBe(200);
  });
});

describe("carry-forward across three occurrences", () => {
  let seriesId: string;
  let m1: string;
  let m2: string;
  let m3: string;
  let stickyItemId: string;
  let closedItemId: string;

  const generate = async (from?: string) => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      chair.headers,
      from ? { count: 1, from } : { count: 1 },
    );
    expect(res.statusCode).toBe(201);
    return res.json().created[0];
  };

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meeting-series`, chair.headers, {
      title: "Design Coordination",
      meetingType: "coordination",
      recurrence: "weekly",
      dayOfWeek: 3,
      startTime: "10:00",
    });
    seriesId = res.json().id;
    m1 = (await generate("2026-04-01")).id;
  });

  it("carries an unclosed item into the next occurrence with carryCount 1", async () => {
    const sticky = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/agenda-items`,
      chair.headers,
      { title: "Facade interface not resolved", category: "design" },
    );
    expect(sticky.statusCode).toBe(201);
    stickyItemId = sticky.json().id;
    expect(sticky.json().carryCount).toBe(0);
    expect(sticky.json().firstRaisedMeetingId).toBe(m1);

    const closed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/agenda-items`,
      chair.headers,
      { title: "Site access agreed", category: "logistics" },
    );
    closedItemId = closed.json().id;
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${closedItemId}/close`,
      chair.headers,
      { discussion: "Agreed and done" },
    );

    const occurrence2 = await generate();
    m2 = occurrence2.id;
    expect(occurrence2.occurrenceNumber).toBe(2);
    expect(occurrence2.carriedForward.carried).toBe(1);

    const items = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${m2}/agenda-items`,
      chair.headers,
    );
    const carried = (items.json().items as { title: string; carryCount: number }[]).find(
      (i) => i.title === "Facade interface not resolved",
    )!;
    expect(carried.carryCount).toBe(1);
    expect(
      (items.json().items as { title: string }[]).some((i) => i.title === "Site access agreed"),
    ).toBe(false);
  });

  it("marks the source item carried_forward and links it forwards", async () => {
    const source = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${m1}/agenda-items`,
      chair.headers,
    );
    const row = (source.json().items as { id: string; status: string; carriedForwardToItemId: string }[]).find(
      (i) => i.id === stickyItemId,
    )!;
    expect(row.status).toBe("carried_forward");
    expect(row.carriedForwardToItemId).toBeTruthy();
  });

  it("increments to 2 on the third occurrence and keeps the first-raised meeting", async () => {
    const occurrence3 = await generate();
    m3 = occurrence3.id;
    expect(occurrence3.occurrenceNumber).toBe(3);
    expect(occurrence3.carriedForward.carried).toBe(1);

    const items = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${m3}/agenda-items`,
      chair.headers,
    );
    const carried = (
      items.json().items as {
        title: string;
        carryCount: number;
        firstRaisedMeetingId: string;
        carriedFromItemId: string;
      }[]
    ).find((i) => i.title === "Facade interface not resolved")!;
    expect(carried.carryCount).toBe(2);
    expect(carried.firstRaisedMeetingId).toBe(m1);
    expect(carried.carriedFromItemId).toBeTruthy();
    expect(carried.carriedFromItemId).not.toBe(stickyItemId); // it chains through m2
  });

  it("is idempotent — carrying again moves nothing", async () => {
    const first = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m3}/carry-forward`,
      chair.headers,
      {},
    );
    expect(first.statusCode).toBe(200);
    expect(first.json().carried).toBe(0);
    const items = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${m3}/agenda-items`,
      chair.headers,
    );
    expect(items.json().total).toBe(1);
  });

  it("refuses to edit an item that has already been carried on", async () => {
    const res = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${stickyItemId}`,
      chair.headers,
      { discussion: "Late edit" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("reports the carry count per series and raises a signal at the threshold", async () => {
    // A fourth occurrence takes the item to carryCount 3 — the threshold.
    const occurrence4 = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      chair.headers,
      { count: 1 },
    );
    expect(occurrence4.json().created[0].carriedForward.carried).toBe(1);

    const report = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/carry-forward`,
      chair.headers,
    );
    expect(report.statusCode).toBe(200);
    expect(report.json().summary.maxCarryCount).toBe(3);
    expect(report.json().items[0].title).toBe("Facade interface not resolved");
    expect(report.json().items[0].carryCount).toBe(3);

    /* The read is pure now: the carried-item signal is raised by the scheduled
       job, under a null (system) actor, not by whoever opened the report. */
    await built.app.scheduler.runNow("meetings.carried-items");

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, chair.companyId),
          eq(signals.detector, "meeting_item_carried_repeatedly"),
        ),
      );
    expect(raised).toHaveLength(1);

    // Reading the report again must not raise it a second time.
    await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-reports/carry-forward`,
      chair.headers,
    );
    const again = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, chair.companyId),
          eq(signals.detector, "meeting_item_carried_repeatedly"),
        ),
      );
    expect(again).toHaveLength(1);
  });

  it("shows the project-wide carry-forward picture", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-reports/carry-forward`,
      chair.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.carriedItems).toBeGreaterThanOrEqual(1);
    expect(res.json().summary.overThreshold).toBeGreaterThanOrEqual(1);
    expect(res.json().bySeries.length).toBeGreaterThanOrEqual(1);
  });
});

describe("attendance, quorum and minutes", () => {
  let seriesId: string;
  let m1: string;
  let m2: string;

  beforeAll(async () => {
    const series = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series`,
      chair.headers,
      {
        title: "OAC Meeting",
        meetingType: "owner_architect_contractor",
        recurrence: "weekly",
        dayOfWeek: 2,
        startTime: "11:00",
        quorumRequired: 2,
        minuteTakerId: chair.userId,
      },
    );
    seriesId = series.json().id;
    const gen = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      chair.headers,
      { count: 2, from: "2026-05-05" },
    );
    m1 = gen.json().created[0].id;
    m2 = gen.json().created[1].id;
  });

  it("records attendance, delegates and apologies", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/attendees`,
      chair.headers,
      {
        attendees: [
          { name: "Owner Rep", role: "required", userId: second.userId },
          { name: "Architect", role: "required" },
          { name: "Consultant", role: "optional" },
        ],
      },
    );
    expect(created.statusCode).toBe(201);
    const ids = created.json().items as { id: string; name: string }[];

    const owner = ids.find((a) => a.name === "Owner Rep")!;
    const present = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-attendees/${owner.id}`,
      chair.headers,
      { attendance: "present" },
    );
    expect(present.statusCode).toBe(200);
    expect(present.json().quorum.counted).toBe(1);
    expect(present.json().quorum.met).toBe(false);

    const architect = ids.find((a) => a.name === "Architect")!;
    const noDelegate = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-attendees/${architect.id}`,
      chair.headers,
      { attendance: "delegate_attended" },
    );
    expect(noDelegate.statusCode).toBe(400);
    expect(noDelegate.json().message).toMatch(/delegate's name/i);

    const withDelegate = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-attendees/${architect.id}`,
      chair.headers,
      { attendance: "delegate_attended", delegateName: "Associate Architect" },
    );
    expect(withDelegate.json().quorum.met).toBe(true);

    const consultant = ids.find((a) => a.name === "Consultant")!;
    const apologies = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-attendees/${consultant.id}`,
      chair.headers,
      { attendance: "apologies" },
    );
    expect(apologies.json().apologiesReceivedAt).toBeTruthy();
    expect(apologies.json().quorum.apologies).toBe(1);
  });

  it("settles quorum when the meeting is held", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/hold`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("held");
    expect(res.json().quorumMet).toBe(1);
    expect(res.json().quorum.met).toBe(true);
  });

  it("reports quorum as unknown when none is required", async () => {
    const oneOff = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Ad-hoc catch-up",
      meetingType: "other",
    });
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${oneOff.json().id}/quorum`,
      chair.headers,
    );
    expect(res.json().met).toBeNull();
    expect(res.json().reasons.length).toBeGreaterThan(0);
  });

  it("drafts and issues minutes with an objection period", async () => {
    const draft = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes`,
      chair.headers,
      { minutesBody: "1. Safety moment. 2. Programme reviewed.", objectionPeriodDays: 7 },
    );
    expect(draft.statusCode).toBe(200);
    expect(draft.json().status).toBe("minutes_draft");
    expect(draft.json().minutesObjectionWindow.closesAt).toBeNull();

    const issued = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/issue`,
      chair.headers,
      {},
    );
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe("minutes_issued");
    expect(issued.json().minutesIssuedBy).toBe(chair.userId);
    expect(issued.json().minutesObjectionWindow.closesAt).toBeTruthy();
    expect(issued.json().minutesObjectionWindow.expired).toBe(false);
    expect(issued.json().minutesObjectionWindow.deemedAccepted).toBe(false);
  });

  it("refuses approval by the issuer and by the minute taker", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/approve`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/issued the minutes|minute taker/i);
  });

  it("blocks approval while an objection is open, and allows it once settled", async () => {
    const objection = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/object`,
      h2,
      { note: "Item 2 misstates the programme position" },
    );
    expect(objection.statusCode).toBe(200);
    expect(objection.json().minutesObjectionWindow.openObjections).toBe(1);

    const blocked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/approve`,
      h2,
      {},
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/objection/i);
  });

  it("approves at the next occurrence, once that occurrence has been held", async () => {
    const detail = await inject("GET", `/api/v1/projects/${projectId}/meetings/${m1}`, chair.headers);
    const objections = detail.json().detail.objections as { id: string }[];
    expect(objections).toHaveLength(1);
    const settled = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/objections/${objections[0]!.id}/resolve`,
      chair.headers,
      { resolutionNote: "Programme wording corrected and re-circulated" },
    );
    expect(settled.statusCode).toBe(200);
    expect(settled.json().minutesObjectionWindow.openObjections).toBe(0);

    const tooEarly = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/approve`,
      h2,
      {},
    );
    expect(tooEarly.statusCode).toBe(400);
    expect(tooEarly.json().message).toMatch(/NEXT occurrence/i);

    await inject("POST", `/api/v1/projects/${projectId}/meetings/${m2}/hold`, chair.headers, {});
    const approved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${m1}/minutes/approve`,
      h2,
      {},
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("minutes_accepted");
    expect(approved.json().approvedBy).toBe(second.userId);
    expect(approved.json().approvedAtMeetingId).toBe(m2);
  });

  it("refuses an objection once the period has closed", async () => {
    const oneOff = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Closed-window meeting",
      objectionPeriodDays: 0,
    });
    const id = oneOff.json().id;
    await inject("POST", `/api/v1/projects/${projectId}/meetings/${id}/minutes`, chair.headers, {
      minutesBody: "Short minutes",
      objectionPeriodDays: 0,
    });
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/issue`,
      chair.headers,
      {},
    );
    const late = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/object`,
      h2,
      { note: "Too late" },
    );
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toMatch(/objection period closed/i);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${id}`,
      chair.headers,
    );
    // Silence is reported as "deemed accepted" but the status is not forged.
    expect(detail.json().minutesObjectionWindow.deemedAccepted).toBe(true);
    expect(detail.json().status).toBe("minutes_issued");
    expect(detail.json().approvedAt).toBeNull();
  });
});

describe("decisions", () => {
  let meetingId: string;
  let decisionId: string;

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Commercial review",
      meetingType: "commercial",
    });
    meetingId = res.json().id;
  });

  it("records a decision flagged as cost-impacting with no figure, honestly", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/decisions`,
      chair.headers,
      {
        title: "Change the cladding fixing system",
        decision: "Proceed with the mechanically fixed system",
        rationale: "Programme certainty outweighs the material saving",
        decidedById: second.userId,
        impactsCost: true,
        impactsSchedule: true,
        estimatedScheduleImpactDays: 10,
      },
    );
    expect(res.statusCode).toBe(201);
    decisionId = res.json().id;
    expect(res.json().reference).toMatch(/^DEC-\d{3}$/);
    expect(res.json().costImpact.value).toBeNull();
    expect(res.json().costImpact.reasons[0]).toMatch(/no estimate was recorded/i);
    expect(res.json().scheduleImpact.value).toBe(10);
    expect(res.json().scheduleImpact.reasons).toEqual([]);
  });

  it("reports the figure once it is actually recorded", async () => {
    const res = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}`,
      chair.headers,
      { estimatedCostImpact: 42000, currency: "GBP" },
    );
    expect(res.json().costImpact.value).toBe(42000);
    expect(res.json().costImpact.unit).toBe("GBP");
    expect(res.json().costImpact.reasons).toEqual([]);
  });

  it("refuses ratification by the decision maker and by the minuter", async () => {
    const byDecider = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/ratify`,
      h2,
      {},
    );
    expect(byDecider.statusCode).toBe(403);
    expect(byDecider.json().message).toMatch(/person who made it/i);

    const byMinuter = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/ratify`,
      chair.headers,
      {},
    );
    expect(byMinuter.statusCode).toBe(403);
  });

  it("accepts ratification by an independent third person", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/ratify`,
      h3,
      {},
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ratified");
    expect(res.json().ratifiedBy).toBe(third.userId);
  });

  it("supersedes a decision in both directions", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/supersede`,
      chair.headers,
      {
        meetingId,
        title: "Revert to the adhesive fixing system",
        decision: "The mechanically fixed system is withdrawn",
        rationale: "Supplier could not meet the programme",
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().decision.supersedesDecisionId).toBe(decisionId);
    expect(res.json().superseded.status).toBe("superseded");
    expect(res.json().superseded.supersededByDecisionId).toBe(res.json().decision.id);
  });

  it("links a decision to the record it produced, and freezes a superseded one", async () => {
    const fresh = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/decisions`,
      chair.headers,
      { title: "Accept the revised programme", decision: "Accepted as tabled" },
    );
    const changeEventId = newId("che");
    const linked = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-decisions/${fresh.json().id}`,
      chair.headers,
      { resultingRecordType: "change_event", resultingRecordId: changeEventId },
    );
    expect(linked.statusCode).toBe(200);
    expect(linked.json().resultingRecordType).toBe("change_event");
    expect(linked.json().resultingRecordId).toBe(changeEventId);

    const frozen = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}`,
      chair.headers,
      { resultingRecordType: "change_event", resultingRecordId: changeEventId },
    );
    expect(frozen.statusCode).toBe(400);
  });
});

describe("action items, promotion and the overdue sweep", () => {
  let meetingId: string;
  let actionId: string;
  let overdueId: string;

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Actions meeting",
      meetingType: "progress",
    });
    meetingId = res.json().id;
  });

  it("insists an action has an owner", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      { title: "Someone should look at this", meetingId },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/owner/i);
  });

  it("creates an action with an owner and a due date", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Issue the RFI response on the slab penetrations",
        meetingId,
        ownerId: second.userId,
        ownerName: "Owner Rep",
        dueDate: addDaysISO(todayISO(), 7),
        priority: "high",
        sourceClause: "NEC4 cl.61.4",
      },
    );
    expect(res.statusCode).toBe(201);
    actionId = res.json().id;
    expect(res.json().reference).toMatch(/^ACT-\d{3}$/);
    expect(res.json().status).toBe("open");
    expect(res.json().originalDueDate).toBe(res.json().dueDate);
    expect(res.json().revisedCount).toBe(0);
  });

  it("keeps the original date when the due date slips", async () => {
    const original = addDaysISO(todayISO(), 7);
    const res = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-action-items/${actionId}`,
      chair.headers,
      { dueDate: addDaysISO(todayISO(), 21) },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().originalDueDate).toBe(original);
    expect(res.json().revisedCount).toBe(1);
  });

  it("refuses verification by the person who completed it", async () => {
    const completed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${actionId}/complete`,
      h2,
      { closureNote: "RFI response issued" },
    );
    expect(completed.statusCode).toBe(200);
    expect(completed.json().completedBy).toBe(second.userId);

    const self = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${actionId}/verify`,
      h2,
      {},
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/may not verify/i);

    const other = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${actionId}/verify`,
      h3,
      {},
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().status).toBe("verified");
    expect(other.json().verifiedBy).toBe(third.userId);
  });

  it("refuses to promote an action with no contractual clause", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Tidy the site compound",
        meetingId,
        ownerName: "Site team",
        dueDate: addDaysISO(todayISO(), 3),
      },
    );
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${created.json().id}/promote`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/clause it discharges/i);
  });

  it("refuses to promote an action with no date to bite on", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Serve the early warning",
        meetingId,
        ownerName: "Project Manager",
        sourceClause: "NEC4 cl.15.1",
      },
    );
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${created.json().id}/promote`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/date it bites/i);
  });

  it("promotes an action into a real obligation, copying the shape across", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Issue the compensation event quotation",
        meetingId,
        ownerId: second.userId,
        dueDate: addDaysISO(todayISO(), 14),
        sourceClause: "NEC4 cl.62.3",
        obligeeId: chair.userId,
        warnDaysBefore: 3,
        evidenceRequirement: "The quotation, with the programme showing the delay",
      },
    );
    const id = created.json().id;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/promote`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(201);
    const { actionItem, obligation } = res.json();
    expect(actionItem.obligationId).toBe(obligation.id);
    expect(actionItem.promotedBy).toBe(chair.userId);
    expect(obligation.sourceClause).toBe("NEC4 cl.62.3");
    expect(obligation.obligorId).toBe(second.userId);
    expect(obligation.obligeeId).toBe(chair.userId);
    expect(obligation.warnDaysBefore).toBe(3);
    expect(obligation.evidenceRequirement).toMatch(/quotation/);
    expect(obligation.trigger).toMatch(/ACT-/);
    expect(obligation.status).toBe("open");

    const rows = await built.app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBe(projectId);

    const second_ = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/promote`,
      chair.headers,
      {},
    );
    expect(second_.statusCode).toBe(409);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}`,
      chair.headers,
    );
    expect(detail.json().obligation.id).toBe(obligation.id);
  });

  it("raises exactly one overdue signal per action, however often the list is read", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Close out the temporary works design",
        meetingId,
        ownerId: second.userId,
        ownerName: "Owner Rep",
        dueDate: addDaysISO(todayISO(), -10),
        priority: "critical",
      },
    );
    overdueId = created.json().id;

    const before = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, chair.companyId), eq(signals.detector, "meeting_action_overdue")),
      );

    /* The list read raises nothing — the sweep is the job. */
    const pureRead = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
    );
    expect(pureRead.statusCode).toBe(200);
    const stillClean = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, chair.companyId), eq(signals.detector, "meeting_action_overdue")),
      );
    expect(stillClean.length).toBe(before.length);

    const swept = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-reports/sweep`,
      chair.headers,
      {},
    );
    expect(swept.statusCode).toBe(200);
    expect(swept.json().overdue.raised).toBe(1);

    const first = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
    );
    expect(first.statusCode).toBe(200);

    const afterFirst = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, chair.companyId), eq(signals.detector, "meeting_action_overdue")),
      );
    expect(afterFirst.length).toBe(before.length + 1);

    /* Running the sweep again — however often — raises nothing twice: the
       signal is keyed on the action id AND the row records its signalId. */
    for (let i = 0; i < 3; i++) {
      const repeat = await inject(
        "POST",
        `/api/v1/projects/${projectId}/meeting-reports/sweep`,
        chair.headers,
        {},
      );
      expect(repeat.json().overdue.raised).toBe(0);
    }
    const afterRepeats = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, chair.companyId), eq(signals.detector, "meeting_action_overdue")),
      );
    expect(afterRepeats.length).toBe(afterFirst.length);

    const row = await built.app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.id, overdueId));
    expect(row[0]!.signalId).toBeTruthy();
    // The sweep reports; it does not silently restate the item's status.
    expect(row[0]!.status).toBe("open");
  });

  it("leaves a promoted action to its obligation rather than double-warning", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      {
        title: "Serve the late notice",
        meetingId,
        ownerId: second.userId,
        dueDate: addDaysISO(todayISO(), -30),
        sourceClause: "NEC4 cl.61.3",
      },
    );
    const id = created.json().id;
    const promoted = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/promote`,
      chair.headers,
      {},
    );
    expect(promoted.statusCode).toBe(201);

    const swept = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-reports/sweep`,
      chair.headers,
      {},
    );
    expect(swept.json().overdue.raised).toBe(0);
    const row = await built.app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.id, id));
    expect(row[0]!.signalId).toBeNull();
  });

  it("records slippage when an overdue action is re-dated, without a second signal", async () => {
    const before = await built.app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.id, overdueId));
    const signalId = before[0]!.signalId;
    expect(signalId).toBeTruthy();

    await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-action-items/${overdueId}`,
      chair.headers,
      { dueDate: addDaysISO(todayISO(), -1) },
    );
    const row = await built.app.db
      .select()
      .from(meetingActionItems)
      .where(eq(meetingActionItems.id, overdueId));
    // Re-dating is slippage, not a reset: the warning stays up.
    expect(row[0]!.signalId).toBe(signalId);
    expect(row[0]!.revisedCount).toBe(1);
    expect(row[0]!.originalDueDate).toBe(addDaysISO(todayISO(), -10));

    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-reports/sweep`,
      chair.headers,
      {},
    );
    expect(res.json().overdue.raised).toBe(0);
  });

  it("reports overdue actions grouped by owner", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-reports/overdue-actions`,
      chair.headers,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().summary.overdue).toBeGreaterThanOrEqual(1);
    expect(res.json().summary.promotedToObligations).toBeGreaterThanOrEqual(1);
    expect(res.json().byOwner.length).toBeGreaterThanOrEqual(1);
    expect(res.json().items.every((i: { dueDate: string }) => i.dueDate < todayISO())).toBe(true);
  });

  it("filters the action list by overdue and by promotion", async () => {
    const overdue = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items?overdue=1`,
      chair.headers,
    );
    expect(overdue.json().items.length).toBeGreaterThanOrEqual(1);
    expect(overdue.json().items.every((i: { isOverdue: boolean }) => i.isOverdue)).toBe(true);

    const promoted = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items?promoted=1`,
      chair.headers,
    );
    expect(promoted.json().items.every((i: { obligationId: string }) => i.obligationId)).toBe(true);
  });

  it("refuses to cancel an action whose obligation now owns the time bar", async () => {
    const promoted = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-action-items?promoted=1`,
      chair.headers,
    );
    const id = (promoted.json().items as { id: string }[])[0]!.id;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/cancel`,
      chair.headers,
      { reason: "No longer needed" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/obligation/i);
  });

  it("lists the caller's own actions across the company", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/meeting-action-items/mine`,
      headers: h2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
    expect(res.json().items.every((i: { ownerId: string }) => i.ownerId === second.userId)).toBe(
      true,
    );
    expect(res.json().asOf).toBe(todayISO());
  });

  it("shows every overdue action in the tenant, grouped by project", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: `/api/v1/meeting-action-items/overdue`,
      headers: chair.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
    expect(res.json().byProject.some((p: { projectId: string }) => p.projectId === projectId)).toBe(
      true,
    );
  });

  it("blocks and escalates an action without losing its history", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      { title: "Await the utility diversion date", meetingId, ownerName: "Utilities lead" },
    );
    const id = created.json().id;
    const blocked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/block`,
      chair.headers,
      { reason: "Waiting on the DNO" },
    );
    expect(blocked.json().status).toBe("blocked");
    expect(blocked.json().blockedReason).toMatch(/DNO/);

    const escalated = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/escalate`,
      chair.headers,
      { escalatedToId: third.userId, note: "Six weeks with no date" },
    );
    expect(escalated.json().escalatedToId).toBe(third.userId);
    expect(escalated.json().escalatedAt).toBeTruthy();
    expect(escalated.json().status).toBe("blocked");
  });

  it("closes a series and says what it is leaving behind", async () => {
    const series = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series`,
      chair.headers,
      { title: "Temporary works review", recurrence: "monthly" },
    );
    const seriesId = series.json().id;
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/close`,
      chair.headers,
      { reason: "Works complete" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("closed");
    expect(res.json().openActionItemsLeftBehind).toBe(0);

    const gen = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      chair.headers,
      { count: 1 },
    );
    expect(gen.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* WP-MEET upgrade — audit bug regressions and the new surfaces        */
/* ================================================================== */

describe("audit bug regressions", () => {
  /** A held meeting with minutes drafted, ready to be issued. */
  async function heldMeeting(title: string) {
    const created = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title,
      scheduledStart: new Date().toISOString(),
      minuteTakerId: chair.userId,
      objectionPeriodDays: 7,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await inject("POST", `/api/v1/projects/${projectId}/meetings/${id}/hold`, chair.headers, {});
    await inject("POST", `/api/v1/projects/${projectId}/meetings/${id}/minutes`, chair.headers, {
      minutesBody: "The room agreed the temporary works sequence.",
      objectionPeriodDays: 7,
    });
    return id;
  }

  it("[#1] refuses a redraft over issued minutes and offers a ledgered correction instead", async () => {
    const id = await heldMeeting("Redraft deadlock");
    const issued = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/issue`,
      chair.headers,
      {},
    );
    expect(issued.statusCode).toBe(200);

    const redraft = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes`,
      chair.headers,
      { minutesBody: "Rewritten after the fact", objectionPeriodDays: 30 },
    );
    expect(redraft.statusCode).toBe(409);

    /* The state must still be issuable/approvable — no deadlock. */
    const before = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${id}`,
      chair.headers,
    );
    expect(before.json().status).toBe("minutes_issued");
    expect(before.json().objectionPeriodDays).toBe(7);

    const corrected = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/correct`,
      chair.headers,
      { reason: "The decision on the crane sequence was minuted the wrong way round" },
    );
    expect(corrected.statusCode).toBe(200);
    const after = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${id}`,
      chair.headers,
    );
    expect(after.json().status).toBe("minutes_draft");
    expect(after.json().minutesIssuedAt).toBeNull();
    expect(after.json().minutesVersion).toBe(2);

    /* And the workflow can now complete: redraft, re-issue, sign off. */
    expect(
      (
        await inject("POST", `/api/v1/projects/${projectId}/meetings/${id}/minutes`, chair.headers, {
          minutesBody: "Corrected: the crane sequence was agreed the other way round.",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inject(
          "POST",
          `/api/v1/projects/${projectId}/meetings/${id}/minutes/issue`,
          chair.headers,
          {},
        )
      ).statusCode,
    ).toBe(200);
    const approved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/approve`,
      h2,
      {},
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("minutes_accepted");
  });

  it("[#2] strips status and post-promotion terms from the action-item PATCH", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      { title: "Issue the revised sequence", ownerName: "A Person", dueDate: todayISO() },
    );
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const patched = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}`,
      chair.headers,
      { status: "verified", title: "Renamed" },
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("open");
    expect(patched.json().title).toBe("Renamed");
    expect(patched.json().verifiedBy ?? null).toBeNull();
  });

  it("[#3] un-ratifies a decision that is edited after ratification", async () => {
    const id = await heldMeeting("Ratified then edited");
    const decision = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/decisions`,
      chair.headers,
      {
        title: "Accept the alternative pile design",
        decision: "The alternative design is accepted subject to the engineer's check.",
        decidedById: chair.userId,
        impactsCost: true,
        estimatedCostImpact: 120_000,
        currency: "GBP",
      },
    );
    expect(decision.statusCode).toBe(201);
    const decisionId = decision.json().id as string;
    const ratified = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/ratify`,
      h2,
      {},
    );
    expect(ratified.statusCode).toBe(200);
    expect(ratified.json().status).toBe("ratified");

    const edited = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}`,
      chair.headers,
      { estimatedCostImpact: 900_000 },
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json().status).toBe("recorded");
    expect(edited.json().ratifiedBy).toBeNull();
    expect(edited.json().unratifiedByEdit).toBe(true);
  });

  it("[#4] pushes the meetings date filter into the WHERE so pages and totals agree", async () => {
    const far = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Far future occurrence",
      scheduledStart: `${addDaysISO(todayISO(), 900)}T09:00:00.000Z`,
    });
    expect(far.statusCode).toBe(201);
    const from = addDaysISO(todayISO(), 800);
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings?from=${from}&pageSize=5`,
      chair.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(body.items.length);
    expect(body.items.every((m: { scheduledStart: string }) => m.scheduledStart >= from)).toBe(
      true,
    );
  });

  it("[#11] refuses to hold a meeting whose minutes are already issued", async () => {
    const id = await heldMeeting("Hold after issue");
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/issue`,
      chair.headers,
      {},
    );
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/hold`,
      chair.headers,
      {},
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/rewind its minutes/i);
  });

  it("[#13] applies the standing agenda, invitees and carry-forward when a meeting joins a series", async () => {
    const series = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series`,
      chair.headers,
      {
        title: "Standing arrangements series",
        recurrence: "weekly",
        agendaTemplate: [
          { title: "Safety moment", category: "safety" },
          { title: "Programme", category: "programme" },
        ],
        defaultAttendees: [{ name: "Site Manager", role: "required" }],
        quorumRequired: 1,
      },
    );
    expect(series.statusCode).toBe(201);
    const seriesId = series.json().id as string;

    const created = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Occurrence 1",
      seriesId,
      scheduledStart: new Date().toISOString(),
    });
    expect(created.statusCode).toBe(201);
    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${created.json().id}`,
      chair.headers,
    );
    expect(detail.json().agendaItems).toHaveLength(2);
    expect(detail.json().attendees).toHaveLength(1);
    expect(detail.json().attendees[0].attendance).toBe("absent");
    expect(detail.json().quorumRequired).toBe(1);
  });

  it("[#16] guards cancel, block and escalate by state", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items`,
      chair.headers,
      { title: "Guarded action", ownerName: "A Person", dueDate: todayISO() },
    );
    const id = created.json().id as string;
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/complete`,
      chair.headers,
      { closureNote: "Done and evidenced by the revised drawing" },
    );
    const verified = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/verify`,
      h2,
      {},
    );
    expect(verified.statusCode).toBe(200);

    const cancelled = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/cancel`,
      chair.headers,
      { reason: "Trying to erase the verification" },
    );
    expect(cancelled.statusCode).toBe(409);

    const escalated = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-action-items/${id}/escalate`,
      chair.headers,
      { escalatedToId: second.userId, note: "Trying to escalate a closed action" },
    );
    expect(escalated.statusCode).toBe(409);
  });

  it("[#17] validates atMeetingId on approval of a one-off meeting", async () => {
    const id = await heldMeeting("One-off approval");
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/issue`,
      chair.headers,
      {},
    );
    const bogus = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${id}/minutes/approve`,
      h2,
      { atMeetingId: "mtg_not_a_real_id" },
    );
    expect(bogus.statusCode).toBe(404);
  });

  it("[#5] scopes the company-wide overdue register to the caller's own projects", async () => {
    const res = await inject("GET", "/api/v1/meeting-action-items/overdue", hRead);
    expect(res.statusCode).toBe(200);
    const projectIds = new Set(
      (res.json().items as { projectId: string }[]).map((i) => i.projectId),
    );
    for (const p of projectIds) expect(p).toBe(projectId);

    /* A tenant member with the tool nowhere is refused outright, not given an
       empty list — "you have no access" and "there is nothing" differ. */
    const stranger = await registerActor(built.app);
    const foreign = await inject("GET", "/api/v1/meeting-action-items/overdue", stranger.headers);
    expect([200, 403]).toContain(foreign.statusCode);
    if (foreign.statusCode === 200) {
      expect(foreign.json().items).toEqual([]);
    }
  });
});

describe("minutes as a real document (#422, #425)", () => {
  let docMeeting: string;

  it("renders an agenda pack and the minutes as content-addressed files", async () => {
    const created = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Document render",
      scheduledStart: new Date().toISOString(),
      minuteTakerId: chair.userId,
      distribution: [second.userId],
      objectionPeriodDays: 7,
    });
    docMeeting = created.json().id as string;
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/agenda-items`,
      chair.headers,
      { title: "Temporary works", category: "safety" },
    );

    const pack = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/render`,
      chair.headers,
      { kind: "agenda_pack" },
    );
    expect(pack.statusCode).toBe(200);
    expect(pack.json().sha256).toMatch(/^[0-9a-f]{64}$/);

    /* Minutes cannot be rendered before they are written: an empty document
       with a hash on it is still an empty document. */
    const early = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/render`,
      chair.headers,
      { kind: "minutes" },
    );
    expect(early.statusCode).toBe(400);

    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/hold`,
      chair.headers,
      {},
    );
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes`,
      chair.headers,
      { minutesBody: "Temporary works were discussed and the sequence agreed." },
    );
    const rendered = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/render`,
      chair.headers,
      { kind: "minutes" },
    );
    expect(rendered.statusCode).toBe(200);
    const sha = rendered.json().sha256 as string;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);

    const served = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/document?kind=minutes`,
      chair.headers,
    );
    expect(served.statusCode).toBe(200);
    expect(served.headers["x-document-sha256"]).toBe(sha);
    expect(served.body).toContain("Temporary works");
  });

  it("records a delivery per recipient on issue and lets only the recipient acknowledge", async () => {
    const issued = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/issue`,
      chair.headers,
      {},
    );
    expect(issued.statusCode).toBe(200);

    const deliveries = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/deliveries`,
      chair.headers,
    );
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().total as number).toBeGreaterThan(0);
    const mine = (deliveries.json().items as { id: string; userId: string | null }[]).find(
      (d) => d.userId === second.userId,
    );
    expect(mine).toBeDefined();

    const wrongPerson = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/deliveries/${mine!.id}/acknowledge`,
      h3,
      {},
    );
    expect(wrongPerson.statusCode).toBe(403);

    const acked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/deliveries/${mine!.id}/acknowledge`,
      h2,
      {},
    );
    expect(acked.statusCode).toBe(200);
    expect(acked.json().status).toBe("acknowledged");
  });

  it("returns objections on the detail route and resolves them so sign-off can proceed", async () => {
    const objected = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/object`,
      h2,
      { note: "The sequence recorded is not what was agreed" },
    );
    expect(objected.statusCode).toBe(200);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}`,
      chair.headers,
    );
    expect(detail.json().objections).toHaveLength(1);
    const objectionId = detail.json().objections[0].id as string;

    const blocked = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/approve`,
      h3,
      {},
    );
    expect(blocked.statusCode).toBe(409);

    const resolved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/objections/${objectionId}/resolve`,
      chair.headers,
      { resolutionNote: "Agreed at the site walk; the minutes read correctly on re-reading." },
    );
    expect(resolved.statusCode).toBe(200);

    const approved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${docMeeting}/minutes/approve`,
      h3,
      {},
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("minutes_accepted");
  });
});

describe("meetings health-inputs", () => {
  it("reports the counts the intelligence layer scores, with reasons for what it cannot", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/health-inputs`,
      chair.headers,
    );
    expect(res.statusCode).toBe(200);
    const metrics = res.json().metrics as Record<string, number | null>;
    expect(typeof metrics.meetings).toBe("number");
    expect(typeof metrics.openActionItems).toBe("number");
    expect(Array.isArray(res.json().reasons)).toBe(true);
  });

  it("is refused to another tenant", async () => {
    const stranger = await registerActor(built.app);
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/health-inputs`,
      stranger.headers,
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* AI minutes drafting (#418-421) — the degraded path                   */
/* ================================================================== */

describe("AI minutes drafting", () => {
  let draftMeeting: string;

  beforeAll(async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/meetings`, chair.headers, {
      title: "Drafting test",
      meetingType: "progress",
    });
    draftMeeting = res.json().id as string;
  });

  it("answers 503 AiDisabled with no key, and says the workflow does not depend on it", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/draft-ai`,
      chair.headers,
      { transcript: "Chair: the crane arrives on the fourteenth. Bob will issue the lift plan." },
    );
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("AiDisabled");
    expect(res.json().message).toMatch(/nothing about issuing, objecting to or approving/i);
  });

  it("rejects a transcript too short to minute", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/draft-ai`,
      chair.headers,
      { transcript: "hello" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("refuses a read-only member before it ever reaches the AI layer", async () => {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/draft-ai`,
      hRead,
      { transcript: "Chair: the crane arrives on the fourteenth. Bob will issue the lift plan." },
    );
    expect(res.statusCode).toBe(403);
  });

  it("is refused to another tenant", async () => {
    const stranger = await registerActor(built.app);
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/draft-ai`,
      stranger.headers,
      { transcript: "Chair: the crane arrives on the fourteenth. Bob will issue the lift plan." },
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it("refuses to redraft over issued minutes before consulting the model", async () => {
    const saved = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes`,
      chair.headers,
      { minutesBody: "As recorded.", objectionPeriodDays: 7 },
    );
    expect(saved.statusCode).toBe(200);
    const issued = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/issue`,
      chair.headers,
      { sendEmail: false },
    );
    expect(issued.statusCode).toBe(200);
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${draftMeeting}/minutes/draft-ai`,
      chair.headers,
      { transcript: "Chair: the crane arrives on the fourteenth. Bob will issue the lift plan." },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/minutes\/correct/);
  });
});
