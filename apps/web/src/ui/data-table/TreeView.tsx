/**
 * TreeView — hierarchies: cost-code structures, WBS, folder trees, location
 * breakdowns, org charts.
 *
 * Implements the full ARIA tree pattern: one tab stop, roving focus, arrow
 * keys to walk and open/close, Home/End, type-ahead, and `aria-level` /
 * `aria-setsize` / `aria-posinset` on every node so screen readers announce
 * position correctly.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "../cx";
import { IconChevronRight, IconFolder, IconFolderOpen } from "../icons";
import { Checkbox, Spinner, type IconLike } from "../primitives";
import { tone as toneStyles, type Tone } from "../tokens";
import { renderIconLike } from "./internals";
import { formatNumber, toText } from "./format";

export interface TreeNode {
  id: string;
  label: ReactNode;
  /** Plain text for type-ahead and filtering. Falls back to `label`. */
  text?: string;
  icon?: IconLike;
  children?: readonly TreeNode[];
  /** Set when children exist but have not been fetched yet. */
  hasChildren?: boolean;
  /** Trailing count chip — leaf totals, item counts, budget lines. */
  count?: number;
  badge?: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  tone?: Tone;
  actions?: ReactNode;
}

export interface TreeViewProps {
  nodes: readonly TreeNode[];

  expandedIds?: readonly string[];
  onExpandedChange?: (ids: string[]) => void;
  defaultExpandedIds?: readonly string[];

  selectedId?: string | null;
  onSelect?: (node: TreeNode) => void;

  /** Turns on tri-state checkboxes. */
  checkedIds?: readonly string[];
  onCheckedChange?: (ids: string[]) => void;

  /** Called the first time a lazy node is expanded. */
  onLoadChildren?: (node: TreeNode) => void;
  /** Ids currently fetching children. */
  loadingIds?: readonly string[];

  /** Case-insensitive filter. Ancestors of matches stay visible. */
  filter?: string;

  showCounts?: boolean;
  /** Pixels of indent per level. Default 16. */
  indent?: number;
  /** Draw the vertical guide lines. Default true. */
  guides?: boolean;
  className?: string;
  emptyText?: ReactNode;
  "aria-label"?: string;
}

interface FlatNode {
  node: TreeNode;
  level: number;
  parentId: string | null;
  setSize: number;
  posInSet: number;
  expandable: boolean;
  expanded: boolean;
}

