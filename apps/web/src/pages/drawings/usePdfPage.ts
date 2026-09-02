/**
 * pdf.js (v6) plumbing for the sheet viewer.
 *
 * Documents are opened straight from the authenticated revision URL with
 * RANGE REQUESTS (spec #278): the API advertises `Accept-Ranges: bytes`, so
 * pdf.js fetches the xref and only the objects of the page being shown
 * instead of the whole set. `disableAutoFetch` stops it from quietly pulling
 * the rest of a 400 MB set in the background. The bearer token and tenant
 * header ride on every request through `httpHeaders`.
 */
import { useEffect, useRef, useState } from "react";
// Legacy build: the modern build relies on bleeding-edge JS APIs (e.g.
// Map.prototype.getOrInsertComputed) that are missing in current browsers,
// which makes canvas rendering fail silently. The legacy build polyfills them.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { tokenStore } from "../../lib/api";
import type { PageSize } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  destroy: () => void;
}

/** The revision's PDF endpoint (range-served, access-logged on first open). */
export function revisionPdfUrl(projectId: string, revisionId: string): string {
  return `/api/v1/projects/${projectId}/revisions/${revisionId}/pdf`;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const access = tokenStore.access;
  if (access) headers["authorization"] = `Bearer ${access}`;
  const companyId = tokenStore.companyId;
  if (companyId) headers["x-company-id"] = companyId;
  return headers;
}

/** Open a PDF by URL with range requests and the platform's auth headers. */
export async function loadPdf(url: string): Promise<LoadedPdf> {
  const task = pdfjs.getDocument({
    url,
    httpHeaders: authHeaders(),
    withCredentials: false,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: true,
    disableStream: false,
  });
  try {
    const doc = await task.promise;
    return {
      doc,
      destroy: () => {
        void task.destroy().catch(() => undefined);
      },
    };
  } catch (err) {
    void task.destroy().catch(() => undefined);
    const status = (err as { status?: number })?.status;
    if (status === 404) throw new Error("The sheet's PDF was not found, or you do not have access to it.");
    if (status === 403) throw new Error("You do not have permission to open this sheet.");
    throw err instanceof Error ? err : new Error("Failed to load PDF");
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
 * Load the PDF at `url` and expose the page's scale-1 size. Handles cleanup
 * and url/pageIndex changes; stale loads are discarded.
 */
export function usePdfPage(url: string | null, pageIndex: number): UsePdfResult {
  const [state, setState] = useState<UsePdfResult>({
    doc: null,
    pageSize: null,
    loading: Boolean(url),
    error: null,
  });
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!url) {
      setState({ doc: null, pageSize: null, loading: false, error: null });
      return;
    }
    let loaded: LoadedPdf | null = null;
    setState({ doc: null, pageSize: null, loading: true, error: null });
    (async () => {
      loaded = await loadPdf(url);
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
  }, [url, pageIndex]);

  return state;
}
