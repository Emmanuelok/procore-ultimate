import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_LIMIT,
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  buildProposal,
  checkCitations,
  minutesDraftSchema,
  proposalToMinutesBody,
  resolveOwner,
  type DraftInput,
} from "./aiminutes.js";

const TRANSCRIPT = [
  "Chair: item one, the crane sequence. Bob says the crane arrives on the fourteenth.",
  "Ann: the temporary works design is still outstanding, that has been outstanding three weeks.",
  "Chair: agreed, we proceed with sequence B and Bob will issue the revised lift plan by 2026-06-12.",
].join("\n");

function input(over: Partial<DraftInput> = {}): DraftInput {
  return {
    meeting: {
      reference: "MTG-004",
      title: "Weekly progress",
      meetingType: "progress",
      scheduledStart: "2026-06-01T09:00:00.000Z",
      occurrenceNumber: 4,
    },
    agendaItems: [
      {
        id: "mai_1",
        itemNumber: "1",
        position: 0,
        title: "Crane sequence",
        category: "programme",
        description: null,
        discussion: null,
        carryCount: 0,
        previousDiscussion: null,
        previousStatus: null,
      },
      {
        id: "mai_2",
        itemNumber: "2",
        position: 1,
        title: "Temporary works design",
        category: "design",
        description: null,
        discussion: null,
        carryCount: 3,
        previousDiscussion: "Still with the designer.",
        previousStatus: "carried_forward",
      },
    ],
    attendees: [
      { userId: "usr_bob", contactId: null, name: "Bob Builder", organisation: "Acme", attendance: "present" },
      { userId: null, contactId: "con_ann", name: "Ann Archer", organisation: "Client", attendance: "present" },
    ],
    transcript: TRANSCRIPT,
    ...over,
  };
}

describe("prompt assembly", () => {
  it("names the roll and the agenda ids the model may use", () => {
    const prompt = buildDraftUserPrompt(input());
    expect(prompt).toContain("id=mai_1");
    expect(prompt).toContain("id=mai_2");
    expect(prompt).toContain("Bob Builder (Acme) — present");
    expect(prompt).toContain("Ann Archer (Client) — present [not a platform user]");
    expect(prompt).toContain(TRANSCRIPT);
  });

  it("flags a carried item with its history so 'what changed' is answerable", () => {
    const prompt = buildDraftUserPrompt(input());
    expect(prompt).toContain("[CARRIED 3x");
    expect(prompt).toContain("Still with the designer.");
  });

  it("truncates a pathological transcript and says so in the prompt", () => {
    const long = "x".repeat(TRANSCRIPT_LIMIT + 5_000);
    const prompt = buildDraftUserPrompt(input({ transcript: long }));
    expect(prompt).toContain("TRUNCATED");
    expect(prompt.length).toBeLessThan(TRANSCRIPT_LIMIT + 4_000);
  });

  it("tells the model to leave an off-roll owner null rather than guessing", () => {
    expect(buildDraftSystemPrompt()).toContain("leave ownerName null");
  });

  it("invites transcript-anchored items when the meeting has no agenda", () => {
    const prompt = buildDraftUserPrompt(input({ agendaItems: [] }));
    expect(prompt).toContain('agendaItemId "transcript"');
  });
});

describe("checkCitations", () => {
  it("accepts an excerpt that is in the transcript, whitespace aside", () => {
    const [check] = checkCitations(
      [{ ref: "mai_1", excerpt: "the   crane arrives\non the fourteenth" }],
      TRANSCRIPT,
    );
    expect(check?.grounded).toBe(true);
  });

  it("rejects an excerpt the transcript does not contain", () => {
    const [check] = checkCitations(
      [{ ref: "mai_1", excerpt: "the crane arrives on the second" }],
      TRANSCRIPT,
    );
    expect(check?.grounded).toBe(false);
  });

  it("rejects a citation too short to mean anything", () => {
    const [check] = checkCitations([{ ref: "mai_1", excerpt: "crane" }], TRANSCRIPT);
    expect(check?.grounded).toBe(false);
  });

  it("returns nothing for an absent citation list", () => {
    expect(checkCitations(undefined, TRANSCRIPT)).toEqual([]);
  });
});

describe("resolveOwner", () => {
  const roll = input().attendees;

  it("resolves a platform user to an ownerId", () => {
    expect(resolveOwner("Bob Builder", roll)).toEqual({
      ownerId: "usr_bob",
      ownerContactId: null,
      ownerName: "Bob Builder",
      matched: true,
    });
  });

  it("resolves an external attendee to a contact, never a user", () => {
    const out = resolveOwner("  ann   archer ", roll);
    expect(out.ownerId).toBeNull();
    expect(out.ownerContactId).toBe("con_ann");
    expect(out.matched).toBe(true);
  });

  it("refuses to guess at a name the roll does not contain", () => {
    const out = resolveOwner("Bob", roll);
    expect(out.matched).toBe(false);
    expect(out.ownerId).toBeNull();
    expect(out.ownerName).toBe("Bob");
  });

  it("treats an empty name as unassigned rather than unmatched-with-a-name", () => {
    expect(resolveOwner(null, roll)).toEqual({
      ownerId: null,
      ownerContactId: null,
      ownerName: null,
      matched: false,
    });
  });
});

