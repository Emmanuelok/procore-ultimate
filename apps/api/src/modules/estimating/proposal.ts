/**
 * PROPOSAL GENERATION — spec Vol I §1.2 (#205), with #206 (export) served by
 * the same structured document.
 *
 * Two functions: build a frozen document from an estimate, and render that
 * document as self-contained printable HTML.
 *
 * The document is FROZEN because a proposal is a statement made to a client
 * on a date. Re-deriving it from live rows later would silently change what
 * we are recorded as having said, which is exactly the failure the ledger
 * exists to prevent. Regenerating produces a new proposal, never an edit.
 *
 * `detailLevel` decides what the client sees — a lump sum, a section
 * breakdown, or every line. The internal explanation of each markup is NEVER
 * in the document at any level: telling a client that his price includes 11%
 * profit is a commercial decision, not a formatting one.
 *
 * Pure; no database, no clock (the caller supplies `generatedAt`).
 */
import type { AppliedMarkup } from "./pricing.js";
import { round2, round4 } from "./pricing.js";

export type ProposalDetailLevel = "summary" | "section" | "line";

export interface ProposalLineInput {
  id: string;
  sectionId?: string | null;
  itemCode?: string | null;
  description: string;
  unit?: string | null;
  quantity: number;
  unitRate: number;
  amount: number;
  status: string;
}

export interface ProposalSectionInput {
  id: string;
  code?: string | null;
  name: string;
  sortOrder: number;
}

export interface ProposalInput {
  reference: string;
  title: string;
  clientName?: string | null;
  projectName: string;
  estimateReference: string;
  estimateVersion: number;
  currency: string;
  detailLevel: ProposalDetailLevel;
  sections: readonly ProposalSectionInput[];
  lines: readonly ProposalLineInput[];
  markups: readonly AppliedMarkup[];
  coveringNote?: string | null;
  exclusions?: string | null;
  assumptions?: string | null;
  validUntil?: string | null;
  generatedAt: string;
}

export interface ProposalDocumentLine {
  itemCode: string | null;
  description: string;
  unit: string | null;
  quantity: number;
  unitRate: number;
  amount: number;
}

export interface ProposalDocumentSection {
  id: string;
  code: string | null;
  name: string;
  amount: number;
  lines: ProposalDocumentLine[];
}

export interface ProposalDocument {
  reference: string;
  title: string;
  clientName: string | null;
  projectName: string;
  estimateReference: string;
  estimateVersion: number;
  currency: string;
  detailLevel: ProposalDetailLevel;
  generatedAt: string;
  validUntil: string | null;
  sections: ProposalDocumentSection[];
  markupLines: Array<{ name: string; kind: string; amount: number }>;
  alternates: ProposalDocumentLine[];
  totals: { directCost: number; markupTotal: number; total: number };
  coveringNote: string | null;
  exclusions: string | null;
  assumptions: string | null;
  notes: string[];
}

const counted = (status: string): boolean => status === "active" || status === "provisional";

