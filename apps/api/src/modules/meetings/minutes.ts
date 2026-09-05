/**
 * THE MINUTES AS A DOCUMENT (spec Vol I #422, #425).
 *
 * Deemed acceptance is the sharpest rule in this module: after the objection
 * period, silence becomes agreement. Before this file the platform held the
 * minutes only as a text column and started that clock the moment the sender
 * pressed "issue" — a record which, challenged, could prove neither what was
 * sent nor that it arrived.
 *
 * This is a pure renderer. Given the meeting and its parts it produces a
 * self-contained HTML document (no external assets, so it prints and archives
 * identically in ten years) whose bytes are then content-addressed by
 * app.storage: the sha256 recorded on the meeting and in the ledger is what
 * makes "these are the minutes that were issued" checkable later, when the
 * body text in the database has been corrected twice.
 *
 * It renders TWO documents from one model:
 *   • the AGENDA PACK, issued before the meeting (items, allocations, the
 *     carried-forward tail with its carry counts, open actions due);
 *   • the MINUTES, issued after (attendance and the quorum result, discussion
 *     per item, decisions with impacts and ratification state, actions with
 *     owner/date/carry count, and the objection-period wording).
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not produce a PDF. A PDF engine is a large dependency for a
 * marginal gain here: this HTML prints to PDF from any browser, is
 * diff-able, and — unlike a binary — a reviewer can read the bytes the hash
 * was taken over. `contentType` is therefore text/html and honest about it.
 */

/* ------------------------------------------------------------------ */
/* The model the renderer needs (structural, not drizzle rows)         */
/* ------------------------------------------------------------------ */

export interface MinutesMeeting {
  reference: string;
  title: string;
  meetingType: string;
  status: string;
  occurrenceNumber: number | null;
  scheduledStart: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  location: string | null;
  isVirtual: number;
  chairName: string | null;
  minuteTakerName: string | null;
  quorumRequired: number | null;
  minutesBody: string | null;
  objectionPeriodDays: number | null;
  minutesVersion: number;
}

export interface MinutesAttendee {
  name: string;
  organisation: string | null;
  role: string;
  attendance: string;
  delegateName: string | null;
}

export interface MinutesAgendaItem {
  itemNumber: string | null;
  position: number;
  title: string;
  category: string;
  status: string;
  description: string | null;
  discussion: string | null;
  carryCount: number;
  allocatedMinutes: number | null;
  presenterName: string | null;
  linkLabel: string | null;
}

export interface MinutesDecision {
  reference: string;
  title: string;
  decision: string;
  rationale: string | null;
  decidedByName: string | null;
  status: string;
  ratifiedByName: string | null;
  impactsCost: number;
  estimatedCostImpact: number | null;
  currency: string | null;
  impactsSchedule: number;
  estimatedScheduleImpactDays: number | null;
}

export interface MinutesAction {
  reference: string;
  title: string;
  ownerLabel: string;
  dueDate: string | null;
  originalDueDate: string | null;
  status: string;
  priority: string;
  carryCount: number;
  revisedCount: number;
  obligationId: string | null;
  sourceClause: string | null;
}

export interface QuorumResult {
  met: boolean | null;
  required: number | null;
  counted: number;
  reasons: string[];
}

export interface MinutesModel {
  kind: "agenda_pack" | "minutes";
  projectName: string | null;
  companyName: string | null;
  seriesTitle: string | null;
  meeting: MinutesMeeting;
  attendees: MinutesAttendee[];
  agendaItems: MinutesAgendaItem[];
  decisions: MinutesDecision[];
  actions: MinutesAction[];
  quorum: QuorumResult;
  /** ISO instant the document was rendered — part of the hashed bytes */
  renderedAt: string;
  renderedByName: string | null;
  /** distribution list as displayed on the document */
  recipients: string[];
}

