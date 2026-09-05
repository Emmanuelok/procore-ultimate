import { describe, expect, it } from "vitest";
import {
  attendanceSummary,
  computeObjectionWindow,
  esc,
  escBlock,
  money,
  objectionWording,
  renderMeetingDocument,
  type MinutesModel,
} from "./minutes.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function model(over: Partial<MinutesModel> = {}): MinutesModel {
  return {
    kind: "minutes",
    projectName: "Meetings Tower",
    companyName: "Acme Construction",
    seriesTitle: "Weekly progress",
    meeting: {
      reference: "MTG-001",
      title: "Weekly progress",
      meetingType: "progress",
      status: "minutes_issued",
      occurrenceNumber: 4,
      scheduledStart: "2026-06-01T09:00:00.000Z",
      actualStart: "2026-06-01T09:05:00.000Z",
      actualEnd: "2026-06-01T10:10:00.000Z",
      location: "Site cabin",
      isVirtual: 0,
      chairName: "A Chair",
      minuteTakerName: "A Scribe",
      quorumRequired: 3,
      minutesBody: "The room agreed the crane sequence.",
      objectionPeriodDays: 7,
      minutesVersion: 1,
    },
    attendees: [
      {
        name: "A Chair",
        organisation: "Acme",
        role: "chair",
        attendance: "present",
        delegateName: null,
      },
      {
        name: "B Person",
        organisation: "Sub Ltd",
        role: "required",
        attendance: "apologies",
        delegateName: null,
      },
      {
        name: "C Person",
        organisation: null,
        role: "optional",
        attendance: "absent",
        delegateName: null,
      },
    ],
    agendaItems: [
      {
        itemNumber: "1",
        position: 0,
        title: "Safety moment",
        category: "safety",
        status: "closed",
        description: null,
        discussion: "Scaffold inspection is current.",
        carryCount: 0,
        allocatedMinutes: 5,
        presenterName: "A Chair",
        linkLabel: null,
      },
    ],
    decisions: [
      {
        reference: "DEC-001",
        title: "Accept the alternative pile design",
        decision: "Accepted subject to the engineer's check.",
        rationale: null,
        decidedByName: "A Chair",
        status: "ratified",
        ratifiedByName: "B Person",
        impactsCost: 1,
        estimatedCostImpact: 120_000,
        currency: "GBP",
        impactsSchedule: 0,
        estimatedScheduleImpactDays: null,
      },
    ],
    actions: [
      {
        reference: "ACT-001",
        title: "Issue the revised sequence",
        ownerLabel: "B Person",
        dueDate: "2026-06-08",
        originalDueDate: "2026-06-05",
        status: "open",
        priority: "high",
        carryCount: 2,
        revisedCount: 1,
        obligationId: null,
        sourceClause: null,
      },
    ],
    quorum: { met: true, required: 3, counted: 3, reasons: [] },
    renderedAt: "2026-06-01T11:00:00.000Z",
    renderedByName: "A Scribe",
    recipients: ["A Chair", "B Person"],
    ...over,
  };
}

/* ================================================================== */
/* Escaping — the document is HTML and its inputs are user text        */
/* ================================================================== */

describe("esc / escBlock", () => {
  it("escapes every character that could break out of the document", () => {
    expect(esc(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
    );
  });

  it("renders null and undefined as nothing rather than the word 'null'", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });

  it("turns blank lines into paragraphs and single newlines into breaks", () => {
    expect(escBlock("one\ntwo\n\nthree")).toBe("<p>one<br/>two</p><p>three</p>");
    expect(escBlock(null)).toBe("");
  });

  it("escapes inside a block, so markup in free text cannot survive", () => {
    expect(escBlock("<b>bold</b>")).toBe("<p>&lt;b&gt;bold&lt;/b&gt;</p>");
  });
});

/* ================================================================== */
/* Money — never a bare number                                         */
/* ================================================================== */

