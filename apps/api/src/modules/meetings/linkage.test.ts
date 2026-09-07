/**
 * The routes that connect a meeting to the rest of the platform, and the
 * company-level agenda template library — the surfaces meetings.test.ts does
 * not reach.
 *
 * Covered here:
 *  · POST /meeting-agenda-items/:id/raise (#424) — creating the RFI / change
 *    event / risk from the item, the two-way record_links edge, the live
 *    status shown back on the agenda row, AND the permission boundary: a
 *    caller holding `meetings` but not the target tool may not create the
 *    target record.
 *  · GET  /meeting-links — the reverse view ("which meetings tabled this RFI").
 *  · GET/POST/PATCH /meeting-agenda-templates (#416) and both apply-template
 *    routes (series and single occurrence).
 *  · POST /meeting-decisions/:id/dispute — including the states it must refuse.
 *  · Tenant isolation on each of them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  meetingDecisions,
  projects,
  projectMemberships,
  recordLinks,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor;
/** A member who runs meetings but holds no RFI / change / risk permission. */
let chairOnly: TestActor;
/** A member who runs meetings AND may open RFIs. */
let chairPlus: TestActor;
/** A different tenant entirely. */
let outsider: TestActor;
let hChairOnly: Record<string, string>;
let hChairPlus: Record<string, string>;
let projectId: string;
let otherProjectId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

/** A meeting with one open agenda item, ready to raise something from. */
async function meetingWithItem(title: string): Promise<{ meetingId: string; itemId: string }> {
  const meeting = await inject("POST", `/api/v1/projects/${projectId}/meetings`, owner.headers, {
    title,
    meetingType: "progress",
  });
  expect(meeting.statusCode).toBe(201);
  const meetingId = meeting.json().id as string;
  const item = await inject(
    "POST",
    `/api/v1/projects/${projectId}/meetings/${meetingId}/agenda-items`,
    owner.headers,
    { title: `${title} — the unresolved question`, category: "design" },
  );
  expect(item.statusCode).toBe(201);
  return { meetingId, itemId: item.json().id as string };
}

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  chairOnly = await registerActor(built.app);
  chairPlus = await registerActor(built.app);
  outsider = await registerActor(built.app);

  await built.app.db.insert(companyMemberships).values([
    { id: newId("cm"), companyId: owner.companyId, userId: chairOnly.userId, role: "member" },
    { id: newId("cm"), companyId: owner.companyId, userId: chairPlus.userId, role: "member" },
  ]);
  hChairOnly = {
    authorization: `Bearer ${chairOnly.accessToken}`,
    "x-company-id": owner.companyId,
  };
  hChairPlus = {
    authorization: `Bearer ${chairPlus.accessToken}`,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  otherProjectId = newId("prj");
  await built.app.db.insert(projects).values([
    { id: projectId, companyId: owner.companyId, name: "Linkage Tower" },
    { id: otherProjectId, companyId: outsider.companyId, name: "Other Tenant Tower" },
  ]);
  await built.app.db.insert(projectMemberships).values([
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: chairOnly.userId,
      templateKey: "read_only",
      /* read_only is `read` on everything; the override lifts ONLY meetings. */
      overrides: { meetings: "admin" },
    },
    {
      id: newId("pm"),
      companyId: owner.companyId,
      projectId,
      userId: chairPlus.userId,
      templateKey: "read_only",
      overrides: { meetings: "standard", rfis: "standard", risk: "standard" },
    },
  ]);
}, 180_000);

afterAll(async () => {
  await built.close();
});

/* ================================================================== */
/* Raising a record from an agenda item (#424)                         */
/* ================================================================== */

