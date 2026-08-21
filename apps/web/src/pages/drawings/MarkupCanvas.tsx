/**
 * Screen-space overlay canvas: published markup layers (read-only), my
 * personal layer, the in-progress draft shape, selection halo, calibration
 * picks and record pins. Redraws on every prop change — shapes are converted
 * from normalized sheet coordinates through the current view transform, so
 * pan/zoom stays perfectly crisp with constant-size pins/handles.
 */
import { useEffect, useRef } from "react";
import { drawShape, toScreen } from "./tools";
import {
  PIN_STYLE,
  type MarkupShape,
  type PageSize,
  type PinRecord,
  type SheetPoint,
  type ViewTransform,
} from "./types";

export interface MarkupCanvasProps {
  width: number;
  height: number;
  page: PageSize | null;
  transform: ViewTransform;
  publishedShapes: MarkupShape[];
  showPublished: boolean;
  myShapes: MarkupShape[];
  showMine: boolean;
  draft: MarkupShape | null;
  selectedIndex: number | null;
  pins: PinRecord[];
  showPins: boolean;
  activePinId: string | null;
  calibrationPoints: SheetPoint[];
  /** compare mode hides markup layers entirely */
  compareMode: boolean;
}

export const PIN_RADIUS = 11;

export function drawPin(
  ctx: CanvasRenderingContext2D,
  pin: PinRecord,
  page: PageSize,
  t: ViewTransform,
  active: boolean,
): void {
  const style = PIN_STYLE[pin.recordType] ?? { letter: "?", color: "#475569" };
  const p = toScreen({ x: pin.x, y: pin.y }, page, t);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, PIN_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = style.color;
  ctx.fill();
  ctx.lineWidth = active ? 3 : 2;
  ctx.strokeStyle = active ? "#0f172a" : "#ffffff";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.letter, p.x, p.y + 0.5);
  ctx.restore();
}

export default function MarkupCanvas(props: MarkupCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(props.width * dpr));
    canvas.height = Math.max(1, Math.floor(props.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, props.width, props.height);
    const { page, transform } = props;
    if (!page) return;

    if (!props.compareMode) {
      if (props.showPublished) {
        for (const shape of props.publishedShapes) {
          drawShape(ctx, shape, page, transform, { alpha: 0.85 });
        }
      }
      if (props.showMine) {
        props.myShapes.forEach((shape, i) => {
          drawShape(ctx, shape, page, transform, { selected: i === props.selectedIndex });
        });
      }
      if (props.draft) drawShape(ctx, props.draft, page, transform, { alpha: 0.9 });

      // calibration picks: crosshair dots
      for (const cp of props.calibrationPoints) {
        const p = toScreen(cp, page, transform);
        ctx.save();
        ctx.strokeStyle = "#7c3aed";
        ctx.fillStyle = "#7c3aed";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(p.x - 10, p.y);
        ctx.lineTo(p.x + 10, p.y);
        ctx.moveTo(p.x, p.y - 10);
        ctx.lineTo(p.x, p.y + 10);
        ctx.stroke();
        ctx.restore();
      }
      if (props.calibrationPoints.length === 2) {
        const a = toScreen(props.calibrationPoints[0]!, page, transform);
        const b = toScreen(props.calibrationPoints[1]!, page, transform);
        ctx.save();
        ctx.strokeStyle = "#7c3aed";
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }

      if (props.showPins) {
        for (const pin of props.pins) {
          drawPin(ctx, pin, page, transform, pin.id === props.activePinId);
        }
      }
    }
  }, [props]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0"
      style={{ width: props.width, height: props.height }}
    />
  );
}
