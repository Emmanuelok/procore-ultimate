/**
 * DOCUMENTS — spec Vol I §2.2 (#287–#301), routed at /projects/:projectId/documents.
 *
 *   Files      the folder tree (privacy and ACLs inherited down the path),
 *              a metadata-searchable register, multi-file upload with
 *              per-file progress, preview, versions, copy, check-in/out.
 *   Access     the download-tracking report (#299).
 *   Inbound    e-mail-to-folder ingestion log and the address to use (#300).
 *   Recycle    soft-deleted files, restorable by documents admins.
 *
 * Every action button reflects what the API will actually allow: the file
 * list carries the caller's level and the holder of each checkout, so the
 * page never offers a "Check in" that is going to be refused.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, ApiClientError, fetchBlobUrl, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useResource } from "../../layouts/project/lib";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  ErrorAlert,
  Field,
  FileDropzone,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Stat,
  Tabs,
  Textarea,
  useConfirm,
  type DataColumns,
} from "../../ui";
import { IconFolder, IconFolderOpen, IconLock, IconMail, IconTrash, IconUpload } from "../../ui/icons";
import { formatBytes, formatDateTime, humanize } from "../format";

/* ------------------------------------------------------------------------- */
/* Wire types                                                                 */
/* ------------------------------------------------------------------------- */

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  isPrivate: number;
  permissions: Record<string, string>;
  effectiveLevel: "none" | "read" | "standard" | "admin";
  fileCount: number;
  children: FolderNode[];
}

interface FoldersResponse {
  items: FolderNode[];
  total: number;
  access: { level: string; seesPrivate: boolean };
}

interface FileItem {
  id: string;
  name: string;
  folderId: string | null;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  isPrivate: number;
  checkedOutBy: string | null;
  checkedOutByName?: string | null;
  checkedOutAt: string | null;
  documentType: string | null;
  tags: string[];
  description: string | null;
  revisionLabel: string | null;
  metadata: Record<string, unknown>;
  pipelineOwned?: boolean;
  deletedAt: string | null;
  deletedBy: string | null;
  uploadedBy: string;
  uploadedByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FilesResponse {
  items: FileItem[];
  total: number;
  access: { level: string; seesPrivate: boolean; isDocumentsAdmin: boolean };
}

interface FileVersion {
  id: string;
  version: number;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  note: string | null;
  uploadedBy: string;
  createdAt: string;
}

interface FileDetail extends FileItem {
  versions: FileVersion[];
  accessCount: number;
  folderPath: string | null;
  references: string[];
  previewable: boolean;
  people: Record<string, { id: string; name: string; email: string }>;
  access: { level: string; isDocumentsAdmin: boolean; canCheckin: boolean };
}

interface AccessReport {
  since: string;
  totals: { events: number; downloads: number; views: number; uniqueUsers: number; uniqueFiles: number };
  byFile: Array<{ fileId: string; name: string | null; deleted: boolean; downloads: number; views: number; other: number; uniqueUsers: number; lastAt: string | null }>;
  byUser: Array<{ userId: string; name: string | null; events: number; filesTouched: number; lastAt: string | null }>;
  recent: Array<{ id: string; fileId: string; fileName: string | null; userId: string; userName: string | null; action: string; context: string | null; at: string }>;
}

interface InboundEmail {
  id: string;
  folderId: string | null;
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  status: string;
  rejectReason: string | null;
  attachmentCount: number;
  fileIds: string[];
  rejected: Array<{ filename: string; reason: string }>;
  createdAt: string;
}

interface CompanyUser {
  id: string;
  name: string;
  email: string;
}

const DOCUMENT_TYPES = ["drawing", "specification", "contract", "correspondence", "report", "photo", "schedule", "submittal", "rfi", "permit", "certificate", "invoice", "meeting", "safety", "quality", "email", "other"] as const;
const FOLDER_LEVELS = ["none", "read", "standard", "admin"] as const;

function errMsg(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    const rejected = (err.details as { details?: { rejected?: Array<{ filename: string; reason: string }> } } | undefined)?.details?.rejected;
    if (rejected?.length) return `${err.message}: ${rejected.map((r) => `${r.filename} — ${r.reason}`).join("; ")}`;
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

/** Multipart upload with progress: the fetch API cannot report upload progress, XHR can. */
function uploadWithProgress(url: string, form: FormData, onProgress: (pct: number) => void, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    const access = tokenStore.access;
    if (access) xhr.setRequestHeader("authorization", `Bearer ${access}`);
    const companyId = tokenStore.companyId;
    if (companyId) xhr.setRequestHeader("x-company-id", companyId);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new ApiClientError(xhr.status, (body as { message?: string } | null)?.message ?? `Upload failed (${xhr.status})`, body));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(form);
  });
}