describe("raising a record from an agenda item", () => {
  it("creates the RFI, links it both ways and shows its live status on the item", async () => {
    const { meetingId, itemId } = await meetingWithItem("Cladding interface");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/raise`,
      owner.headers,
      { target: "rfi", detail: "Which detail governs at the parapet?", closeItem: true },
    );
    expect(res.statusCode).toBe(201);
    const raised = res.json().raised as { type: string; id: string; reference: string };
    expect(raised.type).toBe("rfi");
    expect(raised.reference).toMatch(/^RFI-\d{3}$/);
    expect(res.json().itemStatus).toBe("closed");

    /* Both directions, so the RFI can answer "where was this tabled?" and the
       agenda row can answer "what came of it?". */
    const edges = await built.app.db
      .select()
      .from(recordLinks)
      .where(
        and(
          eq(recordLinks.companyId, owner.companyId),
          eq(recordLinks.projectId, projectId),
        ),
      );
    const forward = edges.filter((e) => e.fromId === itemId && e.toId === raised.id);
    const back = edges.filter((e) => e.fromId === raised.id && e.toId === itemId);
    expect(forward).toHaveLength(1);
    expect(back).toHaveLength(1);

    const links = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/links`,
      owner.headers,
    );
    expect(links.statusCode).toBe(200);
    const linked = links.json().items as Array<{ type: string; id: string; status: string }>;
    expect(linked.some((l) => l.type === "rfi" && l.id === raised.id)).toBe(true);
    /* The LIVE status, read from the RFI itself — not a copy taken at raise
       time that would go stale the moment the RFI was answered. */
    expect(linked.find((l) => l.id === raised.id)?.status).toBe("draft");

    /* The reverse view an RFI's own page uses. */
    const reverse = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-links?recordType=rfi&recordId=${raised.id}`,
      owner.headers,
    );
    expect(reverse.statusCode).toBe(200);
    expect(reverse.json().meetings.map((m: { id: string }) => m.id)).toContain(meetingId);
    expect(reverse.json().agendaItems.map((i: { id: string }) => i.id)).toContain(itemId);
  });

  it("raises a risk and a change event from the same vocabulary", async () => {
    const risk = await meetingWithItem("Ground conditions");
    const riskRes = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${risk.itemId}/raise`,
      owner.headers,
      { target: "risk" },
    );
    expect(riskRes.statusCode).toBe(201);
    expect(riskRes.json().raised.reference).toMatch(/^RSK-\d{3}$/);
    /* The item stays open unless the caller says otherwise: raising a record
       is not the same as settling the question. */
    expect(riskRes.json().itemStatus).toBe("open");

    const change = await meetingWithItem("Client-instructed rework");
    const changeRes = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${change.itemId}/raise`,
      owner.headers,
      { target: "change_event", title: "Rework to level 3 slab" },
    );
    expect(changeRes.statusCode).toBe(201);
    expect(changeRes.json().raised.type).toBe("change_event");
  });

  it("refuses a raise from a caller who holds meetings but not the target tool", async () => {
    /*
     * REGRESSION. The route is gated on `meetings: standard`, and it creates a
     * record in another tool's register. Without a second check, running a
     * meeting was permission to open RFIs, raise change events and write the
     * risk register — one tool widened into four by choosing a URL.
     */
    const { itemId } = await meetingWithItem("Out of my lane");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/raise`,
      hChairOnly,
      { target: "rfi" },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/rfis/);

    /* And nothing was created on the way to the refusal. */
    const links = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/links`,
      owner.headers,
    );
    expect(links.json().total).toBe(0);
  });

  it("allows the raise once the caller holds the target tool too", async () => {
    const { itemId } = await meetingWithItem("In my lane");
    const ok = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/raise`,
      hChairPlus,
      { target: "rfi" },
    );
    expect(ok.statusCode).toBe(201);

    /* Same caller, a tool they still do not hold: refused, per target. */
    const second = await meetingWithItem("Still not my lane");
    const refused = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${second.itemId}/raise`,
      hChairPlus,
      { target: "change_event" },
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/change_management/);
  });

  it("refuses an unknown target rather than inventing a record type", async () => {
    const { itemId } = await meetingWithItem("Nonsense target");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/raise`,
      owner.headers,
      { target: "purchase_order" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("does not let another tenant raise from, or read the links of, this item", async () => {
    const { itemId } = await meetingWithItem("Not yours");
    const raise = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/raise`,
      outsider.headers,
      { target: "rfi" },
    );
    expect([403, 404]).toContain(raise.statusCode);
    const links = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meeting-agenda-items/${itemId}/links`,
      outsider.headers,
    );
    expect([403, 404]).toContain(links.statusCode);
  });
});

/* ================================================================== */
/* Agenda template library (#416)                                      */
/* ================================================================== */

