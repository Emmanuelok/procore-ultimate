/**
 * Pure geometry + canvas drawing helpers for the sheet viewer.
 *
 * Coordinate systems:
 * - normalized: SheetPoint with x/y in 0..1 relative to the page.
 * - page space:  css px at pdf.js scale 1 (normalized * pageSize).
 * - screen space: page space * transform.scale + transform.offset.
 *
 * All functions here are pure (no React) and exported for testing.
 */
import type {
  MarkupShape,
  PageSize,
  SheetCalibration,
  SheetPoint,
  ViewTransform,
} from "./types";

/* ------------------------------- transforms ------------------------------- */

export function toScreen(p: SheetPoint, page: PageSize, t: ViewTransform): { x: number; y: number } {
  return {
    x: p.x * page.width * t.scale + t.offsetX,
    y: p.y * page.height * t.scale + t.offsetY,
  };
}

export function toNormalized(
  screen: { x: number; y: number },
  page: PageSize,
  t: ViewTransform,
): SheetPoint {
  return {
    x: (screen.x - t.offsetX) / (t.scale * page.width),
    y: (screen.y - t.offsetY) / (t.scale * page.height),
  };
}

export function clamp01(p: SheetPoint): SheetPoint {
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

/** Zoom around a fixed screen point, returning the new transform. */
export function zoomAround(
  t: ViewTransform,
  factor: number,
  cx: number,
  cy: number,
  minScale = 0.05,
  maxScale = 16,
): ViewTransform {
  const scale = Math.min(maxScale, Math.max(minScale, t.scale * factor));
  const k = scale / t.scale;
  return {
    scale,
    offsetX: cx - (cx - t.offsetX) * k,
    offsetY: cy - (cy - t.offsetY) * k,
  };
}

/** Fit the page inside a container width/height with padding, centered. */
export function fitTransform(
  page: PageSize,
  containerW: number,
  containerH: number,
  pad = 24,
): ViewTransform {
  const scale = Math.max(
    0.05,
    Math.min((containerW - pad * 2) / page.width, (containerH - pad * 2) / page.height),
  );
  return {
    scale,
    offsetX: (containerW - page.width * scale) / 2,
    offsetY: (containerH - page.height * scale) / 2,
  };
}

/* ------------------------------ measurement ------------------------------- */

/** Length of a normalized segment in page px (accounts for page aspect). */
export function segmentPageLength(from: SheetPoint, to: SheetPoint, page: PageSize): number {
  const dx = (from.x - to.x) * page.width;
  const dy = (from.y - to.y) * page.height;
  return Math.hypot(dx, dy);
}

/** Real-world length of a segment given a sheet calibration. */
export function measureValue(
  from: SheetPoint,
  to: SheetPoint,
  calibration: SheetCalibration,
  page: PageSize,
): number {
  const calLen = segmentPageLength(calibration.from, calibration.to, page);
  if (calLen <= 0) return 0;
  return (segmentPageLength(from, to, page) / calLen) * calibration.realDistance;
}

export function formatMeasure(value: number, unit: string): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return `${rounded} ${unit}`;
}

/* ------------------------------- hit testing ------------------------------ */

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Normalized bounding box of a shape as {x1,y1,x2,y2}. */
export function shapeBounds(shape: MarkupShape): { x1: number; y1: number; x2: number; y2: number } {
  if (shape.kind === "pen") {
    const xs = shape.points.map((p) => p.x);
    const ys = shape.points.map((p) => p.y);
    return {
      x1: Math.min(...xs, 1),
      y1: Math.min(...ys, 1),
      x2: Math.max(...xs, 0),
      y2: Math.max(...ys, 0),
    };
  }
  if (shape.kind === "text") {
    return { x1: shape.at.x, y1: shape.at.y, x2: shape.at.x + 0.001, y2: shape.at.y + 0.001 };
  }
  return {
    x1: Math.min(shape.from.x, shape.to.x),
    y1: Math.min(shape.from.y, shape.to.y),
    x2: Math.max(shape.from.x, shape.to.x),
    y2: Math.max(shape.from.y, shape.to.y),
  };
}

/**
 * Hit test in SCREEN space so tolerance is a constant number of pixels
 * regardless of zoom. Returns true when the pointer is on the shape.
 */
