import { describe, expect, it } from "vitest";
import {
  cleanSubject,
  detectReference,
  htmlToText,
  parseAddress,
  parseAddresses,
  parseInboundEmail,
  routeInbound,
  stripQuotedReply,
  type RoutingCandidate,
} from "./email.js";

const NOW = "2026-09-02T09:00:00.000Z";

describe("parseAddress", () => {
  it("splits a display name from the address and lower-cases the address", () => {
    expect(parseAddress('"Jane Doe" <Jane.Doe@Contractor.COM>')).toEqual({
      email: "jane.doe@contractor.com",
      name: "Jane Doe",
    });
    expect(parseAddress("Bob Stone <bob@x.io>")).toEqual({ email: "bob@x.io", name: "Bob Stone" });
  });

  it("returns a bare address with no name", () => {
    expect(parseAddress("  ops@site.co.uk ")).toEqual({ email: "ops@site.co.uk", name: null });
  });

  it("treats an empty display name as absent", () => {
    expect(parseAddress("<solo@x.io>")).toEqual({ email: "solo@x.io", name: null });
  });
});

describe("parseAddresses", () => {
  it("de-duplicates case-insensitively and skips blanks", () => {
    expect(parseAddresses(["A@x.io", "  ", "a@x.io", "B <b@x.io>"])).toEqual([
      { email: "a@x.io", name: null },
      { email: "b@x.io", name: "B" },
    ]);
  });

  it("is empty for an absent list", () => {
    expect(parseAddresses(undefined)).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("flattens block elements to newlines and decodes entities", () => {
    const out = htmlToText("<p>Line one</p><div>Line &amp; two</div><style>x{}</style>");
    expect(out).toBe("Line one\nLine & two");
  });
});

describe("stripQuotedReply", () => {
  it("cuts at the On … wrote: marker", () => {
    const text = "Our answer is grade 8.8.\n\nOn 1 Sep 2026, Bob wrote:\n> what grade?";
    expect(stripQuotedReply(text)).toBe("Our answer is grade 8.8.");
  });

  it("keeps a message that is entirely a quote rather than emptying it", () => {
    expect(stripQuotedReply("> only a quote")).toBe("> only a quote");
  });
});

describe("detectReference", () => {
  const prefixes = ["LTR", "EOT", "EOT-NOT"];

  it("finds a configured prefix with padding and separators", () => {
    expect(detectReference("Re: LTR-007 Rebar spacing", prefixes)).toEqual({
      prefix: "LTR",
      number: 7,
      matched: "LTR-007",
    });
    expect(detectReference("ltr 12 — access", prefixes)?.number).toBe(12);
    expect(detectReference("LTR#0004 access", prefixes)?.number).toBe(4);
  });

  it("prefers the longest matching prefix so EOT-NOT beats EOT", () => {
    expect(detectReference("FW: EOT-NOT-003 delay notice", prefixes)?.prefix).toBe("EOT-NOT");
  });

  it("ignores a bare number and unknown prefixes", () => {
    expect(detectReference("Invoice 42 attached", prefixes)).toBeNull();
    expect(detectReference("RFI-004 question", prefixes)).toBeNull();
  });

  it("does not treat zero as a reference", () => {
    expect(detectReference("LTR-000 placeholder", prefixes)).toBeNull();
  });
});

describe("cleanSubject", () => {
  it("strips reply markers and the matched reference", () => {
    expect(cleanSubject("Re: Fwd: LTR-012: Rebar spacing", "LTR-012")).toBe("Rebar spacing");
  });

  it("leaves a plain subject alone", () => {
    expect(cleanSubject("Site access on Monday")).toBe("Site access on Monday");
  });
});

describe("parseInboundEmail", () => {
  it("prefers text over html, strips the quote and collects stored attachments", () => {
    const parsed = parseInboundEmail(
      {
        from: "Jane <jane@sub.co>",
        to: ["pm@main.co"],
        cc: ["qs@main.co", "pm@main.co"],
        subject: "RE: LTR-003 Late information",
        text: "We disagree.\n\nOn 1 Sep 2026, PM wrote:\n> you are late",
        html: "<p>ignored</p>",
        messageId: "<abc@mail>",
        attachments: [{ fileId: "fil_1", filename: "a.pdf" }, { filename: "b.pdf" }],
      },
      ["LTR"],
      NOW,
    );
    expect(parsed.body).toBe("We disagree.");
    expect(parsed.cleanedSubject).toBe("Late information");
    expect(parsed.reference).toEqual({ prefix: "LTR", number: 3, matched: "LTR-003" });
    expect(parsed.sender).toEqual({ email: "jane@sub.co", name: "Jane" });
    expect(parsed.cc.map((c) => c.email)).toEqual(["qs@main.co", "pm@main.co"]);
    expect(parsed.fileIds).toEqual(["fil_1"]);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.receivedAt).toBe(NOW);
  });

  it("falls back to html and to the raw subject when there is nothing else", () => {
    const parsed = parseInboundEmail(
      { from: "x@y.z", subject: "   ", html: "<div>Hello</div>" },
      [],
      NOW,
    );
    expect(parsed.body).toBe("Hello");
    expect(parsed.subject).toBe("(no subject)");
    expect(parsed.cleanedSubject).toBe("Inbound message");
  });

  it("keeps a supplied receivedAt and rejects an unparseable one", () => {
    expect(parseInboundEmail({ from: "a@b.c", subject: "s", receivedAt: "2026-08-01T00:00:00Z" }, [], NOW).receivedAt).toBe(
      "2026-08-01T00:00:00Z",
    );
    expect(parseInboundEmail({ from: "a@b.c", subject: "s", receivedAt: "not a date" }, [], NOW).receivedAt).toBe(NOW);
  });
});

describe("routeInbound", () => {
  const candidate = (over: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
    id: "cl_1",
    reference: "LTR-003",
    typeKey: "letter",
    threadId: "cl_1",
    status: "issued",
    responseRequired: true,
    ...over,
  });

  it("replies on the thread the subject reference names", () => {
    const decision = routeInbound({
      reference: { prefix: "LTR", number: 3, matched: "LTR-003" },
      byReference: candidate(),
      byMessageId: null,
    });
    expect(decision.action).toBe("reply");
    expect(decision.threadId).toBe("cl_1");
    expect(decision.reason).toContain("LTR-003");
  });

  it("falls back to the In-Reply-To thread", () => {
    const decision = routeInbound({
      reference: null,
      byReference: null,
      byMessageId: candidate({ id: "cl_9", threadId: "cl_2" }),
    });
    expect(decision.action).toBe("reply");
    expect(decision.threadId).toBe("cl_2");
  });

  it("captures a new letter when nothing matches", () => {
    const decision = routeInbound({ reference: null, byReference: null, byMessageId: null });
    expect(decision.action).toBe("new");
    expect(decision.target).toBeNull();
  });

  it("flags a quoted reference this project never issued", () => {
    const decision = routeInbound({
      reference: { prefix: "LTR", number: 99, matched: "LTR-099" },
      byReference: null,
      byMessageId: null,
    });
    expect(decision.action).toBe("unmatched");
    expect(decision.reason).toContain("no such record");
  });

  it("never reopens a voided letter", () => {
    const decision = routeInbound({
      reference: { prefix: "LTR", number: 3, matched: "LTR-003" },
      byReference: candidate({ status: "void" }),
      byMessageId: null,
    });
    expect(decision.action).toBe("unmatched");
    expect(decision.reason).toContain("voided");
  });
});
