/**
 * pdf.js (v6) plumbing for the sheet viewer: document loading via the
 * authenticated blob fetch, page rendering into canvases with cancellation,
 * and a hook that manages document lifecycle per fileId.
 */
import { useEffect, useRef, useState } from "react";
// Legacy build: the modern build relies on bleeding-edge JS APIs (e.g.
// Map.prototype.getOrInsertComputed) that are missing in current browsers,
// which makes canvas rendering fail silently. The legacy build polyfills them.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { fetchBlobUrl } from "../../lib/api";
import type { PageSize } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  blobUrl: string;
  destroy: () => void;
}

/** Fetch a drawing file (auth headers attached) and open it with pdf.js. */
export async function loadPdf(fileId: string): Promise<LoadedPdf> {
  const blobUrl = await fetchBlobUrl(`/api/v1/drawing-files/${fileId}/pdf`);
  try {
    const doc = await pdfjs.getDocument({ url: blobUrl }).promise;
    return {
      doc,
      blobUrl,
      destroy: () => {
        void doc.loadingTask.destroy().catch(() => undefined);
        URL.revokeObjectURL(blobUrl);
      },
    };
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
}

/** Page dimensions in css px at scale 1. */
export async function getPageSize(doc: PDFDocumentProxy, pageIndex: number): Promise<PageSize> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

/** Largest backing-store dimension we allow (keeps memory sane on big sheets). */
const MAX_CANVAS_DIM = 8192;

/**
 * Render a page into `canvas` at `scale` (css px multiplier) honoring the
 * devicePixelRatio. Returns the effective render scale actually used after
 * clamping. Cancels any in-flight render tracked by `taskRef`.
 */
export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
  canvas: HTMLCanvasElement,
  taskRef?: { current: { cancel: () => void } | null },
): Promise<number> {
  const page = await doc.getPage(pageIndex + 1);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const base = page.getViewport({ scale: 1 });
  let deviceScale = scale * dpr;
  const maxDim = Math.max(base.width, base.height);
  if (maxDim * deviceScale > MAX_CANVAS_DIM) deviceScale = MAX_CANVAS_DIM / maxDim;
  const viewport = page.getViewport({ scale: deviceScale });

  if (taskRef?.current) {
    try {
      taskRef.current.cancel();
    } catch {
      /* ignore */
    }
  }

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;

  const task = page.render({ canvas, viewport });
  if (taskRef) taskRef.current = task;
  try {
    await task.promise;
  } catch (err) {
    // rendering cancelled by a newer render — not an error
    if ((err as { name?: string })?.name === "RenderingCancelledException") return deviceScale / dpr;
    throw err;
  } finally {
    if (taskRef && taskRef.current === task) taskRef.current = null;
  }
  return deviceScale / dpr;
}

/** Render a page to a fresh offscreen canvas (used by revision compare). */
export async function renderPageOffscreen(
  doc: PDFDocumentProxy,
  pageIndex: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  await renderPageToCanvas(doc, pageIndex, scale, canvas);
  return canvas;
}

export interface UsePdfResult {
  doc: PDFDocumentProxy | null;
  pageSize: PageSize | null;
  loading: boolean;
  error: string | null;
}

/**
 * Load the PDF document for a fileId and expose the page's scale-1 size.
 * Handles cleanup + fileId/pageIndex changes; stale loads are discarded.
 */
export function usePdfPage(fileId: string | null, pageIndex: number): UsePdfResult {
  const [state, setState] = useState<UsePdfResult>({
    doc: null,
    pageSize: null,
    loading: Boolean(fileId),
    error: null,
  });
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!fileId) {
      setState({ doc: null, pageSize: null, loading: false, error: null });
      return;
    }
    let loaded: LoadedPdf | null = null;
    setState({ doc: null, pageSize: null, loading: true, error: null });
    (async () => {
      loaded = await loadPdf(fileId);
      if (generation.current !== gen) {
        loaded.destroy();
        return;
      }
      const size = await getPageSize(loaded.doc, pageIndex);
      if (generation.current !== gen) {
        loaded.destroy();
        return;
      }
      setState({ doc: loaded.doc, pageSize: size, loading: false, error: null });
    })().catch((err: unknown) => {
      if (generation.current !== gen) return;
      setState({
        doc: null,
        pageSize: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load PDF",
      });
    });
    return () => {
      generation.current++;
      if (loaded) loaded.destroy();
    };
  }, [fileId, pageIndex]);

  return state;
}