export function hitTestShape(
  shape: MarkupShape,
  screen: { x: number; y: number },
  page: PageSize,
  t: ViewTransform,
  tolerance = 8,
): boolean {
  const S = (p: SheetPoint) => toScreen(p, page, t);
  switch (shape.kind) {
    case "pen": {
      for (let i = 1; i < shape.points.length; i++) {
        if (distToSegment(screen, S(shape.points[i - 1]!), S(shape.points[i]!)) <= tolerance) return true;
      }
      return shape.points.length === 1 && Math.hypot(screen.x - S(shape.points[0]!).x, screen.y - S(shape.points[0]!).y) <= tolerance;
    }
    case "line":
    case "arrow":
    case "measure":
      return distToSegment(screen, S(shape.from), S(shape.to)) <= tolerance;
    case "rect":
    case "cloud": {
      const a = S(shape.from);
      const b = S(shape.to);
      const x1 = Math.min(a.x, b.x);
      const y1 = Math.min(a.y, b.y);
      const x2 = Math.max(a.x, b.x);
      const y2 = Math.max(a.y, b.y);
      // near any of the 4 edges
      return (
        distToSegment(screen, { x: x1, y: y1 }, { x: x2, y: y1 }) <= tolerance ||
        distToSegment(screen, { x: x2, y: y1 }, { x: x2, y: y2 }) <= tolerance ||
        distToSegment(screen, { x: x2, y: y2 }, { x: x1, y: y2 }) <= tolerance ||
        distToSegment(screen, { x: x1, y: y2 }, { x: x1, y: y1 }) <= tolerance
      );
    }
    case "ellipse": {
      const a = S(shape.from);
      const b = S(shape.to);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.max(1, Math.abs(b.x - a.x) / 2);
      const ry = Math.max(1, Math.abs(b.y - a.y) / 2);
      // distance from unit circle in normalized ellipse space
      const nx = (screen.x - cx) / rx;
      const ny = (screen.y - cy) / ry;
      const d = Math.abs(Math.hypot(nx, ny) - 1);
      return d * Math.min(rx, ry) <= tolerance;
    }
    case "text": {
      const at = S(shape.at);
      const size = shape.fontSize * t.scale;
      const w = Math.max(40, shape.text.length * size * 0.6);
      return (
        screen.x >= at.x - tolerance &&
        screen.x <= at.x + w + tolerance &&
        screen.y >= at.y - size - tolerance &&
        screen.y <= at.y + tolerance + size * 0.35
      );
    }
    default:
      return false;
  }
}

/** Translate a shape by a normalized delta. */
export function translateShape(shape: MarkupShape, dx: number, dy: number): MarkupShape {
  const mv = (p: SheetPoint): SheetPoint => ({ x: p.x + dx, y: p.y + dy });
  switch (shape.kind) {
    case "pen":
      return { ...shape, points: shape.points.map(mv) };
    case "text":
      return { ...shape, at: mv(shape.at) };
    default:
      return { ...shape, from: mv(shape.from), to: mv(shape.to) };
  }
}

/* -------------------------------- drawing --------------------------------- */

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 6), to.y - size * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 6), to.y - size * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function drawCloudPath(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const w = x2 - x1;
  const h = y2 - y1;
  const perim: { x: number; y: number }[] = [];
  const step = Math.max(14, Math.min(36, Math.min(Math.abs(w), Math.abs(h)) / 3 || 20));
  const push = (ax: number, ay: number, bx: number, by: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      perim.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n });
    }
  };
  push(x1, y1, x2, y1);
  push(x2, y1, x2, y2);
  push(x2, y2, x1, y2);
  push(x1, y2, x1, y1);
  if (perim.length < 3) return;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  ctx.beginPath();
  ctx.moveTo(perim[0]!.x, perim[0]!.y);
  for (let i = 1; i <= perim.length; i++) {
    const prev = perim[i - 1]!;
    const cur = perim[i % perim.length]!;
    const mx = (prev.x + cur.x) / 2;
    const my = (prev.y + cur.y) / 2;
    // bulge outward: away from the rect centre
    let ox = mx - cx;
    let oy = my - cy;
    const olen = Math.hypot(ox, oy) || 1;
    const bulge = Math.hypot(cur.x - prev.x, cur.y - prev.y) * 0.66;
    ox = (ox / olen) * bulge;
    oy = (oy / olen) * bulge;
    ctx.quadraticCurveTo(mx + ox, my + oy, cur.x, cur.y);
  }
  ctx.stroke();
}

export interface DrawOptions {
  /** dim published layers slightly */
  alpha?: number;
  /** dashed selection halo */
  selected?: boolean;
}