/* ------------------------------------------------------------------ */
/* Escaping and small formatters                                       */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Multi-line free text: escaped, then newlines become paragraph breaks. */
export function escBlock(value: string | null | undefined): string {
  if (!value) return "";
  return esc(value)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Money on a rendered document. A figure with no currency is NOT printed as a
 * bare number — the reader would supply a currency from context and be wrong.
 */
export function money(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return "not recorded";
  if (!currency) return `${amount.toLocaleString("en-GB")} (currency not recorded)`;
  return `${currency} ${amount.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return esc(value);
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/* ------------------------------------------------------------------ */
/* Attendance and quorum                                               */
/* ------------------------------------------------------------------ */

const PRESENT_STATES = new Set(["present", "delegate_attended", "late", "left_early"]);

export function attendanceSummary(attendees: readonly MinutesAttendee[]): {
  present: number;
  absent: number;
  apologies: number;
  total: number;
} {
  let present = 0;
  let apologies = 0;
  let absent = 0;
  for (const a of attendees) {
    if (PRESENT_STATES.has(a.attendance)) present += 1;
    else if (a.attendance === "apologies") apologies += 1;
    else absent += 1;
  }
  return { present, absent, apologies, total: attendees.length };
}

/**
 * The wording that makes the objection period mean something. Rendered onto
 * the document itself, because a deeming provision the recipient never saw is
 * one no tribunal will apply.
 */
export function objectionWording(days: number | null): string {
  if (days === null || days === undefined) {
    return (
      "No objection period is recorded for these minutes. They are a record of what the " +
      "minute taker heard, and nothing in them is deemed accepted by anyone by the passage " +
      "of time alone."
    );
  }
  if (days === 0) {
    return (
      "These minutes are issued with a zero-day objection period: they take effect as the " +
      "record on delivery. Any correction must be raised as a new agenda item at the next " +
      "occurrence."
    );
  }
  return (
    `Objections to these minutes must be raised within ${days} day${days === 1 ? "" : "s"} of ` +
    "delivery, through the platform or in writing to the minute taker. An objection raised " +
    "in time suspends acceptance of the item it concerns until it is settled. After that " +
    "period, items not objected to are taken as an accurate record — which is why the date " +
    "of delivery, and not the date of issue, is the date printed below."
  );
}

/* ------------------------------------------------------------------ */
/* The renderer                                                        */
/* ------------------------------------------------------------------ */

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #14181f; background: #fff; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; text-transform: uppercase;
       letter-spacing: .06em; color: #4a5464; border-bottom: 1px solid #d8dee7; padding-bottom: 4px; }
  h3 { font-size: 13px; margin: 16px 0 4px; }
  p { margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; }
  th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e6eaf0; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5a6675; background: #f6f8fb; }
  .meta { color: #5a6675; font-size: 12px; }
  .meta strong { color: #14181f; }
  .kv { display: grid; grid-template-columns: 170px 1fr; gap: 2px 12px; margin: 12px 0 0; font-size: 12px; }
  .kv dt { color: #5a6675; }
  .kv dd { margin: 0; }
  .flag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px;
          background: #eef1f6; color: #35405020; color: #354050; }
  .flag-warn { background: #fdf0e3; color: #8a4b09; }
  .flag-bad { background: #fdeaea; color: #8d1f1f; }
  .flag-ok { background: #e8f4ec; color: #1c6b3a; }
  .note { border-left: 3px solid #c9d2de; padding: 6px 0 6px 12px; color: #4a5464; margin: 10px 0; }
  .foot { margin-top: 32px; padding-top: 10px; border-top: 1px solid #d8dee7;
          color: #6b7686; font-size: 11px; }
  .discussion { margin: 4px 0 0; }
`;

function flag(text: string, tone: "ok" | "warn" | "bad" | "plain" = "plain"): string {
  const cls = tone === "plain" ? "flag" : `flag flag-${tone}`;
  return `<span class="${cls}">${esc(text)}</span>`;
}

function renderTitleBlock(m: MinutesModel): string {
  const heading = m.kind === "minutes" ? "Minutes" : "Agenda pack";
  const occ = m.meeting.occurrenceNumber ? ` — occurrence ${m.meeting.occurrenceNumber}` : "";
  return `
    <h1>${esc(heading)}: ${esc(m.meeting.title)}</h1>
    <div class="meta">
      <strong>${esc(m.meeting.reference)}</strong>${esc(occ)}
      · ${esc(titleCase(m.meeting.meetingType))}
      ${m.seriesTitle ? `· series “${esc(m.seriesTitle)}”` : ""}
      ${m.projectName ? `· ${esc(m.projectName)}` : ""}
      ${m.companyName ? `· ${esc(m.companyName)}` : ""}
    </div>
    <dl class="kv">
      <dt>Scheduled</dt><dd>${dateTime(m.meeting.scheduledStart)}</dd>
      ${
        m.kind === "minutes"
          ? `<dt>Held</dt><dd>${dateTime(m.meeting.actualStart)}${
              m.meeting.actualEnd ? ` to ${dateTime(m.meeting.actualEnd)}` : ""
            }</dd>`
          : ""
      }
      <dt>Location</dt><dd>${
        m.meeting.isVirtual === 1
          ? "Virtual"
          : esc(m.meeting.location ?? "not recorded")
      }</dd>
      <dt>Chair</dt><dd>${esc(m.meeting.chairName ?? "not recorded")}</dd>
      <dt>Minute taker</dt><dd>${esc(m.meeting.minuteTakerName ?? "not recorded")}</dd>
      <dt>Document version</dt><dd>${esc(String(m.meeting.minutesVersion))}</dd>
      <dt>Rendered</dt><dd>${dateTime(m.renderedAt)}${
        m.renderedByName ? ` by ${esc(m.renderedByName)}` : ""
      }</dd>
    </dl>`;
}

function renderAttendance(m: MinutesModel): string {
  const s = attendanceSummary(m.attendees);
  const q = m.quorum;
  const verdict =
    q.met === null
      ? flag("Quorum not assessable", "warn")
      : q.met
        ? flag(`Quorum met (${q.counted} of ${q.required} required)`, "ok")
        : flag(`Quorum NOT met (${q.counted} of ${q.required} required)`, "bad");
  const rows = m.attendees.length
    ? m.attendees
        .map(
          (a) => `<tr>
            <td>${esc(a.name)}${a.delegateName ? ` <span class="meta">(delegate: ${esc(a.delegateName)})</span>` : ""}</td>
            <td>${esc(a.organisation ?? "—")}</td>
            <td>${esc(titleCase(a.role))}</td>
            <td>${esc(titleCase(a.attendance))}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="meta">No attendees are recorded on this meeting.</td></tr>`;
  return `
    <h2>Attendance</h2>
    <p class="meta">${s.present} present · ${s.apologies} apologies · ${s.absent} absent · ${verdict}</p>
    ${q.reasons.length ? `<div class="note">${q.reasons.map((r) => esc(r)).join("<br/>")}</div>` : ""}
    <table><thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Attendance</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function renderAgenda(m: MinutesModel): string {
  if (m.agendaItems.length === 0) {
    return `<h2>Agenda</h2><p class="meta">No agenda items are recorded on this meeting.</p>`;
  }
  const body = m.agendaItems
    .map((i) => {
      const carried =
        i.carryCount > 0
          ? ` ${flag(`carried ${i.carryCount}×`, i.carryCount >= 3 ? "bad" : "warn")}`
          : "";
      const alloc = i.allocatedMinutes != null ? ` · ${i.allocatedMinutes} min` : "";
      const link = i.linkLabel ? ` · ${esc(i.linkLabel)}` : "";
      const discussion =
        m.kind === "minutes"
          ? i.discussion
            ? `<div class="discussion">${escBlock(i.discussion)}</div>`
            : `<p class="meta">No discussion was recorded against this item.</p>`
          : i.description
            ? `<div class="discussion">${escBlock(i.description)}</div>`
            : "";
      return `
        <h3>${esc(i.itemNumber ?? String(i.position + 1))}. ${esc(i.title)}${carried}</h3>
        <div class="meta">${esc(titleCase(i.category))} · ${esc(titleCase(i.status))}${esc(alloc)}${
          i.presenterName ? ` · presented by ${esc(i.presenterName)}` : ""
        }${link}</div>
        ${discussion}`;
    })
    .join("");
  return `<h2>${m.kind === "minutes" ? "Items and discussion" : "Agenda"}</h2>${body}`;
}

function renderDecisions(m: MinutesModel): string {
  if (m.kind !== "minutes") return "";
  if (m.decisions.length === 0) {
    return `<h2>Decisions</h2><p class="meta">No decisions were recorded at this meeting.</p>`;
  }
  const rows = m.decisions
    .map((d) => {
      const cost =
        d.impactsCost === 1
          ? d.estimatedCostImpact != null
            ? money(d.estimatedCostImpact, d.currency)
            : "flagged as cost-impacting, no estimate recorded"
          : "none flagged";
      const time =
        d.impactsSchedule === 1
          ? d.estimatedScheduleImpactDays != null
            ? `${d.estimatedScheduleImpactDays} day(s)`
            : "flagged as schedule-impacting, no estimate recorded"
          : "none flagged";
      const ratified =
        d.status === "ratified"
          ? flag(`ratified by ${d.ratifiedByName ?? "recorded user"}`, "ok")
          : flag(titleCase(d.status), d.status === "disputed" ? "bad" : "warn");
      return `<tr>
        <td>${esc(d.reference)}</td>
        <td><strong>${esc(d.title)}</strong><br/>${escBlock(d.decision)}${
          d.rationale ? `<div class="meta">Rationale: ${esc(d.rationale)}</div>` : ""
        }</td>
        <td>${esc(d.decidedByName ?? "not recorded")}</td>
        <td>${ratified}</td>
        <td>${esc(cost)}<br/><span class="meta">${esc(time)}</span></td>
      </tr>`;
    })
    .join("");
  return `
    <h2>Decisions</h2>
    <table><thead><tr><th>Ref</th><th>Decision</th><th>Decided by</th><th>State</th><th>Impact</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="meta">A decision is ratified by someone other than the person who made it. An
    unratified decision is a record of what was said, not an authorisation.</p>`;
}

function renderActions(m: MinutesModel): string {
  if (m.actions.length === 0) {
    return `<h2>Actions</h2><p class="meta">No action items are attached to this meeting.</p>`;
  }
  const rows = m.actions
    .map((a) => {
      const slipped =
        a.originalDueDate && a.originalDueDate !== a.dueDate
          ? ` ${flag(`re-dated ${a.revisedCount}× from ${a.originalDueDate}`, "warn")}`
          : "";
      const carried = a.carryCount > 0 ? ` ${flag(`carried ${a.carryCount}×`, "warn")}` : "";
      const promoted = a.obligationId
        ? ` ${flag(`obligation${a.sourceClause ? ` — ${a.sourceClause}` : ""}`, "ok")}`
        : "";
      return `<tr>
        <td>${esc(a.reference)}</td>
        <td>${esc(a.title)}${promoted}</td>
        <td>${esc(a.ownerLabel)}</td>
        <td>${esc(a.dueDate ?? "no date")}${slipped}</td>
        <td>${esc(titleCase(a.status))} · ${esc(titleCase(a.priority))}${carried}</td>
      </tr>`;
    })
    .join("");
  return `
    <h2>Actions</h2>
    <table><thead><tr><th>Ref</th><th>Action</th><th>Owner</th><th>Due</th><th>State</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/**
 * Render the document. Deterministic given the model: the only varying input
 * is `renderedAt`, which the caller supplies, so a test can hash the output.
 */
export function renderMeetingDocument(m: MinutesModel): { html: string; contentType: string } {
  const parts = [
    renderTitleBlock(m),
    renderAttendance(m),
    renderAgenda(m),
    renderDecisions(m),
    renderActions(m),
  ];
  if (m.kind === "minutes" && m.meeting.minutesBody) {
    parts.push(`<h2>Minutes as authored</h2>${escBlock(m.meeting.minutesBody)}`);
  }
  if (m.kind === "minutes") {
    parts.push(
      `<h2>Objection period</h2><div class="note">${esc(
        objectionWording(m.meeting.objectionPeriodDays),
      )}</div>`,
    );
  }
  parts.push(
    `<div class="foot">Distribution: ${
      m.recipients.length ? esc(m.recipients.join(", ")) : "nobody is listed on this meeting"
    }.<br/>Generated by ConstructOS. The sha256 of this file is recorded on the meeting and in the
    hash-chained ledger; any later copy that differs in a single byte will not match it.</div>`,
  );
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(m.meeting.reference)} ${m.kind === "minutes" ? "minutes" : "agenda"} — ${esc(
    m.meeting.title,
  )}</title>
<style>${STYLE}</style></head>
<body>${parts.filter(Boolean).join("\n")}</body></html>`;
  return { html, contentType: "text/html" };
}

/* ------------------------------------------------------------------ */
/* The objection window, measured from DELIVERY                        */
/* ------------------------------------------------------------------ */

export interface ObjectionWindowInput {
  minutesIssuedAt: string | null;
  minutesDeliveredAt: string | null;
  objectionPeriodDays: number | null;
  approvedAt: string | null;
  objections: ReadonlyArray<{ resolvedAt?: unknown }>;
  nowMs: number;
}

export interface ObjectionWindow {
  closesAt: string | null;
  expired: boolean | null;
  /** which timestamp the clock actually ran from */
  runsFrom: "delivery" | "issue" | null;
  objections: number;
  openObjections: number;
  deemedAccepted: boolean | null;
  reasons: string[];
}

/**
 * The clock runs from DELIVERY when a delivery is recorded, and falls back to
 * ISSUE when it is not — saying so in `reasons` either way. Issuing is an act
 * of the sender; only delivery is a fact about the recipient, and deeming
 * acceptance against someone who never received the document is the one thing
 * this window must never do silently.
 */
export function computeObjectionWindow(input: ObjectionWindowInput): ObjectionWindow {
  const openObjections = input.objections.filter((o) => o.resolvedAt == null).length;
  if (!input.minutesIssuedAt || input.objectionPeriodDays == null) {
    return {
      closesAt: null,
      expired: null,
      runsFrom: null,
      objections: input.objections.length,
      openObjections,
      deemedAccepted: null,
      reasons: [
        input.minutesIssuedAt
          ? "No objection period is recorded on this meeting, so nothing is deemed accepted."
          : "Minutes have not been issued, so no objection period is running.",
      ],
    };
  }
  const from = input.minutesDeliveredAt ?? input.minutesIssuedAt;
  const runsFrom: "delivery" | "issue" = input.minutesDeliveredAt ? "delivery" : "issue";
  const base = Date.parse(from);
  if (Number.isNaN(base)) {
    return {
      closesAt: null,
      expired: null,
      runsFrom: null,
      objections: input.objections.length,
      openObjections,
      deemedAccepted: null,
      reasons: [`The recorded ${runsFrom} timestamp "${from}" is not a valid instant.`],
    };
  }
  const closesAt = new Date(base + input.objectionPeriodDays * 86_400_000).toISOString();
  const expired = input.nowMs > Date.parse(closesAt);
  return {
    closesAt,
    expired,
    runsFrom,
    objections: input.objections.length,
    openObjections,
    /*
     * "Deemed accepted" is REPORTED, never written: the status stays
     * minutes_issued until a human signs the minutes off. Silence has legal
     * weight, but it is not a signature and the record must not pretend it is.
     */
    deemedAccepted: expired && openObjections === 0 && input.approvedAt == null,
    reasons:
      runsFrom === "issue"
        ? [
            "No delivery of these minutes has been recorded, so the period is measured from " +
              "issue. A recipient who can show they never received them can displace that.",
          ]
        : [],
  };
}
