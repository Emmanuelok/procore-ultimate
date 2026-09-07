/**
 * Claim submission package renderer (spec Vol II Domain D #317-319) — pure.
 *
 * Turns the assembled package into ONE self-contained HTML document a party
 * can print to PDF, e-mail, or drop into a tribunal bundle. There is no PDF
 * renderer in the platform and adding a headless browser to produce one would
 * be worse than useless here: a printed-from-HTML document keeps its text
 * selectable and its structure intact, which is what a bundle needs.
 *
 * RULES THIS FILE KEEPS:
 *  - What is MISSING is printed first, in a box, never omitted. A submission
 *    that quietly leaves out its delay analysis is how a claim dies.
 *  - Every figure carries its basis: the analysis prints its MIP code, SCL
 *    reference and rationale; every quantum calculation prints its formula,
 *    workings and assumptions; disruption prints its method and justification.
 *  - Nothing is invented. A null stays "not available", never 0, and money is
 *    printed with the claim's currency, never converted.
 *  - Every string that came from a user is escaped.
 *
 * DELIBERATELY NOT HERE: page numbering, tables of contents and cross-
 * references (the browser's print engine owns pagination), and any styling
 * that depends on a network font or stylesheet — the document must render the
 * same on a machine with no internet.
 */

export interface ClaimPackageClaim {
  number: number;
  title: string;
  kind: string;
  status: string;
  currency: string;
  clauseRef: string | null;
  daysClaimed: number | null;
  amountClaimed: number | null;
  daysAssessed: number | null;
  amountAssessed: number | null;
  quantumBest: number | null;
  quantumLikely: number | null;
  quantumWorst: number | null;
  successProbability: number | null;
  provisionAmount: number | null;
  chain: Record<string, string | undefined> | null;
  createdAt: string;
}

export interface ClaimPackageEvent {
  number: number;
  title: string;
  cause: string;
  status: string;
  party: string;
  excusable: number;
  compensable: number;
  startDate: string;
  durationDays: number;
  noticeDueDate: string | null;
  contractEventId: string | null;
}

export interface ClaimPackageAnalysis {
  title: string;
  method: string;
  mipCode: string | null;
  sclReference: string | null;
  resultDays: number | null;
  rationale: string | null;
  summary: string | null;
  createdAt: string;
}

export interface ClaimPackageQuantum {
  method: string;
  currency: string;
  amount: number | null;
  formula: string | null;
  workings: string | null;
  assumptions: string[] | null;
  createdAt: string;
}

export interface ClaimPackageDisruption {
  method: string;
  currency: string;
  lostHours: number | null;
  amount: number | null;
  justification: string | null;
  summary: string | null;
  createdAt: string;
}

export interface ClaimPackage {
  claim: ClaimPackageClaim;
  delayEvents: ClaimPackageEvent[];
  analyses: ClaimPackageAnalysis[];
  quantumCalculations: ClaimPackageQuantum[];
  disruptionAnalyses: ClaimPackageDisruption[];
  chronology: unknown;
  sufficiency: unknown;
  scottSchedule: unknown;
  completeness: { ready: boolean; missing: string[] };
  generatedAt: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A figure with no source prints as "not available", never as zero. */
function num(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '<span class="na">not available</span>';
  }
  return escapeHtml(`${value}${suffix}`);
}

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '<span class="na">not available</span>';
  }
  const formatted = value.toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return escapeHtml(`${currency} ${formatted}`);
}

