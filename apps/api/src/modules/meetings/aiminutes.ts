/**
 * AI MINUTES DRAFTING — prompt assembly and proposal parsing (spec #418-421).
 *
 * WHAT THIS IS
 * A minute taker types the same thing every week: eight headings, who said
 * what, three decisions, six actions. A transcript already contains all of
 * it. This file turns a transcript plus the meeting's own structure into a
 * PROPOSAL — discussion text per agenda item, decisions, actions with a
 * suggested owner drawn from the attendance roll, and the carried items whose
 * status did not move again — that a person then accepts item by item.
 *
 * WHY IT IS PURE
 * The prompt is the part that has to be reviewable: what the model was told,
 * what evidence it was given, and what shape its answer had to take. Keeping
 * assembly and parsing here (rather than inline in a route) means both are
 * unit-testable without a network, a database or an API key, which is the
 * only way "the citation points at a real transcript span" can be asserted
 * rather than hoped for.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  • It never issues minutes. Issuing starts a deemed-acceptance clock
 *    against real people; a machine may not start that clock.
 *  • It never invents an owner id. The model proposes a NAME from the roll and
 *    this file resolves it against the attendance — an unmatched name comes
 *    back unresolved rather than attached to whoever sounds closest.
 *  • It does not transcribe audio. The transcript is an input, not an output:
 *    speech-to-text is a different dependency and a different failure mode.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* The model the prompt is built from                                  */
/* ------------------------------------------------------------------ */

export interface DraftAttendee {
  /** platform user id, when the attendee is one */
  userId: string | null;
  contactId: string | null;
  name: string;
  organisation: string | null;
  attendance: string;
}

export interface DraftAgendaItem {
  id: string;
  itemNumber: string | null;
  position: number;
  title: string;
  category: string;
  description: string | null;
  /** what is already minuted against the item, if anything */
  discussion: string | null;
  carryCount: number;
  /** the discussion recorded against the item this one continues */
  previousDiscussion: string | null;
  previousStatus: string | null;
}

export interface DraftMeeting {
  reference: string;
  title: string;
  meetingType: string;
  scheduledStart: string | null;
  occurrenceNumber: number | null;
}

export interface DraftInput {
  meeting: DraftMeeting;
  agendaItems: readonly DraftAgendaItem[];
  attendees: readonly DraftAttendee[];
  /** the raw transcript or note text the draft must be grounded in */
  transcript: string;
}

/* ------------------------------------------------------------------ */
/* The shape the model must answer in                                  */
/* ------------------------------------------------------------------ */

const citationSchema = z.object({
  /** the agenda item id, or "transcript" for a whole-meeting citation */
  ref: z.string().max(120),
  /** the words in the transcript the claim rests on */
  excerpt: z.string().max(1200),
});

