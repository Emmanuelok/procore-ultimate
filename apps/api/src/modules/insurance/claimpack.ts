/**
 * THE CLAIM DOCUMENTATION PACK (spec #784, #785).
 *
 * WHY IT EXISTS
 * An insurer decides a claim on the pack it was given, not on what the
 * platform holds. Before this file the claim's evidence was a JSON array of
 * record references: readable by the person who typed it, traversable by
 * nothing, and impossible to hand to an adjuster. Worse, when the adjuster
 * later said "we never received the daily logs", there was no record of what
 * was actually sent.
 *
 * The pack is therefore ONE document, content-addressed: an index of every
 * linked record with its reference, date and one-line description, the
 * notification chronology (incident → awareness → deadline → notification),
 * the policy terms the claim is tested against, and the adjuster's
 * outstanding requests. The sha256 of those bytes goes on the claim and into
 * the hash-chained ledger, so "this is the pack that was submitted" survives
 * a later disagreement.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  • It does not bundle the underlying FILES into a ZIP. The evidence lives
 *    in the file register under its own hashes; duplicating megabytes into a
 *    second content-addressed object would double the storage to say the same
 *    thing twice. The index names each file's id and hash, which is what a
 *    recipient needs in order to ask for it and to check it.
 *  • It does not produce a PDF, for the reason `minutes.ts` gives: this HTML
 *    prints, diffs and archives, and a reviewer can read the bytes the hash
 *    was taken over.
 *  • It never asserts cover. Whether the policy responds is the insurer's
 *    decision; the pack states the dates and the terms and stops there.
 */

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export interface PackClaim {
  number: string;
  title: string;
  description: string | null;
  incidentDate: string;
  awareDate: string;
  notifiedAt: string | null;
  notificationDueAt: string | null;
  status: string;
  quantum: number | null;
  reserve: number | null;
  settledAmount: number | null;
  currency: string;
  insurerRef: string | null;
  lossAdjuster: string | null;
}

export interface PackPolicy {
  number: string;
  policyType: string;
  insurer: string;
  policyNumber: string;
  periodStart: string;
  periodEnd: string;
  notificationDays: number | null;
  limitOfIndemnity: number | null;
  limitBasis: string | null;
  deductible: number | null;
  currency: string;
  territorialLimits: string | null;
}

export interface PackItem {
  recordType: string;
  recordId: string;
  reference: string | null;
  title: string | null;
  occurredAt: string | null;
  note: string | null;
  /**
   * `resolved` — looked up and found in this company/project.
   * `not_found` — looked up and missing: deleted, or another tenant's id.
   * `not_resolvable` — a record type this module cannot look up, listed
   *   verbatim. Deliberately distinct from `not_found`: "we could not check"
   *   and "we checked and it is gone" are different answers and only the
   *   second is a hole in the claim.
   */
  resolution: "resolved" | "not_found" | "not_resolvable";
  fileId?: string | null;
  sha256?: string | null;
}

export interface PackRequest {
  kind: string;
  title: string;
  requestedBy: string | null;
  dueDate: string | null;
  status: string;
  respondedAt: string | null;
  overdue: boolean;
}

