/**
 * Full sheet viewer: PDF canvas with pan/zoom, markup tools (pen, line,
 * arrow, rect, ellipse, cloud, text, measure), calibration, revision compare
 * (red/blue overlay), record pins and a personal-vs-published markup model
 * with debounced auto-save + publish.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  EmptyState,
} from "../../ui";
import { loadPdf, renderPageToCanvas, usePdfPage, type LoadedPdf } from "./usePdfPage";
import MarkupCanvas, { PIN_RADIUS } from "./MarkupCanvas";
import {
  clamp01,
  compositeCompare,
  fitTransform,
  hitTestShape,
  measureValue,
  toNormalized,
  toScreen,
  translateShape,
  zoomAround,
} from "./tools";
import {
  MARKUP_COLORS,
  MARKUP_WIDTHS,
  PIN_RECORD_TYPES,
  PIN_STYLE,
  type ListResponse,
  type MarkupRecord,
  type MarkupShape,
  type PageSize,
  type PinRecord,
  type RevisionSummary,
  type SheetCalibration,
  type SheetDetail,
  type SheetPoint,
  type ToolId,
  type ViewTransform,
} from "./types";
import type { PDFDocumentProxy } from "pdfjs-dist";

/* --------------------------------- icons ---------------------------------- */

function Icon({ d, extra }: { d: string; extra?: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
      {extra}
    </svg>
  );
}

