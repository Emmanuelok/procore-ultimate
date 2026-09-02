/**
 * Full sheet viewer: PDF canvas (range-loaded per revision) with pan/zoom,
 * markup tools (pen, line, arrow, rect, ellipse, cloud, text, measure),
 * calibration, revision compare (red/blue overlay with an opacity slider),
 * change-detection regions with their verdict and basis (#262), callout
 * hyperlink hot-zones with a links panel (#263), record pins validated by
 * the API (#272–#276), and a personal-vs-published markup model with prior
 * revisions' markups shown dimmed and a carry-forward action (#269).
 *
 * What the viewer will not do: invent a verdict when the diff could not
 * see (it prints the API's basis), or offer a mutation the caller's tool
 * level does not permit (the sheet carries `access.canEdit`).
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
import { loadPdf, renderPageToCanvas, revisionPdfUrl, usePdfPage, type LoadedPdf } from "./usePdfPage";
import MarkupCanvas, { PIN_RADIUS } from "./MarkupCanvas";
import {
  clamp01,
  compositeCompare,
  fitTransform,
  hitTestShape,
  measureValue,
  simplifyStroke,
  splitStroke,
  toNormalized,
  toScreen,
  translateShape,
  zoomAround,
} from "./tools";
import {
  MARKUP_COLORS,
  MARKUP_WIDTHS,
  MAX_PEN_POINTS,
  PIN_RECORD_TYPES,
  PIN_STYLE,
  type ChangedRegion,
  type HyperlinkRecord,
  type ListResponse,
  type MarkupRecord,
  type MarkupShape,
  type MarkupsResponse,
  type PageSize,
  type PinRecord,
  type RevisionDiff,
  type RevisionSummary,
  type SheetCalibration,
  type SheetDetail,
  type SheetListItem,
  type SheetPoint,
  type ToolId,
  type ViewTransform,
} from "./types";
import { pct, regionSummary } from "./drawingsShared";
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

const TOOL_DEFS: { id: ToolId; label: string; icon: ReactNode; edit: boolean }[] = [
  { id: "select", label: "Select / move (V)", icon: <Icon d="M5 3l14 8-6.5 1.5L9 19z" />, edit: false },
  { id: "pan", label: "Pan (H)", icon: <Icon d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />, edit: false },
  { id: "pen", label: "Pen (P)", icon: <Icon d="M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5z" />, edit: false },
  { id: "line", label: "Line (L)", icon: <Icon d="M4 20L20 4" />, edit: false },
  { id: "arrow", label: "Arrow (A)", icon: <Icon d="M4 20L20 4M20 4h-7M20 4v7" />, edit: false },
  { id: "rect", label: "Rectangle (R)", icon: <Icon d="M4 6h16v12H4z" />, edit: false },
  { id: "ellipse", label: "Ellipse (E)", icon: <Icon d="M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z" />, edit: false },
  { id: "cloud", label: "Revision cloud (C)", icon: <Icon d="M6.5 18a4 4 0 01-.6-7.9A6 6 0 0117.5 8.5 4 4 0 0117 18z" />, edit: false },
  { id: "text", label: "Text (T)", icon: <Icon d="M5 6V4h14v2M12 4v16M9 20h6" />, edit: false },
  { id: "measure", label: "Measure (M)", icon: <Icon d="M3 17L17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2" />, edit: false },
  { id: "pin", label: "Drop pin (N)", icon: <Icon d="M12 21s-7-6.4-7-11a7 7 0 0114 0c0 4.6-7 11-7 11z" extra={<circle cx="12" cy="10" r="2.4" />} />, edit: true },
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

/** Where the pin picker lists candidates from; null → paste an id by hand. */
const PIN_SOURCES: Record<string, { path: string; label: (row: Record<string, unknown>) => string } | null> = {
  rfi: { path: "rfis", label: (r) => `RFI-${String(r["number"] ?? "").padStart(3, "0")} ${String(r["subject"] ?? "")}` },
  submittal: { path: "submittals", label: (r) => `SUB-${String(r["number"] ?? "").padStart(3, "0")} ${String(r["title"] ?? "")}` },
  punch: { path: "punch", label: (r) => `PL-${String(r["number"] ?? "").padStart(3, "0")} ${String(r["title"] ?? "")}` },
  photo: { path: "photos", label: (r) => String(r["caption"] ?? r["id"] ?? "Photo") },
  observation: { path: "observations", label: (r) => `OBS-${String(r["number"] ?? "").padStart(3, "0")} ${String(r["title"] ?? "")}` },
  inspection: null,
};

const REGION_COLORS: Record<ChangedRegion["kind"], string> = {
  added: "#16a34a",
  removed: "#dc2626",
  moved: "#d97706",
};

