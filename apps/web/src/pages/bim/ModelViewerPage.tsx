/**
 * ModelViewerPage — in-browser IFC viewer (three.js + web-ifc wasm) with
 * element property inspection, per-type visibility, isolate, a horizontal
 * section plane and BCF-style issue creation (spec §1.4 #233, #235, #240,
 * #243, #245).
 *
 * Degrades gracefully: when WebGL/wasm init or parsing fails, the page keeps
 * the API-backed element browser fully usable.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiClientError, tokenStore } from "../../lib/api";
import {
  Badge,
  Button,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from "../../ui";
import { humanize } from "../format";
import {
  CdeBadge,
  SuitabilityChip,
  type BimElement,
  type BimModelDetail,
  type ElementTypeCount,
  type ListResponse,
  type ModelVersion,
} from "./bimShared";
import { IfcEngine, type PickedElement, type TypeBucket } from "./ifcEngine";

type ViewerState = "idle" | "loading" | "ready" | "failed" | "unsupported";
type PanelTab = "properties" | "types" | "elements";

const ELEMENTS_PAGE_SIZE = 25;

async function fetchModelBuffer(fileId: string): Promise<ArrayBuffer> {
  // same auth-header pattern as lib/api's fetchBlobUrl, but we need the raw
  // ArrayBuffer for the wasm parser rather than an object URL
  const headers: Record<string, string> = {};
  const access = tokenStore.access;
  if (access) headers["authorization"] = `Bearer ${access}`;
  const companyId = tokenStore.companyId;
  if (companyId) headers["x-company-id"] = companyId;
  const res = await fetch(`/api/v1/bim/files/${fileId}/model`, { headers });
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  return res.arrayBuffer();
}

export default function ModelViewerPage() {
  const { projectId, modelId } = useParams<{ projectId: string; modelId: string }>();

  const [model, setModel] = useState<BimModelDetail | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<IfcEngine | null>(null);
  const [viewerState, setViewerState] = useState<ViewerState>("idle");
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [viewerTypes, setViewerTypes] = useState<TypeBucket[]>([]);
  const [loadNote, setLoadNote] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>("properties");
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [isolated, setIsolated] = useState(false);

  const [sectionOn, setSectionOn] = useState(false);
  const [sectionRange, setSectionRange] = useState({ min: 0, max: 10 });
  const [sectionHeight, setSectionHeight] = useState(10);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());

  const [apiTypes, setApiTypes] = useState<ElementTypeCount[] | null>(null);
  const [elements, setElements] = useState<BimElement[] | null>(null);
  const [elementsTotal, setElementsTotal] = useState(0);
  const [elementsPage, setElementsPage] = useState(1);
  const [elementsSearch, setElementsSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [elementsError, setElementsError] = useState<string | null>(null);

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueForm, setIssueForm] = useState({ title: "", description: "" });
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueDone, setIssueDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const version: ModelVersion | undefined = model?.versions.find(
    (v) => v.id === selectedVersionId,
  );

  /* ------------------------------ model meta ------------------------------ */

  useEffect(() => {
    if (!modelId) return;
    setModelError(null);
    api
      .get<BimModelDetail>(`/api/v1/bim/models/${modelId}`)
      .then((m) => {
        setModel(m);
        const first = m.currentVersionId ?? m.versions[0]?.id ?? null;
        setSelectedVersionId(first);
        if (!first) setViewerState("unsupported");
      })
      .catch((err) => {
        setModelError(err instanceof Error ? err.message : "Failed to load the model");
      });
  }, [modelId]);

  /* --------------------------- 3D engine lifecycle ------------------------ */

  useEffect(() => {
    const container = containerRef.current;
    if (!model || !selectedVersionId || !container) return;
    const v = model.versions.find((x) => x.id === selectedVersionId);
    if (!v) return;

    setPicked(null);
    setIsolated(false);
    setSectionOn(false);
    setHiddenTypes(new Set());
    setViewerTypes([]);
    setLoadNote(null);

    if (model.format !== "ifc") {
      setViewerState("unsupported");
      setViewerError(
        `3D parsing is available for IFC models only (this model is ${model.format.toUpperCase()}). The element browser below remains available.`,
      );
      return;
    }

    let cancelled = false;
    let engine: IfcEngine | null = null;
    setViewerState("loading");
    setViewerError(null);

    (async () => {
      try {
        engine = new IfcEngine(container);
        engineRef.current = engine;
        engine.onPick = (el) => {
          setPicked(el);
          if (el) setTab("properties");
        };
        setLoadNote("Downloading model…");
        const buffer = await fetchModelBuffer(v.fileId);
        if (cancelled) return;
        setLoadNote("Parsing IFC geometry (wasm)…");
        // yield a frame so the note paints before the synchronous parse
        await new Promise((r) => setTimeout(r, 30));
        if (cancelled) return;
        const summary = await engine.load(buffer);
        if (cancelled) return;
        setViewerTypes(summary.types);
        const range = engine.getHeightRange();
        setSectionRange({ min: range.min, max: range.max });
        setSectionHeight(range.max);
        setLoadNote(null);
        setViewerState("ready");
      } catch (err) {
        if (cancelled) return;
        setViewerState("failed");
        setLoadNote(null);
        setViewerError(
          err instanceof Error ? err.message : "The 3D viewer could not be initialised.",
        );
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current = null;
      try {
        engine?.dispose();
      } catch {
        /* teardown is best-effort */
      }
    };
  }, [model, selectedVersionId]);

  /* ------------------------------ API elements ---------------------------- */

  useEffect(() => {
    if (!selectedVersionId) return;
    setApiTypes(null);
    api
      .get<{ items: ElementTypeCount[] }>(
        `/api/v1/bim/versions/${selectedVersionId}/element-types`,
      )
      .then((res) => setApiTypes(res.items))
      .catch(() => setApiTypes([]));
  }, [selectedVersionId]);

  const loadElements = useCallback(async () => {
    if (!selectedVersionId) return;
    setElementsError(null);
    try {
      const params = new URLSearchParams({
        page: String(elementsPage),
        pageSize: String(ELEMENTS_PAGE_SIZE),
      });
      if (elementsSearch.trim()) params.set("search", elementsSearch.trim());
      if (typeFilter) params.set("ifcType", typeFilter);
      const res = await api.get<ListResponse<BimElement>>(
        `/api/v1/bim/versions/${selectedVersionId}/elements?${params}`,
      );
      setElements(res.items);
      setElementsTotal(res.total);
    } catch (err) {
      setElements([]);
      setElementsError(err instanceof Error ? err.message : "Failed to load elements");
    }
  }, [selectedVersionId, elementsPage, elementsSearch, typeFilter]);

  useEffect(() => {
    const t = setTimeout(() => void loadElements(), elementsSearch ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadElements, elementsSearch]);

  /* -------------------------------- actions ------------------------------- */

  function toggleType(ifcType: string) {
    const key = ifcType.toUpperCase();
    const next = new Set(hiddenTypes);
    const nowHidden = !next.has(key);
    if (nowHidden) next.add(key);
    else next.delete(key);
    setHiddenTypes(next);
    engineRef.current?.setTypeVisible(key, !nowHidden);
  }

  function onIsolate() {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isolateSelection()) setIsolated(true);
  }

  function onClearIsolation() {
    const engine = engineRef.current;
    if (!engine) return;
    engine.clearIsolation();
    engine.clearSelection();
    setPicked(null);
    setIsolated(false);
  }

  function onToggleSection() {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !sectionOn;
    setSectionOn(next);
    engine.setSectionEnabled(next);
    if (next) engine.setSectionHeight(sectionHeight);
  }

  function onSectionHeight(value: number) {
    setSectionHeight(value);
    engineRef.current?.setSectionHeight(value);
  }

  function onElementRowClick(el: BimElement) {
    if (viewerState !== "ready") return;
    const found = engineRef.current?.selectByGlobalId(el.globalId) ?? null;
    if (found) {
      setPicked(found);
      setTab("properties");
    } else {
      setPicked({
        expressID: -1,
        globalId: el.globalId,
        name: el.name,
        ifcType: el.ifcType,
        attributes: [{ key: "note", value: "No renderable geometry for this element" }],
      });
      setTab("properties");
    }
  }

  async function onCreateIssue(e: FormEvent) {
    e.preventDefault();
    if (!picked?.globalId) return;
    setIssueError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: issueForm.title.trim(),
        elementGlobalIds: [picked.globalId],
        modelVersionId: selectedVersionId,
      };
      if (issueForm.description.trim()) payload["description"] = issueForm.description.trim();
      const viewpoint = engineRef.current?.getViewpoint();
      if (viewpoint) payload["viewpoint"] = viewpoint;
      const created = await api.post<{ number: number }>(
        `/api/v1/projects/${projectId}/bim/issues`,
        payload,
      );
      setIssueOpen(false);
      setIssueForm({ title: "", description: "" });
      setIssueDone(`Coordination issue #${created.number} created with this element attached.`);
    } catch (err) {
      setIssueError(err instanceof ApiClientError ? err.message : "Failed to create the issue.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  const totalPages = Math.max(1, Math.ceil(elementsTotal / ELEMENTS_PAGE_SIZE));
  const typeRows: { ifcType: string; count: number; inScene: boolean }[] = (
    apiTypes && apiTypes.length > 0
      ? apiTypes.map((t) => ({
          ifcType: t.ifcType,
          count: t.count,
          inScene: viewerTypes.some((vt) => vt.ifcType === t.ifcType.toUpperCase()),
        }))
      : viewerTypes.map((t) => ({ ifcType: t.ifcType, count: t.meshCount, inScene: true }))
  ).sort((a, b) => b.count - a.count);

  if (modelError) {
    return (
      <div>
        <BackLink projectId={projectId} />
        <ErrorAlert message={modelError} />
      </div>
    );
  }
  if (!model) return <Spinner label="Loading model…" />;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 210px)", minHeight: 520 }}>
      {/* -------------------------------- toolbar ------------------------------ */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-sm ring-1 ring-ink-100">
        <BackLink projectId={projectId} />
        <span className="mx-1 h-5 w-px bg-ink-200" />
        <span className="text-sm font-semibold text-ink-900">{model.name}</span>
        <Badge tone="gray">{model.format.toUpperCase()}</Badge>
        {model.versions.length > 0 && (
          <Select
            className="w-auto py-1 text-xs"
            value={selectedVersionId ?? ""}
            onChange={(e) => setSelectedVersionId(e.target.value)}
          >
            {model.versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.version} · {v.cdeState} {v.suitability}
              </option>
            ))}
          </Select>
        )}
        {version && (
          <>
            <CdeBadge state={version.cdeState} />
            <SuitabilityChip code={version.suitability} />
            <span className="text-xs text-ink-400">
              {version.elementCount.toLocaleString()} elements
            </span>
          </>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={viewerState !== "ready"}
            onClick={() => engineRef.current?.fitCameraToModel()}
          >
            Fit
          </Button>
          <Button
            size="sm"
            variant={sectionOn ? "primary" : "secondary"}
            disabled={viewerState !== "ready"}
            onClick={onToggleSection}
          >
            Section
          </Button>
          {sectionOn && (
            <input
              type="range"
              className="w-32 accent-brand-600"
              min={sectionRange.min}
              max={sectionRange.max}
              step={(sectionRange.max - sectionRange.min) / 200 || 0.1}
              value={sectionHeight}
              onChange={(e) => onSectionHeight(Number(e.target.value))}
              title={`Section height: ${sectionHeight.toFixed(2)}`}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={viewerState !== "ready" || !picked || picked.expressID < 0}
            onClick={onIsolate}
          >
            Isolate
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={viewerState !== "ready" || (!isolated && !picked)}
            onClick={onClearIsolation}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant={panelOpen ? "primary" : "secondary"}
            onClick={() => setPanelOpen((o) => !o)}
          >
            Panel
          </Button>
        </div>
      </div>

      {issueDone && (
        <div className="mb-3 flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-100">
          <span>{issueDone}</span>
          <button
            type="button"
            className="text-xs text-emerald-700 underline"
            onClick={() => setIssueDone(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ------------------------------ canvas + panel ------------------------- */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
          <div ref={containerRef} className="absolute inset-0" />
          {viewerState === "loading" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70">
              <Spinner label={loadNote ?? "Preparing viewer…"} />
            </div>
          )}
          {(viewerState === "failed" || viewerState === "unsupported") && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink-50/80 p-6">
              <div className="max-w-md rounded-lg bg-white p-5 text-center shadow-sm ring-1 ring-ink-100">
                <p className="text-sm font-semibold text-ink-900">
                  {viewerState === "failed" ? "3D viewer unavailable" : "No 3D preview"}
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {viewerError ??
                    "The in-browser IFC engine could not start. Element data remains available in the panel."}
                </p>
              </div>
            </div>
          )}
          {viewerState === "ready" && (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-white/80 px-2 py-1 text-[11px] text-ink-500 ring-1 ring-ink-100">
              Drag to orbit · right-drag to pan · scroll to zoom · click an element to inspect
            </div>
          )}
        </div>

        {/* --------------------------- right panel ---------------------------- */}
        {panelOpen && (
          <div className="flex w-96 shrink-0 flex-col overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-ink-100">
            <div className="flex border-b border-ink-100">
              {(["properties", "types", "elements"] as PanelTab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`flex-1 px-3 py-2 text-xs font-medium capitalize ${
                    tab === t
                      ? "border-b-2 border-brand-600 text-brand-700"
                      : "text-ink-500 hover:text-ink-800"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {tab === "properties" && (
                <PropertiesTab
                  picked={picked}
                  viewerReady={viewerState === "ready"}
                  onCreateIssue={() => {
                    setIssueForm({
                      title: picked?.name
                        ? `Issue at ${picked.name}`
                        : `Issue at element ${picked?.globalId ?? ""}`,
                      description: "",
                    });
                    setIssueError(null);
                    setIssueOpen(true);
                  }}
                />
              )}

              {tab === "types" && (
                <div>
                  {apiTypes === null ? (
                    <Spinner />
                  ) : typeRows.length === 0 ? (
                    <p className="py-6 text-center text-xs text-ink-400">
                      No element types — upload an IFC version to extract elements.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-[11px] text-ink-400">
                        {viewerState === "ready"
                          ? "Toggle 3D visibility per IFC type."
                          : "Viewer offline — selecting a type filters the elements table."}
                      </p>
                      <ul className="space-y-1">
                        {typeRows.map((t) => {
                          const key = t.ifcType.toUpperCase();
                          const visible = !hiddenTypes.has(key);
                          return (
                            <li key={t.ifcType}>
                              {viewerState === "ready" ? (
                                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-ink-50">
                                  <input
                                    type="checkbox"
                                    className="accent-brand-600"
                                    checked={visible}
                                    onChange={() => toggleType(t.ifcType)}
                                  />
                                  <span className="font-mono text-ink-800">{t.ifcType}</span>
                                  <span className="ml-auto tabular-nums text-ink-400">
                                    {t.count.toLocaleString()}
                                  </span>
                                  {!t.inScene && (
                                    <span className="text-[10px] text-ink-300">no geometry</span>
                                  )}
                                </label>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setTypeFilter(typeFilter === t.ifcType ? "" : t.ifcType);
                                    setElementsPage(1);
                                    setTab("elements");
                                  }}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-ink-50 ${
                                    typeFilter === t.ifcType ? "bg-brand-50 text-brand-800" : ""
                                  }`}
                                >
                                  <span className="font-mono">{t.ifcType}</span>
                                  <span className="ml-auto tabular-nums text-ink-400">
                                    {t.count.toLocaleString()}
                                  </span>
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              )}

              {tab === "elements" && (
                <div>
                  <div className="mb-2 flex gap-2">
                    <Input
                      className="py-1.5 text-xs"
                      placeholder="Search name or GlobalId…"
                      value={elementsSearch}
                      onChange={(e) => {
                        setElementsSearch(e.target.value);
                        setElementsPage(1);
                      }}
                    />
                    {typeFilter && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setTypeFilter("");
                          setElementsPage(1);
                        }}
                      >
                        {typeFilter} ✕
                      </Button>
                    )}
                  </div>
                  <ErrorAlert message={elementsError} />
                  {elements === null ? (
                    <Spinner />
                  ) : elements.length === 0 ? (
                    <p className="py-6 text-center text-xs text-ink-400">
                      No elements{elementsSearch || typeFilter ? " match the filter" : ""}.
                    </p>
                  ) : (
                    <>
                      <ul className="divide-y divide-ink-100">
                        {elements.map((el) => (
                          <li key={el.id}>
                            <button
                              type="button"
                              onClick={() => onElementRowClick(el)}
                              className="w-full px-1 py-1.5 text-left hover:bg-ink-50"
                              title={
                                viewerState === "ready" ? "Locate in 3D" : el.globalId
                              }
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium text-ink-800">
                                  {el.name ?? "(unnamed)"}
                                </span>
                                <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-400">
                                  {el.ifcType}
                                </span>
                              </div>
                              <div className="truncate font-mono text-[10px] text-ink-400">
                                {el.globalId}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex items-center justify-between text-xs text-ink-500">
                        <span>
                          Page {elementsPage}/{totalPages} · {elementsTotal.toLocaleString()}
                        </span>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={elementsPage <= 1}
                            onClick={() => setElementsPage((p) => Math.max(1, p - 1))}
                          >
                            Prev
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={elementsPage >= totalPages}
                            onClick={() => setElementsPage((p) => p + 1)}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ------------------------- issue-from-element modal --------------------- */}
      <Modal
        open={issueOpen}
        title="Create coordination issue"
        onClose={() => setIssueOpen(false)}
      >
        <ErrorAlert message={issueError} />
        <form onSubmit={onCreateIssue} className="space-y-4">
          <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
            Attached element:{" "}
            <span className="font-mono">{picked?.globalId ?? "—"}</span>
            {picked?.name ? <span className="text-ink-400"> · {picked.name}</span> : null}
            <span className="mt-0.5 block text-ink-400">
              The current camera viewpoint is stored with the issue (BCF-style).
            </span>
          </div>
          <Field label="Title">
            <Input
              required
              value={issueForm.title}
              onChange={(e) => setIssueForm((f) => ({ ...f, title: e.target.value }))}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={issueForm.description}
              onChange={(e) => setIssueForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Clash description, affected disciplines, proposed fix…"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setIssueOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !issueForm.title.trim()}>
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function BackLink({ projectId }: { projectId: string | undefined }) {
  return (
    <Link
      to={`/projects/${projectId}/bim`}
      className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:text-brand-800"
    >
      ← Models
    </Link>
  );
}

function PropertiesTab({
  picked,
  viewerReady,
  onCreateIssue,
}: {
  picked: PickedElement | null;
  viewerReady: boolean;
  onCreateIssue: () => void;
}) {
  if (!picked) {
    return (
      <p className="py-6 text-center text-xs text-ink-400">
        {viewerReady
          ? "Click an element in the 3D view — or pick one from the Elements tab — to inspect its properties."
          : "Pick an element from the Elements tab to inspect it."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          {humanize("selected element")}
        </div>
        <div className="mt-1 text-sm font-semibold text-ink-900">
          {picked.name ?? "(unnamed element)"}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-ink-500">{picked.ifcType}</div>
      </div>
      <dl className="space-y-1.5 text-xs">
        <PropRow label="GlobalId" value={picked.globalId ?? "—"} mono />
        {picked.expressID >= 0 && (
          <PropRow label="expressID" value={String(picked.expressID)} mono />
        )}
        {picked.attributes.map((a) => (
          <PropRow key={a.key} label={a.key} value={a.value} />
        ))}
      </dl>
      <Button size="sm" disabled={!picked.globalId} onClick={onCreateIssue}>
        Create issue with this element
      </Button>
    </div>
  );
}

function PropRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 truncate text-ink-400">{label}</dt>
      <dd className={`min-w-0 break-all text-ink-800 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