export interface ClaimPackModel {
  companyName: string;
  projectName: string | null;
  claim: PackClaim;
  policy: PackPolicy | null;
  items: readonly PackItem[];
  requests: readonly PackRequest[];
  generatedAt: string;
  generatedByName: string | null;
  /** honest statements about what the pack could NOT establish */
  gaps: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Money with its currency, or an honest dash — never a bare 0. */
export function money(amount: number | null | undefined, currency: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  const formatted = amount.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency ?? ""} ${formatted}`.trim();
}

const DAY = 86_400_000;

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY);
}

export interface Chronology {
  lines: Array<{ label: string; value: string; note: string | null }>;
  /** null when the deadline or the notification is unknown */
  onTime: boolean | null;
  verdict: string;
}

/**
 * The chronology an adjuster reads first: when it happened, when the insured
 * knew, when notice was due, when notice was given. Every gap is stated as a
 * gap rather than filled with an assumption.
 */
export function buildChronology(claim: PackClaim, policy: PackPolicy | null): Chronology {
  const lines: Chronology["lines"] = [
    { label: "Incident date", value: claim.incidentDate, note: null },
    {
      label: "Date the insured became aware",
      value: claim.awareDate,
      note: (() => {
        const d = daysBetween(claim.incidentDate, claim.awareDate);
        return d === null ? null : `${d} day(s) after the incident`;
      })(),
    },
  ];
  lines.push({
    label: "Notification due",
    value: claim.notificationDueAt ?? "not established",
    note:
      claim.notificationDueAt === null
        ? policy && policy.notificationDays === null
          ? "The policy records no notification period, so no deadline can be computed. This is a gap in the policy record, not evidence that none applies."
          : "No deadline recorded."
        : `${policy?.notificationDays ?? "?"} day(s) from awareness`,
  });
  lines.push({
    label: "Notified to insurer",
    value: claim.notifiedAt ?? "not yet notified",
    note: claim.notifiedAt === null ? "The clock is still running." : null,
  });

  if (!claim.notificationDueAt || !claim.notifiedAt) {
    return {
      lines,
      onTime: null,
      verdict:
        "Timeliness cannot be established from this record: " +
        (!claim.notificationDueAt
          ? "no notification deadline is recorded."
          : "no notification has been recorded."),
    };
  }
  const late = claim.notifiedAt > claim.notificationDueAt;
  const slack = daysBetween(claim.notifiedAt, claim.notificationDueAt);
  return {
    lines,
    onTime: !late,
    verdict: late
      ? `Notification was given on ${claim.notifiedAt}, AFTER the deadline of ${claim.notificationDueAt}. ` +
        "Notification within the policy period is a condition precedent to liability in most wordings."
      : `Notification was given on ${claim.notifiedAt}, ${slack ?? 0} day(s) inside the deadline of ${claim.notificationDueAt}.`,
  };
}

/**
 * Everything the pack cannot establish, said out loud. A pack that reads as
 * complete when it is not is worse than no pack: it invites the claim to be
 * submitted with a hole in it.
 */
export function packGaps(model: Omit<ClaimPackModel, "gaps">): string[] {
  const gaps: string[] = [];
  if (!model.policy) {
    gaps.push(
      "The policy this claim is made under could not be read from this project, so the terms it is tested against are not stated here.",
    );
  } else if (model.policy.notificationDays === null) {
    gaps.push(
      `Policy ${model.policy.number} records no notification period, so no deadline could be computed and none is asserted.`,
    );
  }
  if (model.items.length === 0) {
    gaps.push(
      "No evidence records are linked to this claim. An adjuster reading this pack has been given the claim's dates and nothing to test them against.",
    );
  }
  const missing = model.items.filter((i) => i.resolution === "not_found");
  if (missing.length > 0) {
    gaps.push(
      `${missing.length} linked record(s) could not be found in this project and are listed by id only — they may have been deleted, or belong elsewhere.`,
    );
  }
  const unchecked = model.items.filter((i) => i.resolution === "not_resolvable");
  if (unchecked.length > 0) {
    gaps.push(
      `${unchecked.length} linked record(s) are of a type this module cannot look up, so their reference and date are not stated and have not been checked.`,
    );
  }
  const overdue = model.requests.filter((r) => r.overdue);
  if (overdue.length > 0) {
    gaps.push(
      `${overdue.length} information request(s) from the adjuster are past their date and unanswered. A claim is more often lost on an unanswered request than on its merits.`,
    );
  }
  if (model.claim.notifiedAt === null) {
    gaps.push(
      "This claim has not been notified to the insurer. The pack is an assembly of what exists, not a notice.",
    );
  }
  return gaps;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;margin:0;padding:28px;background:#fff}
h1{font-size:18px;margin:0 0 2px}
h2{font-size:13px;margin:22px 0 6px;padding-bottom:3px;border-bottom:1px solid #ccc;text-transform:uppercase;letter-spacing:.04em}
.sub{color:#555;margin:0 0 14px}
table{border-collapse:collapse;width:100%;margin:0 0 8px}
th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}
th{background:#f4f4f4;font-weight:600}
.meta td:first-child{width:220px;font-weight:600;background:#fafafa}
.gap{border-left:3px solid #b45309;background:#fffbeb;padding:8px 10px;margin:6px 0}
.late{border-left:3px solid #b91c1c;background:#fef2f2;padding:8px 10px;margin:6px 0}
.ok{border-left:3px solid #15803d;background:#f0fdf4;padding:8px 10px;margin:6px 0}
.small{color:#666;font-size:11px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
footer{margin-top:26px;padding-top:8px;border-top:1px solid #ccc;color:#666;font-size:11px}
@media print{body{padding:0}}
`;

function chronologyBlock(c: Chronology): string {
  const rows = c.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.label)}</td><td>${esc(l.value)}${
          l.note ? ` <span class="small">— ${esc(l.note)}</span>` : ""
        }</td></tr>`,
    )
    .join("");
  const cls = c.onTime === null ? "gap" : c.onTime ? "ok" : "late";
  return `<table class="meta">${rows}</table><p class="${cls}">${esc(c.verdict)}</p>`;
}

export function renderClaimPack(m: ClaimPackModel): { html: string; contentType: string } {
  const chronology = buildChronology(m.claim, m.policy);
  const policyRows = m.policy
    ? `<table class="meta">
        <tr><td>Policy</td><td>${esc(m.policy.number)} — ${esc(m.policy.policyType)}</td></tr>
        <tr><td>Insurer</td><td>${esc(m.policy.insurer)} (policy no. ${esc(m.policy.policyNumber)})</td></tr>
        <tr><td>Period</td><td>${esc(m.policy.periodStart)} to ${esc(m.policy.periodEnd)}</td></tr>
        <tr><td>Limit of indemnity</td><td>${esc(money(m.policy.limitOfIndemnity, m.policy.currency))}${
          m.policy.limitBasis ? ` (${esc(m.policy.limitBasis)})` : ""
        }</td></tr>
        <tr><td>Deductible</td><td>${esc(money(m.policy.deductible, m.policy.currency))}</td></tr>
        <tr><td>Territorial limits</td><td>${esc(m.policy.territorialLimits ?? "—")}</td></tr>
      </table>`
    : `<p class="gap">The policy could not be read from this project, so no terms are stated.</p>`;

  const itemRows = m.items.length
    ? m.items
        .map(
          (i) =>
            `<tr><td>${esc(i.recordType)}</td><td>${esc(i.reference ?? "—")}</td><td>${esc(
              i.title ?? "—",
            )}</td><td>${esc(i.occurredAt ?? "—")}</td><td class="mono">${esc(i.recordId)}${
              i.sha256 ? `<br>sha256 ${esc(i.sha256.slice(0, 16))}…` : ""
            }</td><td>${
              i.resolution === "resolved"
                ? "resolved"
                : i.resolution === "not_found"
                  ? "NOT FOUND"
                  : "not checked"
            }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6">No evidence records are linked to this claim.</td></tr>`;

  const requestRows = m.requests.length
    ? m.requests
        .map(
          (r) =>
            `<tr><td>${esc(r.kind)}</td><td>${esc(r.title)}</td><td>${esc(
              r.requestedBy ?? "—",
            )}</td><td>${esc(r.dueDate ?? "—")}</td><td>${esc(r.status)}${
              r.overdue ? " (OVERDUE)" : ""
            }</td><td>${esc(r.respondedAt ?? "—")}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6">No requests recorded from the loss adjuster.</td></tr>`;

  const gaps = m.gaps.length
    ? m.gaps.map((g) => `<p class="gap">${esc(g)}</p>`).join("")
    : `<p class="ok">Nothing in this pack is missing that the platform can detect. That is not the same as complete.</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Claim pack ${esc(m.claim.number)} — ${esc(m.claim.title)}</title>
<style>${STYLE}</style></head>
<body>
<h1>Claim documentation pack — ${esc(m.claim.number)}</h1>
<p class="sub">${esc(m.claim.title)} · ${esc(m.companyName)}${
    m.projectName ? ` · ${esc(m.projectName)}` : ""
  }</p>

<h2>The claim</h2>
<table class="meta">
  <tr><td>Status</td><td>${esc(m.claim.status)}</td></tr>
  <tr><td>Description</td><td>${esc(m.claim.description ?? "—")}</td></tr>
  <tr><td>Quantum claimed</td><td>${esc(money(m.claim.quantum, m.claim.currency))}</td></tr>
  <tr><td>Reserve</td><td>${esc(money(m.claim.reserve, m.claim.currency))}</td></tr>
  <tr><td>Settled</td><td>${esc(money(m.claim.settledAmount, m.claim.currency))}</td></tr>
  <tr><td>Insurer reference</td><td>${esc(m.claim.insurerRef ?? "—")}</td></tr>
  <tr><td>Loss adjuster</td><td>${esc(m.claim.lossAdjuster ?? "—")}</td></tr>
</table>

<h2>Notification chronology</h2>
${chronologyBlock(chronology)}

<h2>Policy terms this claim is tested against</h2>
${policyRows}

<h2>Evidence index (${m.items.length})</h2>
<table>
  <tr><th>Type</th><th>Reference</th><th>Title</th><th>Date</th><th>Record id</th><th>Resolution</th></tr>
  ${itemRows}
</table>
<p class="small">The underlying files stay in the file register under their own hashes; this index names them so a recipient can request and verify each one. Nothing here is a copy.</p>

<h2>Loss adjuster requests (${m.requests.length})</h2>
<table>
  <tr><th>Kind</th><th>Request</th><th>Asked by</th><th>Due</th><th>Status</th><th>Answered</th></tr>
  ${requestRows}
</table>

<h2>What this pack does not establish</h2>
${gaps}

<footer>
Generated ${esc(m.generatedAt)}${m.generatedByName ? ` by ${esc(m.generatedByName)}` : ""}.
This pack states dates and terms; whether the policy responds is the insurer's decision and nothing here asserts it.
The sha256 of these bytes is recorded on the claim and in the hash-chained ledger.
</footer>
</body></html>`;
  return { html, contentType: "text/html; charset=utf-8" };
}
