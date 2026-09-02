/**
 * Inbound email → RFI parsing (spec #324). The transport (an SMTP webhook,
 * a mailbox poller, the correspondence module's inbound path) hands a
 * parsed-email JSON to `POST /projects/:id/rfis/inbound`; this file turns it
 * into RFI fields and detects replies to an existing RFI by its reference.
 *
 * It does not resolve senders to users (the route does, against the
 * company directory) and it does not fetch attachments — file ids are passed
 * through when the transport already stored them.
 */

export interface InboundEmail {
  from: string;
  to?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
  receivedAt?: string;
  attachments?: Array<{ fileId?: string; filename?: string }>;
}

export interface ParsedInboundRfi {
  subject: string;
  question: string;
  /** RFI number the message replies to, when the subject carries "RFI-012" */
  replyToNumber: number | null;
  senderEmail: string;
  senderName: string | null;
  fileIds: string[];
}

/** "Jane Doe <jane@x.com>" → { email, name }; bare addresses → name null. */
export function parseAddress(value: string): { email: string; name: string | null } {
  const m = value.trim().match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
  if (m) return { email: m[2]!.trim().toLowerCase(), name: m[1]?.trim() || null };
  return { email: value.trim().toLowerCase(), name: null };
}

/** Strip HTML to text: block elements → newlines, tags removed, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
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
  const markers = [/^On .+wrote:\s*$/m, /^-{3,}\s*Original Message\s*-{3,}/m, /^From: .+$/m, /^>+ ?/m];
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

const RFI_REF = /\bRFI[-\s#]*0*(\d{1,6})\b/i;

export function detectRfiReference(subject: string): number | null {
  const m = RFI_REF.exec(subject);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "Re: Fwd: RFI-012: Rebar spacing" → "Rebar spacing" (reference kept separately). */
export function cleanSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 5; i += 1) s = s.replace(/^(re|fwd?|aw|wg)\s*:\s*/i, "");
  s = s.replace(RFI_REF, "").replace(/^[\s:—–-]+/, "").trim();
  return s || "Inbound RFI";
}

export function parseInboundRfiEmail(email: InboundEmail): ParsedInboundRfi {
  const sender = parseAddress(email.from);
  const rawBody = email.text && email.text.trim() !== "" ? email.text : email.html ? htmlToText(email.html) : "";
  const question = stripQuotedReply(rawBody).slice(0, 20000) || "(empty message body)";
  return {
    subject: cleanSubject(email.subject).slice(0, 300),
    question,
    replyToNumber: detectRfiReference(email.subject),
    senderEmail: sender.email,
    senderName: sender.name,
    fileIds: (email.attachments ?? [])
      .map((a) => a.fileId)
      .filter((id): id is string => typeof id === "string" && id !== ""),
  };
}