describe("money", () => {
  it("prints the currency with the amount", () => {
    expect(money(120_000, "GBP")).toBe("GBP 120,000.00");
  });

  it("refuses to print a bare number when no currency is recorded", () => {
    expect(money(120_000, null)).toBe("120,000 (currency not recorded)");
  });

  it("says 'not recorded' rather than 0 for an absent figure", () => {
    expect(money(null, "GBP")).toBe("not recorded");
    expect(money(Number.NaN, "GBP")).toBe("not recorded");
  });
});

/* ================================================================== */
/* Attendance                                                          */
/* ================================================================== */

describe("attendanceSummary", () => {
  it("counts late and left-early as present, and apologies separately from absent", () => {
    const out = attendanceSummary([
      { name: "a", organisation: null, role: "chair", attendance: "present", delegateName: null },
      { name: "b", organisation: null, role: "required", attendance: "late", delegateName: null },
      {
        name: "c",
        organisation: null,
        role: "required",
        attendance: "left_early",
        delegateName: null,
      },
      {
        name: "d",
        organisation: null,
        role: "required",
        attendance: "delegate_attended",
        delegateName: "e",
      },
      {
        name: "f",
        organisation: null,
        role: "optional",
        attendance: "apologies",
        delegateName: null,
      },
      { name: "g", organisation: null, role: "optional", attendance: "absent", delegateName: null },
    ]);
    expect(out).toEqual({ present: 4, apologies: 1, absent: 1, total: 6 });
  });

  it("counts an unknown attendance state as absent rather than as present", () => {
    const out = attendanceSummary([
      { name: "a", organisation: null, role: "chair", attendance: "unheard_of", delegateName: null },
    ]);
    expect(out.present).toBe(0);
    expect(out.absent).toBe(1);
  });
});

/* ================================================================== */
/* The deeming wording                                                 */
/* ================================================================== */

describe("objectionWording", () => {
  it("says nothing is deemed accepted when no period is recorded", () => {
    expect(objectionWording(null)).toMatch(/nothing in them is deemed accepted/i);
  });

  it("handles a zero-day period as immediate effect on delivery", () => {
    expect(objectionWording(0)).toMatch(/zero-day/i);
  });

  it("names the period and says the clock runs from delivery", () => {
    const text = objectionWording(7);
    expect(text).toContain("7 days");
    expect(text).toMatch(/date of delivery, and not the date of issue/);
  });

  it("uses the singular for one day", () => {
    expect(objectionWording(1)).toContain("1 day of");
  });
});

/* ================================================================== */
/* The rendered document                                               */
/* ================================================================== */

