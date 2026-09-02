import { describe, expect, it } from "vitest";
import {
  ackPosition,
  assessLetter,
  deriveTransmittalStatus,
  registerStats,
  type LetterInput,
  type RecipientInput,
} from "./tracking.js";
import { addDaysISO, addWorkingDaysISO, daysBetween, isIsoDate } from "./dates.js";

const TODAY = "2026-09-02";

const letter = (over: Partial<LetterInput> & { id: string }): LetterInput => ({
  reference: `LTR-${over.id}`,
  typeKey: "letter",
  direction: "outbound",
  status: "issued",
  priority: "normal",
  responseRequired: false,
  responseDueDate: null,
  respondedAt: null,
  issuedAt: "2026-08-20T09:00:00.000Z",
  letterDate: "2026-08-20",
  createdAt: "2026-08-20T09:00:00.000Z",
  ...over,
});

describe("dates", () => {
  it("adds calendar days without timezone drift", () => {
    expect(addDaysISO("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("skips weekends for working days", () => {
    // 2026-09-04 is a Friday; +1 working day is Monday the 7th.
    expect(addWorkingDaysISO("2026-09-04", 1)).toBe("2026-09-07");
    expect(addWorkingDaysISO("2026-09-04", 5)).toBe("2026-09-11");
    expect(addWorkingDaysISO("2026-09-04", 0)).toBe("2026-09-04");
  });

  it("measures signed day differences and validates shape", () => {
    expect(daysBetween("2026-09-01", "2026-09-05")).toBe(4);
    expect(daysBetween("2026-09-05", "2026-09-01")).toBe(-4);
    expect(daysBetween(null, "2026-09-01")).toBeNull();
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-09-01")).toBe(true);
  });
});

describe("assessLetter", () => {
  it("puts an unanswered outbound letter in the recipient's court", () => {
    const a = assessLetter(
      letter({ id: "1", responseRequired: true, responseDueDate: "2026-09-05" }),
      TODAY,
    );
    expect(a.awaitingResponse).toBe(true);
    expect(a.ballInCourt).toBe("recipient");
    expect(a.dueInDays).toBe(3);
    expect(a.dueSoon).toBe(true);
    expect(a.overdue).toBe(false);
  });

  it("puts an unanswered inbound letter in ours", () => {
    const a = assessLetter(
      letter({ id: "2", direction: "inbound", responseRequired: true, responseDueDate: "2026-09-10" }),
      TODAY,
    );
    expect(a.ballInCourt).toBe("us");
  });

  it("counts days overdue past the response date", () => {
    const a = assessLetter(
      letter({ id: "3", responseRequired: true, responseDueDate: "2026-08-25" }),
      TODAY,
    );
    expect(a.overdue).toBe(true);
    expect(a.daysOverdue).toBe(8);
    expect(a.dueSoon).toBe(false);
  });

  it("stops chasing once a response is recorded and reports the cycle time", () => {
    const a = assessLetter(
      letter({
        id: "4",
        status: "responded",
        responseRequired: true,
        responseDueDate: "2026-08-25",
        respondedAt: "2026-08-24T00:00:00.000Z",
      }),
      TODAY,
    );
    expect(a.awaitingResponse).toBe(false);
    expect(a.overdue).toBe(false);
    expect(a.ballInCourt).toBe("none");
    expect(a.responseDays).toBe(4);
  });

  it("does not chase a draft or a void letter", () => {
    expect(assessLetter(letter({ id: "5", status: "draft", responseRequired: true, responseDueDate: "2026-01-01" }), TODAY).awaitingResponse).toBe(false);
    expect(assessLetter(letter({ id: "6", status: "void", responseRequired: true, responseDueDate: "2026-01-01" }), TODAY).overdue).toBe(false);
  });

  it("reports no due figure when a response is required but no date was set", () => {
    const a = assessLetter(letter({ id: "7", responseRequired: true }), TODAY);
    expect(a.awaitingResponse).toBe(true);
    expect(a.dueInDays).toBeNull();
    expect(a.overdue).toBe(false);
  });
});

describe("registerStats", () => {
  it("summarises the register and averages only answered letters", () => {
    const stats = registerStats(
      [
        letter({ id: "1", responseRequired: true, responseDueDate: "2026-08-25" }),
        letter({ id: "2", status: "responded", responseRequired: true, respondedAt: "2026-08-26T00:00:00.000Z" }),
        letter({ id: "3", status: "draft" }),
        letter({ id: "4", direction: "inbound", typeKey: "notice" }),
      ],
      TODAY,
    );
    expect(stats.total).toBe(4);
    expect(stats.byStatus["issued"]).toBe(2);
    expect(stats.byDirection["inbound"]).toBe(1);
    expect(stats.byType["notice"]).toBe(1);
    // issued ×2 are open; the responded one and the draft are not.
    expect(stats.open).toBe(2);
    expect(stats.overdue).toBe(1);
    expect(stats.ballWithRecipient).toBe(1);
    expect(stats.ballWithUs).toBe(1);
    expect(stats.averageResponseDays).toBe(6);
    expect(stats.averageResponseBasis).toContain("1 answered letter");
  });

  it("declines to average when nothing has been answered", () => {
    const stats = registerStats([letter({ id: "1" })], TODAY);
    expect(stats.averageResponseDays).toBeNull();
    expect(stats.averageResponseBasis).toContain("no cycle time");
  });
});

describe("ackPosition", () => {
  const recipient = (over: Partial<RecipientInput> & { id: string }): RecipientInput => ({
    name: over.id,
    kind: "to",
    acknowledgementRequired: true,
    acknowledgedAt: null,
    firstReadAt: null,
    deliveryStatus: "sent",
    ...over,
  });

  it("reports the acknowledgement rate over the recipients who were asked", () => {
    const p = ackPosition(
      [
        recipient({ id: "a", acknowledgedAt: "2026-08-30T00:00:00Z", firstReadAt: "2026-08-29T00:00:00Z" }),
        recipient({ id: "b" }),
        recipient({ id: "c", acknowledgementRequired: false }),
      ],
      "2026-08-31",
      TODAY,
    );
    expect(p.recipients).toBe(3);
    expect(p.required).toBe(2);
    expect(p.acknowledged).toBe(1);
    expect(p.percent).toBe(50);
    expect(p.read).toBe(1);
    expect(p.overdue).toBe(true);
    expect(p.daysOverdue).toBe(2);
    expect(p.outstandingNames).toEqual(["b"]);
  });

  it("refuses to invent a rate when nobody was asked", () => {
    const p = ackPosition([recipient({ id: "a", acknowledgementRequired: false })], null, TODAY);
    expect(p.percent).toBeNull();
    expect(p.reasons[0]).toContain("no acknowledgement rate");
  });

  it("says out loud that a bounced recipient's silence is not receipt", () => {
    const p = ackPosition([recipient({ id: "a", deliveryStatus: "bounced" })], null, TODAY);
    expect(p.bounced).toBe(1);
    expect(p.reasons.some((r) => r.includes("not evidence of receipt"))).toBe(true);
  });

  it("is not overdue when everyone has acknowledged", () => {
    const p = ackPosition([recipient({ id: "a", acknowledgedAt: "2026-08-01T00:00:00Z" })], "2026-08-01", TODAY);
    expect(p.overdue).toBe(false);
    expect(p.percent).toBe(100);
  });
});

describe("deriveTransmittalStatus", () => {
  const position = (required: number, acknowledged: number) =>
    ackPosition(
      Array.from({ length: required }, (_, i) => ({
        id: `r${i}`,
        name: `r${i}`,
        kind: "to",
        acknowledgementRequired: true,
        acknowledgedAt: i < acknowledged ? "2026-08-30T00:00:00Z" : null,
        firstReadAt: null,
        deliveryStatus: "sent",
      })),
      null,
      TODAY,
    );

  it("never overwrites draft, closed or void", () => {
    expect(deriveTransmittalStatus("draft", position(2, 2))).toBe("draft");
    expect(deriveTransmittalStatus("closed", position(2, 0))).toBe("closed");
    expect(deriveTransmittalStatus("void", position(2, 2))).toBe("void");
  });

  it("walks issued → partially acknowledged → acknowledged", () => {
    expect(deriveTransmittalStatus("issued", position(2, 0))).toBe("issued");
    expect(deriveTransmittalStatus("issued", position(2, 1))).toBe("partially_acknowledged");
    expect(deriveTransmittalStatus("partially_acknowledged", position(2, 2))).toBe("acknowledged");
  });

  it("stays issued when nobody was asked to acknowledge", () => {
    expect(deriveTransmittalStatus("issued", position(0, 0))).toBe("issued");
  });
});
