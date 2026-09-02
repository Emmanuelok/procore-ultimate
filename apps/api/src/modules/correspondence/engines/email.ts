/**
 * INBOUND EMAIL → CORRESPONDENCE (spec #99, and #446 response tracking).
 *
 * The transport (an SMTP webhook, a mailbox poller, an integration) hands
 * this module a PARSED email as JSON. Everything here is pure: address
 * parsing, HTML flattening, quoted-reply stripping, reference detection
 * against the tenant's own configured prefixes, and the routing decision.
 *
 * The routing decision is the interesting part and it is deliberately
 * conservative:
 *
 *   · a subject carrying a reference this project actually issued  → reply on
 *     that thread;
 *   · an `In-Reply-To` header matching a message we already captured → reply
 *     on the same thread;
 *   · anything else → a NEW inbound letter, flagged `unmatched` so a human
 *     can see the register did not guess.
 *
 * It never invents a sender identity: resolving an address to a user or a
 * contact is a database question the route answers, and an unresolved address
 * stays an external party with its address on the record.
 */

export interface InboundEmailInput {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  receivedAt?: string;
  attachments?: Array<{ fileId?: string | null; filename?: string | null; contentType?: string | null }>;
}

export interface ParsedAddress {
  email: string;
  name: string | null;
}

/** "Jane Doe <jane@x.com>" → { email, name }; bare addresses → name null. */
export function parseAddress(value: string): ParsedAddress {
  const trimmed = value.trim();
  const angled = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
  if (angled) {
    const email = (angled[2] ?? "").trim().toLowerCase();
    const name = (angled[1] ?? "").trim();
    return { email, name: name === "" ? null : name };
  }
  return { email: trimmed.toLowerCase(), name: null };
}

export function parseAddresses(values: readonly string[] | undefined): ParsedAddress[] {
  if (!values) return [];
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const parsed = parseAddress(raw);
    if (parsed.email === "" || seen.has(parsed.email)) continue;
    seen.add(parsed.email);
    out.push(parsed);
  }
  return out;
}

