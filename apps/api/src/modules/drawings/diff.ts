/**
 * Revision change detection (spec Vol I #262) — pure.
 *
 * Compares the positioned text items of two revisions of a sheet and
 * reports (a) a verdict — changed / unchanged / unknown — and (b) the
 * changed regions as normalised rectangles, each carrying what moved in or
 * out of it. It is a VECTOR diff of the text layer: geometry-only edits
 * (a moved wall with no annotation change) are outside its reach, and the
 * verdict says `unknown` rather than `unchanged` when either revision has no
 * text layer, because "we could not tell" and "nothing changed" are
 * different claims.
 *
 * Also exported: the overlap tests the pipeline uses to flag carried-forward
 * markups and pinned records that sit inside a changed region.
 */
import type { DrawingChangedRegion } from "@constructos/db";
import type { PositionedItem } from "./pdf.js";

export type ChangeVerdict = "changed" | "unchanged" | "unknown";

export interface DiffStats {
  prevItems: number;
  nextItems: number;
  added: number;
  removed: number;
  moved: number;
  common: number;
  /** 0..1 share of items that differ, relative to the larger revision */
  changeRatio: number | null;
}

export interface DiffResult {
  verdict: ChangeVerdict;
  regions: DrawingChangedRegion[];
  stats: DiffStats;
  basis: string;
}

/** Position quantum: items within this distance count as "the same place". */
const POSITION_STEP = 0.004;
/** Regions closer than this (normalised) are merged into one box. */
const MERGE_GAP = 0.02;
const MAX_REGIONS = 200;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
const quant = (n: number) => Math.round(n / POSITION_STEP);

function key(it: PositionedItem): string {
  return `${norm(it.t)}|${quant(it.x)}|${quant(it.y)}`;
}

interface Tagged {
  item: PositionedItem;
  kind: "added" | "removed" | "moved";
}

function gap(a: DrawingChangedRegion, b: DrawingChangedRegion): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

function merge(a: DrawingChangedRegion, b: DrawingChangedRegion): DrawingChangedRegion {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
    kind: a.kind === b.kind ? a.kind : "moved",
    items: a.items + b.items,
    sample: a.sample.length >= b.sample.length ? a.sample : b.sample,
  };
}

/** Cluster tagged items into rectangles. Deterministic: sorted by y then x. */
export function clusterRegions(tagged: Tagged[]): DrawingChangedRegion[] {
  const sorted = [...tagged].sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);
  const regions: DrawingChangedRegion[] = [];
  for (const t of sorted) {
    const r: DrawingChangedRegion = {
      x: t.item.x,
      y: t.item.y,
      w: Math.max(t.item.w, 0.002),
      h: Math.max(t.item.h, 0.002),
      kind: t.kind,
      items: 1,
      sample: t.item.t.trim().slice(0, 80),
    };
    let merged = false;
    for (let i = 0; i < regions.length; i++) {
      const existing = regions[i]!;
      if (gap(existing, r) <= MERGE_GAP) {
        regions[i] = merge(existing, r);
        merged = true;
        break;
      }
    }
    if (!merged) regions.push(r);
  }
  // A second pass catches chains that only became adjacent after merging.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < regions.length && !changed; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (gap(regions[i]!, regions[j]!) <= MERGE_GAP) {
          regions[i] = merge(regions[i]!, regions[j]!);
          regions.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  const rounded = regions.map((r) => ({
    ...r,
    x: Math.round(r.x * 10000) / 10000,
    y: Math.round(r.y * 10000) / 10000,
    w: Math.round(r.w * 10000) / 10000,
    h: Math.round(r.h * 10000) / 10000,
  }));
  rounded.sort((a, b) => b.items - a.items || a.y - b.y || a.x - b.x);
  return rounded.slice(0, MAX_REGIONS);
}

/**
 * Diff two revisions' positioned items. `prevHasText`/`nextHasText` let the
 * caller state that a revision had no text layer even when the item arrays
 * are empty for another reason.
 */