function humanise(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function paragraphs(text: string | undefined | null): string {
  const value = (text ?? "").trim();
  if (value.length === 0) return '<p class="na">This limb has not been written.</p>';
  return value
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

interface ChronologyEntry {
  date: string;
  source: string;
  ref: string;
  title: string;
}

/**
 * The claim stores its chronology and its Scott Schedule as plain arrays of
 * rows. Both are also accepted wrapped in `{ entries }` / `{ rows }`, so a
 * caller that hands the renderer an endpoint envelope instead of the stored
 * column still gets a document rather than an empty section.
 */
function asArray(value: unknown, key: "entries" | "rows"): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function chronologyRows(chronology: unknown): ChronologyEntry[] {
  return asArray(chronology, "entries").filter(
    (e): e is ChronologyEntry =>
      typeof e === "object" && e !== null && typeof (e as ChronologyEntry).date === "string",
  );
}

/** As produced by sufficiency.ts `buildScottSchedule`. */
interface ScottRow {
  item: number;
  reference: string;
  description: string;
  claimantContention: string;
  evidenceRefs: string[];
  daysClaimed: number | null;
  amountClaimed: number | null;
  respondentResponse: string;
  daysAdmitted: number | null;
  amountAdmitted: number | null;
  tribunalFinding: string;
  daysAwarded: number | null;
  amountAwarded: number | null;
}

function scottRows(scott: unknown): ScottRow[] {
  return asArray(scott, "rows").filter(
    (r): r is ScottRow =>
      typeof r === "object" && r !== null && typeof (r as ScottRow).reference === "string",
  );
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px; font: 13px/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111827; background: #fff; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d1d5db; text-transform: uppercase; letter-spacing: .04em; }
h3 { font-size: 13px; margin: 16px 0 4px; }
p { margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 4px; }
th, td { border: 1px solid #d1d5db; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.meta { color: #6b7280; font-size: 11px; }
.na { color: #9ca3af; font-style: italic; }
.missing { border: 1px solid #f59e0b; background: #fffbeb; padding: 10px 14px; margin: 16px 0; }
.missing h2 { border: 0; margin: 0 0 6px; color: #92400e; }
.ready { border: 1px solid #10b981; background: #ecfdf5; padding: 10px 14px; margin: 16px 0; color: #065f46; }
.basis { color: #4b5563; font-size: 11px; margin: 2px 0 8px; }
ul { margin: 4px 0 8px; padding-left: 18px; }
@media print { body { padding: 0; } h2 { break-after: avoid; } table { break-inside: auto; } tr { break-inside: avoid; } }
`;

export function renderClaimPackageHtml(pkg: ClaimPackage): string {
  const c = pkg.claim;
  const cur = c.currency;
  const title = `Claim CL-${c.number} — ${c.title}`;

  const completeness = pkg.completeness.ready
    ? `<div class="ready"><strong>This package is complete.</strong> Every component of a submission is present.</div>`
    : `<div class="missing"><h2>Not yet complete</h2><ul>${pkg.completeness.missing
        .map((m) => `<li>${escapeHtml(m)}</li>`)
        .join("")}</ul></div>`;

  const header = `
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">
      ${escapeHtml(humanise(c.kind))} claim · status ${escapeHtml(humanise(c.status))}
      ${c.clauseRef ? ` · clause ${escapeHtml(c.clauseRef)}` : ""}
      · raised ${escapeHtml(c.createdAt.slice(0, 10))}
      · generated ${escapeHtml(pkg.generatedAt.slice(0, 19).replace("T", " "))} UTC
    </p>`;

  const position = section(
    "Position",
    `<table>
      <tr><th>Days claimed</th><td class="num">${num(c.daysClaimed)}</td>
          <th>Days assessed</th><td class="num">${num(c.daysAssessed)}</td></tr>
      <tr><th>Amount claimed</th><td class="num">${money(c.amountClaimed, cur)}</td>
          <th>Amount assessed</th><td class="num">${money(c.amountAssessed, cur)}</td></tr>
      <tr><th>Valuation best / likely / worst</th>
          <td class="num" colspan="3">${money(c.quantumBest, cur)} / ${money(c.quantumLikely, cur)} / ${money(c.quantumWorst, cur)}</td></tr>
      <tr><th>Probability of success</th><td class="num">${
        c.successProbability === null ? '<span class="na">not available</span>' : escapeHtml(`${Math.round(c.successProbability * 100)}%`)
      }</td>
          <th>Provision carried</th><td class="num">${money(c.provisionAmount, cur)}</td></tr>
    </table>
    <p class="basis">Sums are stated in ${escapeHtml(cur)} only; the platform never converts or adds across currencies.</p>`,
  );

  const chain = c.chain ?? {};
  const chainHtml = section(
    "Cause, effect, entitlement, quantum",
    (["cause", "effect", "entitlement", "quantum"] as const)
      .map((k) => `<h3>${escapeHtml(humanise(k))}</h3>${paragraphs(chain[k])}`)
      .join(""),
  );

  const events =
    pkg.delayEvents.length === 0
      ? '<p class="na">No delay events are linked to this claim.</p>'
      : `<table>
          <thead><tr><th>Ref</th><th>Event</th><th>Cause</th><th>Party</th><th>E / C</th><th>Start</th><th class="num">Days</th><th>Notice due</th><th>Notice</th><th>Status</th></tr></thead>
          <tbody>${pkg.delayEvents
            .map(
              (e) => `<tr>
                <td>DE-${escapeHtml(e.number)}</td>
                <td>${escapeHtml(e.title)}</td>
                <td>${escapeHtml(humanise(e.cause))}</td>
                <td>${escapeHtml(humanise(e.party))}</td>
                <td>${e.excusable === 1 ? "E" : "—"} / ${e.compensable === 1 ? "C" : "—"}</td>
                <td>${escapeHtml(e.startDate)}</td>
                <td class="num">${escapeHtml(e.durationDays)}</td>
                <td>${e.noticeDueDate ? escapeHtml(e.noticeDueDate) : '<span class="na">none</span>'}</td>
                <td>${e.contractEventId ? "served" : '<span class="na">not recorded</span>'}</td>
                <td>${escapeHtml(humanise(e.status))}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table>`;

  const analyses =
    pkg.analyses.length === 0
      ? '<p class="na">No delay analysis has been recorded against this claim.</p>'
      : pkg.analyses
          .map(
            (a) => `<h3>${escapeHtml(a.title)}</h3>
              <p class="basis">${escapeHtml(humanise(a.method))}${
                a.mipCode ? ` · AACE 29R-03 MIP ${escapeHtml(a.mipCode)}` : ""
              }${a.sclReference ? ` · ${escapeHtml(a.sclReference)}` : ""} · run ${escapeHtml(
                a.createdAt.slice(0, 10),
              )}</p>
              <p>Result: <strong>${num(a.resultDays, " days")}</strong></p>
              ${a.summary ? `<p>${escapeHtml(a.summary)}</p>` : ""}
              ${
                a.rationale
                  ? `<p class="basis">Method selected because: ${escapeHtml(a.rationale)}</p>`
                  : '<p class="basis na">No method-selection rationale was recorded.</p>'
              }`,
          )
          .join("");

  const quantum =
    pkg.quantumCalculations.length === 0
      ? '<p class="na">No quantum calculation is linked to this claim.</p>'
      : pkg.quantumCalculations
          .map(
            (q) => `<h3>${escapeHtml(humanise(q.method))} — ${money(q.amount, q.currency)}</h3>
              ${q.formula ? `<p class="basis">${escapeHtml(q.formula)}</p>` : ""}
              ${q.workings ? `<p>${escapeHtml(q.workings)}</p>` : ""}
              ${
                q.assumptions && q.assumptions.length > 0
                  ? `<p class="basis">Assumptions:</p><ul>${q.assumptions
                      .map((a) => `<li>${escapeHtml(a)}</li>`)
                      .join("")}</ul>`
                  : '<p class="basis na">No assumptions were recorded — a respondent will ask for them.</p>'
              }`,
          )
          .join("");

  const disruption =
    pkg.disruptionAnalyses.length === 0
      ? '<p class="na">No disruption analysis is linked to this claim.</p>'
      : pkg.disruptionAnalyses
          .map(
            (d) => `<h3>${escapeHtml(humanise(d.method))} — ${money(d.amount, d.currency)}</h3>
              <p>Lost hours: ${num(d.lostHours)}</p>
              ${d.summary ? `<p>${escapeHtml(d.summary)}</p>` : ""}
              ${
                d.justification
                  ? `<p class="basis">Justification: ${escapeHtml(d.justification)}</p>`
                  : ""
              }`,
          )
          .join("");

  const chron = chronologyRows(pkg.chronology);
  const chronologyHtml =
    chron.length === 0
      ? '<p class="na">No chronology has been assembled for this claim.</p>'
      : `<table>
          <thead><tr><th>Date</th><th>Source</th><th>Ref</th><th>Entry</th></tr></thead>
          <tbody>${chron
            .map(
              (e) =>
                `<tr><td>${escapeHtml(e.date)}</td><td>${escapeHtml(humanise(e.source))}</td><td>${escapeHtml(
                  e.ref,
                )}</td><td>${escapeHtml(e.title)}</td></tr>`,
            )
            .join("")}</tbody>
        </table>`;

  const scott = scottRows(pkg.scottSchedule);
  const scottHtml =
    scott.length === 0
      ? '<p class="na">No Scott Schedule has been generated for this claim.</p>'
      : `<table>
          <thead><tr>
            <th>Item</th><th>Ref</th><th>Claimant's contention</th><th>Evidence</th>
            <th class="num">Days</th><th class="num">Amount</th>
            <th>Respondent's response</th><th class="num">Days admitted</th><th class="num">Amount admitted</th>
            <th>Tribunal</th>
          </tr></thead>
          <tbody>${scott
            .map(
              (r) => `<tr>
                <td>${escapeHtml(r.item)}</td>
                <td>${escapeHtml(r.reference)}</td>
                <td>${escapeHtml(r.claimantContention)}</td>
                <td>${
                  Array.isArray(r.evidenceRefs) && r.evidenceRefs.length > 0
                    ? escapeHtml(r.evidenceRefs.join(", "))
                    : '<span class="na">none</span>'
                }</td>
                <td class="num">${num(r.daysClaimed)}</td>
                <td class="num">${money(r.amountClaimed, cur)}</td>
                <td>${escapeHtml(r.respondentResponse ?? "")}</td>
                <td class="num">${num(r.daysAdmitted)}</td>
                <td class="num">${money(r.amountAdmitted, cur)}</td>
                <td>${escapeHtml(r.tribunalFinding ?? "")}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table>
        <p class="basis">The respondent and tribunal columns are left blank by design — they are filled in by the other parties, not by the claimant.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body>
${header}
${completeness}
${position}
${chainHtml}
${section("Delay events relied on", events)}
${section("Delay analysis", analyses)}
${section("Quantum", quantum)}
${section("Disruption", disruption)}
${section("Chronology", chronologyHtml)}
${section("Scott Schedule", scottHtml)}
<p class="meta">Produced by ConstructOS from the contemporaneous record. Every figure above is traceable to the record it was computed from; nothing on this page was estimated to fill a gap.</p>
</body></html>`;
}