/** The message a refusal actually carries — a zod issue, or the server's sentence. */
function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    const details = (err.details as { details?: unknown } | undefined)?.details;
    const issues = Array.isArray(details) ? details : Array.isArray((details as { issues?: unknown })?.issues) ? (details as { issues: unknown[] }).issues : null;
    const first = issues?.[0] as { message?: string; path?: unknown[] } | undefined;
    if (first?.message) return `${err.message}: ${first.message}${Array.isArray(first.path) && first.path.length ? ` (${first.path.join(".")})` : ""}`;
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

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
  const revision = useMemo(() => revisions.find((r) => r.id === revisionId) ?? null, [revisions, revisionId]);
  const canEdit = sheet?.access?.canEdit ?? true;

  /* pdf — per revision, range-served */
  const pdfUrl = projectId && revisionId ? revisionPdfUrl(projectId, revisionId) : null;
  const pdf = usePdfPage(pdfUrl, revision?.pageIndex ?? 0);
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
  const [flaggedShapes, setFlaggedShapes] = useState<MarkupShape[]>([]);
  const [priorShapes, setPriorShapes] = useState<MarkupShape[]>([]);
  const [priorLabels, setPriorLabels] = useState<string[]>([]);
  const [carried, setCarried] = useState<MarkupRecord[]>([]);
  const [showPublished, setShowPublished] = useState(true);
  const [showPrior, setShowPrior] = useState(true);
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
  const [carrying, setCarrying] = useState(false);

  /* change detection */
  const [changedRegions, setChangedRegions] = useState<ChangedRegion[]>([]);
  const [diff, setDiff] = useState<RevisionDiff | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);

  /* hyperlinks */
  const [links, setLinks] = useState<HyperlinkRecord[]>([]);
  const [showLinks, setShowLinks] = useState(true);
  const [linksOpen, setLinksOpen] = useState(false);
  const [linkModal, setLinkModal] = useState<{ index: number } | null>(null);
  const [sheetOptions, setSheetOptions] = useState<SheetListItem[]>([]);
  const [linkTarget, setLinkTarget] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

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
  const [pinCandidates, setPinCandidates] = useState<Array<{ id: string; label: string }> | null>(null);
  const [pinCandidatesError, setPinCandidatesError] = useState<string | null>(null);
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
  const otherRevision = useMemo(() => revisions.find((r) => r.id === otherRevId) ?? null, [revisions, otherRevId]);

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
      const detail = await api.get<SheetDetail>(`/api/v1/sheets/${sheetId}`);
      const revs = detail.revisions ?? [];
      setSheet({ ...detail, revisions: revs });
      setSheetError(null);
      setRevisionId((prev) => {
        if (prev && revs.some((r) => r.id === prev)) return prev;
        const current = detail.currentRevisionId && revs.find((r) => r.id === detail.currentRevisionId);
        return current ? current.id : (revs[0]?.id ?? null);
      });
    } catch (err) {
      setSheetError(describeError(err, "Failed to load sheet"));
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

  const loadMarkups = useCallback(async () => {
    if (!revisionId) return;
    try {
      const res = await api.get<MarkupsResponse>(`/api/v1/revisions/${revisionId}/markups?includePrior=1`);
      const items = res.items ?? [];
      const mine = items.find((m) => m.layer === "personal");
      setMyShapes((mine?.shapes as MarkupShape[] | undefined) ?? []);
      setMyMarkupId(mine?.id ?? null);
      const published = items.filter((m) => m.layer === "published");
      setPublishedShapes(published.flatMap((m) => (m.shapes as MarkupShape[]) ?? []));
      setFlaggedShapes(
        published.flatMap((m) => (m.reviewFlags ?? []).map((i) => (m.shapes as MarkupShape[])[i]).filter((s): s is MarkupShape => Boolean(s))),
      );
      setCarried(published.filter((m) => m.carriedFromRevisionId));
      const prior = res.prior ?? [];
      setPriorShapes(prior.flatMap((m) => (m.shapes as MarkupShape[]) ?? []));
      setPriorLabels([...new Set(prior.map((m) => m.revisionLabel ?? "?"))]);
      setChangedRegions(res.changedRegions ?? []);
      setMarkupError(null);
    } catch (err) {
      setMarkupError(describeError(err, "Failed to load markups"));
    }
  }, [revisionId]);

  const loadLinks = useCallback(async () => {
    if (!revisionId) return;
    try {
      const res = await api.get<ListResponse<HyperlinkRecord>>(`/api/v1/revisions/${revisionId}/hyperlinks`);
      setLinks(res.items ?? []);
    } catch {
      setLinks([]);
    }
  }, [revisionId]);

  /* markups + calibration + links per revision */
  useEffect(() => {
    setMyShapes([]);
    setMyMarkupId(null);
    setPublishedShapes([]);
    setFlaggedShapes([]);
    setPriorShapes([]);
    setPriorLabels([]);
    setCarried([]);
    setSelectedIndex(null);
    updateDraft(null);
    setSaveState("clean");
    setCalibPoints([]);
    setRecalibrating(false);
    setDiff(null);
    setShowChanges(false);
    setCalibration(revision?.calibration ?? null);
    if (!revisionId) return;
    void loadMarkups();
    void loadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisionId]);

  const loadDiff = useCallback(async () => {
    if (!revisionId) return;
    setDiffLoading(true);
    try {
      const res = await api.get<RevisionDiff>(`/api/v1/revisions/${revisionId}/diff`);
      setDiff(res);
      setChangedRegions(res.regions ?? []);
    } catch (err) {
      setMarkupError(describeError(err, "Failed to compute the revision diff"));
    } finally {
      setDiffLoading(false);
    }
  }, [revisionId]);

  function toggleChanges() {
    const next = !showChanges;
    setShowChanges(next);
    if (next && !diff) void loadDiff();
  }

  /* --------------------------------- saving -------------------------------- */

  const saveNow = useCallback(async (): Promise<string | null> => {
    if (!revisionId) return null;
    const shapes = myShapesRef.current;
    setSaveState("saving");
    try {
      const res = await api.put<MarkupRecord>(`/api/v1/revisions/${revisionId}/markups`, { layer: "personal", shapes });
      setMyMarkupId(res?.id ?? null);
      setSaveState(myShapesRef.current === shapes ? "saved" : "dirty");
      setMarkupError(null);
      return res?.id ?? null;
    } catch (err) {
      setSaveState("error");
      setMarkupError(describeError(err, "Failed to save markups"));
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
      if (saveStateRef.current === "dirty" || saveStateRef.current === "saving" || !id) id = await saveNow();
      if (!id) {
        if (myShapesRef.current.length === 0) setMarkupError("Nothing to publish yet — draw something first.");
        return;
      }
      await api.post(`/api/v1/markups/${id}/publish`);
      setPublishedShapes((prev) => [...prev, ...myShapesRef.current]);
      setMyShapes([]);
      setMyMarkupId(null);
      setSelectedIndex(null);
      setSaveState("clean");
    } catch (err) {
      setMarkupError(describeError(err, "Failed to publish markups"));
    } finally {
      setPublishing(false);
    }
  }

  async function carryForward() {
    if (!revisionId) return;
    setCarrying(true);
    setMarkupError(null);
    try {
      const res = await api.post<{ basis: string }>(`/api/v1/revisions/${revisionId}/markups/carry-forward`, {});
      await loadMarkups();
      setMarkupError(null);
      window.setTimeout(() => setMarkupError(null), 0);
      setCarryNote(res.basis);
    } catch (err) {
      setMarkupError(describeError(err, "Failed to carry markups forward"));
    } finally {
      setCarrying(false);
    }
  }
  const [carryNote, setCarryNote] = useState<string | null>(null);

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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.name : "";
        if (name !== "RenderingCancelledException" && !/destroyed/i.test(msg)) {
          console.error("Sheet render failed:", err);
        }
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
  }, [sheet, revisionId, pdf.doc, linksOpen]);

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

  /* compare: load the other revision's file when needed (range-served too) */
  useEffect(() => {
    compareCacheRef.current = null;
    if (!compareOn || !otherRevision || !revision || !projectId) {
      setCompareDoc(null);
      return;
    }
    if (otherRevision.fileId === revision.fileId) {
      setCompareDoc(null);
      return;
    }
    let cancelled = false;
    let loaded: LoadedPdf | null = null;
    loadPdf(revisionPdfUrl(projectId, otherRevision.id))
      .then((l) => {
        if (cancelled) {
          l.destroy();
          return;
        }
        loaded = l;
        setCompareDoc(l.doc);
      })
      .catch((err: unknown) => setMarkupError(describeError(err, "Failed to load the comparison revision")));
    return () => {
      cancelled = true;
      loaded?.destroy();
      setCompareDoc(null);
    };
  }, [compareOn, otherRevision, revision, projectId]);

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
      return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === " " && !isTyping()) {
        spaceRef.current = true;
        e.preventDefault();
        return;
      }
      if (isTyping() || textModal || pinModal || calibModalOpen || linkModal) return;
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
      if (hot && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (hot === "pin" && !canEdit) return;
        setTool(hot);
      }
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
  }, [selectedIndex, mutateShapes, textModal, pinModal, calibModalOpen, linkModal, updateDraft, canEdit]);

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

    if (e.button === 1 || spaceRef.current || tool === "pan" || compareOn) {
      startPan();
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const norm = toNormalized(screen, page, t);

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
        let hit: number | null = null;
        for (let i = myShapes.length - 1; i >= 0; i--) {
          const s = myShapes[i];
          if (s && hitTestShape(s, screen, page, t)) {
            hit = i;
            break;
          }
        }
        setSelectedIndex(hit);
        if (hit !== null) interactionRef.current = { mode: "move", index: hit, last: norm, moved: false };
        else startPan();
        return;
      }
      case "pin": {
        if (!canEdit) return;
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
          if (!canEdit) {
            setMarkupError("This sheet is not calibrated and calibration requires standard access to drawings.");
            return;
          }
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
      setTransform({ ...it.startT, offsetX: it.startT.offsetX + (screen.x - it.startX), offsetY: it.startT.offsetY + (screen.y - it.startY) });
      return;
    }
    const norm = toNormalized(screen, page, transformRef.current);
    if (it.mode === "move") {
      const dx = norm.x - it.last.x;
      const dy = norm.y - it.last.y;
      if (dx === 0 && dy === 0) return;
      interactionRef.current = { ...it, last: norm, moved: true };
      setMyShapes((prev) => prev.map((s, i) => (i === it.index ? translateShape(s, dx, dy) : s)));
      return;
    }
    const prev = draftRef.current;
    if (!prev) return;
    if (prev.kind === "pen") updateDraft({ ...prev, points: [...prev.points, norm] });
    else if (prev.kind !== "text") updateDraft({ ...prev, to: norm });
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
      final = { ...final, value: measureValue(final.from, final.to, effectiveCalibration, page), unit: effectiveCalibration.unit };
    }
    if (!final) return;
    if (final.kind === "pen") {
      // Simplify, then split anything still over the API's per-stroke cap so
      // one long scribble never makes the whole layer unsaveable.
      const pieces = splitStroke(simplifyStroke(final.points), MAX_PEN_POINTS);
      const strokes: MarkupShape[] = pieces.map((points) => ({ kind: "pen", points, color: final.color, width: final.width }));
      mutateShapes((prev) => [...prev, ...strokes]);
      return;
    }
    const toAdd = final;
    mutateShapes((prev) => [...prev, toAdd]);
  }

  /* ------------------------------- actions --------------------------------- */

  async function saveCalibration() {
    if (!revisionId || calibPoints.length !== 2) return;
    const distance = Number(calibDistance);
    if (!Number.isFinite(distance) || distance <= 0) return;
    const body: SheetCalibration = { from: calibPoints[0]!, to: calibPoints[1]!, realDistance: distance, unit: calibUnit };
    try {
      await api.put(`/api/v1/revisions/${revisionId}/calibration`, body);
      setCalibration(body);
      setRecalibrating(false);
      setCalibPoints([]);
      setCalibModalOpen(false);
      setMarkupError(null);
    } catch (err) {
      setMarkupError(describeError(err, "Failed to save calibration"));
    }
  }

  function addText() {
    if (!textModal || !textValue.trim()) {
      setTextModal(null);
      return;
    }
    mutateShapes((prev) => [...prev, { kind: "text", at: textModal.at, text: textValue.trim(), color, fontSize: textSize }]);
    setTextModal(null);
  }

  /* pin candidates for the chosen record type */
  useEffect(() => {
    if (!pinModal || !projectId) return;
    const source = PIN_SOURCES[pinType] ?? null;
    setPinCandidates(null);
    setPinCandidatesError(null);
    if (!source) return;
    let cancelled = false;
    api
      .get<ListResponse<Record<string, unknown>>>(`/api/v1/projects/${projectId}/${source.path}?pageSize=200`)
      .then((res) => {
        if (cancelled) return;
        setPinCandidates((res.items ?? []).map((row) => ({ id: String(row["id"]), label: source.label(row) })));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPinCandidatesError(describeError(err, "Could not list records"));
      });
    return () => {
      cancelled = true;
    };
  }, [pinModal, pinType, projectId]);

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
      setMarkupError(describeError(err, "Failed to create pin"));
    }
  }

  async function deletePin(pinId: string) {
    try {
      await api.del(`/api/v1/pins/${pinId}`);
      setPins((prev) => prev.filter((p) => p.id !== pinId));
      setActivePinId(null);
    } catch (err) {
      setMarkupError(describeError(err, "Failed to delete pin"));
    }
  }

  /* manual hyperlink from a selected rectangle */
  async function openLinkModal(index: number) {
    if (!projectId) return;
    setLinkModal({ index });
    setLinkTarget("");
    setLinkLabel("");
    try {
      const res = await api.get<ListResponse<SheetListItem>>(`/api/v1/projects/${projectId}/sheets?pageSize=500`);
      setSheetOptions((res.items ?? []).filter((s) => s.id !== sheetId));
    } catch (err) {
      setMarkupError(describeError(err, "Could not list sheets"));
    }
  }

  async function createLink() {
    if (!linkModal || !revisionId || !linkTarget) return;
    const shape = myShapes[linkModal.index];
    if (!shape || shape.kind === "pen" || shape.kind === "text") return;
    const x = Math.min(shape.from.x, shape.to.x);
    const y = Math.min(shape.from.y, shape.to.y);
    try {
      await api.post(`/api/v1/revisions/${revisionId}/hyperlinks`, {
        toSheetId: linkTarget,
        x,
        y,
        w: Math.abs(shape.to.x - shape.from.x),
        h: Math.abs(shape.to.y - shape.from.y),
        label: linkLabel.trim() || undefined,
      });
      setLinkModal(null);
      mutateShapes((prev) => prev.filter((_, i) => i !== linkModal.index));
      setSelectedIndex(null);
      await loadLinks();
    } catch (err) {
      setMarkupError(describeError(err, "Failed to create the hyperlink"));
    }
  }

  async function deleteLink(link: HyperlinkRecord) {
    if (!revisionId) return;
    try {
      await api.del(`/api/v1/revisions/${revisionId}/hyperlinks/${link.id}`);
      await loadLinks();
    } catch (err) {
      setMarkupError(describeError(err, "Failed to delete the hyperlink"));
    }
  }

  function followLink(link: HyperlinkRecord) {
    if (!link.toSheetId) return;
    if (dirty && !window.confirm("You have unsaved markups. Leave anyway?")) return;
    navigate(`../drawings/${link.toSheetId}`);
  }

  function switchRevision(id: string) {
    if (dirty && !window.confirm("You have unsaved markups. Discard them and switch revision?")) return;
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
    const supersedes = revision?.supersedesRevisionId ? revisions.find((r) => r.id === revision.supersedesRevisionId) : null;
    const idx = revisions.findIndex((r) => r.id === revisionId);
    const fallback = supersedes ?? revisions[idx + 1] ?? others[0];
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
    if (dirty && !window.confirm("You have unsaved markups. Leave anyway?")) e.preventDefault();
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
        <BackBar sheet={sheet} revision={null} onBack={backGuard} />
        <EmptyState title="No revisions for this sheet yet" hint="Upload a drawing set containing this sheet number to add its first revision." />
      </div>
    );
  }

  const page: PageSize | null = pdf.pageSize;
  const activePin = pins.find((p) => p.id === activePinId) ?? null;
  const activePinScreen = activePin && page ? toScreen({ x: activePin.x, y: activePin.y }, page, transform) : null;
  const selectedShape = selectedIndex !== null ? myShapes[selectedIndex] : undefined;
  const selectedIsRect = selectedShape?.kind === "rect";
  const carriedFrom = revision?.supersedesRevisionId ? revisions.find((r) => r.id === revision.supersedesRevisionId) : null;
  const alreadyCarried = carried.some((m) => m.carriedFromRevisionId === carriedFrom?.id);

  const cursor = panning ? "grabbing" : tool === "pan" || compareOn ? "grab" : tool === "select" ? "default" : "crosshair";

  const saveLabel =
    saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : saveState === "error" ? "Save failed" : saveState === "saved" ? "All changes saved" : "";

  const visibleLinks = showLinks && !compareOn && page ? links.filter((l) => l.status !== "rejected") : [];

  return (
    <div className="-mt-1">
      {/* ------------------------------- toolbar ------------------------------ */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <BackBar sheet={sheet} revision={revision} onBack={backGuard} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!canEdit ? <Badge tone="neutral">read only</Badge> : null}
          {saveLabel ? (
            <span className={`flex items-center gap-1.5 text-xs ${saveState === "error" ? "text-red-600" : saveState === "dirty" ? "text-amber-600" : "text-ink-400"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${saveState === "error" ? "bg-red-500" : saveState === "dirty" ? "bg-amber-500" : saveState === "saving" ? "animate-pulse bg-brand-500" : "bg-emerald-500"}`} />
              {saveLabel}
            </span>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => void saveNow()} disabled={!revisionId || saveState === "saving"}>
            Save
          </Button>
          <Button size="sm" onClick={() => void publish()} disabled={!canEdit || publishing || (myShapes.length === 0 && !myMarkupId)} title={canEdit ? "Publish your personal markup layer for the whole team" : "Publishing requires standard access to drawings"}>
            {publishing ? "Publishing…" : "Publish layer"}
          </Button>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* revision picker */}
        <label className="flex items-center gap-1.5 text-xs text-ink-500">
          Rev
          <Select value={revisionId ?? ""} onChange={(e) => switchRevision(e.target.value)} className="w-auto! py-1.5! text-xs">
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.revision}
                {r.set?.name ? ` · ${r.set.name}` : ""}
                {Number(r.isSuperseded) === 1 ? " (superseded)" : ""}
              </option>
            ))}
          </Select>
        </label>

        <button
          type="button"
          onClick={toggleCompare}
          disabled={revisions.length < 2}
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${compareOn ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}
        >
          Compare
        </button>
        {compareOn ? (
          <>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              vs
              <Select value={otherRevId ?? ""} onChange={(e) => setOtherRevId(e.target.value)} className="w-auto! py-1.5! text-xs">
                {revisions.filter((r) => r.id !== revisionId).map((r) => (
                  <option key={r.id} value={r.id}>
                    Rev {r.revision}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500" /> old
              <input type="range" min={0} max={100} value={Math.round(oldAlpha * 100)} onChange={(e) => setOldAlpha(Number(e.target.value) / 100)} className="w-24 accent-brand-600" />
            </label>
            <span className="flex items-center gap-1.5 text-xs text-ink-500">
              <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-600" /> current
            </span>
          </>
        ) : null}

        <button
          type="button"
          onClick={toggleChanges}
          disabled={revisions.length < 2}
          className={`rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${showChanges ? "bg-amber-500 text-white ring-amber-500" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}
          title="Show the regions the text-layer diff found changed against the superseded revision"
        >
          {diffLoading ? "Diffing…" : "Changes"}
        </button>

        {/* tools */}
        {!compareOn ? (
          <div className="flex items-center gap-0.5 rounded-md bg-white p-0.5 ring-1 ring-ink-200">
            {TOOL_DEFS.filter((t) => !t.edit || canEdit).map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.label}
                onClick={() => {
                  setTool(t.id);
                  setSelectedIndex(null);
                }}
                className={`rounded p-1.5 transition-colors ${tool === t.id ? "bg-brand-600 text-white" : "text-ink-500 hover:bg-ink-100 hover:text-ink-800"}`}
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
                    if (selectedIndex !== null) mutateShapes((prev) => prev.map((s, i) => (i === selectedIndex ? { ...s, color: c } : s)));
                  }}
                  className={`h-5 w-5 rounded-full ring-2 ring-offset-1 transition-transform ${color === c ? "scale-110 ring-ink-400" : "ring-transparent hover:scale-105"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <Select value={String(strokeWidth)} onChange={(e) => setStrokeWidth(Number(e.target.value))} className="w-auto! py-1.5! text-xs" title="Stroke width">
              {MARKUP_WIDTHS.map((w) => (
                <option key={w} value={w}>
                  {w}px
                </option>
              ))}
            </Select>
            {selectedIsRect && canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => void openLinkModal(selectedIndex!)} title="Turn the selected rectangle into a hyperlink hot-zone">
                Link to sheet…
              </Button>
            ) : null}
          </>
        ) : null}

        {/* zoom + layers */}
        <div className="ml-auto flex items-center gap-1">
          {!compareOn ? (
            <>
              <ToggleChip on={showPublished} onClick={() => setShowPublished((v) => !v)} label="Published" />
              <ToggleChip on={showPrior} onClick={() => setShowPrior((v) => !v)} label={priorLabels.length ? `Rev ${priorLabels.join("/")}` : "Prior"} title="Markups published on other revisions of this sheet, shown dimmed" />
              <ToggleChip on={showMine} onClick={() => setShowMine((v) => !v)} label="Mine" />
              <ToggleChip on={showPins} onClick={() => setShowPins((v) => !v)} label="Pins" />
              <ToggleChip on={showLinks} onClick={() => setShowLinks((v) => !v)} label={`Links${links.length ? ` ${links.filter((l) => l.status !== "rejected").length}` : ""}`} />
              <ToggleChip on={linksOpen} onClick={() => setLinksOpen((v) => !v)} label="Panel" title="Open the links side panel" />
            </>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => zoomBy(0.8)} title="Zoom out">
            −
          </Button>
          <span className="w-12 text-center text-xs tabular-nums text-ink-500">{Math.round(transform.scale * 100)}%</span>
          <Button size="sm" variant="secondary" onClick={() => zoomBy(1.25)} title="Zoom in">
            +
          </Button>
          <Button size="sm" variant="secondary" onClick={fitToView}>
            Fit
          </Button>
        </div>
      </div>

      {/* change-detection banner */}
      {showChanges && diff ? (
        <div className={`mb-2 flex flex-wrap items-center gap-2 rounded-md px-3 py-1.5 text-xs ring-1 ${diff.verdict === "changed" ? "bg-amber-50 text-amber-900 ring-amber-200" : diff.verdict === "unchanged" ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-ink-50 text-ink-700 ring-ink-200"}`}>
          <Badge tone={diff.verdict === "changed" ? "warning" : diff.verdict === "unchanged" ? "success" : "neutral"} size="xs">
            {diff.verdict}
          </Badge>
          <span>
            {diff.againstRevisionId ? `vs rev ${diff.against?.revision ?? "?"} · ` : ""}
            {diff.verdict === "changed" ? regionSummary(diff.regions) : diff.basis}
          </span>
          {diff.verdict === "changed" ? <span className="text-ink-500">· {diff.basis}</span> : null}
          {diff.stats?.changeRatio != null ? <span className="text-ink-500">· {pct(diff.stats.changeRatio)} of text items differ</span> : null}
          {diff.pinsInChangedRegions.length > 0 ? (
            <span className="font-medium">
              · {diff.pinsInChangedRegions.length} pinned record{diff.pinsInChangedRegions.length === 1 ? "" : "s"} inside a changed region: {diff.pinsInChangedRegions.map((p) => p.label ?? p.recordId).join(", ")}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-2 text-ink-500">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: REGION_COLORS.added }} /> added
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: REGION_COLORS.removed }} /> removed
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: REGION_COLORS.moved }} /> moved
          </span>
        </div>
      ) : null}

      {/* carry-forward offer */}
      {carriedFrom && !alreadyCarried && !compareOn && priorShapes.length > 0 && canEdit ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-brand-50 px-3 py-1.5 text-xs text-brand-900 ring-1 ring-brand-100">
          <span>
            Revision {carriedFrom.revision} has published markups. Carry them onto this revision? Shapes that land inside a changed region are flagged for review.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void carryForward()} disabled={carrying}>
            {carrying ? "Carrying…" : `Carry forward from rev ${carriedFrom.revision}`}
          </Button>
        </div>
      ) : null}
      {carryNote ? (
        <div className="mb-2 rounded-md bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900 ring-1 ring-emerald-100">
          {carryNote}
          {flaggedShapes.length > 0 ? ` ${flaggedShapes.length} shape(s) are drawn with a dashed halo.` : ""}
        </div>
      ) : null}

      {/* measure/calibration status */}
      {tool === "measure" && !compareOn ? (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-violet-50 px-3 py-1.5 text-xs text-violet-800 ring-1 ring-violet-100">
          {effectiveCalibration ? (
            <>
              <span>
                Calibrated: {effectiveCalibration.realDistance} {effectiveCalibration.unit} reference. Drag to measure.
              </span>
              {canEdit ? (
                <button type="button" className="font-medium underline hover:text-violet-950" onClick={() => { setRecalibrating(true); setCalibPoints([]); }}>
                  Recalibrate
                </button>
              ) : null}
            </>
          ) : (
            <span>Calibration needed — click two points a known distance apart ({calibPoints.length}/2 picked).</span>
          )}
        </div>
      ) : null}

      <ErrorAlert message={markupError} />

      {/* ------------------------------- viewer ------------------------------- */}
      <div className="flex gap-3">
        <div
          ref={containerRef}
          className="relative min-w-0 flex-1 touch-none select-none overflow-hidden rounded-lg bg-ink-200/70 ring-1 ring-ink-200"
          style={{ height: "max(420px, calc(100vh - 300px))", cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            className="absolute left-0 top-0 will-change-transform"
            style={{ transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${renderScale > 0 ? transform.scale / renderScale : 1})`, transformOrigin: "0 0" }}
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
            priorShapes={priorShapes}
            showPrior={showPrior}
            flaggedShapes={flaggedShapes}
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

          {/* changed regions (HTML overlay, non-interactive) */}
          {showChanges && page && !compareOn
            ? changedRegions.map((r, i) => {
                const a = toScreen({ x: r.x, y: r.y }, page, transform);
                const b = toScreen({ x: r.x + r.w, y: r.y + r.h }, page, transform);
                return (
                  <div
                    key={`region-${i}`}
                    className="pointer-events-none absolute rounded-sm"
                    title={`${r.kind}: ${r.sample}`}
                    style={{ left: a.x - 3, top: a.y - 3, width: Math.max(6, b.x - a.x + 6), height: Math.max(6, b.y - a.y + 6), border: `2px dashed ${REGION_COLORS[r.kind]}`, background: `${REGION_COLORS[r.kind]}14` }}
                  />
                );
              })
            : null}

          {/* hyperlink hot-zones */}
          {visibleLinks.map((l) => {
            const a = toScreen({ x: l.x, y: l.y }, page!, transform);
            const b = toScreen({ x: l.x + l.w, y: l.y + l.h }, page!, transform);
            const unresolved = !l.toSheetId;
            return (
              <button
                key={l.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => followLink(l)}
                title={unresolved ? `Callout to ${l.targetNumber ?? "?"} — no such sheet in this project` : `${l.label ?? l.targetNumber ?? "link"} → ${l.target?.number ?? ""} ${l.target?.title ?? ""}${l.confidence != null ? ` (auto, ${pct(l.confidence)})` : ""}`}
                className={`absolute rounded-sm ${unresolved ? "cursor-help border-2 border-dashed border-red-400 bg-red-400/10" : "cursor-pointer border-2 border-sky-500/80 bg-sky-400/10 hover:bg-sky-400/25"}`}
                style={{ left: a.x - 2, top: a.y - 2, width: Math.max(10, b.x - a.x + 4), height: Math.max(10, b.y - a.y + 4) }}
              />
            );
          })}

          {pdf.loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white/60">
              <Spinner label="Fetching the sheet (range requests — only the page you are viewing)…" />
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
              className="absolute z-10 w-64 -translate-x-1/2 rounded-lg bg-white p-3 shadow-xl ring-1 ring-ink-200"
              style={{ left: activePinScreen.x, top: Math.max(8, activePinScreen.y - PIN_RADIUS - 8), transform: "translate(-50%, -100%)" }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="mb-1.5 flex items-center justify-between">
                <Badge tone="info">{activePin.recordType.toUpperCase()}</Badge>
                <button type="button" onClick={() => setActivePinId(null)} className="text-ink-300 hover:text-ink-600" aria-label="Close">
                  ✕
                </button>
              </div>
              <p className="text-sm font-medium text-ink-800">{activePin.label ?? activePin.recordId}</p>
              <p className="truncate font-mono text-2xs text-ink-400" title={activePin.recordId}>
                {activePin.recordId}
              </p>
              <div className="mt-2 flex items-center justify-between">
                {pinLink(activePin) ? (
                  <Link to={pinLink(activePin)!} onClick={backGuard} className="text-xs font-medium text-brand-700 hover:underline">
                    Open record →
                  </Link>
                ) : (
                  <span className="text-xs text-ink-300">No linked page</span>
                )}
                {canEdit ? (
                  <Button size="sm" variant="danger" onClick={() => void deletePin(activePin.id)}>
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {/* links side panel */}
        {linksOpen ? (
          <aside className="w-72 shrink-0 overflow-y-auto rounded-lg bg-white p-3 ring-1 ring-ink-200" style={{ height: "max(420px, calc(100vh - 300px))" }}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Links on rev {revision?.revision}</h2>
              <button type="button" onClick={() => setLinksOpen(false)} className="text-ink-300 hover:text-ink-600" aria-label="Close panel">
                ✕
              </button>
            </div>
            {links.filter((l) => l.status !== "rejected").length === 0 ? (
              <p className="text-xs text-ink-400">No callouts were detected on this revision and nobody has drawn a link. Select a rectangle and use “Link to sheet…” to add one.</p>
            ) : (
              <ul className="space-y-1.5">
                {links.filter((l) => l.status !== "rejected").map((l) => (
                  <li key={l.id} className="rounded-md px-2 py-1.5 text-xs ring-1 ring-ink-100">
                    <div className="flex items-center justify-between gap-1">
                      <button type="button" onClick={() => followLink(l)} disabled={!l.toSheetId} className="min-w-0 truncate text-left font-medium text-brand-700 hover:underline disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline">
                        {l.label ?? l.targetNumber ?? "link"}
                      </button>
                      <Badge tone={l.toSheetId ? (l.source === "auto" ? "info" : "neutral") : "danger"} size="xs">
                        {l.toSheetId ? (l.source === "auto" ? `auto ${pct(l.confidence)}` : "manual") : "unresolved"}
                      </Badge>
                    </div>
                    <p className="truncate text-ink-500">{l.target ? `${l.target.number} ${l.target.title}` : `No sheet ${l.targetNumber ?? ""} in this project`}</p>
                    {canEdit ? (
                      <button type="button" onClick={() => void deleteLink(l)} className="mt-0.5 text-2xs text-ink-400 hover:text-red-600">
                        remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {pins.length > 0 ? (
              <>
                <h2 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-500">Pinned records</h2>
                <ul className="space-y-1">
                  {pins.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => setActivePinId(p.id)} className="w-full truncate text-left text-xs text-ink-700 hover:text-brand-700">
                        <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: PIN_STYLE[p.recordType]?.color ?? "#475569" }} />
                        {p.label ?? p.recordId}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>
        ) : null}
      </div>

      <p className="mt-1.5 text-xs text-ink-400">
        Scroll to zoom · drag to pan (hold space with any tool) · V select · P pen · M measure{canEdit ? " · N pin" : ""} · Delete removes the selected markup · click a blue hot-zone to follow a callout
      </p>

      {/* ------------------------------- modals ------------------------------- */}
      <Modal open={calibModalOpen} title="Calibrate sheet" onClose={() => { setCalibModalOpen(false); setCalibPoints([]); }}>
        <p className="mb-3 text-sm text-ink-500">Enter the real-world distance between the two points you clicked.</p>
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label="Distance">
              <Input type="number" min="0" step="any" value={calibDistance} onChange={(e) => setCalibDistance(e.target.value)} placeholder="e.g. 20" autoFocus />
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
          <Button onClick={() => void saveCalibration()} disabled={!Number.isFinite(Number(calibDistance)) || Number(calibDistance) <= 0}>
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
        <div className="space-y-3">
          <div className="w-44">
            <Field label="Record type">
              <Select value={pinType} onChange={(e) => { setPinType(e.target.value); setPinRecordId(""); }}>
                {PIN_RECORD_TYPES.map((tpe) => (
                  <option key={tpe} value={tpe}>
                    {tpe.toUpperCase()} ({PIN_STYLE[tpe]?.letter})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {pinCandidates && pinCandidates.length > 0 ? (
            <Field label="Record" hint="Only records that exist on this project are listed; the API refuses anything else.">
              <Select value={pinRecordId} onChange={(e) => setPinRecordId(e.target.value)}>
                <option value="">Choose…</option>
                {pinCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field
              label="Record ID"
              hint={
                pinCandidatesError
                  ? `Could not list ${pinType}s (${pinCandidatesError}); paste the id from its page.`
                  : pinCandidates && pinCandidates.length === 0
                    ? `No ${pinType} exists on this project yet.`
                    : `Paste the id from the ${pinType}'s page. The API verifies it belongs to this project.`
              }
            >
              <Input value={pinRecordId} onChange={(e) => setPinRecordId(e.target.value)} placeholder={`${pinType}_…`} autoFocus />
            </Field>
          )}
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

      <Modal open={linkModal !== null} title="Link the selected rectangle to a sheet" onClose={() => setLinkModal(null)}>
        <div className="space-y-3">
          <Field label="Target sheet">
            <Select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}>
              <option value="">Choose…</option>
              {sheetOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.number} — {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label" hint="Optional, e.g. 3/A-501">
            <Input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} />
          </Field>
          <p className="text-xs text-ink-400">The rectangle becomes a hot-zone on this revision and is removed from your personal layer.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setLinkModal(null)}>
            Cancel
          </Button>
          <Button onClick={() => void createLink()} disabled={!linkTarget}>
            Create link
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