/** Strip HTML to text: block elements → newlines, tags removed, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop quoted replies below the usual "On … wrote:" / "-----Original Message-----" markers. */
export function stripQuotedReply(text: string): string {
  const markers = [
    /^On .+wrote:\s*$/m,
    /^-{3,}\s*Original Message\s*-{3,}/m,
    /^_{10,}\s*$/m,
    /^From: .+$/m,
    /^>+ ?/m,
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

export interface DetectedReference {
  prefix: string;
  number: number;
  /** the literal text that matched, e.g. "LTR-012" */
  matched: string;
}

/**
 * Find a reference this tenant could have issued. Prefixes come from the
 * project's configured correspondence types, longest first so "EOT-NOT"
 * matches before "EOT"; a bare number never counts, because "Invoice 42" is
 * not a letter reference.
 */
export function detectReference(
  subject: string,
  prefixes: readonly string[],
): DetectedReference | null {
  const ordered = [...new Set(prefixes.map((p) => p.trim()).filter((p) => p !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of ordered) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}[-\\s#]*0*(\\d{1,6})\\b`, "i");
    const m = re.exec(subject);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    return { prefix, number: n, matched: m[0] };
  }
  return null;
}

/** "Re: Fwd: LTR-012: Rebar spacing" → "Rebar spacing". */
export function cleanSubject(subject: string, matched?: string | null): string {
  let s = subject.trim();
  for (let i = 0; i < 5; i += 1) s = s.replace(/^(re|fwd?|aw|wg|tr)\s*:\s*/i, "").trim();
  if (matched) {
    const escaped = matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(escaped, "i"), "");
  }
  s = s.replace(/^[\s:—–-]+/, "").replace(/[\s:—–-]+$/, "").trim();
  return s;
}

export interface ParsedInboundEmail {
  subject: string;
  /** the subject with prefixes and the reference removed, for the letter */
  cleanedSubject: string;
  body: string;
  sender: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  reference: DetectedReference | null;
  messageId: string | null;
  inReplyTo: string | null;
  receivedAt: string;
  fileIds: string[];
  attachments: Array<{ fileId: string | null; filename: string | null; contentType: string | null }>;
}

const MAX_BODY = 100_000;

export function parseInboundEmail(
  email: InboundEmailInput,
  prefixes: readonly string[],
  now: string,
): ParsedInboundEmail {
  const sender = parseAddress(email.from);
  const rawBody =
    email.text && email.text.trim() !== ""
      ? email.text
      : email.html
        ? htmlToText(email.html)
        : "";
  const body = stripQuotedReply(rawBody).slice(0, MAX_BODY);
  const subject = (email.subject ?? "").trim();
  const reference = detectReference(subject, prefixes);
  const cleaned = cleanSubject(subject, reference?.matched ?? null);
  const attachments = (email.attachments ?? []).map((a) => ({
    fileId: typeof a.fileId === "string" && a.fileId !== "" ? a.fileId : null,
    filename: typeof a.filename === "string" && a.filename !== "" ? a.filename : null,
    contentType: typeof a.contentType === "string" && a.contentType !== "" ? a.contentType : null,
  }));
  return {
    subject: subject === "" ? "(no subject)" : subject.slice(0, 300),
    cleanedSubject: (cleaned === "" ? subject || "Inbound message" : cleaned).slice(0, 300),
    body,
    sender,
    to: parseAddresses(email.to),
    cc: parseAddresses(email.cc),
    reference,
    messageId: email.messageId?.trim() || null,
    inReplyTo: email.inReplyTo?.trim() || null,
    receivedAt: email.receivedAt && !Number.isNaN(Date.parse(email.receivedAt)) ? email.receivedAt : now,
    fileIds: attachments.map((a) => a.fileId).filter((id): id is string => id !== null),
    attachments,
  };
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

export interface RoutingCandidate {
  id: string;
  reference: string;
  typeKey: string;
  threadId: string;
  status: string;
  responseRequired: boolean;
}

export type RoutingAction = "reply" | "new" | "unmatched";

export interface RoutingDecision {
  action: RoutingAction;
  /** the letter the message answers, when one was found */
  target: RoutingCandidate | null;
  threadId: string | null;
  reason: string;
}

/**
 * Decide what an inbound message is. `byReference` is the letter whose
 * reference the subject carried (already looked up by the caller);
 * `byMessageId` is the letter whose thread the In-Reply-To header names.
 *
 * A voided letter is never a reply target: answering a withdrawn notice would
 * silently resurrect it.
 */
export function routeInbound(input: {
  reference: DetectedReference | null;
  byReference: RoutingCandidate | null;
  byMessageId: RoutingCandidate | null;
}): RoutingDecision {
  const { reference, byReference, byMessageId } = input;

  if (byReference !== null && byReference.status !== "void") {
    return {
      action: "reply",
      target: byReference,
      threadId: byReference.threadId,
      reason: `Subject quotes ${byReference.reference}, which this project issued.`,
    };
  }
  if (byReference !== null && byReference.status === "void") {
    return {
      action: "unmatched",
      target: null,
      threadId: null,
      reason: `Subject quotes ${byReference.reference}, which was voided. Captured as a new inbound letter rather than reopening a withdrawn record.`,
    };
  }
  if (byMessageId !== null && byMessageId.status !== "void") {
    return {
      action: "reply",
      target: byMessageId,
      threadId: byMessageId.threadId,
      reason: `In-Reply-To matches a message already captured against ${byMessageId.reference}.`,
    };
  }
  if (reference !== null) {
    return {
      action: "unmatched",
      target: null,
      threadId: null,
      reason: `Subject quotes ${reference.prefix}-${reference.number} but this project has no such record. Captured as a new inbound letter for a human to route.`,
    };
  }
  return {
    action: "new",
    target: null,
    threadId: null,
    reason: "No reference in the subject and no matching thread — captured as a new inbound letter.",
  };
}
