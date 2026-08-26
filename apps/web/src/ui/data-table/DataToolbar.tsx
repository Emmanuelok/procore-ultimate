/**
 * DataToolbar — the control strip that sits above every collection view:
 * search, filters, saved views, view switcher, tools and actions.
 *
 * It is deliberately a *layout*, not a controller. Every control is optional
 * and driven by props, so the same bar serves a grid, a board, a file list and
 * a map without any of them knowing about the others.
 */
import { useEffect, useRef, useState } from "react";
import { cx } from "../cx";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconFilter,
  IconSave,
  IconSearch,
  IconTrash,
} from "../icons";
import { Button, IconButton, Input, Spinner } from "../primitives";
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator, Popover } from "../overlays";
import { renderIconLike } from "./internals";
import { formatNumber } from "./format";
import type { DataToolbarProps } from "./types";

export function DataToolbar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  searching = false,
  filters,
  filterCount = 0,
  onOpenFilters,
  onClearFilters,
  views,
  activeViewId,
  onViewChange,
  onSaveView,
  onDeleteView,
  viewDirty = false,
  viewModes,
  viewMode,
  onViewModeChange,
  tools,
  actions,
  selectionCount = 0,
  totalCount,
  summary,
  title,
  className,
  flush = false,
  children,
}: DataToolbarProps) {
  const showSearch = Boolean(onSearchChange);
  const activeView = views?.find((view) => view.id === activeViewId);

  return (
    <div
      className={cx(
        "flex flex-col gap-2 bg-surface-raised px-cell-x py-2",
        !flush && "border-b border-border",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {title ? (
          <div className="mr-1 min-w-0 shrink-0 text-sm font-semibold text-content">{title}</div>
        ) : null}

        {views && views.length > 0 ? (
          <ViewSwitcher
            views={views}
            activeViewId={activeViewId ?? null}
            activeName={activeView?.name}
            dirty={viewDirty}
            onViewChange={onViewChange}
            onSaveView={onSaveView}
            onDeleteView={onDeleteView}
          />
        ) : null}

        {showSearch ? (
          <div className="relative min-w-0 flex-1 sm:max-w-72">
            <Input
              type="search"
              size="sm"
              value={search ?? ""}
              onChange={(event) => onSearchChange?.(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              leading={IconSearch}
              trailing={
                searching ? (
                  <Spinner size="sm" />
                ) : search ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => onSearchChange?.("")}
                    className="grid size-4 place-items-center rounded-xs text-content-subtle hover:bg-surface-active hover:text-content"
                  >
                    <IconClose size={12} />
                  </button>
                ) : undefined
              }
              className="w-full"
            />
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {onOpenFilters ? (
          <Button
            variant={filterCount > 0 ? "secondary" : "ghost"}
            size="sm"
            leadingIcon={IconFilter}
            onClick={onOpenFilters}
            aria-label="Filters"
          >
            Filter
            {filterCount > 0 ? (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold tabular-nums text-accent-fg">
                {filterCount}
              </span>
            ) : null}
          </Button>
        ) : null}

        {viewModes && viewModes.length > 1 ? (
          <div
            role="radiogroup"
            aria-label="View mode"
            className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface-sunken p-0.5"
          >
            {viewModes.map((mode) => {
              const active = mode.value === viewMode;
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={mode.label}
                  title={mode.label}
                  onClick={() => onViewModeChange?.(mode.value)}
                  className={cx(
                    "inline-flex h-control-xs items-center gap-1.5 rounded-sm px-2 text-meta font-medium",
                    "transition-colors duration-fast",
                    active
                      ? "bg-surface-raised text-content shadow-e1"
                      : "text-content-subtle hover:text-content",
                  )}
                >
                  {renderIconLike(mode.icon, 14)}
                  <span className="hidden lg:inline">{mode.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {tools}

        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>

      {filters || summary || selectionCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          {filters}
          {filterCount > 0 && onClearFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-sm px-1.5 py-0.5 text-meta text-content-subtle underline-offset-2 hover:text-content hover:underline"
            >
              Clear all
            </button>
          ) : null}
          <div className="flex-1" />
          {summary ?? (
            totalCount !== undefined ? (
              <span className="text-meta tabular-nums text-content-subtle">
                {formatNumber(totalCount)} {totalCount === 1 ? "result" : "results"}
              </span>
            ) : null
          )}
        </div>
      ) : null}

      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Saved views                                                                */
/* ------------------------------------------------------------------------- */

function ViewSwitcher({
  views,
  activeViewId,
  activeName,
  dirty,
  onViewChange,
  onSaveView,
  onDeleteView,
}: {
  views: NonNullable<DataToolbarProps["views"]>;
  activeViewId: string | null;
  activeName: string | undefined;
  dirty: boolean;
  onViewChange?: (id: string) => void;
  onSaveView?: (name: string) => void;
  onDeleteView?: (id: string) => void;
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (saveOpen) {
      setName(activeName && dirty ? activeName : "");
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [saveOpen, activeName, dirty]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <DropdownMenu
        placement="bottom-start"
        aria-label="Saved views"
        trigger={
          <Button variant="ghost" size="sm" trailingIcon={IconChevronDown} className="max-w-52">
            <span className="truncate">{activeName ?? "All records"}</span>
            {dirty ? (
              <span
                aria-label="Unsaved changes"
                title="Unsaved changes"
                className="ml-1 size-1.5 shrink-0 rounded-full bg-warning-solid"
              />
            ) : null}
          </Button>
        }
      >
        <MenuLabel>Views</MenuLabel>
        {views.map((view) => (
          <MenuItem
            key={view.id}
            icon={view.icon}
            selected={view.id === activeViewId}
            trailingIcon={view.id === activeViewId ? IconCheck : undefined}
            onSelect={() => onViewChange?.(view.id)}
          >
            {view.name}
          </MenuItem>
        ))}
        {onDeleteView && views.some((view) => !view.builtIn && view.id === activeViewId) ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon={IconTrash}
              destructive
              onSelect={() => activeViewId && onDeleteView(activeViewId)}
            >
              Delete this view
            </MenuItem>
          </>
        ) : null}
      </DropdownMenu>

      {onSaveView ? (
        <Popover
          open={saveOpen}
          onOpenChange={setSaveOpen}
          placement="bottom-start"
          width={280}
          title="Save view"
          description="Columns, filters, sort and grouping are saved together."
          trigger={
            <IconButton
              icon={IconSave}
              label="Save current view"
              size="sm"
              variant={dirty ? "secondary" : "ghost"}
            />
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              onSaveView(trimmed);
              setSaveOpen(false);
            }}
            className="flex flex-col gap-2"
          >
            <Input
              ref={inputRef}
              size="sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Overdue commitments"
              aria-label="View name"
            />
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim()}>
                Save
              </Button>
            </div>
          </form>
        </Popover>
      ) : null}
    </div>
  );
}
