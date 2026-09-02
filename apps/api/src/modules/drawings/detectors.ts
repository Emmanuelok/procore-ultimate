/**
 * Pure heuristics for the drawing pipeline: sheet number / title extraction
 * from a PDF text stream and discipline classification from the sheet number
 * prefix (spec Vol I #257, #258, #266).
 *
 * These are deliberately dependency-free pure functions so they can be
 * unit-tested against realistic text-stream strings.
 */

import type { DrawingDiscipline } from "@constructos/shared";
import type { PositionedItem } from "./pdf.js";

/** Sheet-number pattern: A-101, S1.02, FP-3, M-101A, C-1.10 ... */
const NUMBER_RE = /\b([A-Z]{1,3}[-–.]?\d{1,4}(?:\.\d{1,2})?[A-Za-z]?)\b/g;

/** Letter prefixes that look like sheet numbers but never are. */
const PREFIX_BLACKLIST = new Set([
  "NO",
  "PG",
  "REV",
  "TEL",
  "FAX",
  "LOT",
  "PH",
  "PO",
  "RM",
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
]);

/** Title-block labels: a line containing one of these is metadata, not a title. */
const LABEL_RE =
  /SCALE|DRAWN|CHECKED|APPROVED|DESIGNED|REVIEWED|PROJECT\s*(NO|NUMBER|#)|DWG|ISSUE|CONTRACT|CLIENT|ARCHITECT OF RECORD/i;

const PREFIX_DISCIPLINE: Record<string, DrawingDiscipline> = {
  G: "general",
  C: "civil",
  A: "architectural",
  S: "structural",
  M: "mechanical",
  E: "electrical",
  P: "plumbing",
  FP: "fire_protection",
  L: "landscape",
  I: "interiors",
  ID: "interiors",
  T: "telecom",
};

/** Map a sheet number's letter prefix to a discipline (spec #266). */
export function disciplineForNumber(number: string): DrawingDiscipline {
  const prefix = (number.trim().toUpperCase().match(/^[A-Z]+/) ?? [""])[0];
  if (!prefix) return "other";
  if (PREFIX_DISCIPLINE[prefix]) return PREFIX_DISCIPLINE[prefix];
  const first = prefix[0]!;
  return PREFIX_DISCIPLINE[first] ?? "other";
}

/**
 * Next revision label in the 0 → A → B → … → Z → AA → AB sequence.
 * A non-lettered current revision (e.g. "0", "1") advances to "A".
 */
export function nextRevisionLabel(prev: string | null | undefined): string {
  if (prev == null || prev.trim() === "") return "0";
  const p = prev.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(p)) return "A";
  const chars = p.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== "Z") {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[i] = "A";
  }
  return `A${chars.join("")}`;
}

export interface NumberMatch {
  value: string;
  index: number;
}

/**
 * Find the most plausible sheet number in a page's text stream. The title
 * block is normally emitted late in the stream, so the LAST plausible match
 * wins.
 */
export function detectSheetNumber(text: string): NumberMatch | null {
  const candidates: NumberMatch[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[1]!;
    const prefix = (raw.match(/^[A-Z]+/) ?? [""])[0];
    if (!prefix || PREFIX_BLACKLIST.has(prefix)) continue;
    const at = m.index;
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const lineEndRaw = text.indexOf("\n", at);
    const line = text.slice(lineStart, lineEndRaw === -1 ? text.length : lineEndRaw);
    // Skip matches on scale ("1/8\" = 1'-0\"" rows tagged SCALE) or date rows.
    if (/SCALE|DATE/i.test(line)) continue;
    candidates.push({ value: raw.toUpperCase().replace(/–/g, "-"), index: at });
  }
  return candidates.length ? candidates[candidates.length - 1]! : null;
}

interface Line {
  text: string;
  start: number;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const part of text.split("\n")) {
    lines.push({ text: part, start });
    start += part.length + 1;
  }
  return lines;
}

/**
 * Find the sheet title: the best mostly-uppercase text run near the sheet
 * number that is not a date, scale or title-block label.
 */
