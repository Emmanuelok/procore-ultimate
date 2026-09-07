/**
 * Hearing bundle production — the document itself (spec Vol II Domain P
 * #340-343).
 *
 * WHAT IT IS
 * The produced bundle, rendered from the SNAPSHOTS taken at generation:
 * a cover sheet, a hyperlinked index (tab → the section it names), one
 * section per produced item rendered from the snapshot (so the served
 * document is reproducible even after the source record moves on), and the
 * privilege log of what was withheld.
 *
 * PAGINATION — WHY THERE ISN'T ANY
 * This runtime has no PDF writer (pdfjs-dist reads, it does not write), so
 * the platform cannot know how many pages an attached file occupies. Rather
 * than print "tab A5, page 7" from an assumption of one page per item — a
 * number that would be wrong the moment a 35-page appendix sits at A1 — the
 * index addresses items by TAB and hyperlinks to the section. Each item
 * starts on a new printed page (`break-before: page`), and the print
 * footer carries the tab, so a printed bundle is navigable by the same
 * addresses the index uses. Page numbers are the printer's to assign.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not merge attached files into the document — the platform holds a
 * content hash and a reference for those, not a renderable page stream — so
 * a file item renders as its cover entry (name, hash, reference) and the
 * file is served alongside.
 */

export interface BundleDocumentItem {
  tab: string;
  title: string;
  date: string | null;
  source: string;
  sha256: string;
  kind: "record" | "file" | null;
  snapshot: Record<string, unknown> | null;
}

export interface BundleDocumentInput {
  bundleName: string;
  disputeReference: string;
  disputeTitle: string;
  projectName: string | null;
  generatedAt: string;
  merkleRoot: string;
  statement: string;
  items: BundleDocumentItem[];
  privilegeLog: Array<{
    title: string;
    date: string | null;
    privilege: string;
    reason: string | null;
  }>;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const anchorFor = (tab: string): string => `tab-${tab.replace(/[^A-Za-z0-9_-]/g, "")}`;

/** Render one snapshot's scalar fields as a definition list; nested values as JSON. */
export function renderSnapshotRow(row: Record<string, unknown>): string {
  const entries = Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (entries.length === 0) {
    return `<p class="empty">The snapshot holds no populated fields for this record.</p>`;
  }
  return `<dl>${entries
    .map(([k, v]) => {
      const label = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
      const value =
        typeof v === "object"
          ? `<pre>${escapeHtml(JSON.stringify(v, null, 2))}</pre>`
          : escapeHtml(v);
      return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
    })
    .join("")}</dl>`;
}

function renderItem(item: BundleDocumentItem): string {
  const head =
    `<h2>Tab ${escapeHtml(item.tab)} — ${escapeHtml(item.title)}</h2>` +
    `<div class="meta">${escapeHtml(item.date ?? "undated")} · ${escapeHtml(item.source)} · ` +
    `<span class="hash">${escapeHtml(item.sha256)}</span></div>`;
  if (!item.snapshot) {
    return (
      `<section class="tab" id="${anchorFor(item.tab)}">${head}` +
      `<p class="empty">No snapshot was taken for this item at generation, so its produced content cannot be reproduced here. The content hash above is what was served.</p></section>`
    );
  }
  if (item.kind === "file") {
    const name = String(item.snapshot["name"] ?? "");
    return (
      `<section class="tab" id="${anchorFor(item.tab)}">${head}` +
      `<p>Attached file <strong>${escapeHtml(name)}</strong>, served with this bundle. ` +
      `The file is content-addressed: the hash above is the hash of its bytes, so the copy served ` +
      `can be checked against this index without reference to this platform.</p></section>`
    );
  }
  const row = (item.snapshot["row"] ?? item.snapshot) as Record<string, unknown>;
  return (
    `<section class="tab" id="${anchorFor(item.tab)}">${head}` +
    renderSnapshotRow(row) +
    `</section>`
  );
}

/** The produced bundle as a print-ready document with a hyperlinked index. */
export function renderBundleDocumentHtml(doc: BundleDocumentInput): string {
  const indexRows = doc.items
    .map(
      (i) =>
        `<tr><td><a href="#${anchorFor(i.tab)}">${escapeHtml(i.tab)}</a></td><td><a href="#${anchorFor(
          i.tab,
        )}">${escapeHtml(i.title)}</a></td><td>${escapeHtml(i.date ?? "—")}</td><td>${escapeHtml(
          i.source,
        )}</td><td class="hash">${escapeHtml(i.sha256.slice(0, 16))}</td></tr>`,
    )
    .join("");
  const privilege =
    doc.privilegeLog.length === 0
      ? ""
      : `<section class="tab" id="privilege-log"><h2>Privilege log</h2>
<p>The following item(s) were withheld from production on the grounds stated and do not appear in this bundle.</p>
<table><thead><tr><th>Document</th><th>Date</th><th>Ground</th><th>Reason</th></tr></thead><tbody>${doc.privilegeLog
          .map(
            (p) =>
              `<tr><td>${escapeHtml(p.title)}</td><td>${escapeHtml(p.date ?? "—")}</td><td>${escapeHtml(
                p.privilege,
              )}</td><td>${escapeHtml(p.reason ?? "—")}</td></tr>`,
          )
          .join("")}</tbody></table></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(doc.bundleName)} — ${escapeHtml(doc.disputeReference)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #101418; margin: 0; padding: 32px; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .cover { min-height: 40vh; }
  .meta { color: #5b6672; font-size: 12px; margin-bottom: 12px; }
  .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #e4e8ec; vertical-align: top; text-align: left; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5b6672; }
  a { color: #14507a; }
  dl { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; margin: 8px 0 0; }
  dt { color: #5b6672; }
  dd { margin: 0; }
  pre { margin: 0; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  p.empty { color: #5b6672; font-style: italic; }
  section.tab { break-before: page; padding-top: 8px; }
  footer { margin-top: 24px; color: #5b6672; font-size: 11px; }
  @media print { body { padding: 0; } @page { margin: 18mm; } }
</style></head>
<body>
<div class="cover">
  <h1>${escapeHtml(doc.bundleName)}</h1>
  <div class="meta">${escapeHtml(doc.disputeReference)} — ${escapeHtml(doc.disputeTitle)}${
    doc.projectName ? ` · ${escapeHtml(doc.projectName)}` : ""
  }</div>
  <p>Produced ${escapeHtml(doc.generatedAt)} · ${doc.items.length} tab${doc.items.length === 1 ? "" : "s"}${
    doc.privilegeLog.length > 0 ? ` · ${doc.privilegeLog.length} withheld on privilege` : ""
  }</p>
  <p class="meta">Merkle root <span class="hash">${escapeHtml(doc.merkleRoot)}</span></p>
  <p class="meta">${escapeHtml(doc.statement)}</p>
</div>
<section class="tab" id="index">
  <h2>Index</h2>
  <table><thead><tr><th>Tab</th><th>Document</th><th>Date</th><th>Source</th><th>Hash</th></tr></thead>
  <tbody>${indexRows}</tbody></table>
  <p class="meta">Each tab begins on a new page. Items are addressed by tab, not by page number: the extent of an attached file is set by the printer, not by this platform, so a page number here would be a guess.</p>
</section>
${doc.items.map(renderItem).join("\n")}
${privilege}
<footer>Rendered from the content snapshots taken when this bundle was produced. Any later change to a source record does not alter this document.</footer>
</body></html>`;
}