export function TreeView({
  nodes,
  expandedIds,
  onExpandedChange,
  defaultExpandedIds,
  selectedId,
  onSelect,
  checkedIds,
  onCheckedChange,
  onLoadChildren,
  loadingIds,
  filter,
  showCounts = true,
  indent = 16,
  guides = true,
  className,
  emptyText = "Nothing to show",
  "aria-label": ariaLabel = "Tree",
}: TreeViewProps) {
  const [internalExpanded, setInternalExpanded] = useState<string[]>(() => [
    ...(defaultExpandedIds ?? []),
  ]);
  const expanded = expandedIds ?? internalExpanded;
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  const checkedSet = useMemo(() => new Set(checkedIds ?? []), [checkedIds]);
  const loadingSet = useMemo(() => new Set(loadingIds ?? []), [loadingIds]);

  const setExpanded = useCallback(
    (next: string[]) => {
      if (expandedIds === undefined) setInternalExpanded(next);
      onExpandedChange?.(next);
    },
    [expandedIds, onExpandedChange],
  );

  /* ---------------------------------------------------------------- filter */

  const query = (filter ?? "").trim().toLowerCase();

  const visibleNodes = useMemo(() => {
    if (!query) return nodes;
    const keep = (node: TreeNode): TreeNode | null => {
      const label = (node.text ?? toText(node.label)).toLowerCase();
      const matched = label.includes(query);
      const children = (node.children ?? [])
        .map(keep)
        .filter((child): child is TreeNode => child !== null);
      if (!matched && children.length === 0) return null;
      return { ...node, children: matched ? node.children : children };
    };
    return nodes.map(keep).filter((node): node is TreeNode => node !== null);
  }, [nodes, query]);

  /* --------------------------------------------------------------- flatten */

  const flat = useMemo(() => {
    const list: FlatNode[] = [];
    const walk = (list_: readonly TreeNode[], level: number, parentId: string | null) => {
      list_.forEach((node, index) => {
        const expandable = Boolean(node.hasChildren ?? (node.children && node.children.length > 0));
        // While filtering, matched branches are opened so hits are visible.
        const isExpanded = query ? true : expandedSet.has(node.id);
        list.push({
          node,
          level,
          parentId,
          setSize: list_.length,
          posInSet: index + 1,
          expandable,
          expanded: expandable && isExpanded,
        });
        if (expandable && isExpanded && node.children?.length) {
          walk(node.children, level + 1, node.id);
        }
      });
    };
    walk(visibleNodes, 0, null);
    return list;
  }, [visibleNodes, expandedSet, query]);

  /* --------------------------------------------------------------- roving */

  const [focusId, setFocusId] = useState<string | null>(null);
  const containerRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef({ buffer: "", at: 0 });

  const activeId = focusId ?? selectedId ?? flat[0]?.node.id ?? null;
  const activeIndex = flat.findIndex((entry) => entry.node.id === activeId);

  const focusNode = useCallback((id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-tree-node="${escapeAttrValue(id)}"]`)
        ?.focus({ preventScroll: false });
    });
  }, []);

  const toggle = useCallback(
    (node: TreeNode, next?: boolean) => {
      const isOpen = expandedSet.has(node.id);
      const open = next ?? !isOpen;
      if (open && !node.children?.length && node.hasChildren) onLoadChildren?.(node);
      setExpanded(
        open ? [...expanded.filter((id) => id !== node.id), node.id] : expanded.filter((id) => id !== node.id),
      );
    },
    [expanded, expandedSet, onLoadChildren, setExpanded],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLUListElement>) => {
      if (flat.length === 0) return;
      const index = activeIndex < 0 ? 0 : activeIndex;
      const entry = flat[index];
      if (!entry) return;

      const move = (nextIndex: number) => {
        const clamped = Math.max(0, Math.min(flat.length - 1, nextIndex));
        const target = flat[clamped];
        if (target) focusNode(target.node.id);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          move(index + 1);
          return;
        case "ArrowUp":
          event.preventDefault();
          move(index - 1);
          return;
        case "Home":
          event.preventDefault();
          move(0);
          return;
        case "End":
          event.preventDefault();
          move(flat.length - 1);
          return;
        case "ArrowRight":
          event.preventDefault();
          if (entry.expandable && !entry.expanded) toggle(entry.node, true);
          else move(index + 1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          if (entry.expanded) {
            toggle(entry.node, false);
          } else if (entry.parentId) {
            focusNode(entry.parentId);
          }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          if (onCheckedChange) toggleChecked(entry.node);
          else if (onSelect && !entry.node.disabled) onSelect(entry.node);
          else if (entry.expandable) toggle(entry.node);
          return;
        case "*":
          event.preventDefault();
          setExpanded([
            ...new Set([
              ...expanded,
              ...flat.filter((item) => item.level === entry.level && item.expandable).map((item) => item.node.id),
            ]),
          ]);
          return;
        default:
          break;
      }

      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const now = Date.now();
        const state = typeahead.current;
        state.buffer = now - state.at > 700 ? event.key : state.buffer + event.key;
        state.at = now;
        const needle = state.buffer.toLowerCase();
        const from = index + (state.buffer.length === 1 ? 1 : 0);
        for (let offset = 0; offset < flat.length; offset += 1) {
          const candidate = flat[(from + offset) % flat.length];
          if (!candidate) continue;
          const label = (candidate.node.text ?? toText(candidate.node.label)).toLowerCase();
          if (label.startsWith(needle)) {
            focusNode(candidate.node.id);
            return;
          }
        }
      }
    },
    [flat, activeIndex, focusNode, toggle, onSelect, onCheckedChange, expanded, setExpanded],
  );

  /* -------------------------------------------------------------- checking */

  const collectIds = useCallback((node: TreeNode, into: string[] = []): string[] => {
    into.push(node.id);
    for (const child of node.children ?? []) collectIds(child, into);
    return into;
  }, []);

  const toggleChecked = useCallback(
    (node: TreeNode) => {
      if (!onCheckedChange) return;
      const subtree = collectIds(node);
      const allChecked = subtree.every((id) => checkedSet.has(id));
      const next = new Set(checkedSet);
      for (const id of subtree) {
        if (allChecked) next.delete(id);
        else next.add(id);
      }
      onCheckedChange([...next]);
    },
    [onCheckedChange, collectIds, checkedSet],
  );

  const checkStateOf = useCallback(
    (node: TreeNode): { checked: boolean; indeterminate: boolean } => {
      const subtree = collectIds(node);
      const hits = subtree.filter((id) => checkedSet.has(id)).length;
      return { checked: hits === subtree.length && hits > 0, indeterminate: hits > 0 && hits < subtree.length };
    },
    [collectIds, checkedSet],
  );

  /* ---------------------------------------------------------------- render */

  useEffect(() => {
    if (focusId && !flat.some((entry) => entry.node.id === focusId)) setFocusId(null);
  }, [flat, focusId]);

  if (flat.length === 0) {
    return (
      <p className={cx("px-3 py-6 text-center text-body text-content-subtle", className)}>
        {emptyText}
      </p>
    );
  }

  return (
    <ul
      ref={containerRef}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={onCheckedChange ? true : undefined}
      onKeyDown={onKeyDown}
      className={cx("relative select-none", className)}
    >
      {flat.map((entry) => {
        const { node, level, expandable, expanded: isOpen, setSize, posInSet } = entry;
        const selected = selectedId === node.id;
        const isActive = activeId === node.id;
        const loading = loadingSet.has(node.id);
        const check = onCheckedChange ? checkStateOf(node) : null;
        const styles = node.tone ? toneStyles[node.tone] : null;

        return (
          <li
            key={node.id}
            role="treeitem"
            aria-level={level + 1}
            aria-setsize={setSize}
            aria-posinset={posInSet}
            aria-expanded={expandable ? isOpen : undefined}
            aria-selected={selected || undefined}
            aria-disabled={node.disabled || undefined}
            data-tree-node={node.id}
            tabIndex={isActive ? 0 : -1}
            onFocus={(event) => {
              event.stopPropagation();
              setFocusId(node.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (node.disabled) return;
              setFocusId(node.id);
              if (onSelect) onSelect(node);
              else if (expandable) toggle(node);
            }}
            className={cx(
              "group/node relative flex h-row-sm items-center gap-1.5 rounded-sm pr-1.5 outline-none",
              "text-body transition-colors duration-instant",
              selected
                ? "bg-accent-subtle font-medium text-accent-subtle-fg"
                : "text-content hover:bg-surface-hover",
              node.disabled && "cursor-not-allowed opacity-50",
              (onSelect || expandable) && !node.disabled && "cursor-pointer",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            )}
            style={{ paddingLeft: level * indent + 4 }}
          >
            {guides && level > 0 ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-border-subtle"
                style={{ left: (level - 1) * indent + 12 }}
              />
            ) : null}

            {expandable ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node);
                }}
                className="grid size-4 shrink-0 place-items-center rounded-xs text-content-subtle hover:bg-surface-active hover:text-content"
              >
                {loading ? (
                  <Spinner size="sm" />
                ) : (
                  <IconChevronRight
                    size={13}
                    className={cx("transition-transform duration-fast", isOpen && "rotate-90")}
                  />
                )}
              </button>
            ) : (
              <span aria-hidden="true" className="size-4 shrink-0" />
            )}

            {check ? (
              <Checkbox
                size="sm"
                tabIndex={-1}
                checked={check.checked}
                indeterminate={check.indeterminate}
                aria-label={`Select ${node.text ?? toText(node.label)}`}
                onClick={(event) => event.stopPropagation()}
                onChange={() => toggleChecked(node)}
              />
            ) : null}

            <span className={cx("shrink-0", styles?.text ?? "text-content-subtle")}>
              {node.icon
                ? renderIconLike(node.icon, 14)
                : expandable
                  ? isOpen
                    ? <IconFolderOpen size={14} />
                    : <IconFolder size={14} />
                  : null}
            </span>

            <span className="min-w-0 flex-1 truncate">{node.label}</span>

            {node.meta ? (
              <span className="shrink-0 text-meta text-content-subtle">{node.meta}</span>
            ) : null}
            {node.badge ? <span className="shrink-0">{node.badge}</span> : null}
            {showCounts && node.count !== undefined ? (
              <span className="shrink-0 rounded-full bg-surface-active px-1.5 text-2xs font-medium tabular-nums text-content-muted">
                {formatNumber(node.count)}
              </span>
            ) : null}
            {node.actions ? (
              <span
                onClick={(event) => event.stopPropagation()}
                className="shrink-0 opacity-0 transition-opacity duration-fast group-hover/node:opacity-100 focus-within:opacity-100"
              >
                {node.actions}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Escape a value for use inside a *quoted* attribute selector. Only the quote
 * and the backslash need escaping there — `CSS.escape` is for identifiers and
 * would over-escape, breaking the match.
 */
function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
