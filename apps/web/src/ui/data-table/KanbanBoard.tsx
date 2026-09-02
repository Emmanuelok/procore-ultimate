/**
 * KanbanBoard — the board view for anything with a lifecycle: punch items,
 * RFIs, submittals, risks, tasks.
 *
 * Drag-and-drop uses native HTML5 DnD (no library, no re-render storm), and
 * every drag interaction has a keyboard equivalent: each card carries a
 * "Move to" menu and each column a "Move column" menu, so the board is fully
 * operable without a pointer.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../cx";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronRight,
  IconDrag,
  IconMore,
  IconPlus,
} from "../icons";
import { Badge, Button, type IconLike } from "../primitives";
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from "../overlays";
import { tone as toneStyles, type Tone } from "../tokens";
import { renderIconLike } from "./internals";
import { formatNumber } from "./format";

export interface KanbanColumn {
  id: string;
  title: string;
  description?: string;
  tone?: Tone;
  icon?: IconLike;
  /** Soft cap. The count turns amber at the limit and red above it. */
  wipLimit?: number;
  /** Hide the "Add" affordance for this lane. */
  readOnly?: boolean;
}

export interface KanbanMove<T> {
  itemId: string;
  item: T;
  from: string;
  to: string;
  /** Insertion index within the destination column. */
  index: number;
}

export interface KanbanBoardProps<T> {
  columns: readonly KanbanColumn[];
  items: readonly T[];
  getItemId: (item: T) => string;
  getItemColumn: (item: T) => string;
  renderCard: (item: T, context: { columnId: string; index: number; dragging: boolean }) => ReactNode;

  onMove?: (move: KanbanMove<T>) => void;
  onColumnOrderChange?: (order: string[]) => void;
  onAddItem?: (columnId: string) => void;
  onCardClick?: (item: T) => void;

  /** Extra menu entries for a lane header. */
  columnActions?: (column: KanbanColumn) => ReactNode;
  /** Secondary line under the lane title — a total value, a forecast, anything. */
  columnSummary?: (items: readonly T[], column: KanbanColumn) => ReactNode;

  emptyColumnText?: string;
  collapsible?: boolean;
  height?: number | string;
  className?: string;
  "aria-label"?: string;
}

