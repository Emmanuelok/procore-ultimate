/**
 * Callout detection (spec Vol I #263, #316, #342) — pure.
 *
 * Reads positioned text items off a sheet and finds the references a
 * drafter put there for a reader to follow: "3/A-501" detail bubbles, "SEE
 * DETAIL 4 ON A-502", "SECTION 03 30 00" spec citations, and the stacked
 * bubble form where the detail number sits on one line and the sheet number
 * directly beneath it. Each hit carries the normalised rectangle of the text
 * that produced it (the hyperlink hot-zone) and a confidence that says how
 * unambiguous the pattern was — a bubble with an explicit "SEE" is a link, a
 * bare sheet-number-shaped token is only a guess and is left out.
 *
 * No I/O. Resolution of a target number to a real sheet is the pipeline's job.
 */
import type { PositionedItem } from "./pdf.js";

export type CalloutKind = "detail" | "section" | "elevation" | "sheet" | "typical";

export interface CalloutDetection {
  /** the callout as written, e.g. "3/A-501" or "SEE A-502" */
  label: string;
  /** the sheet number named, normalised ("A-501") */
  targetNumber: string;
  kind: CalloutKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1 — never 1: a regex reading is never a person's reading */
  confidence: number;
}

export interface SpecCitation {
  /** as written, e.g. "03 30 00" */
  code: string;
  /** separators stripped */
  normalisedCode: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

const SHEET = String.raw`([A-Z]{1,3}[-–]?\d{1,4}(?:\.\d{1,2})?[A-Z]?)`;
const CALLOUT_RE = new RegExp(String.raw`\b(\d{1,2}|[A-Z])\s*/\s*${SHEET}\b`, "g");
// The optional detail id ("4" in "SEE DETAIL 4/A-501") must be followed by a
// separator — a slash, " ON " or whitespace — so it can never swallow the
// first letter of the sheet number itself ("SEE REV-2" is not "EV-2").
const SEE_RE = new RegExp(
  String.raw`\b(?:SEE|REFER(?:\s+TO)?)\s+(?:(DETAIL|SECTION|ELEV(?:ATION)?|SHEET|DWG\.?|PLAN)\s*)?(?:(\d{1,2}|[A-Z])(?:\s*/\s*|\s+ON\s+|\s+))?(?:SHEET\s+|DWG\.?\s+)?${SHEET}\b`,
  "g",
);
const TYP_RE = /\b(TYP\.?|TYPICAL|SIM\.?|SIMILAR)\b/i;
const SPEC_RE = /\b(?:SECTION|SPEC(?:IFICATION)?\.?)\s*(\d{2})[ .\-]?(\d{2})[ .\-]?(\d{2})\b/g;
const BARE_SHEET_RE = new RegExp(String.raw`^${SHEET}$`);
const BARE_DETAIL_RE = /^(\d{1,2}|[A-Z])$/;

const PREFIX_BLACKLIST = new Set(["NO", "PG", "REV", "TEL", "FAX", "LOT", "PH", "PO", "RM", "TYP"]);

export function normaliseSheetNumber(raw: string): string {
  return raw.toUpperCase().replace(/[–—]/g, "-").trim();
}

function prefixOk(number: string): boolean {
  const prefix = (number.match(/^[A-Z]+/) ?? [""])[0];
  return prefix.length > 0 && !PREFIX_BLACKLIST.has(prefix);
}

function kindFor(word: string | undefined, detail: string | undefined): CalloutKind {
  const w = (word ?? "").toUpperCase();
  if (w.startsWith("SECTION")) return "section";
  if (w.startsWith("ELEV")) return "elevation";
  if (w.startsWith("DETAIL")) return "detail";
  if (detail) return "detail";
  return "sheet";
}

const rect = (it: PositionedItem) => ({ x: it.x, y: it.y, w: it.w, h: it.h });

function union(a: PositionedItem, b: PositionedItem) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Find every callout on a page. `ownNumber` is excluded — a title block
 * naming its own sheet is not a link.
 */
export function detectCallouts(items: PositionedItem[], ownNumber: string | null): CalloutDetection[] {
  const own = ownNumber ? normaliseSheetNumber(ownNumber) : null;
  const out: CalloutDetection[] = [];
  const seen = new Set<string>();
  const push = (c: CalloutDetection) => {
    if (c.targetNumber === own) return;
    if (!prefixOk(c.targetNumber)) return;
    const key = `${c.targetNumber}|${c.x.toFixed(2)}|${c.y.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, confidence: Math.round(Math.min(0.95, c.confidence) * 100) / 100 });
  };

  for (const it of items) {
    const text = it.t.toUpperCase();
    const typical = TYP_RE.test(text);
    for (const m of text.matchAll(SEE_RE)) {
      const number = normaliseSheetNumber(m[3]!);
      push({
        label: m[0].replace(/\s+/g, " ").trim(),
        targetNumber: number,
        kind: kindFor(m[1], m[2]),
        ...rect(it),
        confidence: 0.9 - (typical ? 0.05 : 0),
      });
    }
    for (const m of text.matchAll(CALLOUT_RE)) {
      const number = normaliseSheetNumber(m[2]!);
      push({
        label: `${m[1]}/${number}`,
        targetNumber: number,
        kind: "detail",
        ...rect(it),
        confidence: 0.8 - (typical ? 0.05 : 0),
      });
    }
  }

  // Stacked bubble: a lone detail id directly above a lone sheet number,
  // horizontally overlapping and within ~2.5 line heights.
  for (const top of items) {
    const t = top.t.trim().toUpperCase();
    if (!BARE_DETAIL_RE.test(t)) continue;
    for (const below of items) {
      if (below === top) continue;
      const b = normaliseSheetNumber(below.t.trim());
      if (!BARE_SHEET_RE.test(b)) continue;
      const dy = below.y - (top.y + top.h);
      if (dy < -0.002 || dy > Math.max(top.h, below.h) * 2.5 + 0.004) continue;
      const overlap = Math.min(top.x + top.w, below.x + below.w) - Math.max(top.x, below.x);
      if (overlap <= 0) continue;
      push({
        label: `${t}/${b}`,
        targetNumber: b,
        kind: "detail",
        ...union(top, below),
        confidence: 0.7,
      });
    }
  }
  return out;
}

/** Spec section citations on a sheet ("SECTION 03 30 00"). */
export function detectSpecCitations(items: PositionedItem[]): SpecCitation[] {
  const out: SpecCitation[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    for (const m of it.t.toUpperCase().matchAll(SPEC_RE)) {
      const code = `${m[1]} ${m[2]} ${m[3]}`;
      const normalisedCode = `${m[1]}${m[2]}${m[3]}`;
      const key = `${normalisedCode}|${it.x.toFixed(2)}|${it.y.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code, normalisedCode, ...rect(it), confidence: 0.85 });
    }
  }
  return out;
}