function flatten(nodes: FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (list: FolderNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/* ------------------------------------------------------------------------- */
/* Folder tree                                                                */
/* ------------------------------------------------------------------------- */

function FolderRow({ node, depth, selectedId, expanded, onSelect, onToggle }: { node: FolderNode; depth: number; selectedId: string | null; expanded: Set<string>; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  const isOpen = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  const Glyph = isOpen ? IconFolderOpen : IconFolder;
  return (
    <div>
      <div className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-sm ${isSelected ? "bg-brand-50 font-medium text-brand-800" : "text-ink-700 hover:bg-ink-50"}`} style={{ paddingLeft: `${depth * 14 + 6}px` }}>
        {node.children.length > 0 ? (
          <button type="button" onClick={() => onToggle(node.id)} className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-400 hover:text-ink-700" aria-label={isOpen ? "Collapse" : "Expand"}>
            <svg viewBox="0 0 12 12" fill="currentColor" className={`h-2.5 w-2.5 transition-transform ${isOpen ? "rotate-90" : ""}`}><path d="M4 2l5 4-5 4V2z" /></svg>
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <button type="button" onClick={() => onSelect(node.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={`${node.path} · ${node.effectiveLevel}`}>
          <Glyph size={14} className="shrink-0 text-amber-500" />
          <span className="truncate">{node.name}</span>
          {node.isPrivate === 1 ? <IconLock size={11} className="shrink-0 text-ink-400" /> : null}
          <span className="ml-auto text-2xs text-ink-300">{node.fileCount || ""}</span>
        </button>
      </div>
      {isOpen ? node.children.map((c) => <FolderRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} expanded={expanded} onSelect={onSelect} onToggle={onToggle} />) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Page                                                                       */
/* ------------------------------------------------------------------------- */

type TabKey = "files" | "access" | "inbound" | "recycle";

export default function DocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("files");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const health = useResource<{ metrics: Record<string, number | null>; reasons: string[] }>(projectId ? `/api/v1/projects/${projectId}/documents/health-inputs?_v=${version}` : null);
  const folders = useResource<FoldersResponse>(projectId ? `/api/v1/projects/${projectId}/folders?_v=${version}` : null);
  const flat = useMemo(() => flatten(folders.data?.items ?? []), [folders.data]);
  const isAdmin = folders.data?.access.seesPrivate ?? false;

  if (!projectId) return null;
  const m = health.data?.metrics ?? {};
  const tabs: Array<{ value: TabKey; label: string; count?: number; tone?: "warning" | "info" }> = [
    { value: "files", label: "Files" },
    { value: "access", label: "Access report" },
    { value: "inbound", label: "Inbound e-mail", ...((m["inboundRejected7d"] ?? 0) > 0 ? { count: m["inboundRejected7d"] ?? 0, tone: "warning" as const } : {}) },
    ...(isAdmin ? [{ value: "recycle" as const, label: "Recycle bin" }] : []),
  ];

  return (
    <div>
      <PageHeader icon={IconFolder} title="Documents" subtitle="Versioned, content-addressed project files with folder privacy and ACLs, check-in/out, metadata search, access tracking and e-mail capture." tabs={<Tabs items={tabs} value={tab} onChange={setTab} />} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Files" value={m["files"] != null ? Number(m["files"]).toLocaleString() : "—"} loading={health.loading} />
        <Stat label="Checked out" value={m["checkedOut"] != null ? Number(m["checkedOut"]).toLocaleString() : "—"} loading={health.loading} />
        <Stat label="Stale checkouts" value={m["staleCheckouts"] != null ? Number(m["staleCheckouts"]).toLocaleString() : "—"} tone={(m["staleCheckouts"] ?? 0) > 0 ? "warning" : undefined} hint="Held for more than 7 days; the holder is reminded by the scheduler." loading={health.loading} />
        <Stat label="Downloads, 7 days" value={m["downloads7d"] != null ? Number(m["downloads7d"]).toLocaleString() : "—"} loading={health.loading} />
        <Stat label="Inbound refused, 7 days" value={m["inboundRejected7d"] != null ? Number(m["inboundRejected7d"]).toLocaleString() : "—"} tone={(m["inboundRejected7d"] ?? 0) > 0 ? "warning" : undefined} loading={health.loading} />
      </div>

      {tab === "files" ? (
        <FilesTab projectId={projectId} userId={user?.id ?? null} folders={folders} flat={flat} isAdmin={isAdmin} version={version} onChanged={refresh} />
      ) : tab === "access" ? (
        <AccessTab projectId={projectId} version={version} />
      ) : tab === "inbound" ? (
        <InboundTab projectId={projectId} flat={flat} version={version} onChanged={refresh} />
      ) : (
        <RecycleTab projectId={projectId} version={version} onChanged={refresh} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Files tab                                                                  */
/* ------------------------------------------------------------------------- */

function FilesTab({ projectId, userId, folders, flat, isAdmin, version, onChanged }: { projectId: string; userId: string | null; folders: ReturnType<typeof useResource<FoldersResponse>>; flat: FolderNode[]; isAdmin: boolean; version: number; onChanged: () => void }) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [tag, setTag] = useState("");
  const [checkedOut, setCheckedOut] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<"create" | "edit" | "permissions" | null>(null);
  const [uploadMeta, setUploadMeta] = useState({ documentType: "", tags: "", description: "", revisionLabel: "" });
  const [showUpload, setShowUpload] = useState(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(h);
  }, [search]);

  useEffect(() => {
    if (flat.length === 0) return;
    setSelectedFolderId((cur) => (cur && flat.some((f) => f.id === cur) ? cur : (folders.data?.items[0]?.id ?? null)));
    setExpanded((prev) => (prev.size > 0 ? prev : new Set((folders.data?.items ?? []).map((f) => f.id))));
  }, [flat, folders.data]);

  const params = new URLSearchParams({ pageSize: "500", _v: String(version) });
  if (debounced) params.set("search", debounced);
  else if (selectedFolderId) params.set("folderId", selectedFolderId);
  if (documentType) params.set("documentType", documentType);
  if (tag.trim()) params.set("tag", tag.trim());
  if (checkedOut) params.set("checkedOut", checkedOut);
  const files = useResource<FilesResponse>(`/api/v1/projects/${projectId}/files?${params}`);
  const selectedFolder = flat.find((f) => f.id === selectedFolderId) ?? null;
  const canWriteHere = selectedFolder ? selectedFolder.effectiveLevel === "standard" || selectedFolder.effectiveLevel === "admin" : false;

  const reloadAll = useCallback(() => {
    files.reload();
    folders.reload();
    onChanged();
  }, [files, folders, onChanged]);

  async function act(f: FileItem, action: "download" | "checkout" | "checkin" | "copy" | "delete") {
    setError(null);
    try {
      if (action === "download") {
        const url = await fetchBlobUrl(`/api/v1/files/${f.id}/download`);
        const a = document.createElement("a");
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        onChanged();
        return;
      }
      if (action === "delete") {
        const ok = await confirm({ title: `Delete ${f.name}?`, description: "The file goes to the recycle bin, where a documents admin can restore it. Files that back drawing sets, spec books, photos or submittals are refused.", confirmLabel: "Delete", tone: "danger" });
        if (!ok) return;
        await api.del(`/api/v1/files/${f.id}`);
      } else {
        await api.post(`/api/v1/files/${f.id}/${action}`, {});
        if (action === "copy") setNotice(`Copied ${f.name} — the copy shares the same content-addressed bytes.`);
      }
      reloadAll();
    } catch (err) {
      setError(errMsg(err, "The action failed"));
    }
  }

  const rows = files.data?.items ?? [];
  const columns = useMemo<DataColumns<FileItem>>(
    () => [
      { id: "name", header: "Name", accessor: "name", type: "text", width: 280, sticky: "start", truncate: true, cell: ({ row }) => <span className="flex items-center gap-1.5">{row.isPrivate === 1 ? <IconLock size={12} className="text-ink-400" /> : null}<span className="truncate font-medium">{row.name}</span>{row.pipelineOwned ? <Badge tone="neutral" size="xs">pipeline</Badge> : null}</span> },
      { id: "type", header: "Type", accessor: (r) => r.documentType ?? "", type: "status", width: 120, groupable: true, cell: ({ row }) => (row.documentType ? humanize(row.documentType) : <span className="text-ink-300">—</span>) },
      { id: "tags", header: "Tags", accessor: (r) => r.tags.join(" "), type: "text", width: 160, cell: ({ row }) => <span className="flex flex-wrap gap-1">{row.tags.map((t) => <Badge key={t} tone="neutral" size="xs" variant="outline">{t}</Badge>)}</span> },
      { id: "rev", header: "Issuer rev", accessor: (r) => r.revisionLabel ?? "", type: "text", width: 90, cell: ({ row }) => row.revisionLabel ?? "—" },
      { id: "version", header: "Ver", accessor: "version", type: "number", align: "right", width: 60, cell: ({ row }) => `v${row.version}` },
      { id: "size", header: "Size", accessor: "sizeBytes", type: "number", align: "right", width: 90, cell: ({ row }) => formatBytes(row.sizeBytes) },
      { id: "by", header: "Uploaded by", accessor: (r) => r.uploadedByName ?? r.uploadedBy, type: "text", width: 150, cell: ({ row }) => row.uploadedByName ?? "—" },
      { id: "updated", header: "Updated", accessor: "updatedAt", type: "text", width: 150, cell: ({ row }) => formatDateTime(row.updatedAt) },
      { id: "status", header: "Status", accessor: (r) => (r.checkedOutBy ? "checked out" : "available"), type: "status", width: 200, cell: ({ row }) => (row.checkedOutBy ? <Badge tone="warning" size="xs">checked out{row.checkedOutByName ? ` — ${row.checkedOutByName}` : ""}</Badge> : <Badge tone="success" size="xs">available</Badge>) },
    ],
    [],
  );

  const canCheckin = (f: FileItem) => f.checkedOutBy === userId || Boolean(files.data?.access.isDocumentsAdmin);

  return (
    <div className="space-y-3">
      {dialog}
      <ErrorAlert message={error} />
      {notice ? <Alert tone="info" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {folders.error ? <Alert tone="danger" title="Folders could not be loaded">{folders.error}</Alert> : null}
      <div className="flex flex-col gap-4 lg:flex-row">
        <Card className="w-full shrink-0 lg:w-72">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">Folders</span>
            <span className="flex gap-1">
              <Button variant="ghost" size="xs" onClick={() => setFolderModal("create")} title="New folder">+ New</Button>
              {selectedFolder ? <Button variant="ghost" size="xs" onClick={() => setFolderModal("edit")} title="Rename or move">Edit</Button> : null}
              {selectedFolder && isAdmin ? <Button variant="ghost" size="xs" onClick={() => setFolderModal("permissions")} title="Folder permissions">ACL</Button> : null}
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {folders.loading && !folders.data ? <Spinner /> : (folders.data?.items ?? []).length === 0 ? <p className="px-2 py-4 text-center text-xs text-ink-400">No folders yet. Create one to start uploading.</p> : (folders.data?.items ?? []).map((n) => <FolderRow key={n.id} node={n} depth={0} selectedId={selectedFolderId} expanded={expanded} onSelect={(id) => { setSelectedFolderId(id); setSearch(""); }} onToggle={(id) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })} />)}
          </div>
          {selectedFolder ? (
            <div className="border-t border-ink-100 px-3 py-2 text-2xs text-ink-400">
              {selectedFolder.path} · your level: <span className="font-medium text-ink-600">{selectedFolder.effectiveLevel}</span>
              {selectedFolder.isPrivate === 1 ? " · private (inherited by everything beneath)" : ""}
              {Object.keys(selectedFolder.permissions).length > 0 ? ` · ${Object.keys(selectedFolder.permissions).length} ACL entr${Object.keys(selectedFolder.permissions).length === 1 ? "y" : "ies"}` : ""}
            </div>
          ) : null}
        </Card>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, description, tags, issuer rev…" className="w-64" />
            <Select value={documentType} onChange={(e) => setDocumentType(e.target.value)} className="w-40 py-1.5! text-xs">
              <option value="">Any type</option>
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
            </Select>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag" className="w-28" />
            <Select value={checkedOut} onChange={(e) => setCheckedOut(e.target.value)} className="w-36 py-1.5! text-xs">
              <option value="">Any status</option>
              <option value="1">Checked out</option>
              <option value="0">Available</option>
            </Select>
            <span className="ml-auto flex gap-2">
              <Button size="sm" icon={IconUpload} disabled={!selectedFolderId || !canWriteHere} title={!selectedFolderId ? "Select a folder first" : !canWriteHere ? "You have read access to this folder" : undefined} onClick={() => setShowUpload((v) => !v)}>
                {showUpload ? "Hide upload" : "Upload files"}
              </Button>
            </span>
          </div>

          {showUpload && selectedFolder ? (
            <Card>
              <CardBody className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <Field label="Document type"><Select value={uploadMeta.documentType} onChange={(e) => setUploadMeta({ ...uploadMeta, documentType: e.target.value })}><option value="">—</option>{DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
                  <Field label="Tags" hint="comma-separated"><Input value={uploadMeta.tags} onChange={(e) => setUploadMeta({ ...uploadMeta, tags: e.target.value })} /></Field>
                  <Field label="Issuer revision"><Input value={uploadMeta.revisionLabel} onChange={(e) => setUploadMeta({ ...uploadMeta, revisionLabel: e.target.value })} placeholder="P02" /></Field>
                  <Field label="Description"><Input value={uploadMeta.description} onChange={(e) => setUploadMeta({ ...uploadMeta, description: e.target.value })} /></Field>
                </div>
                <FileDropzone
                  multiple
                  maxFiles={25}
                  autoUpload
                  label={`Drop files into ${selectedFolder.name}`}
                  hint="Up to 25 files per drop. Executables are refused; office documents, PDFs, images, CAD, IFC and archives are accepted. Each file is hashed and content-addressed on arrival."
                  upload={async (file, ctx) => {
                    const form = new FormData();
                    if (uploadMeta.documentType) form.append("documentType", uploadMeta.documentType);
                    if (uploadMeta.tags.trim()) form.append("tags", uploadMeta.tags);
                    if (uploadMeta.description.trim()) form.append("description", uploadMeta.description);
                    if (uploadMeta.revisionLabel.trim()) form.append("revisionLabel", uploadMeta.revisionLabel);
                    form.append("file", file, file.name);
                    await uploadWithProgress(`/api/v1/projects/${projectId}/folders/${selectedFolder.id}/files`, form, ctx.onProgress, ctx.signal);
                    reloadAll();
                  }}
                />
              </CardBody>
            </Card>
          ) : null}

          {files.error ? <Alert tone="danger" title="Files could not be loaded">{files.error}</Alert> : null}
          {!files.loading && rows.length === 0 ? (
            <EmptyState icon={IconFolder} title={debounced || documentType || tag || checkedOut ? "No files match" : "No files in this folder"} hint={debounced || documentType || tag || checkedOut ? "Try a different search or clear the filters." : "Upload drawings, specs, contracts and correspondence — or address an e-mail to this folder."} />
          ) : (
            <DataTable<FileItem>
              tableId="documents-files"
              data={rows}
              columns={columns}
              getRowId={(r) => r.id}
              loading={files.loading}
              height={520}
              stickyHeader
              gridLines
              toolbar={false}
              onRowClick={({ row }) => setOpenFileId(row.id)}
              rowActions={(row) => [
                { id: "open", label: "Details, preview & versions", onSelect: () => setOpenFileId(row.id) },
                { id: "download", label: "Download", onSelect: () => void act(row, "download") },
                row.checkedOutBy
                  ? { id: "checkin", label: canCheckin(row) ? "Check in" : `Checked out by ${row.checkedOutByName ?? "another user"}`, disabled: !canCheckin(row), onSelect: () => void act(row, "checkin") }
                  : { id: "checkout", label: "Check out", onSelect: () => void act(row, "checkout") },
                { id: "copy", label: "Copy", onSelect: () => void act(row, "copy") },
                { id: "delete", label: "Delete", disabled: Boolean(row.pipelineOwned), onSelect: () => void act(row, "delete") },
              ]}
              empty={{ title: "No files" }}
              aria-label="Files"
            />
          )}
          <p className="text-xs text-ink-400">{files.data ? `${rows.length}${files.data.total > rows.length ? ` of ${files.data.total}` : ""} file${rows.length === 1 ? "" : "s"} · your level: ${files.data.access.level}` : ""}{debounced ? " · searching every folder you can see" : ""}</p>
        </div>
      </div>

      <FileDrawer projectId={projectId} fileId={openFileId} flat={flat} onClose={() => setOpenFileId(null)} onChanged={reloadAll} />
      <FolderModal mode={folderModal} projectId={projectId} folder={selectedFolder} flat={flat} isAdmin={isAdmin} onClose={() => setFolderModal(null)} onChanged={() => { setFolderModal(null); reloadAll(); }} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* File drawer: metadata, preview, versions, access log                       */
/* ------------------------------------------------------------------------- */

function FileDrawer({ projectId, fileId, flat, onClose, onChanged }: { projectId: string; fileId: string | null; flat: FolderNode[]; onClose: () => void; onChanged: () => void }) {
  const detail = useResource<FileDetail>(fileId ? `/api/v1/files/${fileId}` : null);
  const log = useResource<{ items: Array<{ id: string; action: string; context: string | null; userName: string | null; version: number | null; at: string }> }>(fileId ? `/api/v1/files/${fileId}/access-log` : null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", documentType: "", tags: "", description: "", revisionLabel: "", folderId: "", isPrivate: false });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = detail.data;

  useEffect(() => {
    if (!f) return;
    setForm({ name: f.name, documentType: f.documentType ?? "", tags: f.tags.join(", "), description: f.description ?? "", revisionLabel: f.revisionLabel ?? "", folderId: f.folderId ?? "", isPrivate: f.isPrivate === 1 });
  }, [f]);

  useEffect(() => {
    setPreviewUrl(null);
    if (!f || !f.previewable) return;
    let url: string | null = null;
    let cancelled = false;
    fetchBlobUrl(`/api/v1/files/${f.id}/preview`)
      .then((u) => {
        if (cancelled) URL.revokeObjectURL(u);
        else {
          url = u;
          setPreviewUrl(u);
        }
      })
      .catch(() => setPreviewUrl(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [f]);

  void projectId;

  async function save() {
    if (!f) return;
    setBusy("save");
    setError(null);
    try {
      await api.patch(`/api/v1/files/${f.id}`, {
        name: form.name.trim(),
        documentType: form.documentType || null,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
        description: form.description.trim() || null,
        revisionLabel: form.revisionLabel.trim() || null,
        ...(form.folderId && form.folderId !== f.folderId ? { folderId: form.folderId } : {}),
        ...(f.access.isDocumentsAdmin ? { isPrivate: form.isPrivate } : {}),
      });
      detail.reload();
      onChanged();
    } catch (err) {
      setError(errMsg(err, "Could not save"));
    } finally {
      setBusy(null);
    }
  }

  async function newVersion(file: File) {
    if (!f) return;
    setBusy("version");
    setError(null);
    try {
      const fd = new FormData();
      if (note.trim()) fd.append("note", note.trim());
      fd.append("file", file, file.name);
      await api.upload(`/api/v1/files/${f.id}/versions`, fd);
      setNote("");
      detail.reload();
      log.reload();
      onChanged();
    } catch (err) {
      setError(errMsg(err, "Version upload failed"));
    } finally {
      setBusy(null);
    }
  }

  async function downloadVersion(v: number) {
    if (!f) return;
    const url = await fetchBlobUrl(`/api/v1/files/${f.id}/download?version=${v}`);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    log.reload();
  }

  const canEdit = f ? f.access.level === "standard" || f.access.level === "admin" : false;
  const isText = f ? /^text\/|json$/.test(f.contentType) : false;

  return (
    <Drawer open={fileId !== null} onClose={onClose} size="xl" title={f?.name ?? "File"} description={f ? `${f.folderPath ?? "(no folder)"} · v${f.version} · ${formatBytes(f.sizeBytes)} · ${f.contentType}` : undefined} headerActions={f ? <span className="flex gap-1.5">{f.isPrivate === 1 ? <Badge tone="neutral" size="xs">private</Badge> : null}{f.pipelineOwned ? <Badge tone="info" size="xs">pipeline-owned</Badge> : null}{f.checkedOutBy ? <Badge tone="warning" size="xs">checked out</Badge> : null}</span> : null}>
      {detail.loading && !f ? <p className="text-sm text-ink-400">Loading…</p> : detail.error ? <Alert tone="danger">{detail.error}</Alert> : f ? (
        <div className="space-y-4">
          {error ? <Alert tone="danger" title="Refused" onDismiss={() => setError(null)}>{error}</Alert> : null}
          {f.references.length > 0 ? <Alert tone="info" size="sm" title="Referenced elsewhere">This file backs {f.references.join(", ")}; it cannot be deleted or moved from Documents.</Alert> : null}

          {f.previewable ? (
            <div className="overflow-hidden rounded-md ring-1 ring-ink-200" style={{ height: 360 }}>
              {previewUrl ? (
                f.contentType.startsWith("image/") ? <img src={previewUrl} alt={f.name} className="h-full w-full object-contain" /> : <iframe src={previewUrl} title={f.name} className="h-full w-full" />
              ) : (
                <div className="flex h-full items-center justify-center"><Spinner label="Fetching preview…" /></div>
              )}
            </div>
          ) : (
            <p className="text-xs text-ink-400">No inline preview for {f.contentType}; download it instead.{isText ? "" : ""}</p>
          )}

          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!canEdit} /></Field>
            <Field label="Document type"><Select value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })} disabled={!canEdit}><option value="">—</option>{DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
            <Field label="Issuer revision"><Input value={form.revisionLabel} onChange={(e) => setForm({ ...form, revisionLabel: e.target.value })} disabled={!canEdit} /></Field>
            <Field label="Tags" hint="comma-separated"><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} disabled={!canEdit} /></Field>
            <Field label="Folder"><Select value={form.folderId} onChange={(e) => setForm({ ...form, folderId: e.target.value })} disabled={!canEdit || Boolean(f.pipelineOwned)}>{flat.map((n) => <option key={n.id} value={n.id}>{n.path}</option>)}</Select></Field>
            <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!canEdit} /></Field>
            {f.access.isDocumentsAdmin ? <Checkbox checked={form.isPrivate} onChange={(e) => setForm({ ...form, isPrivate: e.target.checked })} label="Private" description="Visible only to documents admins." /> : null}
            <div className="flex items-end justify-end sm:col-span-2"><Button size="sm" onClick={() => void save()} disabled={!canEdit || busy !== null} loading={busy === "save"}>Save</Button></div>
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Versions</h3>
            <ul className="divide-y divide-ink-100 text-sm">
              {f.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span><span className="font-mono font-semibold">v{v.version}</span> <span className="text-ink-500">{formatBytes(v.sizeBytes)} · {f.people[v.uploadedBy]?.name ?? v.uploadedBy} · {formatDateTime(v.createdAt)}</span>{v.note ? <span className="ml-2 text-ink-600">“{v.note}”</span> : null}</span>
                  <span className="flex items-center gap-2"><span className="font-mono text-2xs text-ink-300" title={v.sha256}>{v.sha256.slice(0, 12)}</span><Button size="xs" variant="ghost" onClick={() => void downloadVersion(v.version)}>Download</Button></span>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="Change note" className="flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version" /></Field>
                <label className="inline-flex cursor-pointer items-center rounded-md bg-ink-800 px-3 py-2 text-xs font-medium text-white hover:bg-ink-900">
                  {busy === "version" ? "Uploading…" : "Upload new version"}
                  <input type="file" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void newVersion(file); }} />
                </label>
                {f.checkedOutBy && !f.access.canCheckin ? <span className="text-xs text-amber-700">Checked out by {f.people[f.checkedOutBy]?.name ?? "another user"} — a new version will be refused until it is checked in.</span> : null}
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Access log ({f.accessCount})</h3>
            {log.error ? <p className="text-xs text-ink-400">{log.error}</p> : (log.data?.items ?? []).length === 0 ? <p className="text-xs text-ink-400">Nobody has opened or downloaded this file yet.</p> : (
              <ul className="max-h-48 divide-y divide-ink-100 overflow-y-auto text-xs">
                {(log.data?.items ?? []).map((e) => <li key={e.id} className="flex justify-between py-1"><span>{e.userName ?? "?"} · {e.action}{e.version ? ` v${e.version}` : ""}{e.context ? ` · ${humanize(e.context)}` : ""}</span><span className="text-ink-400">{formatDateTime(e.at)}</span></li>)}
              </ul>
            )}
          </section>
          <p className="text-2xs text-ink-400">SHA-256 <span className="font-mono">{f.sha256}</span></p>
        </div>
      ) : null}
    </Drawer>
  );
}

/* ------------------------------------------------------------------------- */
/* Folder modal: create / edit / permissions                                  */
/* ------------------------------------------------------------------------- */

function FolderModal({ mode, projectId, folder, flat, isAdmin, onClose, onChanged }: { mode: "create" | "edit" | "permissions" | null; projectId: string; folder: FolderNode | null; flat: FolderNode[]; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [perms, setPerms] = useState<Record<string, string>>({});
  const [addUser, setAddUser] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const users = useResource<{ items: CompanyUser[] }>(mode === "permissions" ? "/api/v1/company/users?pageSize=200" : null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    if (mode === "create") {
      setName("");
      setParentId(folder?.id ?? "");
      setIsPrivate(false);
    } else if (mode === "edit" && folder) {
      setName(folder.name);
      setParentId(folder.parentId ?? "");
      setIsPrivate(folder.isPrivate === 1);
    } else if (mode === "permissions" && folder) {
      setPerms({ ...folder.permissions });
    }
    setError(null);
  }, [mode, folder]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await api.post(`/api/v1/projects/${projectId}/folders`, { name: name.trim(), parentId: parentId || null, ...(isAdmin ? { isPrivate } : {}) });
      } else if (mode === "edit" && folder) {
        await api.patch(`/api/v1/projects/${projectId}/folders/${folder.id}`, { name: name.trim(), parentId: parentId || null, ...(isAdmin ? { isPrivate } : {}) });
      } else if (mode === "permissions" && folder) {
        await api.put(`/api/v1/projects/${projectId}/folders/${folder.id}/permissions`, { permissions: perms });
      }
      onChanged();
    } catch (err) {
      setError(errMsg(err, "The folder change was refused"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!folder) return;
    const ok = await confirm({ title: `Delete folder ${folder.name}?`, description: "Only an empty folder can be deleted.", confirmLabel: "Delete", tone: "danger" });
    if (!ok) return;
    try {
      await api.del(`/api/v1/projects/${projectId}/folders/${folder.id}`);
      onChanged();
    } catch (err) {
      setError(errMsg(err, "The folder could not be deleted"));
    }
  }

  const title = mode === "create" ? "New folder" : mode === "edit" ? `Edit ${folder?.name ?? "folder"}` : `Permissions — ${folder?.name ?? ""}`;
  return (
    <Modal open={mode !== null} onClose={onClose} title={title} footer={<div className="flex justify-between gap-2"><span>{mode === "edit" && folder ? <Button variant="ghost" icon={IconTrash} onClick={() => void remove()}>Delete folder</Button> : null}</span><span className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={(e) => void submit(e)} disabled={busy || (mode !== "permissions" && !name.trim())} loading={busy}>{mode === "create" ? "Create" : "Save"}</Button></span></div>}>
      {dialog}
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <ErrorAlert message={error} />
        {mode === "permissions" ? (
          <>
            <p className="text-xs text-ink-500">An entry applies to this folder and everything beneath it until a deeper folder overrides it. <strong>none</strong> hides the subtree from that person; <strong>admin</strong> lets them into private folders beneath.</p>
            <ul className="divide-y divide-ink-100">
              {Object.entries(perms).map(([uid, level]) => (
                <li key={uid} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <span>{users.data?.items.find((u) => u.id === uid)?.name ?? uid}</span>
                  <span className="flex items-center gap-1">
                    <Select value={level} onChange={(e) => setPerms({ ...perms, [uid]: e.target.value })} className="w-32 py-1! text-xs">{FOLDER_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</Select>
                    <Button size="xs" variant="ghost" onClick={() => setPerms(Object.fromEntries(Object.entries(perms).filter(([k]) => k !== uid)))}>remove</Button>
                  </span>
                </li>
              ))}
              {Object.keys(perms).length === 0 ? <li className="py-2 text-xs text-ink-400">No entries — the documents tool level applies to everyone.</li> : null}
            </ul>
            <div className="flex items-end gap-2">
              <Field label="Add a person" className="flex-1"><Select value={addUser} onChange={(e) => setAddUser(e.target.value)}><option value="">Choose…</option>{(users.data?.items ?? []).filter((u) => !perms[u.id]).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
              <Button size="sm" variant="secondary" disabled={!addUser} onClick={() => { setPerms({ ...perms, [addUser]: "read" }); setAddUser(""); }}>Add</Button>
            </div>
          </>
        ) : (
          <>
            <Field label="Folder name"><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="03 — Contracts" /></Field>
            <Field label="Parent"><Select value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">(top level)</option>{flat.filter((n) => !folder || (n.id !== folder.id && !n.path.startsWith(`${folder.path}/`))).map((n) => <option key={n.id} value={n.id}>{n.path}</option>)}</Select></Field>
            {isAdmin ? <Checkbox checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} label="Private" description="Hidden — with every folder and file beneath it — from everyone but documents admins and people granted admin on it." /> : null}
          </>
        )}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------------- */
/* Access report tab (#299)                                                   */
/* ------------------------------------------------------------------------- */

function AccessTab({ projectId, version }: { projectId: string; version: number }) {
  const [days, setDays] = useState(30);
  const since = useMemo(() => new Date(Date.now() - days * 86_400_000).toISOString(), [days]);
  const report = useResource<AccessReport>(`/api/v1/projects/${projectId}/files/access-report?since=${encodeURIComponent(since)}&limit=200&_v=${version}`);
  const r = report.data;
  const fileColumns = useMemo<DataColumns<AccessReport["byFile"][number]>>(() => [
    { id: "name", header: "File", accessor: (x) => x.name ?? x.fileId, type: "text", width: 300, truncate: true, cell: ({ row }) => <span>{row.name ?? row.fileId}{row.deleted ? <Badge tone="neutral" size="xs" className="ml-1">deleted</Badge> : null}</span> },
    { id: "downloads", header: "Downloads", accessor: "downloads", type: "number", align: "right", width: 100 },
    { id: "views", header: "Views", accessor: "views", type: "number", align: "right", width: 90 },
    { id: "other", header: "Other", accessor: "other", type: "number", align: "right", width: 90, headerTooltip: "copies, checkouts, checkins" },
    { id: "users", header: "People", accessor: "uniqueUsers", type: "number", align: "right", width: 90 },
    { id: "last", header: "Last", accessor: (x) => x.lastAt ?? "", type: "text", width: 160, cell: ({ row }) => formatDateTime(row.lastAt) },
  ], []);
  const userColumns = useMemo<DataColumns<AccessReport["byUser"][number]>>(() => [
    { id: "name", header: "Person", accessor: (x) => x.name ?? x.userId, type: "text", width: 220 },
    { id: "events", header: "Events", accessor: "events", type: "number", align: "right", width: 90 },
    { id: "files", header: "Files touched", accessor: "filesTouched", type: "number", align: "right", width: 120 },
    { id: "last", header: "Last", accessor: (x) => x.lastAt ?? "", type: "text", width: 160, cell: ({ row }) => formatDateTime(row.lastAt) },
  ], []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-600">Window</span>
        {[7, 30, 90].map((d) => <button key={d} type="button" onClick={() => setDays(d)} className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${days === d ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-600 ring-ink-200 hover:bg-ink-50"}`}>{d} days</button>)}
      </div>
      {report.error ? <Alert tone="danger" title="The access report could not be loaded">{report.error}</Alert> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Events" value={r ? r.totals.events.toLocaleString() : "—"} loading={report.loading} />
        <Stat label="Downloads" value={r ? r.totals.downloads.toLocaleString() : "—"} loading={report.loading} />
        <Stat label="Views" value={r ? r.totals.views.toLocaleString() : "—"} loading={report.loading} />
        <Stat label="People" value={r ? r.totals.uniqueUsers.toLocaleString() : "—"} loading={report.loading} />
        <Stat label="Files" value={r ? r.totals.uniqueFiles.toLocaleString() : "—"} loading={report.loading} />
      </div>
      {r && r.totals.events === 0 ? <EmptyState title="No file access in this window" hint="Downloads, previews, copies and checkouts are logged per user and per version. Nothing has happened in the chosen window." /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          <DataTable tableId="doc-access-files" data={r?.byFile ?? []} columns={fileColumns} getRowId={(x) => x.fileId} loading={report.loading} height={360} stickyHeader gridLines toolbar={false} empty={{ title: "No files" }} aria-label="Access by file" />
          <DataTable tableId="doc-access-users" data={r?.byUser ?? []} columns={userColumns} getRowId={(x) => x.userId} loading={report.loading} height={360} stickyHeader gridLines toolbar={false} empty={{ title: "No people" }} aria-label="Access by person" />
        </div>
      )}
      {r && r.recent.length > 0 ? (
        <Card><CardBody>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Recent events</h3>
          <ul className="max-h-60 divide-y divide-ink-100 overflow-y-auto text-xs">
            {r.recent.map((e) => <li key={e.id} className="flex justify-between py-1"><span>{e.userName ?? e.userId} · {e.action} · {e.fileName ?? e.fileId}{e.context ? ` · ${humanize(e.context)}` : ""}</span><span className="text-ink-400">{formatDateTime(e.at)}</span></li>)}
          </ul>
        </CardBody></Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Inbound e-mail tab (#300)                                                  */
/* ------------------------------------------------------------------------- */

function InboundTab({ projectId, flat, version, onChanged }: { projectId: string; flat: FolderNode[]; version: number; onChanged: () => void }) {
  const inbound = useResource<{ items: InboundEmail[]; total: number }>(`/api/v1/projects/${projectId}/documents/inbound?pageSize=100&_v=${version}`);
  const [folderId, setFolderId] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folderById = useMemo(() => new Map(flat.map((f) => [f.id, f])), [flat]);

  async function ingest() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const attachments: Array<{ filename: string; contentType: string; contentBase64: string }> = [];
      if (attachment) {
        const buf = new Uint8Array(await attachment.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        attachments.push({ filename: attachment.name, contentType: attachment.type || "application/octet-stream", contentBase64: btoa(bin) });
      }
      const res = await api.post<InboundEmail>(`/api/v1/projects/${projectId}/documents/inbound`, { folderId: folderId || undefined, from: from || null, to: folderId ? `docs+${folderId}@constructos` : null, subject: subject || null, text: text || null, messageId: `<manual-${Date.now()}@constructos>`, attachments });
      setResult(`${res.status}: ${res.fileIds.length} file(s) stored${res.rejected.length ? `, ${res.rejected.length} refused (${res.rejected.map((r) => `${r.filename}: ${r.reason}`).join("; ")})` : ""}${res.rejectReason ? ` — ${res.rejectReason}` : ""}`);
      setAttachment(null);
      setSubject("");
      setText("");
      inbound.reload();
      onChanged();
    } catch (err) {
      setError(errMsg(err, "Ingestion failed"));
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataColumns<InboundEmail>>(() => [
    { id: "at", header: "Received", accessor: "createdAt", type: "text", width: 160, cell: ({ row }) => formatDateTime(row.createdAt) },
    { id: "from", header: "From", accessor: (r) => r.fromAddress ?? "", type: "text", width: 200, cell: ({ row }) => row.fromAddress ?? "—" },
    { id: "subject", header: "Subject", accessor: (r) => r.subject ?? "", type: "text", width: 260, truncate: true, cell: ({ row }) => row.subject ?? "(no subject)" },
    { id: "folder", header: "Folder", accessor: (r) => folderById.get(r.folderId ?? "")?.path ?? r.folderId ?? "", type: "text", width: 200, cell: ({ row }) => folderById.get(row.folderId ?? "")?.path ?? row.folderId ?? "—" },
    { id: "status", header: "Outcome", accessor: "status", type: "status", width: 110, cell: ({ row }) => <Badge tone={row.status === "stored" ? "success" : row.status === "partial" ? "warning" : "danger"} size="xs" dot>{row.status}</Badge> },
    { id: "files", header: "Files", accessor: (r) => r.fileIds.length, type: "number", align: "right", width: 70 },
    { id: "why", header: "Refused", accessor: (r) => r.rejectReason ?? "", type: "text", width: 320, truncate: true, cell: ({ row }) => row.rejectReason ? `${row.rejectReason}${row.rejected.length ? `: ${row.rejected.map((x) => `${x.filename} (${x.reason})`).join(", ")}` : ""}` : "—" },
  ], [folderById]);

  return (
    <div className="space-y-4">
      <Card><CardBody className="space-y-3">
        <h3 className="text-sm font-semibold text-ink-900">Address a message to a folder</h3>
        <p className="text-xs text-ink-500">The provider webhook (or a person, here) hands the parsed message to <code className="font-mono">POST /projects/{projectId}/documents/inbound</code>. The folder is taken from the <code className="font-mono">+folderId</code> in the address; attachments are classified like uploads and the message itself is kept as an .eml beside them.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Target folder" className="sm:col-span-2"><Select value={folderId} onChange={(e) => setFolderId(e.target.value)}><option value="">Choose…</option>{flat.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}</Select></Field>
          {folderId ? <p className="font-mono text-xs text-ink-700 sm:col-span-2">docs+{folderId}@&lt;your inbound domain&gt;</p> : null}
          <Field label="From"><Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="engineer@consultant.example" /></Field>
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="Body" className="sm:col-span-2"><Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <Field label="Attachment"><input type="file" onChange={(e) => setAttachment(e.target.files?.[0] ?? null)} className="text-xs" /></Field>
          <div className="flex items-end justify-end"><Button icon={IconMail} onClick={() => void ingest()} disabled={!folderId || busy} loading={busy}>Ingest message</Button></div>
        </div>
        {result ? <Alert tone="info" size="sm" onDismiss={() => setResult(null)}>{result}</Alert> : null}
        {error ? <Alert tone="danger" size="sm" onDismiss={() => setError(null)}>{error}</Alert> : null}
      </CardBody></Card>
      {inbound.error ? <Alert tone="danger">{inbound.error}</Alert> : null}
      {!inbound.loading && (inbound.data?.items ?? []).length === 0 ? <EmptyState icon={IconMail} title="No inbound e-mail yet" hint="Messages delivered to a folder address will be listed here with what was stored and what was refused." /> : (
        <DataTable<InboundEmail> tableId="doc-inbound" data={inbound.data?.items ?? []} columns={columns} getRowId={(r) => r.id} loading={inbound.loading} height={400} stickyHeader gridLines toolbar={false} empty={{ title: "Nothing received" }} aria-label="Inbound e-mail" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Recycle bin tab (admin)                                                    */
/* ------------------------------------------------------------------------- */

function RecycleTab({ projectId, version, onChanged }: { projectId: string; version: number; onChanged: () => void }) {
  const bin = useResource<FilesResponse>(`/api/v1/projects/${projectId}/files?deleted=1&pageSize=500&_v=${version}`);
  const [error, setError] = useState<string | null>(null);
  async function restore(f: FileItem) {
    setError(null);
    try {
      await api.post(`/api/v1/files/${f.id}/restore`, {});
      bin.reload();
      onChanged();
    } catch (err) {
      setError(errMsg(err, "Restore failed"));
    }
  }
  const columns = useMemo<DataColumns<FileItem>>(() => [
    { id: "name", header: "Name", accessor: "name", type: "text", width: 300, truncate: true },
    { id: "size", header: "Size", accessor: "sizeBytes", type: "number", align: "right", width: 90, cell: ({ row }) => formatBytes(row.sizeBytes) },
    { id: "deletedAt", header: "Deleted", accessor: (r) => r.deletedAt ?? "", type: "text", width: 160, cell: ({ row }) => formatDateTime(row.deletedAt) },
    { id: "by", header: "By", accessor: (r) => r.deletedBy ?? "", type: "text", width: 160, cell: ({ row }) => row.deletedBy ?? "—" },
  ], []);
  const rows = bin.data?.items ?? [];
  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {bin.error ? <Alert tone="danger" title="The recycle bin could not be loaded">{bin.error}</Alert> : null}
      {!bin.loading && rows.length === 0 ? <EmptyState icon={IconTrash} title="The recycle bin is empty" hint="Deleted files stay here, with their versions and access log, until restored." /> : (
        <DataTable<FileItem> tableId="doc-recycle" data={rows} columns={columns} getRowId={(r) => r.id} loading={bin.loading} height={420} stickyHeader gridLines toolbar={false} rowActions={(row) => [{ id: "restore", label: "Restore", onSelect: () => void restore(row) }]} empty={{ title: "Empty" }} aria-label="Recycle bin" />
      )}
    </div>
  );
}