export function diffTextItems(
  prev: PositionedItem[],
  next: PositionedItem[],
  options: { prevHasText?: boolean; nextHasText?: boolean } = {},
): DiffResult {
  const prevHasText = options.prevHasText ?? prev.length > 0;
  const nextHasText = options.nextHasText ?? next.length > 0;
  if (!prevHasText || !nextHasText) {
    return {
      verdict: "unknown",
      regions: [],
      stats: {
        prevItems: prev.length,
        nextItems: next.length,
        added: 0,
        removed: 0,
        moved: 0,
        common: 0,
        changeRatio: null,
      },
      basis: !prevHasText && !nextHasText
        ? "Neither revision has a text layer; the vector diff cannot compare them."
        : !prevHasText
          ? "The superseded revision has no text layer; nothing to compare the new text against."
          : "The new revision has no text layer; the diff cannot see what it contains.",
    };
  }

  // Multiset match on (text, quantised position).
  const prevCounts = new Map<string, PositionedItem[]>();
  for (const it of prev) {
    const k = key(it);
    const list = prevCounts.get(k) ?? [];
    list.push(it);
    prevCounts.set(k, list);
  }
  let common = 0;
  const addedRaw: PositionedItem[] = [];
  for (const it of next) {
    const list = prevCounts.get(key(it));
    if (list && list.length > 0) {
      list.pop();
      common += 1;
    } else {
      addedRaw.push(it);
    }
  }
  const removedRaw: PositionedItem[] = [];
  for (const list of prevCounts.values()) removedRaw.push(...list);

  // Same text present on both sides at different places → "moved".
  const removedByText = new Map<string, PositionedItem[]>();
  for (const it of removedRaw) {
    const k = norm(it.t);
    const list = removedByText.get(k) ?? [];
    list.push(it);
    removedByText.set(k, list);
  }
  const tagged: Tagged[] = [];
  let moved = 0;
  for (const it of addedRaw) {
    const list = removedByText.get(norm(it.t));
    if (list && list.length > 0) {
      const from = list.pop()!;
      moved += 1;
      tagged.push({ item: it, kind: "moved" });
      tagged.push({ item: from, kind: "moved" });
    } else {
      tagged.push({ item: it, kind: "added" });
    }
  }
  for (const list of removedByText.values()) {
    for (const it of list) tagged.push({ item: it, kind: "removed" });
  }
  const added = addedRaw.length - moved;
  const removed = removedRaw.length - moved;
  const larger = Math.max(prev.length, next.length, 1);
  const changeRatio = Math.round(((added + removed + moved) / larger) * 10000) / 10000;
  const regions = clusterRegions(tagged);
  const verdict: ChangeVerdict = added + removed + moved === 0 ? "unchanged" : "changed";
  return {
    verdict,
    regions,
    stats: { prevItems: prev.length, nextItems: next.length, added, removed, moved, common, changeRatio },
    basis:
      verdict === "unchanged"
        ? `Every one of ${next.length} text items matches the superseded revision at the same position. Geometry-only changes are outside this diff.`
        : `${added} text item(s) added, ${removed} removed, ${moved} moved across ${regions.length} region(s), against ${common} unchanged.`,
  };
}

/* ------------------------------------------------------------------ */
/* Overlap helpers                                                     */
/* ------------------------------------------------------------------ */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectsOverlap(a: NormRect, b: NormRect, pad = 0): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

export function pointInRegions(p: { x: number; y: number }, regions: NormRect[], pad = 0.005): boolean {
  return regions.some((r) => rectsOverlap({ x: p.x, y: p.y, w: 0, h: 0 }, r, pad));
}

/** Minimal server-side bounds of a markup shape (mirrors the web's shapeBounds). */
export function shapeBounds(shape: unknown): NormRect | null {
  if (!shape || typeof shape !== "object") return null;
  const s = shape as Record<string, unknown>;
  const pt = (v: unknown): { x: number; y: number } | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as { x?: unknown; y?: unknown };
    return typeof o.x === "number" && typeof o.y === "number" ? { x: o.x, y: o.y } : null;
  };
  if (s["kind"] === "pen" && Array.isArray(s["points"])) {
    const pts = (s["points"] as unknown[]).map(pt).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length === 0) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (s["kind"] === "text") {
    const at = pt(s["at"]);
    return at ? { x: at.x, y: at.y, w: 0.02, h: 0.01 } : null;
  }
  const from = pt(s["from"]);
  const to = pt(s["to"]);
  if (!from || !to) return null;
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
}

/** Indexes of shapes whose bounds overlap any changed region. */
export function shapesInRegions(shapes: unknown[], regions: NormRect[]): number[] {
  const out: number[] = [];
  shapes.forEach((shape, i) => {
    const b = shapeBounds(shape);
    if (b && regions.some((r) => rectsOverlap(b, r, 0.005))) out.push(i);
  });
  return out;
}