function BackBar({ sheet, revision, onBack }: { sheet: SheetDetail; revision: RevisionSummary | null; onBack: (e: { preventDefault: () => void }) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Link to="../drawings" onClick={onBack} className="flex items-center gap-1 whitespace-nowrap text-sm text-ink-500 hover:text-ink-800">
        ← Drawings
      </Link>
      <span className="text-ink-200">/</span>
      <h1 className="truncate text-base font-semibold text-ink-900">
        {sheet.number}
        <span className="ml-2 font-normal text-ink-500">{sheet.title}</span>
      </h1>
      {Number(sheet.needsReview) === 1 ? <Badge tone="warning">needs review</Badge> : null}
      {revision?.changeVerdict ? (
        <Badge tone={revision.changeVerdict === "changed" ? "warning" : revision.changeVerdict === "unchanged" ? "success" : "neutral"} size="xs" title="Text-layer diff against the revision this one superseded">
          rev {revision.revision}: {revision.changeVerdict}
          {revision.changeVerdict === "changed" && revision.changedRegionCount ? ` (${revision.changedRegionCount})` : ""}
        </Badge>
      ) : null}
      {revision && revision.hasTextLayer === 0 ? <Badge tone="neutral" size="xs" title="No text layer: search, callouts and the diff cannot read this page">scan</Badge> : null}
    </div>
  );
}

function ToggleChip({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1.5 text-xs font-medium ring-1 transition-colors ${on ? "bg-ink-800 text-white ring-ink-800" : "bg-white text-ink-400 ring-ink-200 hover:bg-ink-50"}`}
      title={title ?? `Toggle ${label.toLowerCase()} visibility`}
    >
      {label}
    </button>
  );
}