export function detectSheetTitle(
  text: string,
  numberIndex: number | null,
  numberValue: string | null,
): string | null {
  const lines = splitLines(text);
  let numberLine: number | null = null;
  if (numberIndex != null) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (numberIndex >= l.start && numberIndex < l.start + l.text.length + 1) {
        numberLine = i;
        break;
      }
    }
  }

  let best: { title: string; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.text.trim();
    if (raw.length < 4 || raw.length > 80) continue;
    const letters = raw.replace(/[^A-Za-z]/g, "");
    if (letters.length < 4) continue;
    const upper = letters.replace(/[^A-Z]/g, "");
    if (upper.length / letters.length < 0.7) continue;
    if (LABEL_RE.test(raw)) continue;
    if (/\b(19|20)\d{2}\b/.test(raw)) continue; // year → probably a date row
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(raw)) continue;

    let cleaned = raw;
    if (numberValue) {
      cleaned = cleaned.split(numberValue).join(" ");
    }
    cleaned = cleaned
      .replace(/\bSHEET\b/gi, " ")
      .replace(/\bNO\.?\b/gi, " ")
      .replace(/\bTITLE\b:?/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.replace(/[^A-Za-z]/g, "").length < 4) continue;

    // Proximity to the sheet number dominates: in a title block the title
    // sits directly beside the number, while project names / notes are
    // further away in the stream.
    const distance =
      numberLine == null ? 0 : Math.min(Math.abs(i - numberLine), 20);
    const score = Math.min(cleaned.length, 60) - distance * 6;
    if (!best || score > best.score) best = { title: cleaned, score };
  }
  return best?.title ?? null;
}

export interface SheetDetection {
  number: string | null;
  title: string | null;
  discipline: DrawingDiscipline;
  /** true when both a number and a title were found */
  confident: boolean;
}

/** Full per-page extraction used by the drawing set pipeline. */
export function detectSheetMeta(text: string): SheetDetection {
  const num = detectSheetNumber(text);
  const title = detectSheetTitle(text, num?.index ?? null, num?.value ?? null);
  return {
    number: num?.value ?? null,
    title,
    discipline: num ? disciplineForNumber(num.value) : "other",
    confident: num != null && title != null,
  };
}

/* ------------------------------------------------------------------ */
/* Positioned detection (WP-DOCS): the title block is a PLACE          */
/* ------------------------------------------------------------------ */


export interface SheetCandidate {
  number: string;
  score: number;
  x: number;
  y: number;
  /** true when the candidate sits in the bottom-right title-block zone */
  titleBlock: boolean;
}

export interface PositionedDetection extends SheetDetection {
  method: "title_block" | "text_stream" | "placeholder";
  /** 0..1 — how strongly the reading is supported */
  confidence: number;
  /** every plausible number seen, best first — the review queue shows these */
  candidates: SheetCandidate[];
  /** a cover / drawing-index page: many sheet numbers, none of them its own */
  isIndexPage: boolean;
  /** the page had no text layer at all (scanned) */
  noTextLayer: boolean;
}