/** Draw a single markup shape onto a 2D context in screen space. */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkupShape,
  page: PageSize,
  t: ViewTransform,
  opts: DrawOptions = {},
): void {
  const S = (p: SheetPoint) => toScreen(p, page, t);
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const widthPx = ("width" in shape ? shape.width : 2) * t.scale;
  ctx.lineWidth = Math.max(0.75, widthPx);
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;

  switch (shape.kind) {
    case "pen": {
      if (shape.points.length === 0) break;
      ctx.beginPath();
      const p0 = S(shape.points[0]!);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < shape.points.length; i++) {
        const p = S(shape.points[i]!);
        ctx.lineTo(p.x, p.y);
      }
      if (shape.points.length === 1) ctx.lineTo(p0.x + 0.1, p0.y);
      ctx.stroke();
      break;
    }
    case "line": {
      const a = S(shape.from);
      const b = S(shape.to);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const a = S(shape.from);
      const b = S(shape.to);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      drawArrowHead(ctx, a, b, Math.max(8, 4 * ctx.lineWidth));
      break;
    }
    case "rect": {
      const a = S(shape.from);
      const b = S(shape.to);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    }
    case "ellipse": {
      const a = S(shape.from);
      const b = S(shape.to);
      ctx.beginPath();
      ctx.ellipse(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        Math.abs(b.x - a.x) / 2,
        Math.abs(b.y - a.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "cloud": {
      const a = S(shape.from);
      const b = S(shape.to);
      drawCloudPath(ctx, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
      break;
    }
    case "text": {
      const at = S(shape.at);
      const size = Math.max(6, shape.fontSize * t.scale);
      ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "alphabetic";
      const lines = shape.text.split("\n");
      lines.forEach((line, i) => ctx.fillText(line, at.x, at.y + i * size * 1.25));
      break;
    }
    case "measure": {
      const a = S(shape.from);
      const b = S(shape.to);
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // end ticks
      const angle = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      const tick = 6;
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.moveTo(p.x - tick * Math.cos(angle), p.y - tick * Math.sin(angle));
        ctx.lineTo(p.x + tick * Math.cos(angle), p.y + tick * Math.sin(angle));
        ctx.stroke();
      }
      if (shape.value !== undefined) {
        const label = formatMeasure(shape.value, shape.unit ?? "");
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.font = "600 12px Inter, system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        ctx.save();
        ctx.translate(mx, my);
        let rot = Math.atan2(b.y - a.y, b.x - a.x);
        if (rot > Math.PI / 2 || rot < -Math.PI / 2) rot += Math.PI;
        ctx.rotate(rot);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(-tw / 2 - 4, -18, tw + 8, 16);
        ctx.fillStyle = shape.color;
        ctx.fillText(label, -tw / 2, -6);
        ctx.restore();
      }
      break;
    }
  }

  if (opts.selected) {
    const b = shapeBounds(shape);
    const a = S({ x: b.x1, y: b.y1 });
    const c = S({ x: b.x2, y: b.y2 });
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "#2563eb";
    ctx.strokeRect(a.x - 6, a.y - 6, c.x - a.x + 12, c.y - a.y + 12);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/* ------------------------- revision compare compositing ------------------- */

/**
 * Bluebeam-style overlay: old-only linework red, new-only blue, common dark,
 * background white. Implemented by inverting each render (lines become light
 * on black), tinting (old→cyan, new→yellow), additive "screen" compositing,
 * then inverting the result. oldAlpha fades the old layer out.
 */
export function compositeCompare(
  target: HTMLCanvasElement,
  oldCanvas: HTMLCanvasElement,
  newCanvas: HTMLCanvasElement,
  oldAlpha: number,
): void {
  const w = Math.max(oldCanvas.width, newCanvas.width);
  const h = Math.max(oldCanvas.height, newCanvas.height);
  target.width = w;
  target.height = h;
  const ctx = target.getContext("2d");
  if (!ctx || w === 0 || h === 0) return;

  const tinted = (src: HTMLCanvasElement, color: string): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cc = c.getContext("2d")!;
    cc.fillStyle = "#ffffff";
    cc.fillRect(0, 0, w, h);
    cc.drawImage(src, 0, 0);
    cc.globalCompositeOperation = "difference";
    cc.fillStyle = "#ffffff";
    cc.fillRect(0, 0, w, h); // invert: lines light on black
    cc.globalCompositeOperation = "multiply";
    cc.fillStyle = color;
    cc.fillRect(0, 0, w, h); // tint
    return c;
  };

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = Math.min(1, Math.max(0, oldAlpha));
  ctx.drawImage(tinted(oldCanvas, "#00ffff"), 0, 0); // → red after final invert
  ctx.globalAlpha = 1;
  ctx.drawImage(tinted(newCanvas, "#ffff00"), 0, 0); // → blue after final invert
  ctx.globalCompositeOperation = "difference";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h); // final invert
  ctx.globalCompositeOperation = "source-over";
}

/* ------------------------------------------------------------------------- */
/* Pen stroke simplification                                                  */
/* ------------------------------------------------------------------------- */

function perpendicularDistance(p: SheetPoint, a: SheetPoint, b: SheetPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Douglas–Peucker in normalised sheet units. A 120 Hz scribble produces
 * thousands of near-collinear points; at 0.0006 (≈ half a pixel on a fitted
 * A1 sheet) the stroke is visually identical and an order of magnitude
 * smaller, which keeps it under the API's per-stroke cap.
 */
export function simplifyStroke(points: SheetPoint[], tolerance = 0.0006): SheetPoint[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    const a = points[start]!;
    const b = points[end]!;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i]!, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Split an over-long stroke into consecutive strokes that share a joint point. */
export function splitStroke(points: SheetPoint[], max: number): SheetPoint[][] {
  if (points.length <= max) return [points];
  const out: SheetPoint[][] = [];
  for (let i = 0; i < points.length; i += max - 1) {
    const chunk = points.slice(i, i + max);
    if (chunk.length >= 2) out.push(chunk);
    if (i + max >= points.length) break;
  }
  return out;
}
