import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MutableRefObject,
} from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
} from "../../ui";
import { formatDateTime } from "../format";
import { useCompanyUsers, type ListResponse } from "../rfis/fieldShared";

interface Photo {
  id: string;
  fileId: string;
  album: string | null;
  caption: string | null;
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
  aiTags: string[];
  aiSummary: string | null;
  uploadedBy: string;
  createdAt: string;
  file?: { id: string; name: string; contentType: string; sizeBytes: number };
}

interface AlbumRow {
  album: string | null;
  count: number;
}

const PAGE_SIZE = 48;
const UNFILED = "__unfiled";

type BlobCache = MutableRefObject<Map<string, string>>;

function Thumb({
  fileId,
  alt,
  cache,
  onClick,
}: {
  fileId: string;
  alt: string;
  cache: BlobCache;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(() => cache.current.get(fileId) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const cached = cache.current.get(fileId);
    if (cached) {
      setUrl(cached);
      return;
    }
    fetchBlobUrl(`/api/v1/files/${fileId}/download`)
      .then((u) => {
        const existing = cache.current.get(fileId);
        if (existing && existing !== u) {
          URL.revokeObjectURL(u);
          if (alive) setUrl(existing);
          return;
        }
        cache.current.set(fileId, u);
        if (alive) setUrl(u);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [fileId, cache]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded-lg bg-ink-100 ring-1 ring-ink-100 focus-visible:outline-2 focus-visible:outline-brand-600"
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
        />
      ) : failed ? (
        <span className="flex h-full w-full items-center justify-center text-xs text-ink-400">
          Unavailable
        </span>
      ) : (
        <span className="flex h-full w-full items-center justify-center">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-brand-600" />
        </span>
      )}
    </button>
  );
}

export default function PhotosPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const base = `/api/v1/projects/${projectId}/photos`;
  const { nameOf } = useCompanyUsers();

  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [albums, setAlbums] = useState<AlbumRow[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobCache = useRef(new Map<string, string>());

  const [lightbox, setLightbox] = useState<Photo | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [albumDraft, setAlbumDraft] = useState("");
  const [lightboxError, setLightboxError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  useEffect(() => {
    const cache = blobCache.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const loadAlbums = useCallback(async () => {
    try {
      const res = await api.get<{ items: AlbumRow[] }>(`${base}/albums`);
      setAlbums(res.items);
    } catch {
      setAlbums([]);
    }
  }, [base]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (selectedAlbum && selectedAlbum !== UNFILED) params.set("album", selectedAlbum);
      const res = await api.get<ListResponse<Photo>>(`${base}?${params}`);
      const items =
        selectedAlbum === UNFILED ? res.items.filter((p) => !p.album) : res.items;
      setPhotos(items);
      setTotal(selectedAlbum === UNFILED ? items.length : res.total);
    } catch (err) {
      setPhotos([]);
      setError(err instanceof Error ? err.message : "Failed to load photos");
    }
  }, [base, projectId, page, selectedAlbum]);

  useEffect(() => {
    void load();
    void loadAlbums();
  }, [load, loadAlbums]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const unfiledCount = albums.find((a) => a.album === null)?.count ?? 0;
  const namedAlbums = albums.filter((a) => a.album !== null) as Array<{
    album: string;
    count: number;
  }>;

  async function onFilesPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setUploadBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const file of files) {
        setUploadProgress(`Uploading ${done + 1} of ${files.length}…`);
        const form = new FormData();
        form.append("file", file);
        if (selectedAlbum && selectedAlbum !== UNFILED) form.append("album", selectedAlbum);
        await api.upload(base, form);
        done += 1;
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? `Upload failed after ${done} of ${files.length}: ${err.message}`
          : "Upload failed",
      );
    } finally {
      setUploadBusy(false);
      setUploadProgress(null);
      setPage(1);
      await Promise.all([load(), loadAlbums()]);
    }
  }

  function openLightbox(photo: Photo) {
    setLightbox(photo);
    setCaptionDraft(photo.caption ?? "");
    setAlbumDraft(photo.album ?? "");
    setLightboxError(null);
  }

  async function onSaveMeta() {
    if (!lightbox) return;
    setSaveBusy(true);
    setLightboxError(null);
    try {
      const updated = await api.patch<Photo>(`/api/v1/photos/${lightbox.id}`, {
        caption: captionDraft.trim() !== "" ? captionDraft.trim() : null,
        album: albumDraft.trim() !== "" ? albumDraft.trim() : null,
      });
      setLightbox((prev) => (prev ? { ...prev, ...updated } : prev));
      await Promise.all([load(), loadAlbums()]);
    } catch (err) {
      setLightboxError(err instanceof ApiClientError ? err.message : "Failed to save changes");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Photos"
        subtitle="Site photography organised by album, with AI tagging"
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void onFilesPicked(e)}
            />
            <Button disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>
              {uploadBusy ? (uploadProgress ?? "Uploading…") : "Upload photos"}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <AlbumChip
          label="All"
          count={albums.reduce((s, a) => s + a.count, 0)}
          active={selectedAlbum === ""}
          onClick={() => {
            setSelectedAlbum("");
            setPage(1);
          }}
        />
        {namedAlbums.map((a) => (
          <AlbumChip
            key={a.album}
            label={a.album}
            count={a.count}
            active={selectedAlbum === a.album}
            onClick={() => {
              setSelectedAlbum(a.album);
              setPage(1);
            }}
          />
        ))}
        {unfiledCount > 0 ? (
          <AlbumChip
            label="Unfiled"
            count={unfiledCount}
            active={selectedAlbum === UNFILED}
            onClick={() => {
              setSelectedAlbum(UNFILED);
              setPage(1);
            }}
          />
        ) : null}
      </div>

      <ErrorAlert message={error} />

      {photos === null ? (
        <Spinner />
      ) : photos.length === 0 ? (
        <EmptyState
          title={selectedAlbum ? "No photos in this album" : "No photos yet"}
          hint="Upload site photos to build the visual record. AI tagging runs on new images."
          action={
            <Button disabled={uploadBusy} onClick={() => fileInputRef.current?.click()}>
              Upload photos
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {photos.map((p) => (
              <div key={p.id} className="flex flex-col">
                <Thumb
                  fileId={p.fileId}
                  alt={p.caption ?? p.file?.name ?? "Site photo"}
                  cache={blobCache}
                  onClick={() => openLightbox(p)}
                />
                <div className="mt-1 truncate text-xs text-ink-500">
                  {p.caption ?? p.file?.name ?? "—"}
                </div>
              </div>
            ))}
          </div>

          {selectedAlbum !== UNFILED ? (
            <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
              <span>
                {total} photo{total === 1 ? "" : "s"} · page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <Modal
        open={lightbox !== null}
        title={lightbox?.file?.name ?? "Photo"}
        onClose={() => setLightbox(null)}
        wide
      >
        {lightbox ? (
          <div className="space-y-4">
            <ErrorAlert message={lightboxError} />
            <div className="flex max-h-[55vh] items-center justify-center overflow-hidden rounded-lg bg-ink-950/5">
              <LightboxImage fileId={lightbox.fileId} cache={blobCache} />
            </div>

            {lightbox.aiSummary ? (
              <Card>
                <CardBody className="py-3">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-violet-600">
                    AI summary
                  </div>
                  <p className="text-sm text-ink-700">{lightbox.aiSummary}</p>
                </CardBody>
              </Card>
            ) : null}

            {lightbox.aiTags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {lightbox.aiTags.map((tag) => (
                  <Badge key={tag} tone="violet">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Caption">
                <Input
                  value={captionDraft}
                  onChange={(e) => setCaptionDraft(e.target.value)}
                  placeholder="What does this photo show?"
                />
              </Field>
              <Field label="Album">
                <Input
                  value={albumDraft}
                  onChange={(e) => setAlbumDraft(e.target.value)}
                  placeholder="e.g. Level 3 — Framing"
                  list="photo-albums"
                />
              </Field>
            </div>
            <datalist id="photo-albums">
              {namedAlbums.map((a) => (
                <option key={a.album} value={a.album} />
              ))}
            </datalist>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-ink-400">
                Uploaded by {nameOf(lightbox.uploadedBy)} · {formatDateTime(lightbox.createdAt)}
                {lightbox.takenAt ? ` · taken ${formatDateTime(lightbox.takenAt)}` : ""}
                {lightbox.latitude !== null && lightbox.longitude !== null
                  ? ` · ${lightbox.latitude.toFixed(5)}, ${lightbox.longitude.toFixed(5)}`
                  : ""}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setLightbox(null)}>
                  Close
                </Button>
                <Button size="sm" disabled={saveBusy} onClick={() => void onSaveMeta()}>
                  {saveBusy ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function LightboxImage({ fileId, cache }: { fileId: string; cache: BlobCache }) {
  const [url, setUrl] = useState<string | null>(() => cache.current.get(fileId) ?? null);
  useEffect(() => {
    let alive = true;
    const cached = cache.current.get(fileId);
    if (cached) {
      setUrl(cached);
      return;
    }
    fetchBlobUrl(`/api/v1/files/${fileId}/download`)
      .then((u) => {
        cache.current.set(fileId, u);
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fileId, cache]);
  if (!url) return <Spinner />;
  return <img src={url} alt="Full-size site photo" className="max-h-[55vh] w-auto max-w-full object-contain" />;
}

function AlbumChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-brand-600 text-white"
          : "bg-white text-ink-600 ring-1 ring-ink-200 hover:bg-ink-50"
      }`}
    >
      {label}
      <span className={active ? "text-brand-100" : "text-ink-400"}>{count}</span>
    </button>
  );
}