/** Build the frozen proposal body. */
export function buildProposalDocument(input: ProposalInput): ProposalDocument {
  const notes: string[] = [];
  const sections = [...input.sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const includedLines = input.lines.filter((l) => counted(l.status));
  const alternateLines = input.lines.filter((l) => l.status === "alternate");

  const docSections: ProposalDocumentSection[] = [];
  const emitLines = input.detailLevel === "line";

  const push = (id: string, code: string | null, name: string, lines: ProposalLineInput[]) => {
    if (lines.length === 0) return;
    docSections.push({
      id,
      code,
      name,
      amount: round2(lines.reduce((s, l) => s + l.amount, 0)),
      lines: emitLines
        ? lines.map((l) => ({
            itemCode: l.itemCode ?? null,
            description: l.description,
            unit: l.unit ?? null,
            quantity: round4(l.quantity),
            unitRate: round4(l.unitRate),
            amount: round2(l.amount),
          }))
        : [],
    });
  };

  if (input.detailLevel === "summary") {
    push("__all__", null, "Works as described", includedLines);
  } else {
    for (const section of sections) {
      push(
        section.id,
        section.code ?? null,
        section.name,
        includedLines.filter((l) => l.sectionId === section.id),
      );
    }
    const unsectioned = includedLines.filter(
      (l) => !l.sectionId || !sections.some((s) => s.id === l.sectionId),
    );
    push("__unsectioned__", null, "Other works", unsectioned);
  }

  const directCost = round2(includedLines.reduce((s, l) => s + l.amount, 0));
  const markupLines = input.markups
    .filter((m) => m.amount !== 0)
    .map((m) => ({ name: m.name, kind: m.kind, amount: round2(m.amount) }));
  const markupTotal = round2(markupLines.reduce((s, m) => s + m.amount, 0));

  if (input.detailLevel === "summary") {
    notes.push("This proposal states a lump sum; the underlying breakdown is held by the estimator.");
  }
  if (alternateLines.length > 0) {
    notes.push(
      `${alternateLines.length} alternate${alternateLines.length === 1 ? "" : "s"} ${alternateLines.length === 1 ? "is" : "are"} priced separately below and ${alternateLines.length === 1 ? "is" : "are"} not included in the total.`,
    );
  }
  if (!input.validUntil) {
    notes.push("No validity period was stated on this proposal.");
  }

  return {
    reference: input.reference,
    title: input.title,
    clientName: input.clientName ?? null,
    projectName: input.projectName,
    estimateReference: input.estimateReference,
    estimateVersion: input.estimateVersion,
    currency: input.currency,
    detailLevel: input.detailLevel,
    generatedAt: input.generatedAt,
    validUntil: input.validUntil ?? null,
    sections: docSections,
    markupLines,
    alternates: alternateLines.map((l) => ({
      itemCode: l.itemCode ?? null,
      description: l.description,
      unit: l.unit ?? null,
      quantity: round4(l.quantity),
      unitRate: round4(l.unitRate),
      amount: round2(l.amount),
    })),
    totals: { directCost, markupTotal, total: round2(directCost + markupTotal) },
    coveringNote: input.coveringNote ?? null,
    exclusions: input.exclusions ?? null,
    assumptions: input.assumptions ?? null,
    notes,
  };
}

/** HTML-escape every interpolated value. Nothing here trusts its input. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: number, currency: string): string {
  const fixed = Math.abs(value).toFixed(2);
  const [whole = "0", cents = "00"] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < 0 ? "-" : ""}${currency} ${grouped}.${cents}`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/**
 * Render the frozen document as one self-contained HTML page — no external
 * stylesheet, no script, print-ready. Everything interpolated is escaped.
 */
export function renderProposalHtml(doc: ProposalDocument): string {
  const c = doc.currency;
  const sectionRows = doc.sections
    .map((section) => {
      const head = `<tr class="section"><td colspan="4">${escapeHtml(
        section.code ? `${section.code} — ${section.name}` : section.name,
      )}</td><td class="num">${escapeHtml(money(section.amount, c))}</td></tr>`;
      const lines = section.lines
        .map(
          (l) =>
            `<tr><td>${escapeHtml(l.itemCode ?? "")}</td><td>${escapeHtml(l.description)}</td><td class="num">${escapeHtml(
              l.quantity.toString(),
            )}${l.unit ? ` ${escapeHtml(l.unit)}` : ""}</td><td class="num">${escapeHtml(
              money(l.unitRate, c),
            )}</td><td class="num">${escapeHtml(money(l.amount, c))}</td></tr>`,
        )
        .join("");
      return head + lines;
    })
    .join("");

  const markupRows = doc.markupLines
    .map(
      (m) =>
        `<tr><td colspan="4">${escapeHtml(m.name)}</td><td class="num">${escapeHtml(money(m.amount, c))}</td></tr>`,
    )
    .join("");

  const alternateRows = doc.alternates
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.itemCode ?? "")}</td><td>${escapeHtml(l.description)}</td><td class="num">${escapeHtml(
          l.quantity.toString(),
        )}${l.unit ? ` ${escapeHtml(l.unit)}` : ""}</td><td class="num">${escapeHtml(
          money(l.unitRate, c),
        )}</td><td class="num">${escapeHtml(money(l.amount, c))}</td></tr>`,
    )
    .join("");

  const block = (title: string, body: string | null): string =>
    body ? `<section><h2>${escapeHtml(title)}</h2>${paragraphs(body)}</section>` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(doc.reference)} — ${escapeHtml(doc.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #101418; margin: 0; padding: 32px; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #5b6672; margin: 24px 0 8px; }
  .meta { color: #5b6672; font-size: 12px; margin-bottom: 20px; }
  .meta span { margin-right: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e4e8ec; vertical-align: top; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5b6672; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.section td { background: #f5f7f9; font-weight: 600; }
  tr.total td { border-top: 2px solid #101418; border-bottom: none; font-weight: 700; font-size: 15px; }
  ul.notes { color: #5b6672; font-size: 12px; padding-left: 18px; }
  p { margin: 0 0 8px; }
  @media print { body { padding: 0; } }
</style></head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
<div class="meta">
  <span><strong>${escapeHtml(doc.reference)}</strong></span>
  <span>${escapeHtml(doc.projectName)}</span>
  ${doc.clientName ? `<span>For ${escapeHtml(doc.clientName)}</span>` : ""}
  <span>Prepared ${escapeHtml(doc.generatedAt.slice(0, 10))}</span>
  ${doc.validUntil ? `<span>Valid until ${escapeHtml(doc.validUntil)}</span>` : ""}
  <span>From estimate ${escapeHtml(doc.estimateReference)} rev ${escapeHtml(String(doc.estimateVersion))}</span>
</div>
${doc.coveringNote ? paragraphs(doc.coveringNote) : ""}
<h2>Price</h2>
<table>
  <thead><tr><th>Item</th><th>Description</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
  <tbody>
    ${sectionRows}
    ${markupRows}
    <tr class="total"><td colspan="4">Total</td><td class="num">${escapeHtml(money(doc.totals.total, c))}</td></tr>
  </tbody>
</table>
${
  doc.alternates.length > 0
    ? `<h2>Alternates (not included in the total)</h2><table><thead><tr><th>Item</th><th>Description</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${alternateRows}</tbody></table>`
    : ""
}
${block("Assumptions", doc.assumptions)}
${block("Exclusions", doc.exclusions)}
${
  doc.notes.length > 0
    ? `<h2>Notes</h2><ul class="notes">${doc.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : ""
}
</body></html>`;
}
