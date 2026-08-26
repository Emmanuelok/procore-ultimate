/**
 * ProjectNav — the project workspace's secondary navigation.
 *
 * Replaces a wrapping row of 27 tabs with a two-level, collapsible sidebar
 * that holds 30 destinations without wrapping and would hold 60 without
 * changing shape:
 *
 *   · Overview sits above the groups, because it is where you land.
 *   · Seven groups a construction professional already thinks in.
 *   · A filter box, so 30 destinations are one or two keystrokes away.
 *   · A rail mode (icons only) for when the screen belongs to a drawing.
 *
 * Group open/closed state and the rail toggle persist per user in
 * localStorage. The group holding the current route is always opened, so a
 * deep link never lands you in a nav that hides where you are.
 */
import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { IconChevronDown, IconSearch, IconSidebarCollapse, IconSidebarExpand } from "../../ui/icons";
import { IconButton, Tooltip, VisuallyHidden } from "../../ui";
import { cx } from "../../ui/cx";
import {
  OVERVIEW_ITEM,
  PROJECT_NAV_GROUPS,
  groupIdForPath,
  matchesFilter,
  type ProjectNavItem,
} from "./nav";

const GROUPS_KEY = "constructos.projectnav.groups";
const RAIL_KEY = "constructos.projectnav.rail";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota, blocked storage — the nav still works */
  }
}

export function useProjectNavRail(): [boolean, (next: boolean) => void] {
  const [rail, setRail] = useState<boolean>(() => readJson<boolean>(RAIL_KEY, false));
  useEffect(() => {
    writeJson(RAIL_KEY, rail);
  }, [rail]);
  return [rail, setRail];
}

export interface ProjectNavProps {
  /** Path segment under /projects/:projectId — "" on the overview. */
  activeSegment: string;
  /** Icons only. Ignored in the drawer. */
  rail?: boolean;
  onRailChange?: (next: boolean) => void;
  /** Rendered inside the mobile drawer: full width, no rail, no sticky. */
  variant?: "sidebar" | "drawer";
  /** Called after any destination is chosen (closes the drawer). */
  onNavigate?: () => void;
  className?: string;
}

