/**
 * PDF text extraction shared by the drawings and specifications pipelines.
 *
 * What it does: opens a PDF with pdf.js (legacy Node build), reads the text
 * layer page by page and returns BOTH the flat text stream (what the old
 * pipeline used) and the positioned text items — each item with its
 * normalised (0..1, top-left origin) box on the page. Positions are what let
 * title-block detection prefer the bottom-right corner over "last match
 * wins", let callouts become hyperlink hot-zones, and let two revisions be
 * diffed as vectors rather than as a wall of text.
 *
 * What it deliberately does not do: rasterise (no canvas in this runtime)
 * and OCR (no engine is available; a page with no text layer is reported as
 * `hasTextLayer: false` and the caller records that fact instead of
 * inventing a sheet number).
 */

export interface PositionedItem {
  /** the text run */
  t: string;
  /** normalised left, 0..1 */
  x: number;
  /** normalised top, 0..1 (top-left origin) */
  y: number;
  /** normalised width */
  w: number;
  /** normalised height */
  h: number;
}

export interface ExtractedPage {
  pageIndex: number;
  /** flat text stream: items joined by spaces, line breaks where pdf.js reports EOL */
  text: string;
  items: PositionedItem[];
  /** true when `items` was capped at `maxItems` */
  truncated: boolean;
  hasTextLayer: boolean;
  width: number;
  height: number;
}

export const EXTRACTION_ENGINE = "pdfjs-dist/legacy";
export const EXTRACTION_VERSION = "drawings-extract/v2-positioned";
/** Items kept per page. A dense sheet has ~1–3k; beyond this the page is unusually text-heavy. */
export const DEFAULT_MAX_ITEMS = 3000;

interface OpenedPdf {
  numPages: number;
  page: (pageIndex: number, maxItems?: number) => Promise<ExtractedPage>;
  destroy: () => Promise<void>;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Open a PDF buffer once; pages are extracted on demand so a caller can bound the work. */
export async function openPdf(buf: Buffer): Promise<OpenedPdf> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    async page(pageIndex, maxItems = DEFAULT_MAX_ITEMS) {
      const page = await doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      let text = "";
      const items: PositionedItem[] = [];
      let truncated = false;
      let kept = 0;
      for (const raw of tc.items) {
        if (!("str" in raw)) continue;
        const str = raw.str;
        text += str;
        text += raw.hasEOL ? "\n" : " ";
        if (str.trim() === "") continue;
        if (kept >= maxItems) {
          truncated = true;
          continue;
        }
        const tr = raw.transform as number[];
        const tx = tr[4] ?? 0;
        const ty = tr[5] ?? 0;
        const [vx, vy] = viewport.convertToViewportPoint(tx, ty) as [number, number];
        const h = Math.abs(raw.height) || Math.abs(tr[3] ?? 0) || 1;
        const w = Math.abs(raw.width) || 1;
        const vw = viewport.width || 1;
        const vh = viewport.height || 1;
        items.push({
          t: str,
          x: round(Math.max(0, Math.min(1, vx / vw))),
          y: round(Math.max(0, Math.min(1, (vy - h) / vh))),
          w: round(Math.max(0, Math.min(1, w / vw))),
          h: round(Math.max(0, Math.min(1, h / vh))),
        });
        kept += 1;
      }
      page.cleanup();
      return {
        pageIndex,
        text,
        items,
        truncated,
        hasTextLayer: items.length > 0 || text.trim().length > 0,
        width: viewport.width,
        height: viewport.height,
      };
    },
    async destroy() {
      try {
        await task.destroy();
      } catch {
        /* ignore cleanup failures */
      }
    },
  };
}

/** Page count only — cheap (xref parse), used to decide inline vs deferred processing. */
export async function pdfPageCount(buf: Buffer): Promise<number> {
  const pdf = await openPdf(buf);
  try {
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
}

/** Extract every page (or a bounded range) with positions. */
export async function extractPdfPages(
  buf: Buffer,
  options: { from?: number; to?: number; maxItems?: number } = {},
): Promise<ExtractedPage[]> {
  const pdf = await openPdf(buf);
  try {
    const from = Math.max(0, options.from ?? 0);
    const to = Math.min(pdf.numPages, options.to ?? pdf.numPages);
    const pages: ExtractedPage[] = [];
    for (let p = from; p < to; p++) pages.push(await pdf.page(p, options.maxItems));
    return pages;
  } finally {
    await pdf.destroy();
  }
}

/** Read a whole storage stream into memory (pipeline input). */
export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