export function KanbanBoard<T>({
  columns,
  items,
  getItemId,
  getItemColumn,
  renderCard,
  onMove,
  onColumnOrderChange,
  onAddItem,
  onCardClick,
  columnActions,
  columnSummary,
  emptyColumnText = "Nothing here",
  collapsible = true,
  height,
  className,
  "aria-label": ariaLabel = "Board",
}: KanbanBoardProps<T>) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ columnId: string; index: number } | null>(null);
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const grouped = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const column of columns) map.set(column.id, []);
    for (const item of items) {
      const key = getItemColumn(item);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [columns, items, getItemColumn]);

  const itemsById = useMemo(() => {
    const map = new Map<string, T>();
    for (const item of items) map.set(getItemId(item), item);
    return map;
  }, [items, getItemId]);

  const commitMove = useCallback(
    (itemId: string, to: string, index: number) => {
      const item = itemsById.get(itemId);
      if (!item || !onMove) return;
      const from = getItemColumn(item);
      if (from === to) {
        const current = grouped.get(from) ?? [];
        const currentIndex = current.findIndex((entry) => getItemId(entry) === itemId);
        if (currentIndex === index || currentIndex + 1 === index) return;
      }
      onMove({ itemId, item, from, to, index });
    },
    [itemsById, onMove, getItemColumn, grouped, getItemId],
  );

  const resetDrag = () => {
    setDragItemId(null);
    setDropTarget(null);
    setDragColumnId(null);
    setDropColumnId(null);
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{ height }}
      className={cx(
        "flex min-h-0 min-w-0 gap-3 overflow-x-auto overflow-y-hidden p-cell-x",
        className,
      )}
      onDragEnd={resetDrag}
      onDrop={resetDrag}
    >
      {columns.map((column, columnIndex) => {
        const columnItems = grouped.get(column.id) ?? [];
        const isCollapsed = Boolean(collapsed[column.id]);
        const overLimit = column.wipLimit !== undefined && columnItems.length > column.wipLimit;
        const atLimit = column.wipLimit !== undefined && columnItems.length === column.wipLimit;
        const accent = column.tone ? toneStyles[column.tone] : null;

        if (isCollapsed) {
          return (
            <button
              key={column.id}
              type="button"
              onClick={() => setCollapsed((previous) => ({ ...previous, [column.id]: false }))}
              className={cx(
                "flex w-11 shrink-0 flex-col items-center gap-3 rounded-lg border border-border",
                "bg-surface-sunken py-3 text-content-muted transition-colors hover:bg-surface-hover",
              )}
              aria-label={`Expand ${column.title}`}
            >
              <IconChevronRight size={14} />
              <span className="text-meta font-semibold tabular-nums">{columnItems.length}</span>
              <span
                className="whitespace-nowrap text-label uppercase"
                style={{ writingMode: "vertical-rl" }}
              >
                {column.title}
              </span>
            </button>
          );
        }

        return (
          <section
            key={column.id}
            aria-label={column.title}
            draggable={Boolean(onColumnOrderChange)}
            onDragStart={(event) => {
              if (!onColumnOrderChange) return;
              if (dragItemId) return;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-kanban-column", column.id);
              setDragColumnId(column.id);
            }}
            onDragOver={(event) => {
              if (dragColumnId && dragColumnId !== column.id) {
                event.preventDefault();
                setDropColumnId(column.id);
              }
            }}
            onDrop={(event) => {
              if (dragColumnId && dragColumnId !== column.id) {
                event.preventDefault();
                const order = columns.map((entry) => entry.id).filter((id) => id !== dragColumnId);
                order.splice(columnIndex, 0, dragColumnId);
                onColumnOrderChange?.(order);
              }
              resetDrag();
            }}
            className={cx(
              "flex w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-sunken",
              dropColumnId === column.id && "ring-2 ring-accent",
              dragColumnId === column.id && "opacity-60",
            )}
          >
            {/* -------------------------------------------------- lane header */}
            <header
              className={cx(
                "flex items-center gap-1.5 border-b border-border px-2.5 py-2",
                accent && "shadow-[inset_0_2px_0_0_currentColor]",
                accent?.text,
              )}
            >
              {onColumnOrderChange ? (
                <IconDrag
                  size={13}
                  className="shrink-0 cursor-grab text-content-disabled active:cursor-grabbing"
                />
              ) : null}
              {renderIconLike(column.icon, 14, "shrink-0")}
              <h3 className="min-w-0 flex-1 truncate text-body font-semibold text-content">
                {column.title}
              </h3>

              <span
                className={cx(
                  "shrink-0 rounded-full px-1.5 text-2xs font-semibold tabular-nums",
                  overLimit
                    ? "bg-danger-subtle text-danger-fg"
                    : atLimit
                      ? "bg-warning-subtle text-warning-fg"
                      : "bg-surface-active text-content-muted",
                )}
                title={
                  column.wipLimit !== undefined
                    ? `${columnItems.length} of ${column.wipLimit} (WIP limit)`
                    : `${columnItems.length} items`
                }
              >
                {formatNumber(columnItems.length)}
                {column.wipLimit !== undefined ? `/${column.wipLimit}` : null}
              </span>

              {onAddItem && !column.readOnly ? (
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  leadingIcon={IconPlus}
                  aria-label={`Add to ${column.title}`}
                  onClick={() => onAddItem(column.id)}
                />
              ) : null}

              {collapsible || columnActions || onColumnOrderChange ? (
                <DropdownMenu
                  placement="bottom-end"
                  aria-label={`${column.title} options`}
                  trigger={
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      leadingIcon={IconMore}
                      aria-label={`${column.title} options`}
                    />
                  }
                >
                  <MenuLabel>{column.title}</MenuLabel>
                  {collapsible ? (
                    <MenuItem
                      icon={IconChevronDown}
                      onSelect={() =>
                        setCollapsed((previous) => ({ ...previous, [column.id]: true }))
                      }
                    >
                      Collapse lane
                    </MenuItem>
                  ) : null}
                  {onColumnOrderChange ? (
                    <>
                      <MenuItem
                        icon={IconArrowLeft}
                        disabled={columnIndex === 0}
                        onSelect={() => onColumnOrderChange(moveTo(columns, columnIndex, -1))}
                      >
                        Move lane left
                      </MenuItem>
                      <MenuItem
                        icon={IconArrowRight}
                        disabled={columnIndex === columns.length - 1}
                        onSelect={() => onColumnOrderChange(moveTo(columns, columnIndex, 1))}
                      >
                        Move lane right
                      </MenuItem>
                    </>
                  ) : null}
                  {columnActions ? (
                    <>
                      <MenuSeparator />
                      {columnActions(column)}
                    </>
                  ) : null}
                </DropdownMenu>
              ) : null}
            </header>

            {column.description || columnSummary ? (
              <div className="border-b border-border-subtle px-2.5 py-1.5 text-meta text-content-subtle">
                {columnSummary ? columnSummary(columnItems, column) : column.description}
              </div>
            ) : null}

            {/* --------------------------------------------------- lane body */}
            <div
              className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2"
              onDragOver={(event) => {
                if (!dragItemId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({
                  columnId: column.id,
                  index: indexFromPointer(event.clientY, columnItems, getItemId, cardRefs.current),
                });
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                setDropTarget((previous) =>
                  previous?.columnId === column.id ? null : previous,
                );
              }}
              onDrop={(event) => {
                if (!dragItemId) return;
                event.preventDefault();
                event.stopPropagation();
                const index =
                  dropTarget?.columnId === column.id ? dropTarget.index : columnItems.length;
                commitMove(dragItemId, column.id, index);
                resetDrag();
              }}
            >
              {columnItems.length === 0 ? (
                <p
                  className={cx(
                    "rounded-md border border-dashed border-border px-3 py-6 text-center text-meta text-content-subtle",
                    dropTarget?.columnId === column.id && "border-accent bg-accent-subtle/40",
                  )}
                >
                  {emptyColumnText}
                </p>
              ) : null}

              {columnItems.map((item, index) => {
                const id = getItemId(item);
                const dragging = dragItemId === id;
                const showBefore =
                  dropTarget?.columnId === column.id && dropTarget.index === index && !dragging;
                return (
                  <div key={id} className="contents">
                    {showBefore ? <DropIndicator /> : null}
                    <article
                      ref={(node) => {
                        if (node) cardRefs.current.set(id, node);
                        else cardRefs.current.delete(id);
                      }}
                      draggable={Boolean(onMove)}
                      onDragStart={(event) => {
                        event.stopPropagation();
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", id);
                        setDragItemId(id);
                      }}
                      onDragEnd={resetDrag}
                      onClick={onCardClick ? () => onCardClick(item) : undefined}
                      tabIndex={onCardClick ? 0 : undefined}
                      onKeyDown={
                        onCardClick
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onCardClick(item);
                              }
                            }
                          : undefined
                      }
                      className={cx(
                        "group/card relative rounded-md border border-border bg-surface-raised p-2.5",
                        "shadow-e0 transition-[box-shadow,transform,opacity] duration-fast",
                        onMove && "cursor-grab active:cursor-grabbing",
                        onCardClick && "cursor-pointer hover:border-border-strong hover:shadow-e2",
                        dragging && "opacity-40",
                      )}
                    >
                      {renderCard(item, { columnId: column.id, index, dragging })}

                      {onMove && columns.length > 1 ? (
                        <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100">
                          <DropdownMenu
                            placement="bottom-end"
                            aria-label="Move card"
                            trigger={
                              <Button
                                variant="ghost"
                                size="xs"
                                iconOnly
                                leadingIcon={IconMore}
                                aria-label="Move card"
                                onClick={(event) => event.stopPropagation()}
                              />
                            }
                          >
                            <MenuLabel>Move to</MenuLabel>
                            {columns
                              .filter((entry) => entry.id !== column.id)
                              .map((entry) => (
                                <MenuItem
                                  key={entry.id}
                                  icon={entry.icon}
                                  onSelect={() =>
                                    commitMove(id, entry.id, (grouped.get(entry.id) ?? []).length)
                                  }
                                >
                                  {entry.title}
                                </MenuItem>
                              ))}
                          </DropdownMenu>
                        </div>
                      ) : null}
                    </article>
                  </div>
                );
              })}

              {dropTarget?.columnId === column.id && dropTarget.index >= columnItems.length ? (
                <DropIndicator />
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DropIndicator() {
  return (
    <div aria-hidden="true" className="-my-1 h-0.5 rounded-full bg-accent shadow-[0_0_0_3px_var(--ds-accent-subtle)]" />
  );
}

function moveTo(columns: readonly KanbanColumn[], index: number, delta: number): string[] {
  const order = columns.map((column) => column.id);
  const target = Math.max(0, Math.min(order.length - 1, index + delta));
  const [moved] = order.splice(index, 1);
  if (moved !== undefined) order.splice(target, 0, moved);
  return order;
}

function indexFromPointer<T>(
  clientY: number,
  columnItems: readonly T[],
  getItemId: (item: T) => string,
  refs: Map<string, HTMLElement>,
): number {
  for (let index = 0; index < columnItems.length; index += 1) {
    const item = columnItems[index];
    if (item === undefined) continue;
    const node = refs.get(getItemId(item));
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return columnItems.length;
}

/* ------------------------------------------------------------------------- */
/* A card body good enough to use as-is                                       */
/* ------------------------------------------------------------------------- */

export interface KanbanCardProps {
  title: ReactNode;
  /** Small mono identifier: "RFI-0142". */
  reference?: string;
  description?: ReactNode;
  badges?: ReactNode;
  footer?: ReactNode;
  tone?: Tone;
  meta?: ReactNode;
}

/** The default card look — use it, or ignore it and render your own. */
export function KanbanCard({
  title,
  reference,
  description,
  badges,
  footer,
  tone: cardTone,
  meta,
}: KanbanCardProps) {
  return (
    <div className={cx("flex flex-col gap-1.5", cardTone && "pl-2", cardTone && toneStyles[cardTone].bar)}>
      {reference || badges ? (
        <div className="flex items-center gap-1.5">
          {reference ? (
            <span className="font-mono text-2xs text-content-subtle">{reference}</span>
          ) : null}
          <span className="flex-1" />
          {badges}
        </div>
      ) : null}
      <p className="line-clamp-2 text-body font-medium leading-snug text-content">{title}</p>
      {description ? (
        <p className="line-clamp-2 text-meta text-content-muted">{description}</p>
      ) : null}
      {meta ? <div className="flex items-center gap-1.5 text-meta text-content-subtle">{meta}</div> : null}
      {footer ? (
        <div className="mt-0.5 flex items-center justify-between gap-2 border-t border-border-subtle pt-1.5">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** Convenience badge used on cards for a stage/priority chip. */
export function KanbanChip({ tone: chipTone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <Badge tone={chipTone} size="xs">
      {children}
    </Badge>
  );
}
