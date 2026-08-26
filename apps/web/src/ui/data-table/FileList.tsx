/**
 * FileList / AttachmentGrid — the two ways construction software shows files.
 *
 * `FileList` is the dense row view: type glyph, name, size, version, who
 * uploaded it and when, plus upload progress and per-row actions.
 * `AttachmentGrid` is the visual view: thumbnails for photos and drawings, an
 * icon tile for everything else.
 */
import { useMemo, useState, type ReactNode } from "react";
import { cx } from "../cx";
import {
  IconArchive,
  IconCode,
  IconDocument,
  IconDownload,
  IconDrawing,
  IconFile,
  IconMore,
  IconPhoto,
  IconSheet,
  IconSpreadsheet,
  IconTrash,
  IconVideo,
} from "../icons";
import { Avatar, Badge, Checkbox, EmptyState, Progress, type IconLike } from "../primitives";
import { DropdownMenu, MenuItem } from "../overlays";
import { tone as toneStyles, type Tone } from "../tokens";
import { formatDateCell, formatFileSize, formatRelativeTime } from "./format";
import type { IconComponent } from "../icons";

/* ========================================================================== */

export interface FileActor {
  name: string;
  avatarUrl?: string | null;
}

export interface FileItem {
  id: string;
  name: string;
  /** Bytes. */
  size?: number | null;
  /** MIME type or a bare extension. */
  type?: string | null;
  url?: string;
  thumbnailUrl?: string | null;
  uploadedAt?: string | number | Date | null;
  uploadedBy?: FileActor | string | null;
  /** Revision label — "Rev C", 3, "v1.2". */
  version?: string | number;
  /** Lifecycle chip: "current", "superseded", "pending_review"… */
  status?: string;
  statusTone?: Tone;
  /** 0–100 while uploading. */
  progress?: number;
  error?: string;
  meta?: ReactNode;
  disabled?: boolean;
}

export interface FileAction {
  id: string;
  label: string;
  icon?: IconLike;
  destructive?: boolean;
  onSelect: (file: FileItem) => void;
}

/* ------------------------------------------------------------------------- */
/* Type glyphs                                                                */
/* ------------------------------------------------------------------------- */

const EXTENSION_ICON: Array<[RegExp, IconComponent, Tone]> = [
  [/^(image\/|.*\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$)/i, IconPhoto, "highlight"],
  [/^(video\/|.*\.(mp4|mov|avi|webm|mkv)$)/i, IconVideo, "highlight"],
  [/(\.dwg|\.dxf|\.rvt|\.ifc|\.nwd|\.skp)$/i, IconDrawing, "info"],
  [/(application\/pdf|\.pdf)$/i, IconSheet, "danger"],
  [/(spreadsheet|excel|\.xlsx?|\.csv|\.numbers)$/i, IconSpreadsheet, "success"],
  [/(word|document|\.docx?|\.rtf|\.pages|\.txt|\.md)$/i, IconDocument, "info"],
  [/(zip|compressed|\.zip|\.rar|\.7z|\.tar|\.gz)$/i, IconArchive, "warning"],
  [/(\.json|\.xml|\.ya?ml|\.js|\.ts|\.sql)$/i, IconCode, "neutral"],
];

export function fileGlyph(file: FileItem): { Icon: IconComponent; tone: Tone } {
  const probe = `${file.type ?? ""} ${file.name}`;
  for (const entry of EXTENSION_ICON) {
    const [pattern, Icon, glyphTone] = entry;
    if (pattern.test(probe) || pattern.test(file.name)) return { Icon, tone: glyphTone };
  }
  return { Icon: IconFile, tone: "neutral" };
}

function isImage(file: FileItem): boolean {
  return Boolean(file.thumbnailUrl) || /^image\//i.test(file.type ?? "") ||
    /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(file.name);
}

function actorOf(value: FileItem["uploadedBy"]): FileActor | null {
  if (!value) return null;
  return typeof value === "string" ? { name: value } : value;
}

/* ========================================================================== */
/* FileList                                                                    */
/* ========================================================================== */

export interface FileListProps {
  files: readonly FileItem[];
  onOpen?: (file: FileItem) => void;
  onDownload?: (file: FileItem) => void;
  onRemove?: (file: FileItem) => void;
  /** Extra per-row menu entries. */
  actions?: (file: FileItem) => readonly FileAction[];

  selectable?: boolean;
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;