const TOOL_DEFS: { id: ToolId; label: string; icon: ReactNode }[] = [
  { id: "select", label: "Select / move (V)", icon: <Icon d="M5 3l14 8-6.5 1.5L9 19z" /> },
  { id: "pan", label: "Pan (H)", icon: <Icon d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" /> },
  { id: "pen", label: "Pen (P)", icon: <Icon d="M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5z" /> },
  { id: "line", label: "Line (L)", icon: <Icon d="M4 20L20 4" /> },
  { id: "arrow", label: "Arrow (A)", icon: <Icon d="M4 20L20 4M20 4h-7M20 4v7" /> },
  { id: "rect", label: "Rectangle (R)", icon: <Icon d="M4 6h16v12H4z" /> },
  { id: "ellipse", label: "Ellipse (E)", icon: <Icon d="M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z" /> },
  { id: "cloud", label: "Revision cloud (C)", icon: <Icon d="M6.5 18a4 4 0 01-.6-7.9A6 6 0 0117.5 8.5 4 4 0 0117 18z" /> },
  { id: "text", label: "Text (T)", icon: <Icon d="M5 6V4h14v2M12 4v16M9 20h6" /> },
  { id: "measure", label: "Measure (M)", icon: <Icon d="M3 17L17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2" /> },
  { id: "pin", label: "Drop pin (N)", icon: <Icon d="M12 21s-7-6.4-7-11a7 7 0 0114 0c0 4.6-7 11-7 11z" extra={<circle cx="12" cy="10" r="2.4" />} /> },
];

const TOOL_HOTKEYS: Record<string, ToolId> = {
  v: "select",
  h: "pan",
  p: "pen",
  l: "line",
  a: "arrow",
  r: "rect",
  e: "ellipse",
  c: "cloud",
  t: "text",
  m: "measure",
  n: "pin",
};

const UNITS = ["ft", "in", "m", "cm", "mm"];

/* ------------------------------ interactions ------------------------------ */

type Interaction =
  | { mode: "idle" }
  | { mode: "pan"; startX: number; startY: number; startT: ViewTransform }
  | { mode: "draw"; start: SheetPoint }
  | { mode: "move"; index: number; last: SheetPoint; moved: boolean };

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

interface CompareCache {
  sig: string;
  oldC: HTMLCanvasElement;
  newC: HTMLCanvasElement;
  eff: number;
}

/* ---------------------------------- page ---------------------------------- */

export default function SheetViewerPage() {
  const { projectId, sheetId } = useParams<{ projectId: string; sheetId: string }>();
  const navigate = useNavigate();

  /* sheet + revisions */
  const [sheet, setSheet] = useState<SheetDetail | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);

  const revisions = sheet?.revisions ?? [];
  const revision = useMemo(
    () => revisions.find((r) => r.id === revisionId) ?? null,
    [revisions, revisionId],
  );

  /* pdf */
  const pdf = usePdfPage(revision?.fileId ?? null, revision?.pageIndex ?? 0);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  docRef.current = pdf.doc;

  /* view transform */
  const [transform, setTransform] = useState<ViewTransform>({ scale: 1, offsetX: 0, offsetY: 0 });
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const [renderScale, setRenderScale] = useState(1);
  const renderScaleRef = useRef(1);
  renderScaleRef.current = renderScale;
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const fitKeyRef = useRef<string | null>(null);

  /* markups */
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState<string>(MARKUP_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState<number>(2);
  const [myShapes, setMyShapes] = useState<MarkupShape[]>([]);
  const myShapesRef = useRef<MarkupShape[]>([]);
  myShapesRef.current = myShapes;
  const [myMarkupId, setMyMarkupId] = useState<string | null>(null);
  const [publishedShapes, setPublishedShapes] = useState<MarkupShape[]>([]);
  const [showPublished, setShowPublished] = useState(true);
  const [showMine, setShowMine] = useState(true);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const draftRef = useRef<MarkupShape | null>(null);
  /** draft lives in a ref (source of truth) + state (render mirror) so the
   * commit on pointerup never runs side effects inside a state updater. */
  const updateDraft = useCallback((d: MarkupShape | null) => {
    draftRef.current = d;
    setDraft(d);
  }, []);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const saveStateRef = useRef<SaveState>("clean");
  saveStateRef.current = saveState;
  const [markupError, setMarkupError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  /* calibration + measure */
  const [calibration, setCalibration] = useState<SheetCalibration | null>(null);
  const [recalibrating, setRecalibrating] = useState(false);
  const [calibPoints, setCalibPoints] = useState<SheetPoint[]>([]);
  const [calibModalOpen, setCalibModalOpen] = useState(false);
  const [calibDistance, setCalibDistance] = useState("");
  const [calibUnit, setCalibUnit] = useState("ft");

  /* pins */
  const [pins, setPins] = useState<PinRecord[]>([]);
  const [showPins, setShowPins] = useState(true);
  const [pinModal, setPinModal] = useState<{ at: SheetPoint } | null>(null);
  const [pinType, setPinType] = useState<string>("rfi");
  const [pinRecordId, setPinRecordId] = useState("");
  const [activePinId, setActivePinId] = useState<string | null>(null);

  /* text tool */
  const [textModal, setTextModal] = useState<{ at: SheetPoint } | null>(null);
  const [textValue, setTextValue] = useState("");
  const [textSize, setTextSize] = useState(14);

  /* compare */
  const [compareOn, setCompareOn] = useState(false);
  const [otherRevId, setOtherRevId] = useState<string | null>(null);
  const [oldAlpha, setOldAlpha] = useState(1);
  const oldAlphaRef = useRef(1);
  oldAlphaRef.current = oldAlpha;
  const [compareDoc, setCompareDoc] = useState<PDFDocumentProxy | null>(null);
  const compareCacheRef = useRef<CompareCache | null>(null);
  const otherRevision = useMemo(
    () => revisions.find((r) => r.id === otherRevId) ?? null,
    [revisions, otherRevId],
  );

  /* refs for imperative interaction */
  const containerRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const interactionRef = useRef<Interaction>({ mode: "idle" });
  const spaceRef = useRef(false);
  const renderSeqRef = useRef(0);
  const [panning, setPanning] = useState(false);

  const dirty = saveState === "dirty" || saveState === "saving";

  /* ------------------------------ data loading ----------------------------- */

  const loadSheet = useCallback(async () => {
    if (!sheetId) return;
    try {
      const raw = await api.get<Record<string, unknown>>(`/api/v1/sheets/${sheetId}`);
      const base = (raw["sheet"] && typeof raw["sheet"] === "object" ? raw["sheet"] : raw) as Record<string, unknown>;
      const revs = ((raw["revisions"] ?? base["revisions"]) as RevisionSummary[] | undefined) ?? [];
      const detail = { ...(base as unknown as SheetDetail), revisions: revs };
      setSheet(detail);
      setSheetError(null);
      setRevisionId((prev) => {
        if (prev && revs.some((r) => r.id === prev)) return prev;
        const current = detail.currentRevisionId && revs.find((r) => r.id === detail.currentRevisionId);
        return current ? current.id : (revs[0]?.id ?? null);
      });
    } catch (err) {
      setSheetError(err instanceof ApiClientError ? err.message : "Failed to load sheet");
    }
  }, [sheetId]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  useEffect(() => {
    if (!sheetId) return;
    api
      .get<ListResponse<PinRecord>>(`/api/v1/sheets/${sheetId}/pins`)
      .then((res) => setPins(res.items ?? []))
      .catch(() => setPins([]));
  }, [sheetId]);

  /* markups + calibration per revision */
  useEffect(() => {
    setMyShapes([]);
    setMyMarkupId(null);
    setPublishedShapes([]);
    setSelectedIndex(null);
    updateDraft(null);
    setSaveState("clean");
    setCalibPoints([]);
    setRecalibrating(false);
    setCalibration(revision?.calibration ?? null);
    if (!revisionId) return;
    api
      .get<ListResponse<MarkupRecord>>(`/api/v1/revisions/${revisionId}/markups`)
      .then((res) => {
        const items = res.items ?? [];
        const mine = items.find((m) => m.layer === "personal");
        setMyShapes((mine?.shapes as MarkupShape[] | undefined) ?? []);
        setMyMarkupId(mine?.id ?? null);
        setPublishedShapes(
          items.filter((m) => m.layer === "published").flatMap((m) => (m.shapes as MarkupShape[]) ?? []),
        );
      })
      .catch((err: unknown) =>
        setMarkupError(err instanceof ApiClientError ? err.message : "Failed to load markups"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionId]);

  /* --------------------------------- saving -------------------------------- */

  const saveNow = useCallback(async (): Promise<string | null> => {
    if (!revisionId) return null;
    const shapes = myShapesRef.current;
    setSaveState("saving");
    try {
      const res = await api.put<MarkupRecord>(`/api/v1/revisions/${revisionId}/markups`, {
        layer: "personal",
        shapes,
      });
      setMyMarkupId(res?.id ?? null);
      setSaveState(myShapesRef.current === shapes ? "saved" : "dirty");
      setMarkupError(null);
      return res?.id ?? null;
    } catch (err) {
      setSaveState("error");
      setMarkupError(err instanceof ApiClientError ? err.message : "Failed to save markups");
      return null;
    }
  }, [revisionId]);

  /* debounced auto-save */
  useEffect(() => {
    if (saveState !== "dirty") return;
    const h = window.setTimeout(() => void saveNow(), 1500);
    return () => window.clearTimeout(h);
  }, [saveState, myShapes, saveNow]);

  /* unsaved-changes guard */
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveStateRef.current === "dirty" || saveStateRef.current === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const mutateShapes = useCallback((fn: (prev: MarkupShape[]) => MarkupShape[]) => {
    setMyShapes((prev) => fn(prev));
    setSaveState("dirty");
  }, []);

  async function publish() {
    setPublishing(true);
    setMarkupError(null);
    try {
      let id = myMarkupId;
      if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || !id) {
        id = await saveNow();
      }
      if (!id) {
        if (myShapesRef.current.length === 0) setMarkupError("Nothing to publish yet — draw something first.");
        return;
      }
      await api.post(`/api/v1/markups/${id}/publish`);
      // former personal layer is now published: fold it in, start a fresh layer
      setPublishedShapes((prev) => [...prev, ...myShapesRef.current]);
      setMyShapes([]);
      setMyMarkupId(null);
      setSelectedIndex(null);
      setSaveState("clean");
    } catch (err) {
      setMarkupError(err instanceof ApiClientError ? err.message : "Failed to publish markups");
    } finally {
      setPublishing(false);
    }
  }

  /* ------------------------------- rendering ------------------------------- */

  const doRender = useCallback(
    async (scale: number) => {
      const canvas = baseCanvasRef.current;
      const doc = docRef.current;
      const rev = revision;
      if (!canvas || !doc || !rev) return;
      const seq = ++renderSeqRef.current;
      try {
        if (compareOn && otherRevision) {
          const oldDoc = otherRevision.fileId === rev.fileId ? doc : compareDoc;
          if (!oldDoc) return; // still loading the other file
          const sig = `${rev.id}|${otherRevision.id}|${scale.toFixed(4)}`;
          let cache = compareCacheRef.current;
          if (!cache || cache.sig !== sig) {
            const newC = document.createElement("canvas");
            const oldC = document.createElement("canvas");
            const eff = await renderPageToCanvas(doc, rev.pageIndex, scale, newC);
            await renderPageToCanvas(oldDoc, otherRevision.pageIndex, scale, oldC);
            if (renderSeqRef.current !== seq) return;
            cache = { sig, oldC, newC, eff };
            compareCacheRef.current = cache;
          }
          compositeCompare(canvas, cache.oldC, cache.newC, oldAlphaRef.current);
          const dpr = Math.max(1, window.devicePixelRatio || 1);
          canvas.style.width = `${canvas.width / dpr}px`;
          canvas.style.height = `${canvas.height / dpr}px`;
          setRenderScale(cache.eff);
        } else {
          const eff = await renderPageToCanvas(doc, rev.pageIndex, scale, canvas, renderTaskRef);
          if (renderSeqRef.current !== seq) return;
          setRenderScale(eff);
        }
      } catch {
        /* render cancelled / transient */
      }
    },
    [revision, compareOn, otherRevision, compareDoc],
  );

  /* container resize tracking */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet, revisionId, pdf.doc]);

  /* fit + (re)render when the pdf/revision/compare inputs are ready */
  useEffect(() => {
    if (!pdf.doc || !pdf.pageSize || containerSize.w === 0) return;
    let t = transformRef.current;
    if (fitKeyRef.current !== revisionId) {
      fitKeyRef.current = revisionId;
      t = fitTransform(pdf.pageSize, containerSize.w, containerSize.h);
      setTransform(t);
      transformRef.current = t;
    }
    void doRender(t.scale);
  }, [pdf.doc, pdf.pageSize, containerSize.w, containerSize.h, revisionId, doRender]);

  /* crisp re-render after zoom settles */
  useEffect(() => {
    if (!pdf.doc) return;
    const h = window.setTimeout(() => {
      const target = transformRef.current.scale;
      const cur = renderScaleRef.current;
      if (cur > 0 && Math.abs(target - cur) / cur > 0.02) void doRender(target);
    }, 300);
    return () => window.clearTimeout(h);
  }, [transform.scale, pdf.doc, doRender]);

  /* compare: load the other revision's file when needed */
  useEffect(() => {
    compareCacheRef.current = null;
    if (!compareOn || !otherRevision || !revision) {
      setCompareDoc(null);
      return;
    }
    if (otherRevision.fileId === revision.fileId) {
      setCompareDoc(null);
      return;
    }
    let cancelled = false;
    let loaded: LoadedPdf | null = null;
    loadPdf(otherRevision.fileId)
      .then((l) => {
        if (cancelled) {
          l.destroy();
          return;
        }
        loaded = l;
        setCompareDoc(l.doc);
      })
      .catch(() => setMarkupError("Failed to load the comparison revision"));
    return () => {
      cancelled = true;
      loaded?.destroy();
      setCompareDoc(null);
    };
  }, [compareOn, otherRevision, revision]);

  /* recomposite (cheap) when the old-layer opacity changes */
  useEffect(() => {
    const canvas = baseCanvasRef.current;
    const cache = compareCacheRef.current;
    if (!compareOn || !canvas || !cache) return;
    compositeCompare(canvas, cache.oldC, cache.newC, oldAlpha);
  }, [oldAlpha, compareOn]);

  /* -------------------------------- interactions --------------------------- */

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);

  /* wheel zoom (native, non-passive) */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.pow(2, -e.deltaY * 0.0016);
      setTransform((t) => zoomAround(t, factor, e.clientX - rect.left, e.clientY - rect.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [sheet, revisionId, pdf.doc]);

  /* keyboard: tool hotkeys, space-pan, delete, escape */
  useEffect(() => {
    const isTyping = () => {
      const t = document.activeElement;
      return (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === " " && !isTyping()) {
        spaceRef.current = true;
        e.preventDefault();
        return;
      }
      if (isTyping() || textModal || pinModal || calibModalOpen) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIndex !== null) {
        mutateShapes((prev) => prev.filter((_, i) => i !== selectedIndex));
        setSelectedIndex(null);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        setSelectedIndex(null);
        updateDraft(null);
        setCalibPoints([]);
        setRecalibrating(false);
        setActivePinId(null);
        return;
      }
      const hot = TOOL_HOTKEYS[e.key.toLowerCase()];
      if (hot && !e.metaKey && !e.ctrlKey && !e.altKey) setTool(hot);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [selectedIndex, mutateShapes, textModal, pinModal, calibModalOpen, updateDraft]);

  const effectiveCalibration = recalibrating ? null : calibration;

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pdf.pageSize || !revision) return;
    const page = pdf.pageSize;
    const t = transformRef.current;
    const screen = localPoint(e);
    setActivePinId(null);

    const startPan = () => {
      interactionRef.current = { mode: "pan", startX: screen.x, startY: screen.y, startT: t };
      setPanning(true);
    };

    // middle mouse / space / pan tool always pans
    if (e.button === 1 || spaceRef.current || tool === "pan" || compareOn) {
      startPan();
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const norm = toNormalized(screen, page, t);

    // pins are clickable in select mode
    if (tool === "select" && showPins) {
      const hitPin = [...pins].reverse().find((pin) => {
        const p = toScreen({ x: pin.x, y: pin.y }, page, t);
        return Math.hypot(p.x - screen.x, p.y - screen.y) <= PIN_RADIUS + 3;
      });
      if (hitPin) {
        setActivePinId(hitPin.id);
        interactionRef.current = { mode: "idle" };
        return;
      }
    }

    switch (tool) {
      case "select": {
        // topmost of my shapes wins
        let hit: number | null = null;
        for (let i = myShapes.length - 1; i >= 0; i--) {
          const s = myShapes[i];
          if (s && hitTestShape(s, screen, page, t)) {
            hit = i;
            break;
          }
        }
        setSelectedIndex(hit);
        if (hit !== null) {
          interactionRef.current = { mode: "move", index: hit, last: norm, moved: false };
        } else {
          startPan();
        }
        return;
      }
      case "pin": {
        setPinModal({ at: clamp01(norm) });
        setPinRecordId("");
        return;
      }
      case "text": {
        setTextModal({ at: norm });
        setTextValue("");
        return;
      }
      case "measure": {
        if (!effectiveCalibration) {
          const next = [...calibPoints, norm];
          setCalibPoints(next);
          if (next.length === 2) {
            setCalibDistance("");
            setCalibModalOpen(true);
          }
          return;
        }
        interactionRef.current = { mode: "draw", start: norm };
        updateDraft({ kind: "measure", from: norm, to: norm, color, width: strokeWidth });
        return;
      }
      case "pen": {
        interactionRef.current = { mode: "draw", start: norm };
        updateDraft({ kind: "pen", points: [norm], color, width: strokeWidth });
        return;
      }
      case "line":
      case "arrow":
      case "rect":
      case "ellipse":
      case "cloud": {
        interactionRef.current = { mode: "draw", start: norm };
        updateDraft({ kind: tool, from: norm, to: norm, color, width: strokeWidth });
        return;
      }
      default:
        return;
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const it = interactionRef.current;
    if (it.mode === "idle" || !pdf.pageSize) return;
    const page = pdf.pageSize;
    const screen = localPoint(e);

    if (it.mode === "pan") {
      setTransform({
        ...it.startT,
        offsetX: it.startT.offsetX + (screen.x - it.startX),
        offsetY: it.startT.offsetY + (screen.y - it.startY),
      });
      return;
    }
    const norm = toNormalized(screen, page, transformRef.current);
    if (it.mode === "move") {
      const dx = norm.x - it.last.x;
      const dy = norm.y - it.last.y;
      if (dx === 0 && dy === 0) return;
      interactionRef.current = { ...it, last: norm, moved: true };
      setMyShapes((prev) =>
        prev.map((s, i) => (i === it.index ? translateShape(s, dx, dy) : s)),
      );
      return;
    }
    // drawing
    const prev = draftRef.current;
    if (!prev) return;
    if (prev.kind === "pen") {
      updateDraft({ ...prev, points: [...prev.points, norm] });
    } else if (prev.kind !== "text") {
      updateDraft({ ...prev, to: norm });
    }
  }

  function onPointerUp() {
    const it = interactionRef.current;
    interactionRef.current = { mode: "idle" };
    setPanning(false);
    if (it.mode === "move") {
      if (it.moved) setSaveState("dirty");
      return;
    }
    if (it.mode !== "draw") return;
    const page = pdf.pageSize;
    const current = draftRef.current;
    updateDraft(null);
    if (!current || !page) return;
    let final: MarkupShape | null = current;
    if (current.kind !== "pen" && current.kind !== "text") {
      const a = toScreen(current.from, page, transformRef.current);
      const b = toScreen(current.to, page, transformRef.current);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 4) final = null; // degenerate click
    }
    if (final && final.kind === "measure" && effectiveCalibration) {
      final = {
        ...final,
        value: measureValue(final.from, final.to, effectiveCalibration, page),
        unit: effectiveCalibration.unit,
      };
    }
    if (final) {
      const toAdd = final;
      mutateShapes((prev) => [...prev, toAdd]);
    }
  }

  /* ------------------------------- actions --------------------------------- */

  async function saveCalibration() {
    if (!revisionId || calibPoints.length !== 2) return;
    const distance = Number(calibDistance);
    if (!Number.isFinite(distance) || distance <= 0) return;
    const body: SheetCalibration = {
      from: calibPoints[0]!,
      to: calibPoints[1]!,
      realDistance: distance,
      unit: calibUnit,
    };
    try {
      await api.put(`/api/v1/revisions/${revisionId}/calibration`, body);
      setCalibration(body);
      setRecalibrating(false);
      setCalibPoints([]);
      setCalibModalOpen(false);
      setMarkupError(null);
    } catch (err) {
      setMarkupError(err instanceof ApiClientError ? err.message : "Failed to save calibration");
    }
  }

  function addText() {
    if (!textModal || !textValue.trim()) {
      setTextModal(null);
      return;
    }
    mutateShapes((prev) => [
      ...prev,
      { kind: "text", at: textModal.at, text: textValue.trim(), color, fontSize: textSize },
    ]);
    setTextModal(null);
  }

  async function createPin() {
    if (!pinModal || !sheetId || !pinRecordId.trim()) return;
    try {
      const created = await api.post<PinRecord>(`/api/v1/sheets/${sheetId}/pins`, {
        recordType: pinType,
        recordId: pinRecordId.trim(),
        x: pinModal.at.x,
        y: pinModal.at.y,
      });
      setPins((prev) => [...prev, created]);
      setPinModal(null);
      setMarkupError(null);
    } catch (err) {
      setMarkupError(err instanceof ApiClientError ? err.message : "Failed to create pin");
    }
  }

  async function deletePin(pinId: string) {
    try {
      await api.del(`/api/v1/pins/${pinId}`);
      setPins((prev) => prev.filter((p) => p.id !== pinId));
      setActivePinId(null);
    } catch (err) {
      setMarkupError(err instanceof ApiClientError ? err.message : "Failed to delete pin");
    }
  }

  function switchRevision(id: string) {
    if (dirty && !window.confirm("You have unsaved markups. Discard them and switch revision?")) {
      return;
    }
    setRevisionId(id);
    setCompareOn(false);
    setOtherRevId(null);
  }

  function toggleCompare() {
    if (compareOn) {
      setCompareOn(false);
      setOtherRevId(null);
      return;
    }
    const others = revisions.filter((r) => r.id !== revisionId);
    if (others.length === 0) return;
    const idx = revisions.findIndex((r) => r.id === revisionId);
    const fallback = revisions[idx + 1] ?? others[0];
    setOtherRevId(fallback?.id ?? null);
    setCompareOn(true);
    setSelectedIndex(null);
    updateDraft(null);
  }

  function zoomBy(factor: number) {
    setTransform((t) => zoomAround(t, factor, containerSize.w / 2, containerSize.h / 2));
  }

  function fitToView() {
    if (!pdf.pageSize) return;
    setTransform(fitTransform(pdf.pageSize, containerSize.w, containerSize.h));
  }

  function backGuard(e: { preventDefault: () => void }) {
    if (dirty && !window.confirm("You have unsaved markups. Leave anyway?")) {
      e.preventDefault();
    }
  }

  /* --------------------------------- render -------------------------------- */

  if (sheetError) {
    return (
      <div>
        <ErrorAlert message={sheetError} />
        <Button variant="secondary" onClick={() => navigate(`/projects/${projectId}/drawings`)}>
          Back to drawings
        </Button>
      </div>
    );
  }
  if (!sheet) return <Spinner label="Loading sheet…" />;

  if (revisions.length === 0) {
    return (
      <div>
        <BackBar sheet={sheet} onBack={backGuard} />
        <EmptyState
          title="No revisions for this sheet yet"
          hint="Upload a drawing set containing this sheet number to add its first revision."
        />
      </div>
    );
  }

  const page: PageSize | null = pdf.pageSize;
  const activePin = pins.find((p) => p.id === activePinId) ?? null;
  const activePinScreen =
    activePin && page ? toScreen({ x: activePin.x, y: activePin.y }, page, transform) : null;

  const cursor = panning
    ? "grabbing"
    : tool === "pan" || compareOn
      ? "grab"
      : tool === "select"
        ? "default"
        : "crosshair";

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "dirty"
        ? "Unsaved changes"
        : saveState === "error"
          ? "Save failed"
          : saveState === "saved"
            ? "All changes saved"
            : "";

  return (
    <div className="-mt-1">
      {/* ------------------------------- toolbar ------------------------------ */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <BackBar sheet={sheet} onBack={backGuard} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {saveLabel ? (
            <span
              className={`flex items-center gap-1.5 text-xs ${
                saveState === "error"
                  ? "text-red-600"
                  : saveState === "dirty"
                    ? "text-amber-600"
                    : "text-ink-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  saveState === "error"
                    ? "bg-red-500"
                    : saveState === "dirty"
                      ? "bg-amber-500"
                      : saveState === "saving"
                        ? "animate-pulse bg-brand-500"
                        : "bg-emerald-500"
                }`}
              />
              {saveLabel}
            </span>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void saveNow()} disabled={!revisionId || saveState === "saving"}>
            Save
          </Button>
          <Button
            size="sm"
            onClick={() => void publish()}
            disabled={publishing || (myShapes.length === 0 && !myMarkupId)}
            title="Publish your personal markup layer for the whole team"
          >
            {publishing ? "Publishing…" : "Publish layer"}
          </Button>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* revision picker */}
        <label className="flex items-center gap-1.5 text-xs text-ink-500">
          Rev
          <Select
            value={revisionId ?? ""}
            onChange={(e) => switchRevision(e.target.value)}
            className="w-auto! py-1.5! text-xs"
          >
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.revision}
                {Number(r.isSuperseded) === 1 ? " (superseded)" : ""}
              </option>
            ))}
          </Select>
        </label>

        <button
          type="button"
          onClick={toggleCompare}
          disabled={revisions.length < 2}
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            compareOn
              ? "bg-brand-600 text-white ring-brand-600"
              : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"
          }`}
        >
          Compare
        </button>
        {compareOn ? (
          <>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              vs
              <Select
                value={otherRevId ?? ""}
                onChange={(e) => setOtherRevId(e.target.value)}
                className="w-auto! py-1.5! text-xs"
              >
                {revisions
                  .filter((r) => r.id !== revisionId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      Rev {r.revision}
                    </option>
                  ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500" /> old
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(oldAlpha * 100)}
                onChange={(e) => setOldAlpha(Number(e.target.value) / 100)}
                className="w-24 accent-brand-600"
              />
            </label>
            <span className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-600" /> current
            </span>
          </>
        ) : null}

        {/* tools */}
        {!compareOn ? (
          <div className="flex items-center gap-0.5 rounded-md bg-white p-0.5 ring-1 ring-ink-200">
            {TOOL_DEFS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.label}
                onClick={() => {
                  setTool(t.id);
                  setSelectedIndex(null);
                }}
                className={`rounded p-1.5 transition-colors ${
                  tool === t.id
                    ? "bg-brand-600 text-white"
                    : "text-ink-500 hover:bg-ink-100 hover:text-ink-800"
                }`}
              >
                {t.icon}
              </button>
            ))}
          </div>
        ) : null}

        {/* style */}
        {!compareOn ? (
          <>
            <div className="flex items-center gap-1">
              {MARKUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => {
                    setColor(c);
                    if (selectedIndex !== null) {
                      mutateShapes((prev) =>
                        prev.map((s, i) => (i === selectedIndex ? { ...s, color: c } : s)),
                      );
                    }
                  }}
                  className={`h-5 w-5 rounded-full ring-2 ring-offset-1 transition-transform ${
                    color === c ? "scale-110 ring-ink-400" : "ring-transparent hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <Select
              value={String(strokeWidth)}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
              className="w-auto! py-1.5! text-xs"
              title="Stroke width"
            >
              {MARKUP_WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w}px
                </option>
              ))}
            </Select>
          </>
        ) : null}

        {/* zoom + layers */}
        <div className="ml-auto flex items-center gap-1">
          {!compareOn ? (
            <>
              <ToggleChip on={showPublished} onClick={() => setShowPublished((v) => !v)} label="Published" />
              <ToggleChip on={showMine} onClick={() => setShowMine((v) => !v)} label="Mine" />
              <ToggleChip on={showPins} onClick={() => setShowPins((v) => !v)} label="Pins" />
            </>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => zoomBy(0.8)} title="Zoom out">
            −
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-ink-500">
            {Math.round(transform.scale * 100)}%
          </span>
          <Button size="sm" variant="secondary" onClick={() => zoomBy(1.25)} title="Zoom in">
            +
          </Button>
          <Button size="sm" variant="secondary" onClick={fitToView}>
            Fit
          </Button>
        </div>
      </div>

      {/* measure/calibration status */}
      {tool === "measure" && !compareOn ? (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-violet-50 px-3 py-1.5 text-xs text-violet-800 ring-1 ring-violet-100">
          {effectiveCalibration ? (
            <>
              <span>
                Calibrated: {effectiveCalibration.realDistance} {effectiveCalibration.unit} reference. Drag to
                measure.
              </span>
              <button
                type="button"
                className="font-medium underline hover:text-violet-950"
                onClick={() => {
                  setRecalibrating(true);
                  setCalibPoints([]);
                }}
              >
                Recalibrate
              </button>
            </>
          ) : (
            <span>
              Calibration needed — click two points a known distance apart ({calibPoints.length}/2 picked).
            </span>
          )}
        </div>
      ) : null}

      <ErrorAlert message={markupError} />

      {/* ------------------------------- viewer ------------------------------- */}
      <div
        ref={containerRef}
        className="relative touch-none select-none overflow-hidden rounded-lg bg-ink-200/70 ring-1 ring-ink-200"
        style={{ height: "max(420px, calc(100vh - 300px))", cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute left-0 top-0 will-change-transform"
          style={{
            transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${
              renderScale > 0 ? transform.scale / renderScale : 1
            })`,
            transformOrigin: "0 0",
          }}
        >
          <canvas ref={baseCanvasRef} className="block bg-white shadow-lg" />
        </div>

        <MarkupCanvas
          width={containerSize.w}
          height={containerSize.h}
          page={page}
          transform={transform}
          publishedShapes={publishedShapes}
          showPublished={showPublished}
          myShapes={myShapes}
          showMine={showMine}
          draft={draft}
          selectedIndex={selectedIndex}
          pins={pins}
          showPins={showPins}
          activePinId={activePinId}
          calibrationPoints={calibPoints}
          compareMode={compareOn}
        />

        {pdf.loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60">
            <Spinner label="Rendering sheet…" />
          </div>
        ) : null}
        {pdf.error ? (
          <div className="absolute inset-x-0 top-0 p-4">
            <ErrorAlert message={`Could not load the sheet PDF: ${pdf.error}`} />
          </div>
        ) : null}
        {compareOn && otherRevision && otherRevision.fileId !== revision?.fileId && !compareDoc ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/40">
            <Spinner label="Loading comparison revision…" />
          </div>
        ) : null}

        {/* pin popover */}
        {activePin && activePinScreen ? (
          <div
            className="absolute z-10 w-56 -translate-x-1/2 rounded-lg bg-white p-3 shadow-xl ring-1 ring-ink-200"
            style={{
              left: activePinScreen.x,
              top: Math.max(8, activePinScreen.y - PIN_RADIUS - 8),
              transform: "translate(-50%, -100%)",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="mb-1.5 flex items-center justify-between">
              <Badge tone="blue">{activePin.recordType.toUpperCase()}</Badge>
              <button
                type="button"
                onClick={() => setActivePinId(null)}
                className="text-ink-300 hover:text-ink-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="truncate font-mono text-xs text-ink-600" title={activePin.recordId}>
              {activePin.recordId}
            </p>
            <div className="mt-2 flex items-center justify-between">
              {pinLink(activePin) ? (
                <Link
                  to={pinLink(activePin)!}
                  onClick={backGuard}
                  className="text-xs font-medium text-brand-700 hover:underline"
                >
                  Open record →
                </Link>
              ) : (
                <span className="text-xs text-ink-300">No linked page</span>
              )}
              <Button size="sm" variant="danger" onClick={() => void deletePin(activePin.id)}>
                Delete
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="mt-1.5 text-xs text-ink-400">
        Scroll to zoom · drag to pan (hold space with any tool) · V select · P pen · M measure · N pin ·
        Delete removes the selected markup
      </p>

      {/* ------------------------------- modals ------------------------------- */}
      <Modal open={calibModalOpen} title="Calibrate sheet" onClose={() => { setCalibModalOpen(false); setCalibPoints([]); }}>
        <p className="mb-3 text-sm text-ink-500">
          Enter the real-world distance between the two points you clicked.
        </p>
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Distance">
              <Input
                type="number"
                min="0"
                step="any"
                value={calibDistance}
                onChange={(e) => setCalibDistance(e.target.value)}
                placeholder="e.g. 20"
                autoFocus
              />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Unit">
              <Select value={calibUnit} onChange={(e) => setCalibUnit(e.target.value)}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { setCalibModalOpen(false); setCalibPoints([]); }}>
            Cancel
          </Button>
          <Button
            onClick={() => void saveCalibration()}
            disabled={!Number.isFinite(Number(calibDistance)) || Number(calibDistance) <= 0}
          >
            Save calibration
          </Button>
        </div>
      </Modal>

      <Modal open={textModal !== null} title="Add text" onClose={() => setTextModal(null)}>
        <Field label="Text">
          <textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            className="block min-h-20 w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm ring-1 ring-inset ring-ink-200 focus:ring-2 focus:ring-inset focus:ring-brand-500"
            autoFocus
          />
        </Field>
        <div className="mt-3 w-32">
          <Field label="Size">
            <Select value={String(textSize)} onChange={(e) => setTextSize(Number(e.target.value))}>
              {[10, 14, 20, 28, 40].map((s) => (
                <option key={s} value={s}>
                  {s}pt
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setTextModal(null)}>
            Cancel
          </Button>
          <Button onClick={addText} disabled={!textValue.trim()}>
            Add text
          </Button>
        </div>
      </Modal>

      <Modal open={pinModal !== null} title="Pin a record to this sheet" onClose={() => setPinModal(null)}>
        <div className="flex gap-3">
          <div className="w-40">
            <Field label="Record type">
              <Select value={pinType} onChange={(e) => setPinType(e.target.value)}>
                {PIN_RECORD_TYPES.map((tpe) => (
                  <option key={tpe} value={tpe}>
                    {tpe.toUpperCase()} ({PIN_STYLE[tpe]?.letter})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Record ID" hint="e.g. the RFI id from its detail page">
              <Input
                value={pinRecordId}
                onChange={(e) => setPinRecordId(e.target.value)}
                placeholder="rfi_…"
                autoFocus
              />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPinModal(null)}>
            Cancel
          </Button>
          <Button onClick={() => void createPin()} disabled={!pinRecordId.trim()}>
            Place pin
          </Button>
        </div>
      </Modal>
    </div>
  );

  function pinLink(pin: PinRecord): string | null {
    switch (pin.recordType) {
      case "rfi":
        return `../rfis/${pin.recordId}`;
      case "submittal":
        return `../submittals/${pin.recordId}`;
      case "punch":
        return "../punch";
      case "photo":
        return "../photos";
      default:
        return null;
    }
  }
}

/* -------------------------------- fragments -------------------------------- */

function BackBar({
  sheet,
  onBack,
}: {
  sheet: SheetDetail;
  onBack: (e: { preventDefault: () => void }) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Link
        to="../drawings"
        onClick={onBack}
        className="flex items-center gap-1 whitespace-nowrap text-sm text-ink-500 hover:text-ink-800"
      >
        ← Drawings
      </Link>
      <span className="text-ink-200">/</span>
      <h1 className="truncate text-base font-semibold text-ink-900">
        {sheet.number}
        <span className="ml-2 font-normal text-ink-500">{sheet.title}</span>
      </h1>
      {Number(sheet.needsReview) === 1 ? <Badge tone="amber">needs review</Badge> : null}
    </div>
  );
}

function ToggleChip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1.5 text-xs font-medium ring-1 transition-colors ${
        on ? "bg-ink-800 text-white ring-ink-800" : "bg-white text-ink-400 ring-ink-200 hover:bg-ink-50"
      }`}
      title={`Toggle ${label.toLowerCase()} visibility`}
    >
      {label}
    </button>
  );
}