const CALLOUT_LINE_RE = /\/|\bSEE\b|\bDETAIL\b|\bSECTION\b|\bTYP\b|\bSCALE\b|\bDATE\b|\bREFER\b/i;
const INDEX_HINT_RE = /\b(DRAWING|SHEET)\s+(INDEX|LIST|SCHEDULE)\b|\bLIST OF (DRAWINGS|SHEETS)\b|\bINDEX OF (DRAWINGS|SHEETS)\b/i;
const NUMBER_LABEL_RE = /\b(SHEET|DWG|DRAWING)\s*(NO|NUMBER|#)?\b/i;

function inTitleBlock(it: PositionedItem): boolean {
  return it.x >= 0.55 && it.y >= 0.7;
}

/**
 * Sheet number/title from positioned items. The bottom-right quadrant is
 * where a title block lives on nearly every drawing standard, so a number
 * found there outranks the same number found in a note or a callout.
 */
export function detectSheetMetaPositioned(items: PositionedItem[], text: string): PositionedDetection {
  const noTextLayer = items.length === 0 && text.trim() === "";
  const fallback = detectSheetMeta(text);
  const scores = new Map<string, SheetCandidate>();
  const seenNumbers = new Set<string>();
  let indexHint = false;

  for (const it of items) {
    const upper = it.t.toUpperCase();
    if (INDEX_HINT_RE.test(upper)) indexHint = true;
    const calloutLike = CALLOUT_LINE_RE.test(upper);
    for (const m of upper.matchAll(NUMBER_RE)) {
      const raw = m[1]!;
      const prefix = (raw.match(/^[A-Z]+/) ?? [""])[0];
      if (!prefix || PREFIX_BLACKLIST.has(prefix)) continue;
      const number = raw.replace(/–/g, "-");
      seenNumbers.add(number);
      if (calloutLike) continue;
      const isolated = upper.trim() === raw || upper.replace(NUMBER_LABEL_RE, "").trim() === raw;
      const tb = inTitleBlock(it);
      let score = 1;
      if (tb) score += 3;
      if (it.x >= 0.75 && it.y >= 0.8) score += 1;
      if (isolated) score += 2;
      if (it.h >= 0.012) score += 1;
      if (NUMBER_LABEL_RE.test(upper)) score += 2;
      const prev = scores.get(number);
      if (!prev) scores.set(number, { number, score, x: it.x, y: it.y, titleBlock: tb });
      else {
        prev.score = Math.max(prev.score, score) + 0.5;
        if (tb && !prev.titleBlock) {
          prev.titleBlock = true;
          prev.x = it.x;
          prev.y = it.y;
        }
      }
    }
  }

  const candidates = [...scores.values()].sort((a, b) => b.score - a.score || b.y - a.y);
  const distinct = seenNumbers.size;
  const isIndexPage = distinct >= 15 || (distinct >= 8 && indexHint);

  if (isIndexPage) {
    return {
      number: null,
      title: "DRAWING INDEX",
      discipline: "general",
      confident: false,
      method: "placeholder",
      confidence: 0.2,
      candidates: candidates.slice(0, 12),
      isIndexPage: true,
      noTextLayer,
    };
  }

  const best = candidates[0] ?? null;
  const number = best?.number ?? fallback.number;
  const method: PositionedDetection["method"] = best
    ? best.titleBlock
      ? "title_block"
      : "text_stream"
    : number
      ? "text_stream"
      : "placeholder";

  // Title: the largest uppercase run in the title-block zone that is not a label.
  let title: string | null = null;
  if (number) {
    let bestTitle: { text: string; score: number } | null = null;
    for (const it of items) {
      if (it.x < 0.5 || it.y < 0.6) continue;
      const raw = it.t.trim();
      if (raw.length < 4 || raw.length > 80) continue;
      const letters = raw.replace(/[^A-Za-z]/g, "");
      if (letters.length < 4) continue;
      if (letters.replace(/[^A-Z]/g, "").length / letters.length < 0.7) continue;
      if (LABEL_RE.test(raw) || NUMBER_LABEL_RE.test(raw)) continue;
      if (/\b(19|20)\d{2}\b/.test(raw) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(raw)) continue;
      const cleaned = raw.split(number).join(" ").replace(/\s+/g, " ").trim();
      if (cleaned.replace(/[^A-Za-z]/g, "").length < 4) continue;
      const proximity = best ? 1 - Math.min(1, Math.hypot(it.x - best.x, it.y - best.y) * 2) : 0.5;
      const score = it.h * 1000 + proximity * 10 + Math.min(cleaned.length, 40) / 10;
      if (!bestTitle || score > bestTitle.score) bestTitle = { text: cleaned, score };
    }
    title = bestTitle?.text ?? null;
    if (!title) {
      const idx = text.lastIndexOf(number);
      title = detectSheetTitle(text, idx >= 0 ? idx : null, number);
    }
  }

  const confident = number != null && title != null;
  let confidence = 0;
  if (number) {
    confidence = method === "title_block" ? 0.7 : 0.45;
    if (title) confidence += method === "title_block" ? 0.2 : 0.15;
    if (best && best.score >= 6) confidence += 0.05;
  }
  confidence = Math.round(Math.min(0.95, confidence) * 100) / 100;

  return {
    number,
    title,
    discipline: number ? disciplineForNumber(number) : "other",
    confident,
    method,
    confidence,
    candidates: candidates.slice(0, 12),
    isIndexPage: false,
    noTextLayer,
  };
}