export default function ProjectNav({
  activeSegment,
  rail = false,
  onRailChange,
  variant = "sidebar",
  onNavigate,
  className,
}: ProjectNavProps) {
  const isDrawer = variant === "drawer";
  const collapsed = rail && !isDrawer;

  const [filter, setFilter] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(GROUPS_KEY, {}),
  );
  useEffect(() => {
    writeJson(GROUPS_KEY, openGroups);
  }, [openGroups]);

  const activeGroupId = useMemo(() => groupIdForPath(activeSegment), [activeSegment]);

  const searching = filter.trim().length > 0;

  const groups = useMemo(
    () =>
      PROJECT_NAV_GROUPS.map((group) => ({
        ...group,
        matches: group.items.filter((item) => matchesFilter(item, filter)),
      })).filter((group) => !searching || group.matches.length > 0),
    [filter, searching],
  );

  const overviewMatches = matchesFilter(OVERVIEW_ITEM, filter);
  const nothingMatches = searching && !overviewMatches && groups.length === 0;

  function isOpen(groupId: string): boolean {
    if (searching) return true;
    if (groupId === activeGroupId) return true;
    return openGroups[groupId] ?? true;
  }

  function toggleGroup(groupId: string) {
    setOpenGroups((current) => ({ ...current, [groupId]: !(current[groupId] ?? true) }));
  }

  return (
    <nav
      aria-label="Project sections"
      className={cx(
        "flex min-h-0 flex-col",
        isDrawer ? "w-full" : collapsed ? "w-[3.25rem]" : "w-[13.75rem]",
        !isDrawer && "transition-[width] duration-base ease-standard",
        className,
      )}
    >
      {/* ---------------------------------------------------------- controls */}
      {collapsed ? (
        onRailChange ? (
          <div className="mb-1 flex justify-center">
            <Tooltip content="Expand section list" placement="right">
              <IconButton
                icon={IconSidebarExpand}
                label="Expand section list"
                size="sm"
                onClick={() => onRailChange(false)}
              />
            </Tooltip>
          </div>
        ) : null
      ) : (
        <div className="mb-2 flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <IconSearch
              size={13}
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle"
            />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && filter) {
                  event.stopPropagation();
                  setFilter("");
                }
              }}
              placeholder="Filter sections"
              aria-label="Filter project sections"
              className={cx(
                "h-control-sm w-full rounded-md border border-border bg-surface-raised pl-7 pr-2",
                "text-meta text-content placeholder:text-content-disabled",
                "focus-ring outline-none transition-colors duration-fast",
                "[&::-webkit-search-cancel-button]:appearance-none",
              )}
            />
          </div>
          {onRailChange && !isDrawer ? (
            <Tooltip content="Collapse to icons" placement="right">
              <IconButton
                icon={IconSidebarCollapse}
                label="Collapse section list to icons"
                size="sm"
                onClick={() => onRailChange(true)}
              />
            </Tooltip>
          ) : null}
        </div>
      )}

      {/* -------------------------------------------------------------- list */}
      <div
        className={cx(
          "-mr-1 min-h-0 flex-1 overflow-y-auto pr-1",
          isDrawer ? "" : "max-h-[calc(100dvh-8rem)]",
        )}
      >
        {overviewMatches ? (
          <NavItemLink
            item={OVERVIEW_ITEM}
            collapsed={collapsed}
            onNavigate={onNavigate}
            className="mb-1"
          />
        ) : null}

        {groups.map((group) => {
          const open = isOpen(group.id);
          const items = searching ? group.matches : group.items;
          const holdsActive = group.id === activeGroupId;

          if (collapsed) {
            return (
              <div
                key={group.id}
                className="mt-1 flex flex-col items-center border-t border-border-subtle pt-1"
              >
                <VisuallyHidden>{group.label}</VisuallyHidden>
                {items.map((item) => (
                  <NavItemLink
                    key={item.to}
                    item={item}
                    collapsed
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            );
          }

          return (
            <div key={group.id} className="mt-2 first:mt-0">
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={open}
                className={cx(
                  "group/head flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left",
                  "text-label uppercase text-content-subtle",
                  "transition-colors duration-fast hover:bg-surface-hover hover:text-content-muted",
                  "focus-ring outline-none",
                )}
              >
                <IconChevronDown
                  size={12}
                  aria-hidden="true"
                  className={cx(
                    "shrink-0 transition-transform duration-fast ease-standard",
                    open ? "rotate-0" : "-rotate-90",
                  )}
                />
                <span className="truncate">{group.label}</span>
                {!open && holdsActive ? (
                  <span
                    aria-hidden="true"
                    className="ml-auto size-1.5 shrink-0 rounded-full bg-accent"
                  />
                ) : null}
              </button>

              {open ? (
                <div className="mt-0.5 space-y-px">
                  {items.map((item) => (
                    <NavItemLink
                      key={item.to}
                      item={item}
                      collapsed={false}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {nothingMatches ? (
          <p className="px-2 py-6 text-center text-meta text-content-subtle">
            No section matches “{filter.trim()}”.
          </p>
        ) : null}
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */

function NavItemLink({
  item,
  collapsed,
  onNavigate,
  className,
}: {
  item: ProjectNavItem;
  collapsed: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  const Glyph = item.icon;

  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "group/item relative flex items-center rounded-md text-body",
          "transition-colors duration-fast ease-standard",
          "focus-ring outline-none",
          collapsed ? "size-9 justify-center" : "gap-2 px-2 py-1.5",
          isActive
            ? "bg-surface-selected font-medium text-content"
            : "text-content-muted hover:bg-surface-hover hover:text-content",
          className,
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* The active rail. In icon mode the selected background carries the
              state on its own — a 2px bar inside a 36px square reads as noise. */}
          {isActive && !collapsed ? (
            <span
              aria-hidden="true"
              className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent"
            />
          ) : null}
          <Glyph
            size={15}
            aria-hidden="true"
            className={cx("shrink-0", isActive ? "text-accent-text" : "text-content-subtle")}
          />
          {collapsed ? (
            <VisuallyHidden>{item.label}</VisuallyHidden>
          ) : (
            <span className="truncate">{item.label}</span>
          )}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip content={item.label} placement="right" delay={{ open: 120, close: 40 }}>
      {link}
    </Tooltip>
  );
}
