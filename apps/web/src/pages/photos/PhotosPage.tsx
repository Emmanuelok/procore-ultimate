/**
 * Photos workspace — spec Vol I §2.10.
 *
 * Gallery with server-side album / unfiled / tag / GPS / 360 filters, albums
 * with privacy, EXIF and AI-status badges, select-mode bulk download, and a
 * lightbox for caption/album/tags/360/pin edits and on-demand AI analysis.
 * Tiles are served by the un-ledgered content route, so browsing a page of
 * photos no longer writes a page of access-log rows. AI copy is honest: when
 * AI is not configured the status says "skipped" and why.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MutableRefObject } from "react";
import { useParams } from "react-router-dom";
import { api, fetchBlobUrl } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Select, Spinner, Tabs } from "../../ui";
import { IconPhoto } from "../../ui/icons";
import { formatDateTime, humanize } from "../format";
import { DASH, errorMessage, fetchBlob, qs, saveBlob, useCompanyUsers, useFieldResource, useLocations, useMe, type ListResponse } from "../rfis/fieldShared";

interface Photo {
  id: string;
  fileId: string;
  album: string | null;
  caption: string | null;
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locationId: string | null;
  aiTags: string[];
  aiSummary: string | null;
  aiStatus: string | null;
  aiError: string | null;
  tags: string[];
  is360: number;
  pin: { sheetId: string; x: number; y: number } | null;
  exif: Record<string, unknown> | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string;
  createdAt: string;
  albumIsPrivate?: boolean;
  file?: { id: string; name: string; contentType: string; sizeBytes: number } | null;
}

interface AlbumRow {
  album: string | null;
  count: number;
  id: string | null;
  description: string | null;
  isPrivate: boolean;
  allowedUserIds: string[];
  createdBy: string | null;
}

const PAGE_SIZE = 48;
const UNFILED = "__unfiled";
type BlobCache = MutableRefObject<Map<string, string>>;

function Thumb({ src, alt, cache, selected, selectMode, onClick }: { src: string; alt: string; cache: BlobCache; selected: boolean; selectMode: boolean; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(() => cache.current.get(src) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const cached = cache.current.get(src);
    if (cached) {
      setUrl(cached);
      return;
    }
    fetchBlobUrl(src)
      .then((u) => {
        const existing = cache.current.get(src);
        if (existing && existing !== u) {
          URL.revokeObjectURL(u);
          if (alive) setUrl(existing);
          return;
        }
        cache.current.set(src, u);
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [src, cache]);
  return (
    <button type="button" onClick={onClick} className={`group relative aspect-square overflow-hidden rounded-lg bg-ink-100 ring-2 focus-visible:outline-2 focus-visible:outline-brand-600 ${selected ? "ring-brand-600" : "ring-transparent"}`}>
      {url ? <img src={url} alt={alt} loading="lazy" className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]" /> : failed ? <span className="flex h-full w-full items-center justify-center text-xs text-ink-400">Unavailable</span> : <span className="flex h-full w-full items-center justify-center"><span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-brand-600" /></span>}
      {selectMode ? <span className={`absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-xs ${selected ? "bg-brand-600 text-white" : "bg-white/90 text-ink-500 ring-1 ring-ink-300"}`}>{selected ? "✓" : ""}</span> : null}
    </button>
  );
}

export default function PhotosPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}/photos`;
  const { users, nameOf } = useCompanyUsers();
  const locations = useLocations(projectId);
  const me = useMe();

  const [tab, setTab] = useState<"gallery" | "albums">("gallery");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);
  const [page, setPage] = useState(1);
  const [selectedAlbum, setSelectedAlbum] = useState("");
  const [tag, setTag] = useState("");
  const [hasGps, setHasGps] = useState("");
  const [is360, setIs360] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useFieldResource<ListResponse<Photo>>(projectId ? `${base}${qs({ page, pageSize: PAGE_SIZE, album: selectedAlbum && selectedAlbum !== UNFILED ? selectedAlbum : "", unfiled: selectedAlbum === UNFILED, tag, hasGps, is360, search: debounced })}` : null, [version]);
  const albums = useFieldResource<{ items: AlbumRow[] }>(projectId ? `${base}/albums` : null, [version]);
  const tags = useFieldResource<{ items: Array<{ tag: string; manual: number; ai: number }> }>(projectId ? `${base}/tags` : null, [version]);
  // Sheets power the drawing-pin picker (#433). The drawings tool is gated
  // separately, so a 403 here just falls back to a free-text sheet id.
  const sheets = useFieldResource<{ items: Array<{ id: string; number: string; title: string }> }>(
    projectId ? `/api/v1/projects/${projectId}/sheets?pageSize=200` : null,
  );

  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobCache = useRef(new Map<string, string>());
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<Photo | null>(null);

  useEffect(() => {
    const cache = blobCache.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const photos = list.data?.items ?? null;
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const albumRows = albums.data?.items ?? [];
  const unfiledCount = albumRows.find((a) => a.album === null)?.count ?? 0;
  const namedAlbums = albumRows.filter((a): a is AlbumRow & { album: string } => a.album !== null);

  async function onFilesPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploadBusy(true);
    setError(null);
    let done = 0;
    const failures: string[] = [];
    for (const file of files) {
      setUploadProgress(`Uploading ${done + failures.length + 1} of ${files.length}…`);
      const form = new FormData();
      form.append("file", file);
      if (selectedAlbum && selectedAlbum !== UNFILED) form.append("album", selectedAlbum);
      if (file.lastModified) form.append("takenAt", new Date(file.lastModified).toISOString());
      try {
        await api.upload(base, form);
        done += 1;
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setUploadBusy(false);
    setUploadProgress(null);
    if (failures.length > 0) setError(`${done} uploaded, ${failures.length} rejected — ${failures.slice(0, 3).join("; ")}`);
    setPage(1);
    refresh();
  }

  async function onBulkDownload() {
    if (selected.size === 0) return;
    setError(null);
    try {
      const blob = await fetchBlob(`${base}/bulk-download`, { method: "POST", body: { photoIds: [...selected] } });
      saveBlob(blob, `photos-${projectId}.zip`);
    } catch (err) {
      setError(errorMessage(err, "Bulk download failed"));
    }
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title="Photos"
        subtitle="Site photography organised by album, tagged, geolocated and analysed when AI is configured"
        icon={IconPhoto}
        tabs={<Tabs items={[{ value: "gallery", label: "Gallery" }, { value: "albums", label: "Albums", count: namedAlbums.length || undefined }]} value={tab} onChange={(v) => setTab(v as "gallery" | "albums")} />}
        actions={
          <div className="flex gap-2">
            <input ref={fileInputRef} type="file" accept="image/*,video/mp4,.heic" multiple className="hidden" onChange={(e) => void onFilesPicked(e)} />
            <Button variant={selectMode ? "primary" : "secondary"} onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>{selectMode ? `Done (${selected.size})` : "Select"}</Button>
            {selectMode ? <Button variant="secondary" disabled={selected.size === 0} onClick={() => void onBulkDownload()}>Download ZIP</Button> : null}
            <Button disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>{uploadBusy ? (uploadProgress ?? "Uploading…") : "Upload photos"}</Button>
          </div>
        }
      />

      <ErrorAlert message={error} />

      {tab === "gallery" ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <AlbumChip label="All" count={albumRows.reduce((s, a) => s + a.count, 0)} active={selectedAlbum === ""} onClick={() => { setSelectedAlbum(""); setPage(1); }} />
            {namedAlbums.map((a) => <AlbumChip key={a.album} label={a.isPrivate ? `🔒 ${a.album}` : a.album} count={a.count} active={selectedAlbum === a.album} onClick={() => { setSelectedAlbum(a.album); setPage(1); }} />)}
            {unfiledCount > 0 ? <AlbumChip label="Unfiled" count={unfiledCount} active={selectedAlbum === UNFILED} onClick={() => { setSelectedAlbum(UNFILED); setPage(1); }} /> : null}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="w-56"><Input placeholder="Search caption or file name…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></div>
            <div className="w-44">
              <Select value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
                <option value="">Any tag</option>
                {(tags.data?.items ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.manual + t.ai})</option>)}
              </Select>
            </div>
            <div className="w-36"><Select value={hasGps} onChange={(e) => { setHasGps(e.target.value); setPage(1); }}><option value="">GPS: any</option><option value="true">With GPS</option><option value="false">Without GPS</option></Select></div>
            <div className="w-32"><Select value={is360} onChange={(e) => { setIs360(e.target.value); setPage(1); }}><option value="">All media</option><option value="true">360° only</option></Select></div>
          </div>

          {list.error ? <ErrorAlert message={list.error} onRetry={list.reload} /> : photos === null ? <Spinner /> : photos.length === 0 ? (
            <EmptyState title={selectedAlbum || tag || debounced || hasGps || is360 ? "No photos match" : "No photos yet"} hint="Upload site photos to build the visual record. EXIF date and GPS are read on upload; AI tagging runs when the platform has an AI key configured, and says so when it does not." action={<Button disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>Upload photos</Button>} />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {photos.map((p) => (
                  <div key={p.id} className="flex flex-col">
                    <Thumb src={`${base}/${p.id}/content`} alt={p.caption ?? p.file?.name ?? "Site photo"} cache={blobCache} selected={selected.has(p.id)} selectMode={selectMode} onClick={() => (selectMode ? toggle(p.id) : setLightbox(p))} />
                    <div className="mt-1 flex items-center gap-1 truncate text-xs text-ink-500">
                      <span className="truncate">{p.caption ?? p.file?.name ?? DASH}</span>
                      {p.is360 === 1 ? <Badge tone="blue" size="xs">360°</Badge> : null}
                      {p.exif ? <Badge tone="gray" size="xs">EXIF</Badge> : null}
                      {p.aiStatus === "done" ? <Badge tone="violet" size="xs">AI</Badge> : p.aiStatus === "failed" ? <Badge tone="red" size="xs">AI failed</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
                <span>{total} photo{total === 1 ? "" : "s"} · page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
                  <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <AlbumsPanel base={base} albums={albums} users={users} nameOf={nameOf} me={me} onChanged={refresh} />
      )}

      <Lightbox base={base} photo={lightbox} albums={namedAlbums.map((a) => a.album)} sheets={sheets.data?.items ?? []} locations={locations} nameOf={nameOf} cache={blobCache} onClose={() => setLightbox(null)} onChanged={(p) => { setLightbox(p); refresh(); }} onDeleted={() => { setLightbox(null); refresh(); }} />
    </div>
  );
}

function Lightbox({ base, photo, albums, sheets, locations, nameOf, cache, onClose, onChanged, onDeleted }: {
  base: string;
  photo: Photo | null;
  albums: string[];
  sheets: Array<{ id: string; number: string; title: string }>;
  locations: { items: Array<{ id: string; name: string }>; labelOf: (id: string | null | undefined) => string };
  nameOf: (id: string | null | undefined) => string;
  cache: BlobCache;
  onClose: () => void;
  onChanged: (p: Photo) => void;
  onDeleted: () => void;
}) {
  const [caption, setCaption] = useState("");
  const [album, setAlbum] = useState("");
  const [tags, setTags] = useState("");
  const [is360, setIs360] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [pinSheet, setPinSheet] = useState("");
  const [pinX, setPinX] = useState("");
  const [pinY, setPinY] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return;
    setCaption(photo.caption ?? "");
    setAlbum(photo.album ?? "");
    setTags(photo.tags.join(", "));
    setIs360(photo.is360 === 1);
    setLocationId(photo.locationId ?? "");
    setPinSheet(photo.pin?.sheetId ?? "");
    setPinX(photo.pin ? String(photo.pin.x) : "");
    setPinY(photo.pin ? String(photo.pin.y) : "");
    setError(null);
    const src = `${base}/${photo.id}/content`;
    const cached = cache.current.get(src);
    if (cached) setUrl(cached);
    else {
      setUrl(null);
      fetchBlobUrl(src).then((u) => { cache.current.set(src, u); setUrl(u); }).catch(() => setUrl(null));
    }
  }, [photo, base, cache]);
  if (!photo) return <Modal open={false} title="" onClose={onClose}><span /></Modal>;

  async function save() {
    if (!photo) return;
    setBusy(true);
    setError(null);
    try {
      let pin: { sheetId: string; x: number; y: number } | null = null;
      if (pinSheet.trim() !== "") {
        const x = Number(pinX);
        const y = Number(pinY);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          setError("A drawing pin needs x and y between 0 and 1 (fractions of the sheet).");
          setBusy(false);
          return;
        }
        pin = { sheetId: pinSheet.trim(), x, y };
      }
      const updated = await api.patch<Photo>(`${base}/${photo.id}`, { caption: caption.trim() || null, album: album.trim() || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), is360, locationId: locationId || null, pin });
      onChanged(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function analyse() {
    if (!photo) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ photo: Photo; status: string; error: string | null; aiEnabled: boolean }>(`${base}/${photo.id}/analyse`);
      onChanged(res.photo);
      if (res.status !== "done") setError(res.error ?? `Analysis ${res.status}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!photo || !window.confirm("Delete this photo? The underlying file is retained for the record.")) return;
    setBusy(true);
    try {
      await api.del(`${base}/${photo.id}`);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const exif = photo.exif ?? {};
  return (
    <Modal open title={photo.file?.name ?? "Photo"} onClose={onClose} wide>
      <div className="space-y-4">
        <ErrorAlert message={error} />
        <div className="flex max-h-[50vh] items-center justify-center overflow-hidden rounded-lg bg-ink-950/5">
          {url ? (photo.contentType?.startsWith("video/") ? <video src={url} controls className="max-h-[50vh] max-w-full" /> : <img src={url} alt="Full-size site photo" className="max-h-[50vh] w-auto max-w-full object-contain" />) : <Spinner />}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {photo.aiStatus === "done" ? <Badge tone="violet">AI analysed</Badge> : photo.aiStatus === "pending" ? <Badge tone="blue">AI pending</Badge> : photo.aiStatus === "failed" ? <Badge tone="red">AI failed</Badge> : <Badge tone="gray">AI skipped</Badge>}
          {photo.aiError ? <span className="text-ink-400">{photo.aiError}</span> : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void analyse()}>Analyse now</Button>
        </div>
        {photo.aiSummary ? <Card><CardBody className="py-3"><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-violet-600">AI summary</div><p className="text-sm text-ink-700">{photo.aiSummary}</p></CardBody></Card> : null}
        {photo.aiTags.length > 0 ? <div className="flex flex-wrap gap-1.5">{photo.aiTags.map((t) => <Badge key={t} tone="violet">{t}</Badge>)}</div> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Caption"><Input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="What does this photo show?" /></Field>
          <Field label="Album"><Input value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="e.g. Level 3 — Framing" list="photo-albums" /></Field>
          <Field label="Tags" hint="Comma-separated; searchable alongside AI tags."><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="concrete, pour, level 3" /></Field>
          <Field label="Location"><Select value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">No location</option>{locations.items.map((l) => <option key={l.id} value={l.id}>{locations.labelOf(l.id)}</option>)}</Select></Field>
        </div>
        <datalist id="photo-albums">{albums.map((a) => <option key={a} value={a} />)}</datalist>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={is360} onChange={(e) => setIs360(e.target.checked)} /> 360° / panoramic capture</label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label="Drawing pin — sheet" hint={sheets.length > 0 ? "Where on the drawings this photo was taken (#433)." : "Sheet list unavailable — paste the sheet id if you know it."}>
            {sheets.length > 0 ? (
              <Select value={pinSheet} onChange={(e) => setPinSheet(e.target.value)}>
                <option value="">Not pinned</option>
                {sheets.map((sh) => <option key={sh.id} value={sh.id}>{sh.number} {sh.title}</option>)}
              </Select>
            ) : (
              <Input value={pinSheet} onChange={(e) => setPinSheet(e.target.value)} placeholder="sht_…" />
            )}
          </Field>
          <Field label="Pin x" hint="0 = left edge, 1 = right edge."><Input type="number" min="0" max="1" step="0.01" value={pinX} onChange={(e) => setPinX(e.target.value)} disabled={pinSheet.trim() === ""} /></Field>
          <Field label="Pin y" hint="0 = top edge, 1 = bottom edge."><Input type="number" min="0" max="1" step="0.01" value={pinY} onChange={(e) => setPinY(e.target.value)} disabled={pinSheet.trim() === ""} /></Field>
          <div className="flex items-end"><Button variant="ghost" size="sm" disabled={pinSheet.trim() === ""} onClick={() => { setPinSheet(""); setPinX(""); setPinY(""); }}>Clear pin</Button></div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-ink-500 sm:grid-cols-4">
          <span>Uploaded by {nameOf(photo.uploadedBy)}</span>
          <span>{formatDateTime(photo.createdAt)}</span>
          <span>Taken {photo.takenAt ? formatDateTime(photo.takenAt) : DASH}{exif["takenAt"] ? " (EXIF)" : ""}</span>
          <span>{photo.latitude !== null && photo.longitude !== null ? `${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)}` : "No GPS"}</span>
          <span>{typeof exif["make"] === "string" ? `${exif["make"]} ${typeof exif["model"] === "string" ? exif["model"] : ""}` : "No camera EXIF"}</span>
          <span>{photo.contentType ?? photo.file?.contentType ?? DASH}{photo.sizeBytes ? ` · ${Math.round(photo.sizeBytes / 1024)} KB` : ""}</span>
          <span>{photo.pin ? `Pinned to ${photo.pin.sheetId} @ ${photo.pin.x.toFixed(2)}, ${photo.pin.y.toFixed(2)}` : "No drawing pin"}</span>
          <span>{humanize(photo.contentType?.startsWith("video/") ? "video" : "image")}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void remove()}>Delete</Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
            <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function AlbumsPanel({ base, albums, users, nameOf, me, onChanged }: {
  base: string;
  albums: { data: { items: AlbumRow[] } | null; loading: boolean; error: string | null; reload: () => void };
  users: Array<{ id: string; name: string }>;
  nameOf: (id: string | null | undefined) => string;
  me: { id: string | null; isCompanyAdmin: boolean };
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", isPrivate: false, allowedUserIds: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/albums`, { name: form.name.trim(), description: form.description.trim() || null, isPrivate: form.isPrivate, allowedUserIds: form.allowedUserIds });
      setOpen(false);
      setForm({ name: "", description: "", isPrivate: false, allowedUserIds: [] });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function togglePrivate(a: AlbumRow) {
    if (!a.id) return;
    setBusy(true);
    try {
      await api.patch(`${base}/albums/${a.id}`, { isPrivate: !a.isPrivate });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const rows = (albums.data?.items ?? []).filter((a) => a.album !== null);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">Albums are free text on a photo; register one here to describe it or make it private. A private album is visible to its creator, its allow-list and photo admins.</p>
        <Button onClick={() => setOpen(true)}>New album</Button>
      </div>
      <ErrorAlert message={error ?? albums.error} />
      {rows.length === 0 ? <EmptyState title="No albums yet" hint="Upload a photo into an album, or register one here." /> : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.album} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ink-200 px-3 py-2 text-sm">
              <span><span className="font-medium text-ink-800">{a.album}</span> <span className="text-xs text-ink-400">· {a.count} photo{a.count === 1 ? "" : "s"}{a.description ? ` · ${a.description}` : ""}{a.createdBy ? ` · by ${nameOf(a.createdBy)}` : ""}</span> {a.isPrivate ? <Badge tone="amber" size="xs">Private · {a.allowedUserIds.length} allowed</Badge> : a.id ? <Badge tone="gray" size="xs">Registered</Badge> : null}</span>
              {a.id && (a.createdBy === me.id || me.isCompanyAdmin) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void togglePrivate(a)}>{a.isPrivate ? "Make public" : "Make private"}</Button> : null}
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} title="New album" onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
          <Field label="Description"><Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPrivate} onChange={(e) => setForm((f) => ({ ...f, isPrivate: e.target.checked }))} /> Private</label>
          {form.isPrivate ? (
            <Field label="Allowed users"><select multiple className="h-28 w-full rounded-md border border-ink-200 bg-white px-2 py-1 text-sm" value={form.allowedUserIds} onChange={(e) => setForm((f) => ({ ...f, allowedUserIds: Array.from(e.target.selectedOptions).map((o) => o.value) }))}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          ) : null}
          {form.isPrivate ? <Alert tone="info" size="sm">Photo admins and the album's creator always see it.</Alert> : null}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || form.name.trim() === ""} onClick={() => void create()}>{busy ? "Saving…" : "Create album"}</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function AlbumChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${active ? "bg-brand-600 text-white" : "bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50"}`}>
      {label}
      <span className={active ? "text-brand-100" : "text-ink-400"}>{count}</span>
    </button>
  );
}