  dense?: boolean;
  /** Show the leading thumbnail for images. Default true. */
  thumbnails?: boolean;
  emptyText?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function FileList({
  files,
  onOpen,
  onDownload,
  onRemove,
  actions,
  selectable = false,
  selectedIds,
  onSelectionChange,
  dense = false,
  thumbnails = true,
  emptyText = "No files attached",
  className,
  "aria-label": ariaLabel = "Files",
}: FileListProps) {
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const selected = selectedIds ?? internalSelected;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (id: string, next: boolean) => {
    const ids = next ? [...selected, id] : selected.filter((entry) => entry !== id);
    if (selectedIds === undefined) setInternalSelected(ids);
    onSelectionChange?.(ids);
  };

  if (files.length === 0) {
    return <EmptyState size="sm" icon={IconFile} title={emptyText} bordered className={className} />;
  }

  return (
    <ul aria-label={ariaLabel} className={cx("flex flex-col", className)}>
      {files.map((file) => {
        const { Icon, tone: glyphTone } = fileGlyph(file);
        const actor = actorOf(file.uploadedBy);
        const uploading = typeof file.progress === "number" && file.progress < 100;
        const rowActions = actions?.(file) ?? [];
        const isSelected = selectedSet.has(file.id);

        return (
          <li
            key={file.id}
            className={cx(
              "group/file flex items-center gap-2.5 border-b border-border-subtle px-2 last:border-b-0",
              dense ? "py-1.5" : "py-2",
              isSelected ? "bg-surface-selected" : "hover:bg-surface-hover",
              file.disabled && "opacity-50",
            )}
          >
            {selectable ? (
              <Checkbox
                size="sm"
                checked={isSelected}
                aria-label={`Select ${file.name}`}
                onChange={(event) => toggle(file.id, event.target.checked)}
              />
            ) : null}

            {thumbnails && isImage(file) && file.thumbnailUrl ? (
              <img
                src={file.thumbnailUrl}
                alt=""
                loading="lazy"
                className={cx(
                  "shrink-0 rounded-sm border border-border object-cover drag-none",
                  dense ? "size-7" : "size-9",
                )}
              />
            ) : (
              <span
                className={cx(
                  "grid shrink-0 place-items-center rounded-sm border",
                  dense ? "size-7" : "size-9",
                  toneStyles[glyphTone].subtle,
                  toneStyles[glyphTone].border,
                )}
              >
                <Icon size={dense ? 14 : 16} />
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                {onOpen || file.url ? (
                  <button
                    type="button"
                    onClick={() => (onOpen ? onOpen(file) : window.open(file.url, "_blank", "noopener"))}
                    className="min-w-0 truncate text-body font-medium text-content hover:text-accent-text hover:underline underline-offset-2"
                  >
                    {file.name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-body font-medium text-content">
                    {file.name}
                  </span>
                )}
                {file.version !== undefined ? (
                  <Badge tone="neutral" size="xs" variant="outline">
                    {typeof file.version === "number" ? `v${file.version}` : file.version}
                  </Badge>
                ) : null}
                {file.status ? (
                  <Badge tone={file.statusTone ?? "neutral"} size="xs">
                    {file.status}
                  </Badge>
                ) : null}
              </div>

              {uploading ? (
                <div className="mt-1 flex items-center gap-2">
                  <Progress value={file.progress ?? 0} size="sm" className="flex-1" />
                  <span className="shrink-0 text-meta tabular-nums text-content-subtle">
                    {Math.round(file.progress ?? 0)}%
                  </span>
                </div>
              ) : file.error ? (
                <p className="mt-0.5 text-meta text-danger-fg">{file.error}</p>
              ) : (
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-content-subtle">
                  {file.size !== null && file.size !== undefined ? (
                    <span className="tabular-nums">{formatFileSize(file.size)}</span>
                  ) : null}
                  {actor ? (
                    <span className="flex items-center gap-1">
                      <Avatar name={actor.name} src={actor.avatarUrl ?? null} size="2xs" />
                      {actor.name}
                    </span>
                  ) : null}
                  {file.uploadedAt ? (
                    <time title={formatDateCell(file.uploadedAt)}>
                      {formatRelativeTime(file.uploadedAt)}
                    </time>
                  ) : null}
                  {file.meta}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover/file:opacity-100 focus-within:opacity-100">
              {onDownload ? (
                <button
                  type="button"
                  aria-label={`Download ${file.name}`}
                  onClick={() => onDownload(file)}
                  className="grid size-7 place-items-center rounded-sm text-content-subtle hover:bg-surface-active hover:text-content"
                >
                  <IconDownload size={14} />
                </button>
              ) : null}

              {rowActions.length > 0 || onRemove ? (
                <DropdownMenu
                  placement="bottom-end"
                  aria-label={`${file.name} actions`}
                  trigger={
                    <button
                      type="button"
                      aria-label={`${file.name} actions`}
                      className="grid size-7 place-items-center rounded-sm text-content-subtle hover:bg-surface-active hover:text-content"
                    >
                      <IconMore size={14} />
                    </button>
                  }
                >
                  {rowActions.map((action) => (
                    <MenuItem
                      key={action.id}
                      icon={action.icon}
                      destructive={action.destructive}
                      onSelect={() => action.onSelect(file)}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                  {onRemove ? (
                    <MenuItem icon={IconTrash} destructive onSelect={() => onRemove(file)}>
                      Remove
                    </MenuItem>
                  ) : null}
                </DropdownMenu>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ========================================================================== */
/* AttachmentGrid                                                              */
/* ========================================================================== */

export interface AttachmentGridProps {
  files: readonly FileItem[];
  onOpen?: (file: FileItem) => void;
  onRemove?: (file: FileItem) => void;
  onDownload?: (file: FileItem) => void;
  /** Minimum tile width in px; the grid auto-fills. Default 140. */
  tileSize?: number;
  /** Hide the caption strip under each tile. */
  captions?: boolean;
  emptyText?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function AttachmentGrid({
  files,
  onOpen,
  onRemove,
  onDownload,
  tileSize = 140,
  captions = true,
  emptyText = "No attachments",
  className,
  "aria-label": ariaLabel = "Attachments",
}: AttachmentGridProps) {
  if (files.length === 0) {
    return <EmptyState size="sm" icon={IconPhoto} title={emptyText} bordered className={className} />;
  }

  return (
    <ul
      aria-label={ariaLabel}
      className={cx("grid gap-3", className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileSize}px, 1fr))` }}
    >
      {files.map((file) => {
        const { Icon, tone: glyphTone } = fileGlyph(file);
        const uploading = typeof file.progress === "number" && file.progress < 100;

        return (
          <li key={file.id} className="group/tile min-w-0">
            <div
              className={cx(
                "relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-surface-sunken",
                "transition-[border-color,box-shadow] duration-fast",
                onOpen && "cursor-pointer hover:border-border-strong hover:shadow-e2",
              )}
              onClick={onOpen ? () => onOpen(file) : undefined}
              onKeyDown={
                onOpen
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen(file);
                      }
                    }
                  : undefined
              }
              role={onOpen ? "button" : undefined}
              tabIndex={onOpen ? 0 : undefined}
              aria-label={onOpen ? `Open ${file.name}` : undefined}
            >
              {file.thumbnailUrl ? (
                <img
                  src={file.thumbnailUrl}
                  alt={file.name}
                  loading="lazy"
                  className="size-full object-cover drag-none"
                />
              ) : (
                <span
                  className={cx(
                    "grid size-full place-items-center",
                    toneStyles[glyphTone].subtle,
                  )}
                >
                  <Icon size={28} />
                </span>
              )}

              {uploading ? (
                <div className="absolute inset-x-0 bottom-0 bg-scrim p-1.5 backdrop-blur-[1px]">
                  <Progress value={file.progress ?? 0} size="sm" />
                </div>
              ) : null}

              {(onRemove || onDownload) && !uploading ? (
                <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity duration-fast group-hover/tile:opacity-100 focus-within:opacity-100">
                  {onDownload ? (
                    <button
                      type="button"
                      aria-label={`Download ${file.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDownload(file);
                      }}
                      className="grid size-6 place-items-center rounded-sm bg-surface-overlay/90 text-content shadow-e1 hover:bg-surface-hover"
                    >
                      <IconDownload size={13} />
                    </button>
                  ) : null}
                  {onRemove ? (
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(file);
                      }}
                      className="grid size-6 place-items-center rounded-sm bg-surface-overlay/90 text-danger-fg shadow-e1 hover:bg-danger-subtle"
                    >
                      <IconTrash size={13} />
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            {captions ? (
              <div className="mt-1.5 min-w-0">
                <p className="truncate text-meta font-medium text-content" title={file.name}>
                  {file.name}
                </p>
                <p className="truncate text-2xs tabular-nums text-content-subtle">
                  {[
                    file.size !== null && file.size !== undefined ? formatFileSize(file.size) : null,
                    file.uploadedAt ? formatRelativeTime(file.uploadedAt) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Small helper so callers can render a lone glyph consistently. */
export function FileTypeIcon({ file, size = 16 }: { file: FileItem; size?: number }) {
  const { Icon, tone: glyphTone } = fileGlyph(file);
  return <Icon size={size} className={toneStyles[glyphTone].text} />;
}