describe("buildProposal", () => {
  const draft = minutesDraftSchema.parse({
    summary: "Crane sequence settled; temporary works still open.",
    items: [
      {
        agendaItemId: "mai_1",
        discussion: "The crane arrives on the fourteenth.",
        citations: [{ ref: "mai_1", excerpt: "the crane arrives on the fourteenth" }],
      },
      {
        agendaItemId: "mai_2",
        discussion: "Still outstanding.",
        movedSinceLast: false,
        whatChanged: "Nothing: the design has not been issued.",
        citations: [{ ref: "mai_2", excerpt: "that has been outstanding three weeks" }],
      },
      {
        agendaItemId: "mai_ghost",
        discussion: "An item this meeting does not have.",
        citations: [{ ref: "mai_ghost", excerpt: "never said" }],
      },
    ],
    decisions: [
      {
        agendaItemId: "mai_1",
        title: "Proceed with sequence B",
        decision: "We proceed with sequence B.",
        impactsCost: true,
        citations: [{ ref: "mai_1", excerpt: "we proceed with sequence B" }],
      },
    ],
    actions: [
      {
        agendaItemId: "mai_1",
        title: "Issue the revised lift plan",
        ownerName: "Bob Builder",
        dueDate: "2026-06-12",
        citations: [{ ref: "mai_1", excerpt: "Bob will issue the revised lift plan" }],
      },
      {
        agendaItemId: "mai_1",
        title: "Chase the designer",
        ownerName: "Someone Else",
        dueDate: "next week",
      },
    ],
    confidence: 0.7,
  });

  it("counts every weakness instead of smoothing it over", () => {
    const p = buildProposal(draft, input());
    expect(p.unknownAgendaItems).toBe(1);
    expect(p.ungroundedCitations).toBe(1);
    expect(p.unmatchedOwners).toBe(1);
  });

  it("names the carried item the draft says did not move", () => {
    const p = buildProposal(draft, input());
    expect(p.stalledCarriedItems).toEqual(["2 Temporary works design"]);
  });

  it("marks an unknown agenda item rather than dropping it silently", () => {
    const p = buildProposal(draft, input());
    const ghost = p.items.find((i) => i.agendaItemId === "mai_ghost");
    expect(ghost?.known).toBe(false);
    expect(p.items.find((i) => i.agendaItemId === "mai_1")?.known).toBe(true);
  });

  it("resolves an owner on the roll and discards a non-ISO due date", () => {
    const p = buildProposal(draft, input());
    expect(p.actions[0]?.owner.ownerId).toBe("usr_bob");
    expect(p.actions[0]?.dueDate).toBe("2026-06-12");
    expect(p.actions[1]?.dueDate).toBeNull();
    expect(p.actions[1]?.owner.matched).toBe(false);
  });

  it("defaults priority rather than inventing urgency", () => {
    const p = buildProposal(draft, input());
    expect(p.actions.every((a) => a.priority === "medium")).toBe(true);
  });

  it("keeps a decision's cost impact only where the model asserted it", () => {
    const p = buildProposal(draft, input());
    expect(p.decisions[0]?.impactsCost).toBe(true);
    expect(p.decisions[0]?.impactsSchedule).toBe(false);
  });

  it("drops a decision's agenda link the meeting does not have", () => {
    const stray = minutesDraftSchema.parse({
      decisions: [{ agendaItemId: "mai_ghost", title: "T", decision: "D" }],
    });
    const p = buildProposal(stray, input());
    expect(p.decisions[0]?.agendaItemId).toBeNull();
    expect(p.unknownAgendaItems).toBe(1);
  });

  it("produces an empty proposal from an empty answer", () => {
    const p = buildProposal(minutesDraftSchema.parse({}), input());
    expect(p.items).toEqual([]);
    expect(p.decisions).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(p.confidence).toBeNull();
  });
});

describe("proposalToMinutesBody", () => {
  it("renders headings, decisions and actions a minute taker can edit", () => {
    const draft = minutesDraftSchema.parse({
      summary: "Short meeting.",
      items: [{ agendaItemId: "mai_1", discussion: "Crane on the fourteenth." }],
      decisions: [{ title: "Sequence B", decision: "Proceed." }],
      actions: [{ title: "Lift plan", ownerName: "Bob Builder", dueDate: "2026-06-12" }],
    });
    const body = proposalToMinutesBody(buildProposal(draft, input()), input());
    expect(body).toContain("Short meeting.");
    expect(body).toContain("1. Crane sequence");
    expect(body).toContain("Decisions");
    expect(body).toContain("- Sequence B: Proceed.");
    expect(body).toContain("- Lift plan — Bob Builder by 2026-06-12");
  });

  it("prints an off-roll owner WITH the fact that they are off-roll", () => {
    const draft = minutesDraftSchema.parse({
      actions: [{ title: "Chase", ownerName: "Nobody Here" }],
    });
    const body = proposalToMinutesBody(buildProposal(draft, input()), input());
    expect(body).toContain("- Chase — Nobody Here (not on the attendance roll");
  });

  it("says unassigned when the model named nobody at all", () => {
    const draft = minutesDraftSchema.parse({ actions: [{ title: "Chase" }] });
    const body = proposalToMinutesBody(buildProposal(draft, input()), input());
    expect(body).toContain("- Chase — unassigned");
  });

  it("labels a transcript-anchored item rather than pretending it has a number", () => {
    const draft = minutesDraftSchema.parse({
      items: [{ agendaItemId: "transcript", discussion: "A general point." }],
    });
    const body = proposalToMinutesBody(buildProposal(draft, input()), input());
    expect(body).toContain("General");
  });
});