describe("renderMeetingDocument", () => {
  it("renders a self-contained HTML document with the title block", () => {
    const { html, contentType } = renderMeetingDocument(model());
    expect(contentType).toBe("text/html");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("MTG-001");
    expect(html).toContain("Meetings Tower");
    expect(html).toContain("A Scribe");
  });

  it("prints the attendance with the quorum result, not just the roll", () => {
    const html = renderMeetingDocument(model()).html;
    expect(html).toContain("A Chair");
    expect(html).toContain("B Person");
    expect(html.toLowerCase()).toContain("quorum");
  });

  it("prints a decision's money with its currency and its ratification state", () => {
    const html = renderMeetingDocument(model()).html;
    expect(html).toContain("GBP 120,000.00");
    expect(html).toContain("DEC-001");
  });

  it("prints an action's carry count and its original date, so slippage is visible", () => {
    const html = renderMeetingDocument(model()).html;
    expect(html).toContain("ACT-001");
    expect(html).toContain("2026-06-05");
  });

  it("carries the objection wording on the minutes and omits it from an agenda pack", () => {
    const minutes = renderMeetingDocument(model()).html;
    expect(minutes).toMatch(/Objection period/);
    const pack = renderMeetingDocument(model({ kind: "agenda_pack" })).html;
    expect(pack).not.toMatch(/Objection period/);
  });

  it("says so when nobody is on the distribution list", () => {
    const html = renderMeetingDocument(model({ recipients: [] })).html;
    expect(html).toContain("nobody is listed on this meeting");
  });

  it("escapes hostile text from every field it prints", () => {
    const m = model();
    m.meeting.title = `<img src=x onerror="alert(1)">`;
    m.attendees[0]!.name = "</td><script>bad()</script>";
    const html = renderMeetingDocument(m).html;
    /* Nothing hostile survives as MARKUP. The characters may still appear —
       escaped — because the document must show what was actually typed; what
       must never survive is an angle bracket or a quote that closes a tag. */
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

/* ================================================================== */
/* The objection window — the clock runs from DELIVERY                 */
/* ================================================================== */

describe("computeObjectionWindow", () => {
  const base = {
    approvedAt: null,
    objections: [] as ReadonlyArray<{ resolvedAt?: unknown }>,
    nowMs: Date.parse("2026-06-05T00:00:00.000Z"),
  };

  it("reports no window at all before the minutes are issued", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: null,
      minutesDeliveredAt: null,
      objectionPeriodDays: 7,
    });
    expect(out.closesAt).toBeNull();
    expect(out.deemedAccepted).toBeNull();
    expect(out.reasons.join(" ")).toMatch(/not been issued/);
  });

  it("reports null rather than false when no objection period is recorded", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: null,
      objectionPeriodDays: null,
    });
    expect(out.expired).toBeNull();
    expect(out.deemedAccepted).toBeNull();
    expect(out.reasons.join(" ")).toMatch(/nothing is deemed accepted/i);
  });

  it("runs the clock from DELIVERY when one is recorded", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: "2026-06-03T00:00:00.000Z",
      objectionPeriodDays: 7,
    });
    expect(out.runsFrom).toBe("delivery");
    expect(out.closesAt).toBe("2026-06-10T00:00:00.000Z");
    expect(out.reasons).toEqual([]);
  });

  it("falls back to ISSUE and says the recipient can displace that", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: null,
      objectionPeriodDays: 7,
    });
    expect(out.runsFrom).toBe("issue");
    expect(out.closesAt).toBe("2026-06-08T00:00:00.000Z");
    expect(out.reasons.join(" ")).toMatch(/never received them can displace that/);
  });

  it("deems acceptance only after the window closes with no open objection", () => {
    const args = {
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: null,
      objectionPeriodDays: 3,
    };
    const closed = computeObjectionWindow({ ...args, nowMs: Date.parse("2026-06-09T00:00:00Z") });
    expect(closed.expired).toBe(true);
    expect(closed.deemedAccepted).toBe(true);

    const open = computeObjectionWindow({ ...args, nowMs: Date.parse("2026-06-02T00:00:00Z") });
    expect(open.expired).toBe(false);
    expect(open.deemedAccepted).toBe(false);
  });

  it("refuses to deem acceptance while an objection is unresolved", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: null,
      objectionPeriodDays: 1,
      objections: [{ resolvedAt: null }, { resolvedAt: "2026-06-02T00:00:00.000Z" }],
      nowMs: Date.parse("2026-06-09T00:00:00Z"),
    });
    expect(out.objections).toBe(2);
    expect(out.openObjections).toBe(1);
    expect(out.deemedAccepted).toBe(false);
  });

  it("stops deeming once a human has actually signed the minutes off", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "2026-06-01T00:00:00.000Z",
      minutesDeliveredAt: null,
      objectionPeriodDays: 1,
      approvedAt: "2026-06-04T00:00:00.000Z",
      nowMs: Date.parse("2026-06-09T00:00:00Z"),
    });
    /* Deeming is what happens INSTEAD of a signature; once one exists the
       question does not arise, and the record must not claim both. */
    expect(out.deemedAccepted).toBe(false);
  });

  it("refuses the arithmetic on an unparseable timestamp rather than inventing a date", () => {
    const out = computeObjectionWindow({
      ...base,
      minutesIssuedAt: "not-a-date",
      minutesDeliveredAt: null,
      objectionPeriodDays: 7,
    });
    expect(out.closesAt).toBeNull();
    expect(out.expired).toBeNull();
    expect(out.reasons.join(" ")).toMatch(/not a valid instant/);
  });
});
