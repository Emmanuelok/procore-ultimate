import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatBytes, formatDateTime } from "../format";

interface Folder {
  id: string;
  parentId?: string | null;
  name: string;
  path?: string | null;
}

interface FileItem {
  id: string;
  name: string;
  folderId?: string | null;
  version?: number | null;
  currentVersion?: number | null;
  sizeBytes?: number | null;
  size?: number | null;
  uploadedBy?: string | null;
  uploadedByName?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  checkedOutBy?: string | null;
  checkedOutByName?: string | null;
}

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface TreeNode {
  folder: Folder;
  children: TreeNode[];
  depth: number;
}

function buildTree(folders: Folder[]): TreeNode[] {
  const byParent = new Map<string, Folder[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : "";
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(f);
    else byParent.set(parent, [f]);
  }
  const attach = (parentKey: string, depth: number): TreeNode[] =>
    (byParent.get(parentKey) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ folder: f, depth, children: attach(f.id, depth + 1) }));
  return attach("", 0);
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiClientError || err instanceof Error ? err.message : fallback;
}

function FolderRow({
  node,
  selectedId,
  expanded,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  selectedId: string | null;
  expanded: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const isOpen = expanded.has(node.folder.id);
  const isSelected = selectedId === node.folder.id;
  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-sm ${
          isSelected ? "bg-brand-50 font-medium text-brand-800" : "text-ink-700 hover:bg-ink-50"
        }`}
        style={{ paddingLeft: `${node.depth * 16 + 6}px` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => onToggle(node.folder.id)}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-400 hover:text-ink-700"
            aria-label={isOpen ? "Collapse" : "Expand"}
          >
            <svg
              viewBox="0 0 12 12"
              fill="currentColor"
              className={`h-2.5 w-2.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
            >
              <path d="M4 2l5 4-5 4V2z" />
            </svg>
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.folder.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 shrink-0 text-amber-500">
            <path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.086a1.5 1.5 0 0 1 1.06.44l.915.914a.5.5 0 0 0 .353.146H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3Z" />
          </svg>
          <span className="truncate">{node.folder.name}</span>
        </button>
      </div>
      {isOpen
        ? node.children.map((c) => (
            <FolderRow
              key={c.folder.id}
              node={c}
              selectedId={selectedId}
              expanded={expanded}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  );
}

export default function DocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<FileItem[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [folderModal, setFolderModal] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);

  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const versionRef = useRef<HTMLInputElement | null>(null);
  const versionFileIdRef = useRef<string | null>(null);

  const loadFolders = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api.get<ListResponse<Folder>>(
        `/api/v1/projects/${projectId}/folders?page=1&pageSize=500`,
      );
      setFolders(res.items);
      setSelectedFolderId((current) => {
        if (current && res.items.some((f) => f.id === current)) return current;
        const roots = res.items.filter(
          (f) => !f.parentId || !res.items.some((x) => x.id === f.parentId),
        );
        return roots[0]?.id ?? null;
      });
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        return new Set(
          res.items
            .filter((f) => !f.parentId || !res.items.some((x) => x.id === f.parentId))
            .map((f) => f.id),
        );
      });
    } catch (err) {
      setFolders([]);
      setError(errMsg(err, "Failed to load folders"));
    }
  }, [projectId]);

  const loadFiles = useCallback(async () => {
    if (!projectId) return;
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "200" });
      if (search.trim()) params.set("search", search.trim());
      else if (selectedFolderId) params.set("folderId", selectedFolderId);
      const res = await api.get<ListResponse<FileItem>>(
        `/api/v1/projects/${projectId}/files?${params}`,
      );
      setFiles(res.items);
    } catch (err) {
      setFiles([]);
      setError(errMsg(err, "Failed to load files"));
    }
  }, [projectId, selectedFolderId, search]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    const t = setTimeout(() => void loadFiles(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadFiles, search]);

  const tree = useMemo(() => buildTree(folders ?? []), [folders]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onCreateFolder(e: FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setFolderError(null);
    try {
      const payload: Record<string, unknown> = { name: folderName.trim() };
      if (selectedFolderId) payload["parentId"] = selectedFolderId;
      await api.post(`/api/v1/projects/${projectId}/folders`, payload);
      setFolderModal(false);
      setFolderName("");
      await loadFolders();
    } catch (err) {
      setFolderError(errMsg(err, "Failed to create folder"));
    }
  }

  async function onUploadChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !projectId || !selectedFolderId) return;
    setError(null);
    setNotice(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      await api.upload(
        `/api/v1/projects/${projectId}/folders/${selectedFolderId}/files`,
        fd,
      );
      setNotice(null);
      await loadFiles();
    } catch (err) {
      setNotice(null);
      setError(errMsg(err, "Upload failed"));
    }
  }

  async function onVersionChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const fileId = versionFileIdRef.current;
    e.target.value = "";
    versionFileIdRef.current = null;
    if (!file || !fileId) return;
    setError(null);
    setNotice(`Uploading new version of ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      await api.upload(`/api/v1/files/${fileId}/versions`, fd);
      setNotice(null);
      await loadFiles();
    } catch (err) {
      setNotice(null);
      setError(errMsg(err, "New version upload failed"));
    }
  }

  async function onDownload(f: FileItem) {
    setBusyFileId(f.id);
    setError(null);
    try {
      const url = await fetchBlobUrl(`/api/v1/files/${f.id}/download`);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(errMsg(err, "Download failed"));
    } finally {
      setBusyFileId(null);
    }
  }

  async function onCheckoutToggle(f: FileItem) {
    setBusyFileId(f.id);
    setError(null);
    try {
      await api.post(`/api/v1/files/${f.id}/${f.checkedOutBy ? "checkin" : "checkout"}`);
      await loadFiles();
    } catch (err) {
      setError(errMsg(err, "Checkout state change failed"));
    } finally {
      setBusyFileId(null);
    }
  }

  async function onRename(e: FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;
    setRenameError(null);
    try {
      await api.patch(`/api/v1/files/${renameTarget.id}`, { name: renameValue.trim() });
      setRenameTarget(null);
      await loadFiles();
    } catch (err) {
      setRenameError(errMsg(err, "Rename failed"));
    }
  }

  const selectedFolder = (folders ?? []).find((f) => f.id === selectedFolderId) ?? null;

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle="Versioned project files with checkout control"
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => setFolderModal(true)}>
              New folder
            </Button>
            <Button
              size="sm"
              disabled={!selectedFolderId}
              title={selectedFolderId ? undefined : "Select a folder first"}
              onClick={() => uploadRef.current?.click()}
            >
              Upload file
            </Button>
          </>
        }
      />
      <input ref={uploadRef} type="file" className="hidden" onChange={onUploadChange} />
      <input ref={versionRef} type="file" className="hidden" onChange={onVersionChange} />

      <ErrorAlert message={error} />
      {notice ? (
        <div className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800 ring-1 ring-brand-100">
          {notice}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Folder tree */}
        <Card className="w-full shrink-0 lg:w-64">
          <div className="border-b border-ink-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
            Folders
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {folders === null ? (
              <Spinner />
            ) : tree.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-ink-400">
                No folders yet. Create one to start uploading.
              </p>
            ) : (
              tree.map((n) => (
                <FolderRow
                  key={n.folder.id}
                  node={n}
                  selectedId={selectedFolderId}
                  expanded={expanded}
                  onSelect={(id) => {
                    setSelectedFolderId(id);
                    setSearch("");
                  }}
                  onToggle={toggle}
                />
              ))
            )}
          </div>
        </Card>

        {/* File pane */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-ink-500">
              {search.trim()
                ? `Search results for "${search.trim()}"`
                : selectedFolder
                  ? selectedFolder.path ?? selectedFolder.name
                  : "All files"}
            </div>
            <div className="w-64">
              <Input
                placeholder="Search files across folders…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {files === null ? (
            <Spinner />
          ) : files.length === 0 ? (
            <EmptyState
              title={search ? "No files match your search" : "No files in this folder"}
              hint={
                search
                  ? "Try a different term."
                  : "Upload drawings, specs, contracts and correspondence."
              }
              action={
                !search && selectedFolderId ? (
                  <Button onClick={() => uploadRef.current?.click()}>Upload file</Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Version</Th>
                  <Th>Size</Th>
                  <Th>Uploaded by</Th>
                  <Th>Updated</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {files.map((f) => {
                  const busy = busyFileId === f.id;
                  return (
                    <tr key={f.id} className="hover:bg-ink-50/60">
                      <Td className="max-w-xs truncate font-medium">{f.name}</Td>
                      <Td>v{f.version ?? f.currentVersion ?? 1}</Td>
                      <Td>{formatBytes(f.sizeBytes ?? f.size)}</Td>
                      <Td>{f.uploadedByName ?? f.uploadedBy ?? "—"}</Td>
                      <Td className="whitespace-nowrap text-xs">
                        {formatDateTime(f.updatedAt ?? f.createdAt)}
                      </Td>
                      <Td>
                        {f.checkedOutBy ? (
                          <Badge tone="amber">
                            Checked out{f.checkedOutByName ? ` — ${f.checkedOutByName}` : ""}
                          </Badge>
                        ) : (
                          <Badge tone="green">Available</Badge>
                        )}
                      </Td>
                      <Td className="text-right">
                        <span className="flex justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => onDownload(f)}
                          >
                            Download
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              versionFileIdRef.current = f.id;
                              versionRef.current?.click();
                            }}
                          >
                            New version
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => onCheckoutToggle(f)}
                          >
                            {f.checkedOutBy ? "Check in" : "Check out"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setRenameTarget(f);
                              setRenameValue(f.name);
                              setRenameError(null);
                            }}
                          >
                            Rename
                          </Button>
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </div>

      <Modal open={folderModal} title="New folder" onClose={() => setFolderModal(false)}>
        <ErrorAlert message={folderError} />
        <form onSubmit={onCreateFolder} className="space-y-4">
          <Field
            label="Folder name"
            hint={
              selectedFolder
                ? `Created inside "${selectedFolder.name}".`
                : "Created at the top level."
            }
          >
            <Input
              required
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="03 — Contracts"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFolderModal(false)}>
              Cancel
            </Button>
            <Button type="submit">Create folder</Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={renameTarget !== null}
        title="Rename file"
        onClose={() => setRenameTarget(null)}
      >
        <ErrorAlert message={renameError} />
        <form onSubmit={onRename} className="space-y-4">
          <Field label="File name">
            <Input
              required
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button type="submit">Rename</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