export const minutesDraftSchema = z.object({
  summary: z.string().max(4000).nullable().optional(),
  items: z
    .array(
      z.object({
        agendaItemId: z.string().max(64),
        discussion: z.string().max(20_000),
        /** did this carried item move at all since the last occurrence */
        movedSinceLast: z.boolean().nullable().optional(),
        whatChanged: z.string().max(2000).nullable().optional(),
        citations: z.array(citationSchema).max(20).optional(),
      }),
    )
    .max(200)
    .optional(),
  decisions: z
    .array(
      z.object({
        agendaItemId: z.string().max(64).nullable().optional(),
        title: z.string().max(300),
        decision: z.string().max(10_000),
        rationale: z.string().max(10_000).nullable().optional(),
        impactsCost: z.boolean().nullable().optional(),
        impactsSchedule: z.boolean().nullable().optional(),
        decidedByName: z.string().max(200).nullable().optional(),
        citations: z.array(citationSchema).max(20).optional(),
      }),
    )
    .max(100)
    .optional(),
  actions: z
    .array(
      z.object({
        agendaItemId: z.string().max(64).nullable().optional(),
        title: z.string().max(300),
        description: z.string().max(10_000).nullable().optional(),
        ownerName: z.string().max(200).nullable().optional(),
        dueDate: z.string().max(40).nullable().optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
        citations: z.array(citationSchema).max(20).optional(),
      }),
    )
    .max(200)
    .optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type MinutesDraft = z.infer<typeof minutesDraftSchema>;

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */

/** Characters of transcript fed to the model. Long enough for a two-hour
 *  progress meeting; bounded so one pathological upload cannot blow the
 *  budget the agent policy is measured against. */
export const TRANSCRIPT_LIMIT = 60_000;

export function buildDraftSystemPrompt(): string {
  return [
    "You are the ConstructOS minute taker for a construction project.",
    "You are given a meeting's agenda, its attendance roll and a transcript of what was said.",
    "Write the minutes STRICTLY from the transcript. Never invent a decision, a cost, a date or a party.",
    "Where the transcript does not cover an agenda item, omit that item rather than writing 'no discussion'.",
    "Minute what was said in reported speech, not a summary of the mood. Keep names as spoken.",
    "An ACTION is something a named person owes by a date. A DECISION is a choice the room made.",
    "Do not propose an action whose owner does not appear in the attendance roll; leave ownerName null instead.",
    "Every item, decision and action must carry at least one citation whose excerpt is copied verbatim from the transcript.",
    "A citation's ref is the agendaItemId it belongs to, or the literal string \"transcript\" for a whole-meeting point.",
    'Return ONLY JSON: {"summary","items":[{"agendaItemId","discussion","movedSinceLast","whatChanged","citations"}],"decisions":[...],"actions":[...],"confidence"}.',
    "confidence is your own 0-1 estimate that a reader comparing this to the transcript would accept it unchanged.",
  ].join("\n");
}

/** A carried item's history, so "what changed since last time" is answerable. */
function carriedContext(item: DraftAgendaItem): string {
  if (item.carryCount <= 0) return "";
  const previous = item.previousDiscussion
    ? ` Last occurrence minuted: "${item.previousDiscussion.slice(0, 600)}"`
    : " Nothing was minuted against it last time.";
  return ` [CARRIED ${item.carryCount}x — say explicitly whether it moved.${previous}]`;
}

export function buildDraftUserPrompt(input: DraftInput): string {
  const { meeting, agendaItems, attendees, transcript } = input;
  const roll = attendees.length
    ? attendees
        .map(
          (a) =>
            `- ${a.name}${a.organisation ? ` (${a.organisation})` : ""} — ${a.attendance}` +
            (a.userId ? "" : " [not a platform user]"),
        )
        .join("\n")
    : "- (no attendance recorded)";
  const agenda = agendaItems.length
    ? [...agendaItems]
        .sort((a, b) => a.position - b.position)
        .map(
          (i) =>
            `- id=${i.id} | ${i.itemNumber ?? String(i.position + 1)} ${i.title} ` +
            `(${i.category})${i.description ? ` — ${i.description.slice(0, 400)}` : ""}` +
            carriedContext(i),
        )
        .join("\n")
    : "- (no agenda items — propose items from the transcript with agendaItemId \"transcript\")";
  const truncated = transcript.length > TRANSCRIPT_LIMIT;
  return [
    `MEETING: ${meeting.reference} — ${meeting.title} (${meeting.meetingType})`,
    meeting.occurrenceNumber === null ? "" : `Occurrence: ${meeting.occurrenceNumber}`,
    meeting.scheduledStart ? `Scheduled: ${meeting.scheduledStart}` : "",
    "",
    "ATTENDANCE ROLL (the only names an action may be owed by):",
    roll,
    "",
    "AGENDA (agendaItemId must be one of these ids):",
    agenda,
    "",
    truncated
      ? `TRANSCRIPT (TRUNCATED to the first ${TRANSCRIPT_LIMIT} characters — say so in summary):`
      : "TRANSCRIPT:",
    transcript.slice(0, TRANSCRIPT_LIMIT),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Proposal resolution                                                 */
/* ------------------------------------------------------------------ */

export interface ResolvedOwner {
  ownerId: string | null;
  ownerContactId: string | null;
  ownerName: string | null;
  /** false when the model named somebody the roll does not contain */
  matched: boolean;
}

/**
 * Resolve a proposed owner NAME against the attendance roll.
 *
 * Exact (case- and space-insensitive) match only. A fuzzy match here would
 * silently assign an action to the wrong person, and an action assigned to
 * the wrong person is worse than an unassigned one: it looks owned.
 */
export function resolveOwner(
  name: string | null | undefined,
  attendees: readonly DraftAttendee[],
): ResolvedOwner {
  const wanted = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!wanted) return { ownerId: null, ownerContactId: null, ownerName: null, matched: false };
  const hit = attendees.find(
    (a) => a.name.trim().toLowerCase().replace(/\s+/g, " ") === wanted,
  );
  if (!hit) {
    return { ownerId: null, ownerContactId: null, ownerName: name ?? null, matched: false };
  }
  return {
    ownerId: hit.userId,
    ownerContactId: hit.userId ? null : hit.contactId,
    ownerName: hit.name,
    matched: true,
  };
}

export interface CitationCheck {
  ref: string;
  excerpt: string;
  /** does the excerpt actually appear in the transcript */
  grounded: boolean;
}

/**
 * Check every citation against the transcript it claims to quote.
 *
 * Whitespace is normalised (a transcript arrives with line breaks wherever
 * the recorder put them) but nothing else is: a citation that is not in the
 * transcript is reported as ungrounded and the caller shows it as such. This
 * is the difference between a cited draft and a draft with citation-shaped
 * decoration on it.
 */
export function checkCitations(
  citations: ReadonlyArray<{ ref: string; excerpt: string }> | undefined,
  transcript: string,
): CitationCheck[] {
  if (!citations || citations.length === 0) return [];
  const haystack = transcript.replace(/\s+/g, " ").toLowerCase();
  return citations.map((c) => {
    const needle = c.excerpt.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      ref: c.ref,
      excerpt: c.excerpt,
      grounded: needle.length >= 8 && haystack.includes(needle),
    };
  });
}

export interface ProposalItem {
  agendaItemId: string;
  known: boolean;
  title: string | null;
  discussion: string;
  movedSinceLast: boolean | null;
  whatChanged: string | null;
  carryCount: number;
  citations: CitationCheck[];
}

export interface ProposalDecision {
  agendaItemId: string | null;
  title: string;
  decision: string;
  rationale: string | null;
  impactsCost: boolean;
  impactsSchedule: boolean;
  decidedByName: string | null;
  citations: CitationCheck[];
}

export interface ProposalAction {
  agendaItemId: string | null;
  title: string;
  description: string | null;
  owner: ResolvedOwner;
  dueDate: string | null;
  priority: "low" | "medium" | "high" | "critical";
  citations: CitationCheck[];
}

export interface MinutesProposal {
  summary: string | null;
  items: ProposalItem[];
  decisions: ProposalDecision[];
  actions: ProposalAction[];
  confidence: number | null;
  /** every citation the transcript does not actually contain */
  ungroundedCitations: number;
  /** items the model proposed against an agenda id this meeting does not have */
  unknownAgendaItems: number;
  /** actions whose proposed owner is not on the attendance roll */
  unmatchedOwners: number;
  /** carried items the draft says did not move — the sentence that matters */
  stalledCarriedItems: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turn the model's JSON into a proposal a person can accept item by item,
 * with every weakness counted rather than smoothed over.
 */
export function buildProposal(draft: MinutesDraft, input: DraftInput): MinutesProposal {
  const byId = new Map(input.agendaItems.map((i) => [i.id, i]));
  let ungrounded = 0;
  let unknown = 0;
  let unmatched = 0;
  const stalled: string[] = [];

  const tally = (checks: CitationCheck[]) => {
    ungrounded += checks.filter((c) => !c.grounded).length;
    return checks;
  };

  const items: ProposalItem[] = (draft.items ?? []).map((raw) => {
    const known = byId.get(raw.agendaItemId);
    if (!known) unknown += 1;
    const moved = raw.movedSinceLast ?? null;
    if (known && known.carryCount > 0 && moved === false) {
      stalled.push(known.itemNumber ? `${known.itemNumber} ${known.title}` : known.title);
    }
    return {
      agendaItemId: raw.agendaItemId,
      known: Boolean(known),
      title: known?.title ?? null,
      discussion: raw.discussion,
      movedSinceLast: moved,
      whatChanged: raw.whatChanged ?? null,
      carryCount: known?.carryCount ?? 0,
      citations: tally(checkCitations(raw.citations, input.transcript)),
    };
  });

  const decisions: ProposalDecision[] = (draft.decisions ?? []).map((raw) => {
    const linked = raw.agendaItemId && byId.has(raw.agendaItemId) ? raw.agendaItemId : null;
    if (raw.agendaItemId && !linked) unknown += 1;
    return {
      agendaItemId: linked,
      title: raw.title,
      decision: raw.decision,
      rationale: raw.rationale ?? null,
      impactsCost: raw.impactsCost === true,
      impactsSchedule: raw.impactsSchedule === true,
      decidedByName: raw.decidedByName ?? null,
      citations: tally(checkCitations(raw.citations, input.transcript)),
    };
  });

  const actions: ProposalAction[] = (draft.actions ?? []).map((raw) => {
    const linked = raw.agendaItemId && byId.has(raw.agendaItemId) ? raw.agendaItemId : null;
    if (raw.agendaItemId && !linked) unknown += 1;
    const owner = resolveOwner(raw.ownerName, input.attendees);
    if (!owner.matched) unmatched += 1;
    const due = raw.dueDate && ISO_DATE.test(raw.dueDate) ? raw.dueDate : null;
    return {
      agendaItemId: linked,
      title: raw.title,
      description: raw.description ?? null,
      owner,
      dueDate: due,
      priority: raw.priority ?? "medium",
      citations: tally(checkCitations(raw.citations, input.transcript)),
    };
  });

  return {
    summary: draft.summary ?? null,
    items,
    decisions,
    actions,
    confidence: draft.confidence ?? null,
    ungroundedCitations: ungrounded,
    unknownAgendaItems: unknown,
    unmatchedOwners: unmatched,
    stalledCarriedItems: stalled,
  };
}

/**
 * The minutes body a minute taker starts from, assembled from the accepted
 * items. Plain markdown-ish text, because that is what `minutesBody` is and
 * the renderer escapes it: this is a starting draft, not a document.
 */
export function proposalToMinutesBody(
  proposal: MinutesProposal,
  input: DraftInput,
): string {
  const byId = new Map(input.agendaItems.map((i) => [i.id, i]));
  const lines: string[] = [];
  if (proposal.summary) lines.push(proposal.summary, "");
  for (const item of proposal.items) {
    const known = byId.get(item.agendaItemId);
    const heading = known
      ? `${known.itemNumber ?? String(known.position + 1)}. ${known.title}`
      : item.agendaItemId === "transcript"
        ? "General"
        : `(unmatched agenda item ${item.agendaItemId})`;
    lines.push(heading, item.discussion, "");
    if (item.whatChanged) lines.push(`Change since last occurrence: ${item.whatChanged}`, "");
  }
  if (proposal.decisions.length > 0) {
    lines.push("Decisions", "");
    for (const d of proposal.decisions) lines.push(`- ${d.title}: ${d.decision}`);
    lines.push("");
  }
  if (proposal.actions.length > 0) {
    lines.push("Actions", "");
    for (const a of proposal.actions) {
      /* An unmatched name is printed WITH the fact that it is unmatched. A
         draft that reads "— J Smith" when no J Smith was in the room hands the
         minute taker a name the roll cannot support, which is how an action
         ends up owed by nobody while looking owned. */
      const owner = a.owner.matched
        ? (a.owner.ownerName ?? "unassigned")
        : a.owner.ownerName
          ? `${a.owner.ownerName} (not on the attendance roll — confirm before issuing)`
          : "unassigned";
      lines.push(`- ${a.title} — ${owner}${a.dueDate ? ` by ${a.dueDate}` : ""}`);
    }
  }
  return lines.join("\n").trimEnd();
}