describe("company agenda template library", () => {
  let templateId: string;

  it("creates a company-wide template and lists it", async () => {
    const res = await inject("POST", "/api/v1/meeting-agenda-templates", owner.headers, {
      name: "NEC4 progress meeting",
      meetingType: "progress",
      contractRequirement: "NEC4 cl.31.1",
      items: [
        { title: "Safety moment", category: "safety", position: 0, allocatedMinutes: 5 },
        { title: "Programme", category: "programme", position: 1 },
        { title: "Early warnings", category: "commercial", position: 2 },
      ],
      defaultAttendees: [{ name: "Project Manager", role: "chair" }],
      isDefault: true,
    });
    expect(res.statusCode).toBe(201);
    templateId = res.json().id as string;

    const list = await inject("GET", "/api/v1/meeting-agenda-templates", owner.headers);
    expect(list.statusCode).toBe(200);
    const mine = (list.json().items as Array<Record<string, unknown>>).find(
      (t) => t["id"] === templateId,
    );
    expect(mine).toBeTruthy();
    expect(mine!["itemCount"]).toBe(3);
    expect(mine!["inviteeCount"]).toBe(1);
  });

  it("edits the template through PATCH", async () => {
    const res = await inject(
      "PATCH",
      `/api/v1/meeting-agenda-templates/${templateId}`,
      owner.headers,
      { name: "NEC4 progress meeting (rev B)", isDefault: false },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("NEC4 progress meeting (rev B)");
    expect(res.json().isDefault).toBe(0);
  });

  it("applies a template to a series so every future occurrence carries it", async () => {
    const series = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series`,
      owner.headers,
      { title: "Weekly", recurrence: "weekly", dayOfWeek: 1, startTime: "09:00" },
    );
    expect(series.statusCode).toBe(201);
    const seriesId = series.json().id as string;

    const applied = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/apply-template`,
      owner.headers,
      { templateId },
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json().appliedTemplate.items).toBe(3);
    expect((applied.json().agendaTemplate as unknown[]).length).toBe(3);
    expect((applied.json().defaultAttendees as unknown[]).length).toBe(1);

    /* The occurrence generated afterwards has the standing agenda on it —
       the point of the library, and what the UI copy has always promised. */
    const generated = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/generate-occurrences`,
      owner.headers,
      { count: 1, from: "2026-03-02" },
    );
    expect(generated.statusCode).toBe(201);
    const occurrenceId = generated.json().created[0].id as string;
    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${occurrenceId}`,
      owner.headers,
    );
    expect(detail.json().agendaItems).toHaveLength(3);

    /* Appending must not lose the bespoke tail a series has grown. */
    const appended = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-series/${seriesId}/apply-template`,
      owner.headers,
      { templateId, mode: "append" },
    );
    expect(appended.statusCode).toBe(200);
    expect((appended.json().agendaTemplate as unknown[]).length).toBe(6);
  });

  it("applies a template to one occurrence, appending after what is already there", async () => {
    const { meetingId } = await meetingWithItem("One-off design workshop");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/apply-template`,
      owner.headers,
      { templateId },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(3);

    const detail = await inject(
      "GET",
      `/api/v1/projects/${projectId}/meetings/${meetingId}`,
      owner.headers,
    );
    /* One original item plus the three from the template, positioned after it. */
    expect(detail.json().agendaItems).toHaveLength(4);
    const positions = (detail.json().agendaItems as Array<{ position: number }>).map(
      (i) => i.position,
    );
    expect([...positions].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("refuses to rewrite the agenda of a meeting whose minutes are issued", async () => {
    const { meetingId } = await meetingWithItem("Already minuted");
    await inject("POST", `/api/v1/projects/${projectId}/meetings/${meetingId}/hold`, owner.headers, {});
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/minutes`,
      owner.headers,
      { minutesBody: "Discussed and agreed." },
    );
    const issued = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/minutes/issue`,
      owner.headers,
      { sendEmail: false },
    );
    expect(issued.statusCode).toBe(200);

    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/apply-template`,
      owner.headers,
      { templateId },
    );
    expect(res.statusCode).toBe(409);
  });

  it("does not disclose or accept another tenant's templates", async () => {
    const list = await inject("GET", "/api/v1/meeting-agenda-templates", outsider.headers);
    /* A member of another tenant either holds the tool nowhere (403) or sees
       an empty library — never this company's. */
    if (list.statusCode === 200) {
      expect(
        (list.json().items as Array<{ id: string }>).some((t) => t.id === templateId),
      ).toBe(false);
    } else {
      expect(list.statusCode).toBe(403);
    }

    const patch = await inject(
      "PATCH",
      `/api/v1/meeting-agenda-templates/${templateId}`,
      outsider.headers,
      { name: "Hijacked" },
    );
    expect([403, 404]).toContain(patch.statusCode);
  });

  it("refuses template administration to a member who does not hold meetings admin", async () => {
    const res = await inject("POST", "/api/v1/meeting-agenda-templates", hChairPlus, {
      name: "Not allowed",
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Disputing a decision                                                */
/* ================================================================== */

describe("disputing a decision", () => {
  async function decisionIn(meetingId: string, title: string): Promise<string> {
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meetings/${meetingId}/decisions`,
      owner.headers,
      { title, decision: "Agreed as recorded." },
    );
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("records who disputed a live decision and why", async () => {
    const { meetingId } = await meetingWithItem("Decision meeting");
    const decisionId = await decisionIn(meetingId, "Adopt option B");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/dispute`,
      owner.headers,
      { note: "The cost basis was not tabled." },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("disputed");
    expect(res.json().disputedBy).toBe(owner.userId);
    expect(res.json().disputeNote).toMatch(/cost basis/);
  });

  it("refuses a second dispute rather than overwriting the first objection", async () => {
    const { meetingId } = await meetingWithItem("Twice-disputed");
    const decisionId = await decisionIn(meetingId, "Adopt option C");
    await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/dispute`,
      owner.headers,
      { note: "First objection." },
    );
    const second = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/dispute`,
      hChairPlus,
      { note: "Second objection, erasing the first." },
    );
    expect(second.statusCode).toBe(409);

    const [row] = await built.app.db
      .select()
      .from(meetingDecisions)
      .where(eq(meetingDecisions.id, decisionId))
      .limit(1);
    expect(row!.disputeNote).toBe("First objection.");
    expect(row!.disputedBy).toBe(owner.userId);
  });

  it("refuses to dispute a superseded decision, which would re-open editing of it", async () => {
    /*
     * REGRESSION. `dispute` had no state guard. Disputing a superseded
     * decision overwrote the status that recorded how it ended — while its
     * successor still pointed back at it — and, because the generic PATCH
     * refuses only `superseded`/`rescinded`, dispute-then-edit was a way round
     * the guard on content an independent reviewer had certified.
     */
    const { meetingId } = await meetingWithItem("Superseded decision");
    const decisionId = await decisionIn(meetingId, "Adopt option D");
    const superseded = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/supersede`,
      owner.headers,
      { meetingId, title: "Adopt option E instead", decision: "Option D is withdrawn." },
    );
    expect(superseded.statusCode).toBe(201);

    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/dispute`,
      owner.headers,
      { note: "Trying to re-open a closed record." },
    );
    expect(res.statusCode).toBe(409);

    const [row] = await built.app.db
      .select()
      .from(meetingDecisions)
      .where(eq(meetingDecisions.id, decisionId))
      .limit(1);
    expect(row!.status).toBe("superseded");
    expect(row!.supersededByDecisionId).toBeTruthy();

    /* And the PATCH guard still holds, so the loop is genuinely closed. */
    const patch = await inject(
      "PATCH",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}`,
      owner.headers,
      { decision: "Rewritten after the fact." },
    );
    expect(patch.statusCode).toBe(400);
  });

  it("does not let another tenant dispute this project's decision", async () => {
    const { meetingId } = await meetingWithItem("Foreign dispute");
    const decisionId = await decisionIn(meetingId, "Adopt option F");
    const res = await inject(
      "POST",
      `/api/v1/projects/${projectId}/meeting-decisions/${decisionId}/dispute`,
      outsider.headers,
      { note: "Not my company." },
    );
    expect([403, 404]).toContain(res.statusCode);
  });
});
