/**
 * Withdrawal application document + renderings (spec Vol II Domain N #732,
 * #735, #769).
 *
 * WHAT IT IS
 * The pure half of the withdrawal application: the shape of the document an
 * IFI (World Bank / ADB / AfDB) expects — application summary, statement of
 * expenditure schedule, eligibility position, certification block — and two
 * renderings of it a borrower can actually send:
 *   - `renderWithdrawalApplicationHtml` — the printed form, laid out the way
 *     the lender's own form is (Section 1 application, Section 2 SoE
 *     schedule, Section 3 certification), print-styled so the browser's
 *     "save as PDF" produces the document. There is no PDF writer in this
 *     runtime; claiming to emit a PDF would be a lie, so the platform emits
 *     the print-ready form and says so.
 *   - `withdrawalApplicationCsv` — the SoE schedule for the lender's own
 *     system, mirroring the facility statement.csv route.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It computes nothing. Every figure is passed in from the recorded rows, and
 * anything the platform does not hold appears in `warnings` rather than as a
 * plausible number.
 */

export interface WithdrawalSoeLine {
  evidenceId: string;
  kind: string;
  source: string;
  capturedAt: string | null;
  contentHash: string | null;
  eligibility: string;
  reason: string | null;
  amount: number | null;
}

export interface WithdrawalApplicationDocument {
  header: {
    applicationNumber: number;
    project: string | null;
    borrowerReference: string;
    lender: string;
    instrument: string;
    currency: string;
    committedAmount: number;
    availabilityEndDate: string | null;
    category: { id: string; name: string; limit: number | null } | null;
  };
  application: {
    amount: number;
    purpose: string;
    status: string;
    submittedAt: string | null;
    approvedAt: string | null;
    disbursedAt: string | null;
  };
  statementOfExpenditure: WithdrawalSoeLine[];
  eligibility: {
    total: number;
    eligible: number;
    ineligible: number;
    unassessed: number;
    ineligibleAmount: number | null;
    submittable: boolean;
    reasons: string[];
  };
  certification: {
    certified: boolean;
    certifiedAt: string | null;
    certifiedBy: string | null;
    note: string | null;
    evidenceIds: string[];
    requiredForInstrument: boolean;
  };
  conditionality: unknown;
  warnings: string[];
  basis: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${currency} ${Math.abs(value)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${value < 0 ? " CR" : ""}`;
}

const csvEscape = (v: unknown): string => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The statement-of-expenditure schedule as CSV, plus the application header
 * as leading key/value rows so the file is self-describing when it lands in
 * the lender's inbox detached from this platform.
 */
export function withdrawalApplicationCsv(doc: WithdrawalApplicationDocument): string {
  const lines: string[] = [
    ["field", "value"].join(","),
    ...[
      ["Application number", doc.header.applicationNumber],
      ["Project", doc.header.project ?? ""],
      ["Borrower reference", doc.header.borrowerReference],
      ["Lender", doc.header.lender],
      ["Instrument", doc.header.instrument],
      ["Currency", doc.header.currency],
      ["Amount applied for", doc.application.amount],
      ["Purpose", doc.application.purpose],
      ["Status", doc.application.status],
      ["Category", doc.header.category?.name ?? ""],
      ["Certified", doc.certification.certified ? "yes" : "no"],
      ["Certified at", doc.certification.certifiedAt ?? ""],
    ].map((r) => r.map(csvEscape).join(",")),
    "",
    ["evidenceId", "kind", "source", "capturedAt", "contentHash", "eligibility", "reason", "amount"].join(
      ",",
    ),
    ...doc.statementOfExpenditure.map((l) =>
      [
        l.evidenceId,
        l.kind,
        l.source,
        l.capturedAt ?? "",
        l.contentHash ?? "",
        l.eligibility,
        l.reason ?? "",
        l.amount ?? "",
      ]
        .map(csvEscape)
        .join(","),
    ),
    "",
    ...doc.warnings.map((w) => ["WARNING", w].map(csvEscape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

/** The printed application form. Print styles produce the PDF. */
export function renderWithdrawalApplicationHtml(doc: WithdrawalApplicationDocument): string {
  const h = doc.header;
  const soeRows =
    doc.statementOfExpenditure.length === 0
      ? `<tr><td colspan="6" class="empty">No evidence is attached to this application, so the statement of expenditure is empty.</td></tr>`
      : doc.statementOfExpenditure
          .map(
            (l, i) =>
              `<tr><td class="num">${i + 1}</td><td>${escapeHtml(l.kind)} — ${escapeHtml(
                l.source,
              )}</td><td>${escapeHtml(l.capturedAt?.slice(0, 10) ?? "—")}</td><td class="hash">${escapeHtml(
                l.contentHash ? l.contentHash.slice(0, 16) : "—",
              )}</td><td>${escapeHtml(l.eligibility)}${
                l.reason ? ` — ${escapeHtml(l.reason)}` : ""
              }</td><td class="num">${escapeHtml(
                l.amount === null ? "—" : money(l.amount, h.currency),
              )}</td></tr>`,
          )
          .join("");

  const warnings =
    doc.warnings.length === 0
      ? ""
      : `<section class="warn"><h2>Qualifications</h2><ul>${doc.warnings
          .map((w) => `<li>${escapeHtml(w)}</li>`)
          .join("")}</ul></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Withdrawal application ${escapeHtml(h.applicationNumber)} — ${escapeHtml(h.borrowerReference)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #101418; margin: 0; padding: 32px; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #5b6672; margin: 24px 0 8px; border-bottom: 1px solid #e4e8ec; padding-bottom: 4px; }
  .meta { color: #5b6672; font-size: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e4e8ec; vertical-align: top; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5b6672; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  td.empty { color: #5b6672; font-style: italic; }
  dl { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; margin: 0; }
  dt { color: #5b6672; }
  dd { margin: 0; font-weight: 600; }
  .warn { border-left: 3px solid #b45309; padding-left: 12px; }
  .warn ul { margin: 0; padding-left: 18px; }
  .sign { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .sign div { border-top: 1px solid #101418; padding-top: 6px; color: #5b6672; font-size: 12px; }
  footer { margin-top: 28px; color: #5b6672; font-size: 11px; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style></head>
<body>
<h1>Application for withdrawal ${escapeHtml(h.applicationNumber)}</h1>
<div class="meta">${escapeHtml(h.lender)} · ${escapeHtml(h.instrument)} · ${escapeHtml(
    h.borrowerReference,
  )}${h.project ? ` · ${escapeHtml(h.project)}` : ""}</div>

<h2>Section 1 — Application</h2>
<dl>
  <dt>Amount applied for</dt><dd>${escapeHtml(money(doc.application.amount, h.currency))}</dd>
  <dt>Purpose</dt><dd>${escapeHtml(doc.application.purpose)}</dd>
  <dt>Disbursement category</dt><dd>${escapeHtml(h.category ? h.category.name : "Not allocated to a category")}</dd>
  <dt>Facility commitment</dt><dd>${escapeHtml(money(h.committedAmount, h.currency))}</dd>
  <dt>Availability ends</dt><dd>${escapeHtml(h.availabilityEndDate ?? "Not recorded")}</dd>
  <dt>Status</dt><dd>${escapeHtml(doc.application.status)}</dd>
  <dt>Submitted</dt><dd>${escapeHtml(doc.application.submittedAt?.slice(0, 10) ?? "—")}</dd>
  <dt>Approved</dt><dd>${escapeHtml(doc.application.approvedAt?.slice(0, 10) ?? "—")}</dd>
</dl>

<h2>Section 2 — Statement of expenditure</h2>
<table>
  <thead><tr><th class="num">#</th><th>Supporting record</th><th>Captured</th><th>Content hash</th><th>Eligibility</th><th class="num">Amount</th></tr></thead>
  <tbody>${soeRows}</tbody>
</table>
<p>${escapeHtml(
    `${doc.eligibility.eligible} of ${doc.eligibility.total} item(s) classified eligible; ` +
      `${doc.eligibility.ineligible} ineligible; ${doc.eligibility.unassessed} unassessed.`,
  )}${
    doc.eligibility.ineligibleAmount === null
      ? ""
      : ` ${escapeHtml(`Ineligible expenditure identified: ${money(doc.eligibility.ineligibleAmount, h.currency)}.`)}`
  }</p>

<h2>Section 3 — Certification</h2>
<dl>
  <dt>Independent certification</dt><dd>${escapeHtml(
    doc.certification.certified
      ? `Certified ${doc.certification.certifiedAt?.slice(0, 10) ?? ""}`
      : doc.certification.requiredForInstrument
        ? "NOT CERTIFIED — required for this instrument"
        : "Not certified (optional for this instrument)",
  )}</dd>
  <dt>Certifying engineer</dt><dd>${escapeHtml(doc.certification.certifiedBy ?? "—")}</dd>
  <dt>Certification note</dt><dd>${escapeHtml(doc.certification.note ?? "—")}</dd>
  <dt>Certification evidence</dt><dd>${escapeHtml(
    doc.certification.evidenceIds.length === 0 ? "—" : doc.certification.evidenceIds.join(", "),
  )}</dd>
</dl>
<div class="sign"><div>Authorised representative of the borrower</div><div>Date</div></div>

${warnings}
<footer>${escapeHtml(doc.basis)}</footer>
</body></html>`;
}
